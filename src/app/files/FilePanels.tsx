import { Badge, Button, Textarea } from '@/components/ui';
import { inEventZone } from '@/lib/format';
import { formatBytes, type FileComment, type FileSeries } from '@/lib/uploads';
import { addFileComment } from './actions';

/**
 * The two panels every screen that shows a file needs: what versions of it
 * exist, and what has been said about it.
 *
 * They live beside the route that serves the bytes rather than in
 * `src/components`, because they are the file feature's own UI and nothing
 * outside it renders them. The speaker's content page and the organizer's files
 * library both import them, which is the point: a version list that reads one
 * way on one screen and another way on the other is two features wearing one
 * name, and the thread only works if both roles are looking at the same rows.
 */

/**
 * Every version of one file, newest first.
 *
 * Each row is a link to that exact version, not to "the file": the older bytes
 * keep their own `/files/<id>` address for good, which is what makes a
 * re-upload a version rather than an overwrite. The newest carries the badge,
 * because a list of four identically named PDFs with no current marker is the
 * thing a version list is supposed to prevent.
 */
export function FileVersionList({
  series,
  timezone,
  testId,
}: {
  series: FileSeries;
  timezone: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId ?? `versions-${series.seriesId}`}>
      <p className="text-xs font-medium text-ink">
        {series.versions.length} version{series.versions.length === 1 ? '' : 's'}
      </p>
      <ol className="space-y-1">
        {series.versions.map((version) => (
          <li
            key={version.id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
            data-testid={`version-${version.id}`}
          >
            <span className="font-medium tabular-nums text-ink">v{version.version}</span>
            <a href={version.href} className="truncate underline hover:text-ink">
              {version.filename}
            </a>
            <span className="text-muted">
              {inEventZone(version.createdAt, timezone, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
            <span className="text-muted">{formatBytes(version.bytes)}</span>
            {version.isLatest ? (
              <Badge tone="good" data-testid={`version-latest-${series.seriesId}`}>
                Latest
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The thread on a file, and the box to add to it.
 *
 * Attributed and timestamped on every line, including the viewer's own. A
 * conversation between a speaker and an organizer about a deadline is read
 * later by a third person who was in neither seat.
 *
 * `returnTo` is where the action sends the browser afterwards. It is a field on
 * the form rather than a guess in the action, because the same action serves
 * two screens; the action itself refuses anything outside the two routes it
 * knows, so the field cannot be turned into an open redirect.
 */
export function FileCommentThread({
  series,
  comments,
  timezone,
  returnTo,
}: {
  series: FileSeries;
  comments: FileComment[];
  timezone: string;
  returnTo: string;
}) {
  return (
    <div className="space-y-2" data-testid={`comments-${series.seriesId}`}>
      <p className="text-xs font-medium text-ink">Comments ({comments.length})</p>

      {comments.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing said about this file yet. Speakers and organizers both read this thread.
        </p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className="rounded-md border border-line bg-slate-50 px-3 py-2 text-sm"
              data-testid={`comment-${comment.id}`}
            >
              <p className="text-xs text-muted">
                <span className="font-medium text-ink">
                  {comment.authorName ?? comment.authorEmail}
                </span>{' '}
                ·{' '}
                {inEventZone(comment.createdAt, timezone, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
              <p className="mt-1 whitespace-pre-line text-ink">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form action={addFileComment} className="space-y-2">
        <input type="hidden" name="seriesId" value={series.seriesId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <Textarea
          name="body"
          required
          className="min-h-16 text-sm"
          placeholder="Add a comment on this file"
          aria-label={`Comment on ${series.latest.filename}`}
          data-testid={`comment-box-${series.seriesId}`}
        />
        <Button
          type="submit"
          variant="secondary"
          className="text-xs"
          data-testid={`comment-submit-${series.seriesId}`}
        >
          Post comment
        </Button>
      </form>
    </div>
  );
}
