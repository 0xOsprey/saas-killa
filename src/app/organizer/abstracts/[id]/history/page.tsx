import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Badge, Card, Empty, LinkButton, PageHeader } from '@/components/ui';
import type { AudienceLevel, SubmissionFormat } from '@/db/schema';
import { fieldLabel, revisionHistory, submissionForEdit } from '@/lib/abstracts';
import { FORMAT_LABELS, LEVEL_LABELS, inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';

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

export default async function AbstractHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const submission = await submissionForEdit(parsed.data);
  if (!submission) notFound();

  const [event, revisions] = await Promise.all([getEvent(), revisionHistory(submission.id)]);

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

      {revisions.length === 0 ? (
        <Empty>Nothing has been edited since this was filed.</Empty>
      ) : null}

      <ol className="space-y-3">
        {revisions.map((revision) => (
          <li key={revision.id}>
            <Card className="space-y-3" data-testid={`revision-${revision.id}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone="accent">{fieldLabel(revision.field)}</Badge>
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
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
