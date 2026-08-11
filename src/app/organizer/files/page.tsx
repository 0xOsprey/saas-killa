import { Button, Card, Empty, Field, Input, LinkButton, Notice, PageHeader } from '@/components/ui';
import { inEventZone } from '@/lib/format';
import { uuidOrNull } from '@/lib/ids';
import { getEvent } from '@/lib/queries';
import { EXPORT_GROUPINGS } from '@/lib/export-grouping';
import {
  UPLOAD_KIND_LABELS,
  fileExportById,
  fileSeriesList,
  formatBytes,
  recentFileExports,
  type FileSeries,
} from '@/lib/uploads';
import { ExportStatus, FilesLibrary, type LibraryRow } from './FilesLibrary';

/**
 * Every file anybody has uploaded, in one list.
 *
 * The per-talk panels on the submissions board answer "what did this speaker
 * send"; this answers the other question, which is the one asked in the week
 * before an event: what have we got, whose is still missing, and can the AV
 * team have all of it at once. Nothing here is a second copy of the data —
 * it is `uploads` folded into version chains, the same fold the speaker's own
 * screen reads.
 */

function match(series: FileSeries, needle: string): boolean {
  const haystack = [
    series.latest.filename,
    series.submissionTitle ?? '',
    series.speakerName ?? '',
    series.speakerEmail,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export default async function OrganizerFilesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    submission?: string;
    select?: string;
    open?: string;
    export?: string;
  }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() ?? '';

  const [event, all] = await Promise.all([getEvent(), fileSeriesList()]);

  // `submission` narrows the library to one talk, which is the per-session files
  // tab: the same rows, the same fold, one filter in the address rather than a
  // second screen that could disagree with this one.
  const scoped = params.submission
    ? all.filter((series) => series.submissionId === params.submission)
    : all;
  const rows = q ? scoped.filter((series) => match(series, q.toLowerCase())) : scoped;

  const preselect = new Set((params.select ?? '').split(',').filter(Boolean));
  const initialSelected = rows
    .filter((series) => series.submissionId && preselect.has(series.submissionId))
    .map((series) => series.seriesId);

  // An unparseable `?export=` is no export rather than an error: this is a
  // link handed out after a job finishes, so it gets bookmarked and outlives
  // the row it named. The library behind it still renders, minus the panel.
  const exportId = uuidOrNull(params.export);
  const [job, recent] = await Promise.all([
    exportId ? fileExportById(exportId) : Promise.resolve(null),
    recentFileExports(),
  ]);

  const library: LibraryRow[] = rows.map((series) => ({
    seriesId: series.seriesId,
    filename: series.latest.filename,
    kindLabel: UPLOAD_KIND_LABELS[series.kind],
    submissionId: series.submissionId,
    session: series.submissionTitle ?? 'No session — account file',
    speaker: series.speakerName ?? series.speakerEmail,
    uploaded: inEventZone(series.firstUploadedAt, event.timezone, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    updated: inEventZone(series.updatedAt, event.timezone, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    versionCount: series.versions.length,
    commentCount: series.commentCount,
    size: formatBytes(series.latest.bytes),
    href: series.latest.href,
    detailHref: `/organizer/files/${series.seriesId}`,
  }));

  const scopedTitle = params.submission ? (scoped[0]?.submissionTitle ?? null) : null;
  const versions = rows.reduce((total, series) => total + series.versions.length, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Files"
        description={`${rows.length} file(s) across ${versions} version(s). Every deck, poster, headshot and handout on this event.`}
        action={
          params.submission ? (
            <LinkButton href="/organizer/files" variant="secondary">
              Every session
            </LinkButton>
          ) : (
            <LinkButton href="/organizer/submissions" variant="secondary">
              Submissions
            </LinkButton>
          )
        }
      />

      {scopedTitle ? (
        <Notice tone="accent">
          <span data-testid="files-scope">Files on “{scopedTitle}” only.</span>
        </Notice>
      ) : null}

      {job ? (
        <ExportStatus
          status={job.status}
          detail={
            job.status === 'ready'
              ? `${job.fileCount} file(s), ${formatBytes(job.bytes)}, ${(
                  EXPORT_GROUPINGS.find((option) => option.value === job.grouping)?.label ??
                  job.grouping
                ).toLowerCase()}.`
              : job.status === 'failed'
                ? (job.error ?? 'The archive could not be built.')
                : 'The archive is being built. Reload in a moment.'
          }
          downloadHref={job.status === 'ready' ? `/organizer/files/exports/${job.id}` : null}
        />
      ) : null}

      <Card>
        <form method="get" className="grid items-end gap-3 sm:grid-cols-[3fr_auto]">
          <Field label="Search" hint="File name, session title, speaker name and email.">
            <Input name="q" defaultValue={q} placeholder="slides" data-testid="files-search" />
          </Field>
          <Button type="submit" variant="secondary" data-testid="files-apply">
            Apply
          </Button>
          {params.submission ? (
            <input type="hidden" name="submission" value={params.submission} />
          ) : null}
        </form>
      </Card>

      {library.length === 0 ? (
        <Empty>
          {all.length === 0
            ? 'Nobody has uploaded anything yet. Files appear here the moment a speaker attaches one.'
            : 'Nothing matches. Clear the search.'}
        </Empty>
      ) : (
        <FilesLibrary
          rows={library}
          initialSelected={initialSelected}
          initialOpen={params.open === '1'}
        />
      )}

      {recent.length > 0 ? (
        <Card className="space-y-2">
          <h2 className="text-sm font-medium text-ink">Recent downloads</h2>
          <ul className="space-y-1 text-xs text-muted" data-testid="export-history">
            {recent.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-ink">{row.status}</span>
                <span>
                  {inEventZone(row.createdAt, event.timezone, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
                <span>
                  {row.fileCount} file(s) · {formatBytes(row.bytes)}
                </span>
                {row.status === 'ready' ? (
                  <a href={`/organizer/files/exports/${row.id}`} className="underline">
                    Download
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
