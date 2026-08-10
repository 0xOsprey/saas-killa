import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { FileCommentThread, FileVersionList } from '@/app/files/FilePanels';
import { inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import {
  UPLOAD_KIND_LABELS,
  commentsForSeries,
  fileSeriesById,
  formatBytes,
} from '@/lib/uploads';

/**
 * One file, its versions and the thread on it.
 *
 * The organizer's half of a conversation the speaker started on their own
 * screen. Both halves render from `commentsForSeries` and `FileVersionList`, so
 * neither side can be shown a thread the other cannot see, which is the whole
 * point of hanging comments on the chain rather than on a row.
 */
export default async function OrganizerFileDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ series: string }>;
  searchParams: Promise<{ commented?: string }>;
}) {
  const { series: seriesId } = await params;
  const [event, series, flash] = await Promise.all([
    getEvent(),
    fileSeriesById(seriesId),
    searchParams,
  ]);
  if (!series) notFound();

  const comments = (await commentsForSeries([series.seriesId])).get(series.seriesId) ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={series.latest.filename}
        description={`${UPLOAD_KIND_LABELS[series.kind]} · ${formatBytes(series.latest.bytes)} · ${
          series.versions.length
        } version(s)`}
        action={
          <LinkButton href="/organizer/files" variant="secondary">
            All files
          </LinkButton>
        }
      />

      <Card className="space-y-2">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Session</dt>
            <dd className="text-ink">
              {series.submissionId ? (
                <Link
                  href={`/organizer/files?submission=${series.submissionId}`}
                  className="underline"
                  data-testid="file-session-link"
                >
                  {series.submissionTitle}
                </Link>
              ) : (
                'No session — this file belongs to the person, not a talk.'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Speaker</dt>
            <dd className="text-ink">
              {series.speakerName ?? series.speakerEmail}
              <span className="block text-xs text-muted">{series.speakerEmail}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">First uploaded</dt>
            <dd className="text-ink">
              {inEventZone(series.firstUploadedAt, event.timezone, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Latest version</dt>
            <dd className="text-ink">
              {inEventZone(series.updatedAt, event.timezone, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-ink">Versions</h2>
          <Badge>{series.versions.length} in this chain</Badge>
        </div>
        {/* Every version keeps its own link, including the superseded ones.
            Re-uploading a deck is a new file beside the old one here, never on
            top of it. */}
        <FileVersionList series={series} timezone={event.timezone} />
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium text-ink">Comments</h2>
        {flash.commented ? (
          <p className="text-xs text-emerald-700" data-testid="file-comment-flash">
            Comment posted. The speaker sees this thread on their own content screen.
          </p>
        ) : null}
        <FileCommentThread
          series={series}
          comments={comments}
          timezone={event.timezone}
          returnTo={`/organizer/files/${series.seriesId}?commented=1`}
        />
      </Card>
    </div>
  );
}
