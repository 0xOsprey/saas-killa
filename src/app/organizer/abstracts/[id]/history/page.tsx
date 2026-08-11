import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Badge, Button, Card, Empty, LinkButton, Notice, PageHeader } from '@/components/ui';
import type { AudienceLevel, SubmissionFormat } from '@/db/schema';
import { fieldLabel, revisionHistory, submissionForEdit } from '@/lib/abstracts';
import { fieldLabel as contentFieldLabel } from '@/lib/content';
import { FORMAT_LABELS, LEVEL_LABELS, inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { isRestorableField, unrestorableReason } from '@/lib/revisions';
import { restoreRevisionAction } from './actions';

/** Enum columns are logged as their stored value; the reader wants the label. */
function readable(field: string, value: string | null): string {
  if (value === null || value === '') return '—';
  if (field === 'format' && value in FORMAT_LABELS) {
    return FORMAT_LABELS[value as SubmissionFormat];
  }
  if (field === 'audienceLevel' && value in LEVEL_LABELS) {
    return LEVEL_LABELS[value as AudienceLevel];
  }
  return value;
}

/**
 * `fieldLabel` in `@/lib/abstracts` knows the six fields its own editor writes.
 * The log also carries status, content status, track and the file columns,
 * written by `logRevisions` elsewhere, and those have names in `@/lib/content`.
 * Ask the narrower one first and fall back, so an entry never prints a raw
 * column name at a reader.
 */
function label(field: string): string {
  const known = fieldLabel(field);
  return known === field ? contentFieldLabel(field) : known;
}

export default async function AbstractHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ restored?: string; field?: string; error?: string }>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const submission = await submissionForEdit(parsed.data);
  if (!submission) notFound();

  const [event, revisions, query] = await Promise.all([
    getEvent(),
    revisionHistory(submission.id),
    searchParams,
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Revision history"
        description={`${submission.title} · ${revisions.length} logged change(s), newest first`}
        action={
          <LinkButton href={`/organizer/abstracts/${submission.id}`} variant="secondary">
            Back to the abstract
          </LinkButton>
        }
      />

      {query.error ? (
        <Notice tone="bad">
          <span data-testid="restore-error">{query.error}</span>
        </Notice>
      ) : null}
      {query.restored === '1' ? (
        <Notice tone="good">
          <span data-testid="restore-done">
            Restored. The {query.field ? label(query.field).toLowerCase() : 'field'} is back to that
            version, and the restore is logged below as its own change.
          </span>
        </Notice>
      ) : null}
      {query.restored === 'same' ? (
        <Notice tone="accent">
          <span data-testid="restore-noop">
            Nothing to do — that is already the current version.
          </span>
        </Notice>
      ) : null}

      {revisions.length === 0 ? (
        <Empty>Nothing has been edited since this was filed.</Empty>
      ) : null}

      {/*
        Newest first, and each entry is a *version*: its "Now" panel is what the
        field held after that edit. That is what "Restore this version" puts
        back, so undoing the most recent edit is the second card down, and
        everything logged before it survives.
      */}
      <ol className="space-y-3" data-testid="revision-history">
        {revisions.map((revision) => {
          const restorable = isRestorableField(revision.field);
          return (
            <li key={revision.id}>
              <Card className="space-y-3" data-testid={`revision-${revision.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone="accent">{label(revision.field)}</Badge>
                  <span>{revision.editorName ?? revision.editorEmail}</span>
                  <span className="ml-auto tabular-nums">
                    {inEventZone(revision.createdAt, event.timezone, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                      Was
                    </p>
                    <p className="whitespace-pre-wrap rounded-md border border-line bg-slate-50 px-3 py-2 text-sm text-muted">
                      {readable(revision.field, revision.oldValue)}
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                      Now
                    </p>
                    <p className="whitespace-pre-wrap rounded-md border border-line bg-white px-3 py-2 text-sm text-ink">
                      {readable(revision.field, revision.newValue)}
                    </p>
                  </div>
                </div>

                {restorable ? (
                  <form action={restoreRevisionAction} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="submissionId" value={submission.id} />
                    <input type="hidden" name="revisionId" value={revision.id} />
                    <Button
                      type="submit"
                      variant="secondary"
                      className="px-3 py-1.5 text-xs"
                      data-testid={`restore-revision-${revision.id}`}
                    >
                      Restore this version
                    </Button>
                    <span className="text-xs text-muted">
                      Writes the “Now” text above back onto the {label(revision.field).toLowerCase()}
                      , logged as a new change.
                    </span>
                  </form>
                ) : (
                  /*
                    No button, and the reason in plain words. The allowlist that
                    actually stops this lives in `restoreRevision`; this line is
                    so an organizer is not left hunting for a control that was
                    withheld on purpose.
                  */
                  <p className="text-xs text-muted" data-testid={`no-restore-${revision.id}`}>
                    {unrestorableReason(revision.field)}
                  </p>
                )}
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
