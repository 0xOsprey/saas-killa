'use client';

import { useState, useTransition } from 'react';
import { Badge, Button, Card, Input, ScoreDots, Select, Textarea, cn } from '@/components/ui';
import {
  approveContent,
  bulkApproveContent,
  bulkSetLock,
  bulkSetStatus,
  bulkSetTrack,
  editSubmissionText,
  returnContent,
  setDecision,
  setFieldLock,
} from './actions';

export type RevisionEntry = {
  field: string;
  fieldLabel: string;
  who: string;
  when: string;
  oldValue: string | null;
  newValue: string | null;
};

export type BoardRow = {
  id: string;
  title: string;
  abstract: string;
  speakerName: string;
  speakerEmail: string;
  meta: string;
  status: 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
  statusLabel: string;
  statusTone: 'neutral' | 'good' | 'bad' | 'warn' | 'accent';
  averageScore: number | null;
  reviewCount: number;
  notified: boolean;
  scheduled: boolean;
  contentStatus: 'draft' | 'pending' | 'approved';
  contentStatusLabel: string;
  hasContent: boolean;
  /** Supporting documents. Private, so this board is the only way to reach one. */
  documents: { href: string; name: string; size: string }[];
  lockedFields: string[];
  revisionCount: number;
  lastEdit: RevisionEntry | null;
  history: RevisionEntry[];
};

export type FieldOption = { field: string; label: string };

const CONTENT_TONE = {
  draft: 'neutral',
  pending: 'warn',
  approved: 'good',
} as const;

/**
 * The organizer's content dashboard. Selection, the inline editors and the
 * expanded panels are client state; every write is a server action that
 * re-validates the page, so the board never holds a second copy of a row it
 * would have to keep in step with the database.
 *
 * Row text renders as text until an editor is opened rather than as an input
 * with a value. A page of forty always-open inputs is slower to read, slower to
 * scan for the row you want, and invisible to anything that matches on the
 * page's text.
 */
export function SubmissionsBoard({
  rows,
  tracks,
  lockableFields,
  statuses,
}: {
  rows: BoardRow[];
  tracks: { id: string; name: string }[];
  lockableFields: FieldOption[];
  statuses: { value: string; label: string }[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
          data-testid="select-all"
          className="h-4 w-4 rounded border-line"
          aria-label="Select every submission"
        />
        <span>{allSelected ? 'Clear selection' : `Select all ${rows.length}`}</span>
      </div>

      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          selected={selected.has(row.id)}
          onToggle={() => toggle(row.id)}
          lockableFields={lockableFields}
        />
      ))}

      {selected.size > 0 ? (
        <BulkBar
          ids={[...selected]}
          tracks={tracks}
          lockableFields={lockableFields}
          statuses={statuses}
          onDone={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  );
}

function Row({
  row,
  selected,
  onToggle,
  lockableFields,
}: {
  row: BoardRow;
  selected: boolean;
  onToggle: () => void;
  lockableFields: FieldOption[];
}) {
  const [draft, setDraft] = useState<{ title: string; abstract: string } | null>(null);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  function save() {
    if (!draft) return;
    const data = new FormData();
    data.set('submissionId', row.id);
    data.set('title', draft.title);
    data.set('abstract', draft.abstract);
    startTransition(async () => {
      await editSubmissionText(data);
      setDraft(null);
    });
  }

  function sendBack() {
    const data = new FormData();
    data.set('submissionId', row.id);
    data.set('reason', reason);
    startTransition(async () => {
      await returnContent(data);
      setReason('');
    });
  }

  function run(action: (data: FormData) => Promise<void>, fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    startTransition(async () => {
      await action(data);
    });
  }

  return (
    <Card
      className={cn('space-y-3', pending && 'opacity-60', selected && 'border-accent')}
      data-testid={`submission-${row.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            data-testid={`select-${row.id}`}
            className="mt-1 h-4 w-4 shrink-0 rounded border-line"
            aria-label={`Select ${row.title}`}
          />
          <div className="min-w-0">
            <h2 className="font-medium text-ink">{row.title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {row.speakerName} · {row.speakerEmail}
            </p>
            <p className="mt-0.5 text-xs text-muted">{row.meta}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <ScoreDots score={row.averageScore} />
          <span className="text-xs text-muted">{row.reviewCount} review(s)</span>
          <Badge tone={row.statusTone}>{row.statusLabel}</Badge>
          <Badge tone={CONTENT_TONE[row.contentStatus]}>
            Content: {row.contentStatusLabel}
          </Badge>
        </div>
      </div>

      {row.lockedFields.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Locked to the speaker:</span>
          {row.lockedFields.map((field) => (
            <Badge key={field} tone="warn">
              {lockableFields.find((option) => option.field === field)?.label ?? field}
            </Badge>
          ))}
        </p>
      ) : null}

      {draft ? (
        <div className="space-y-2">
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            data-testid={`edit-title-${row.id}`}
            aria-label="Title"
          />
          <Textarea
            value={draft.abstract}
            onChange={(e) => setDraft({ ...draft, abstract: e.target.value })}
            data-testid={`edit-abstract-${row.id}`}
            aria-label="Abstract"
          />
          <div className="flex gap-2">
            <Button type="button" onClick={save} data-testid={`save-${row.id}`}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted">{row.abstract}</p>
          <button
            type="button"
            onClick={() => setDraft({ title: row.title, abstract: row.abstract })}
            className="text-xs text-muted underline hover:text-ink"
            data-testid={`edit-${row.id}`}
          >
            Edit title and abstract
          </button>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <form action={setDecision}>
          <input type="hidden" name="submissionId" value={row.id} />
          <input type="hidden" name="status" value="accepted" />
          <Button
            type="submit"
            variant={row.status === 'accepted' ? 'primary' : 'secondary'}
            data-testid={`accept-${row.id}`}
          >
            Accept
          </Button>
        </form>
        <form action={setDecision}>
          <input type="hidden" name="submissionId" value={row.id} />
          <input type="hidden" name="status" value="rejected" />
          <Button type="submit" variant={row.status === 'rejected' ? 'danger' : 'secondary'}>
            Reject
          </Button>
        </form>
        {row.status !== 'submitted' ? (
          <form action={setDecision}>
            <input type="hidden" name="submissionId" value={row.id} />
            <input type="hidden" name="status" value="submitted" />
            <Button type="submit" variant="ghost" className="text-xs">
              Undecide
            </Button>
          </form>
        ) : null}

        <span className="ml-auto text-xs text-muted">
          {row.notified ? 'speaker notified' : 'not notified'}
          {row.scheduled ? ' · scheduled' : ''}
        </span>
      </div>

      <details className="rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Content and locks
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">
            {row.hasContent
              ? 'Slides, a recording or resources are attached.'
              : 'The speaker has not attached anything yet.'}
          </p>

          {row.documents.length > 0 ? (
            <div className="space-y-1" data-testid={`organizer-documents-${row.id}`}>
              <p className="text-xs font-medium text-ink">
                Supporting documents ({row.documents.length})
              </p>
              <ul className="space-y-0.5">
                {row.documents.map((document) => (
                  <li key={document.href} className="flex items-baseline gap-2 text-xs">
                    <a href={document.href} className="truncate underline hover:text-ink">
                      {document.name}
                    </a>
                    <span className="shrink-0 text-muted">{document.size}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {row.contentStatus === 'approved' ? null : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => run(approveContent, { submissionId: row.id })}
                data-testid={`content-approve-${row.id}`}
              >
                Approve content
              </Button>
            )}
            {row.contentStatus === 'draft' ? null : (
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why it is going back"
                  className="min-w-48 flex-1"
                  data-testid={`return-reason-${row.id}`}
                  aria-label="Reason for sending content back"
                />
                <Button
                  type="button"
                  variant="danger"
                  disabled={reason.trim().length < 4}
                  onClick={sendBack}
                  data-testid={`content-return-${row.id}`}
                >
                  Send back
                </Button>
              </div>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-ink">Fields the speaker may not edit</p>
            <div className="flex flex-wrap gap-1.5">
              {lockableFields.map((option) => {
                const locked = row.lockedFields.includes(option.field);
                return (
                  <button
                    key={option.field}
                    type="button"
                    onClick={() =>
                      run(setFieldLock, {
                        submissionId: row.id,
                        field: option.field,
                        locked: locked ? 'false' : 'true',
                      })
                    }
                    data-testid={`lock-${row.id}-${option.field}`}
                    aria-pressed={locked}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs',
                      locked
                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                        : 'border-line bg-white text-muted hover:border-accent',
                    )}
                  >
                    {option.label}
                    {locked ? ' · locked' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </details>

      <div className="border-t border-line pt-2 text-xs text-muted">
        {row.lastEdit ? (
          <details>
            <summary className="cursor-pointer" data-testid={`last-edit-${row.id}`}>
              Last edit: {row.lastEdit.fieldLabel} by {row.lastEdit.who}, {row.lastEdit.when} ·{' '}
              {row.revisionCount} change(s) logged
            </summary>
            <ul className="mt-2 space-y-1.5">
              {row.history.map((entry, index) => (
                <li key={`${entry.when}-${entry.field}-${index}`}>
                  <span className="text-ink">{entry.fieldLabel}</span> by {entry.who}, {entry.when}
                  <span className="block truncate">
                    {entry.oldValue ? `“${entry.oldValue}” → ` : ''}
                    {entry.newValue ? `“${entry.newValue}”` : 'cleared'}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <span>No edits logged yet.</span>
        )}
      </div>
    </Card>
  );
}

/**
 * The bulk bar. It appears only with a selection and sits above the page rather
 * than at the top of it, because the rows an organizer is picking are usually
 * further down the list than the controls would be.
 */
function BulkBar({
  ids,
  tracks,
  lockableFields,
  statuses,
  onDone,
}: {
  ids: string[];
  tracks: { id: string; name: string }[];
  lockableFields: FieldOption[];
  statuses: { value: string; label: string }[];
  onDone: () => void;
}) {
  const [status, setStatus] = useState(statuses[0]?.value ?? 'accepted');
  const [trackId, setTrackId] = useState('');
  const [lockField, setLockField] = useState(lockableFields[0]?.field ?? 'title');
  const [pending, startTransition] = useTransition();

  function run(action: (data: FormData) => Promise<void>, fields: Record<string, string> = {}) {
    const data = new FormData();
    for (const id of ids) data.append('ids', id);
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    startTransition(async () => {
      await action(data);
      onDone();
    });
  }

  return (
    <div className="sticky bottom-4 z-10" data-testid="bulk-bar">
      <Card className={cn('flex flex-wrap items-center gap-3 shadow-md', pending && 'opacity-60')}>
        <span className="text-sm font-medium text-ink">{ids.length} selected</span>

        <div className="flex items-center gap-1.5">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-auto"
            data-testid="bulk-status"
            aria-label="Status to apply"
          >
            {statuses.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(bulkSetStatus, { status })}
            data-testid="bulk-status-apply"
          >
            Set status
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            value={trackId}
            onChange={(e) => setTrackId(e.target.value)}
            className="w-auto"
            data-testid="bulk-track"
            aria-label="Track to apply"
          >
            <option value="">No track</option>
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(bulkSetTrack, { trackId })}
            data-testid="bulk-track-apply"
          >
            Set track
          </Button>
        </div>

        <Button
          type="button"
          variant="secondary"
          onClick={() => run(bulkApproveContent)}
          data-testid="bulk-approve-content"
        >
          Approve content
        </Button>

        <div className="flex items-center gap-1.5">
          <Select
            value={lockField}
            onChange={(e) => setLockField(e.target.value)}
            className="w-auto"
            data-testid="bulk-lock-field"
            aria-label="Field to lock or unlock"
          >
            {lockableFields.map((option) => (
              <option key={option.field} value={option.field}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(bulkSetLock, { field: lockField, locked: 'true' })}
            data-testid="bulk-lock"
          >
            Lock
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => run(bulkSetLock, { field: lockField, locked: 'false' })}
            data-testid="bulk-unlock"
          >
            Unlock
          </Button>
        </div>

        <Button type="button" variant="ghost" className="ml-auto" onClick={onDone}>
          Clear
        </Button>
      </Card>
    </div>
  );
}
