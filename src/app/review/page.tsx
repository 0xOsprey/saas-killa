import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { reviews } from '@/db/schema';
import { Badge, Button, Card, Empty, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';
import { reviewQueue } from '@/lib/queries';
import { submitReview } from './actions';

export default async function ReviewPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.roles.includes('reviewer') && !user.roles.includes('organizer')) {
    return (
      <Notice tone="bad">
        This page is for programme-committee reviewers. Ask an organizer to add you.
      </Notice>
    );
  }

  const queue = await reviewQueue(user.id);

  // The AI evaluator's notes, fetched separately and shown behind a disclosure.
  // Keeping them out of the main payload means the human reads the abstract
  // before an advisory score has a chance to anchor them.
  const aiNotes = await db
    .select({
      submissionId: reviews.submissionId,
      score: reviews.score,
      comment: reviews.comment,
      rubric: reviews.rubric,
    })
    .from(reviews)
    .where(eq(reviews.source, 'ai'));
  const aiBySubmission = new Map(aiNotes.map((n) => [n.submissionId, n]));

  const graded = queue.filter((row) => row.myScore !== null).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Review queue"
        description={`${graded} of ${queue.length} graded. Least-reviewed proposals come first.`}
      />

      <Notice tone="accent">
        Reviews are blind: speaker names and bios are not loaded on this page. Grade the proposal,
        not the person.
      </Notice>

      {queue.length === 0 ? <Empty>Nothing awaiting review.</Empty> : null}

      {queue.map((row) => {
        const ai = aiBySubmission.get(row.id);
        return (
          <Card key={row.id} className="space-y-3" data-testid={`review-card-${row.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="font-medium text-ink">{row.title}</h2>
              <div className="flex items-center gap-2">
                {row.myScore !== null ? (
                  <Badge tone="good" data-testid={`my-score-${row.id}`}>
                    you scored {row.myScore}
                  </Badge>
                ) : (
                  <Badge>ungraded</Badge>
                )}
                <Badge>{row.reviewCount} review(s)</Badge>
              </div>
            </div>

            <p className="text-xs text-muted">
              {FORMAT_LABELS[row.format]} · {LEVEL_LABELS[row.audienceLevel]}
              {row.trackName ? ` · ${row.trackName}` : ''}
            </p>

            <p className="whitespace-pre-wrap text-sm text-ink">{row.abstract}</p>

            {ai ? (
              <details className="rounded-md border border-line bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-medium text-muted">
                  AI evaluator note (advisory, scored {ai.score}/5)
                </summary>
                <p className="mt-2 text-sm text-ink">{ai.comment}</p>
                {ai.rubric ? (
                  <ul className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
                    {Object.entries(ai.rubric).map(([key, value]) => (
                      <li key={key}>
                        {key}: <span className="tabular-nums text-ink">{value}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ) : null}

            <form action={submitReview} className="space-y-3 border-t border-line pt-3">
              <input type="hidden" name="submissionId" value={row.id} />
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink">Score</span>
                  <Select
                    name="score"
                    defaultValue={row.myScore?.toString() ?? '3'}
                    className="w-28"
                    data-testid={`score-${row.id}`}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button type="submit" data-testid={`grade-${row.id}`}>
                  {row.myScore === null ? 'Grade' : 'Update grade'}
                </Button>
              </div>
              <Textarea
                name="comment"
                className="min-h-20"
                placeholder="Notes for the rest of the committee (optional)"
              />
            </form>
          </Card>
        );
      })}
    </div>
  );
}
