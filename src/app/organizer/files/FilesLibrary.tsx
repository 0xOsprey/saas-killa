'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Badge, Button, Card, cn } from '@/components/ui';
import { EXPORT_GROUPINGS, type ExportGrouping } from '@/lib/export-grouping';
import { generateFileExport } from './actions';

/**
 * The files library, and the export dialog hanging off it.
 *
 * A client component only because a selection is client state. Every row is
 * rendered from props the server already formatted, timestamps included: the
 * browser's locale disagrees with the server's, and a date formatted in both
 * places fails hydration on the first reader outside Europe.
 */

export type LibraryRow = {
  seriesId: string;
  filename: string;
  kindLabel: string;
  submissionId: string | null;
  session: string;
  speaker: string;
  uploaded: string;
  updated: string;
  versionCount: number;
  commentCount: number;
  size: string;
  href: string;
  detailHref: string;
};

export function FilesLibrary({
  rows,
  initialSelected,
  initialOpen,
}: {
  rows: LibraryRow[];
  initialSelected: string[];
  initialOpen: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [dialogOpen, setDialogOpen] = useState(initialOpen && initialSelected.length > 0);

  function toggle(seriesId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.seriesId));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() =>
            setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.seriesId)))
          }
          data-testid="files-select-all"
          className="h-4 w-4 rounded border-line"
          aria-label="Select every file listed"
        />
        <span>{allSelected ? 'Clear selection' : `Select all ${rows.length} files`}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full min-w-3xl text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-10 px-3 py-2" />
              <th className="px-3 py-2 font-medium">File</th>
              <th className="px-3 py-2 font-medium">Session</th>
              <th className="px-3 py-2 font-medium">Speaker</th>
              <th className="px-3 py-2 font-medium">Uploaded</th>
              <th className="px-3 py-2 font-medium">Versions</th>
              <th className="px-3 py-2 font-medium">Comments</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.seriesId}
                className={cn(
                  'border-b border-line last:border-b-0',
                  selected.has(row.seriesId) && 'bg-accent-soft',
                )}
                data-testid={`file-row-${row.seriesId}`}
              >
                <td className="px-3 py-2 align-top">
                  <input
                    type="checkbox"
                    checked={selected.has(row.seriesId)}
                    onChange={() => toggle(row.seriesId)}
                    data-testid={`file-select-${row.seriesId}`}
                    className="h-4 w-4 rounded border-line"
                    aria-label={`Select ${row.filename}`}
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <a href={row.href} className="font-medium text-ink underline">
                    {row.filename}
                  </a>
                  <p className="mt-0.5 text-xs text-muted">
                    {row.kindLabel} · {row.size}
                  </p>
                </td>
                <td className="px-3 py-2 align-top">{row.session}</td>
                <td className="px-3 py-2 align-top">{row.speaker}</td>
                <td className="px-3 py-2 align-top text-xs text-muted">
                  <span className="block">{row.uploaded}</span>
                  {row.versionCount > 1 ? (
                    <span className="block">latest {row.updated}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top tabular-nums">
                  <span data-testid={`file-versions-${row.seriesId}`}>{row.versionCount}</span>
                </td>
                <td className="px-3 py-2 align-top tabular-nums">{row.commentCount}</td>
                <td className="px-3 py-2 align-top">
                  <Link href={row.detailHref} className="text-xs underline hover:text-ink">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected.size > 0 ? (
        <div className="sticky bottom-4 z-10" data-testid="files-bulk-bar">
          <Card className="flex flex-wrap items-center gap-3 shadow-md">
            <span className="text-sm font-medium text-ink">{selected.size} selected</span>
            <Button
              type="button"
              onClick={() => setDialogOpen(true)}
              data-testid="files-export-open"
            >
              Download selected files
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setSelected(new Set());
                setDialogOpen(false);
              }}
            >
              Clear
            </Button>
          </Card>
        </div>
      ) : null}

      {dialogOpen && selected.size > 0 ? (
        <ExportDialog
          rows={rows.filter((row) => selected.has(row.seriesId))}
          onClose={() => setDialogOpen(false)}
          onDeselect={toggle}
        />
      ) : null}
    </div>
  );
}

/**
 * What goes in the archive and how it is laid out, decided before anything is
 * built.
 *
 * Rendered in the page rather than in a real `<dialog>`: the choice being made
 * is worth reading beside the list it applies to, and a modal would hide the
 * rows the organizer is about to change their mind about.
 */
function ExportDialog({
  rows,
  onClose,
  onDeselect,
}: {
  rows: LibraryRow[];
  onClose: () => void;
  onDeselect: (seriesId: string) => void;
}) {
  const [grouping, setGrouping] = useState<ExportGrouping>('session');
  const [pending, startTransition] = useTransition();

  function generate() {
    const data = new FormData();
    for (const row of rows) data.append('seriesIds', row.seriesId);
    data.set('grouping', grouping);
    startTransition(async () => {
      await generateFileExport(data);
    });
  }

  return (
    <Card className={cn('space-y-4', pending && 'opacity-60')} data-testid="export-dialog">
      <div>
        <h2 className="font-medium text-ink">Download {rows.length} file(s)</h2>
        <p className="mt-0.5 text-sm text-muted">
          The archive holds the latest version of each file and nothing else. An AV team handed
          four files called slides.pdf has to guess which one is going on the screen.
        </p>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-ink">Folders</legend>
        {EXPORT_GROUPINGS.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name="grouping"
              value={option.value}
              checked={grouping === option.value}
              onChange={() => setGrouping(option.value)}
              data-testid={`export-grouping-${option.value}`}
              className="h-4 w-4 border-line"
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">Files in this download</p>
        <ul className="space-y-1">
          {rows.map((row) => (
            <li
              key={row.seriesId}
              className="flex flex-wrap items-baseline gap-x-2 text-sm"
              data-testid={`export-file-${row.seriesId}`}
            >
              <span className="text-ink">{row.filename}</span>
              <span className="text-xs text-muted">
                {row.session} · v{row.versionCount}
              </span>
              <button
                type="button"
                onClick={() => onDeselect(row.seriesId)}
                className="text-xs text-muted underline hover:text-ink"
                data-testid={`export-drop-${row.seriesId}`}
              >
                Leave out
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={generate} disabled={pending} data-testid="export-generate">
          {pending ? 'Generating…' : 'Generate download'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** The state of one archive, read back from its row rather than from a guess. */
export function ExportStatus({
  status,
  detail,
  downloadHref,
}: {
  status: 'queued' | 'generating' | 'ready' | 'failed';
  detail: string;
  downloadHref: string | null;
}) {
  const tone = status === 'ready' ? 'good' : status === 'failed' ? 'bad' : 'warn';
  const label = {
    queued: 'Queued',
    generating: 'Generating',
    ready: 'Ready',
    failed: 'Failed',
  }[status];

  return (
    <Card className="flex flex-wrap items-center gap-3" data-testid="export-status">
      <Badge tone={tone} data-testid="export-state">
        {label}
      </Badge>
      <span className="text-sm text-ink">{detail}</span>
      {downloadHref ? (
        <a
          href={downloadHref}
          className="text-sm underline hover:text-ink"
          data-testid="export-download"
        >
          Download the archive
        </a>
      ) : null}
    </Card>
  );
}
