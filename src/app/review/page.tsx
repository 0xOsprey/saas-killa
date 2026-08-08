import { and, eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { reviews } from '@/db/schema';
import { Badge, Button, Card, Empty, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, LEVEL_LABELS, STATUS_LABELS, dayLabel } from '@/lib/format';
import {
  assignedQueue,
  assignmentCount,
  myCompletedReviews,
  openSubmissionQueue,
  type ReviewerQueueRow,
} from '@/lib/grading';
import { getEvent } from '@/lib/queries';
import { activeRound } from '@/lib/rounds';
import { RUBRIC, RUBRIC_KEYS, RUBRIC_LABELS } from '@/lib/rubric';
import { submitReview } from './actions';
import { AnswerList } from '@/components/AnswerList';
import { answersByQuestion } from '@/lib/question-queries';

const STATUS_TONE = {
  submitted: 'neutral',
  accepted: 'good',
  rejected: 'bad',
  withdrawn: 'neutral',
} as const;

/**
 * The criterion defaults matter more than they look. A reviewer who graded 5
 * before the rubric existed has a score and no breakdown; seeding every
 * criterion from that score means an accidental resubmit re-derives the same 5
 * rather than silently dropping them to a default 3.
 */
function defaultFor(row: ReviewerQueueRow, key: string): number {
  return row.myRubric?.[key] ?? row.myScore ?? 3;
}

/**
 * Why a grade was not recorded. `submitReview` refuses on three conditions and
 * used to do it with a bare `return`, so the page came back unchanged and the
 * reviewer's four criteria and comment were gone with no explanation.
 */
const GRADE_REFUSALS: Record<string, string> = {
  decided: 'That proposal has already been decided, so the grade was not recorded. A decided proposal is out of the committee’s hands.',
  own: 'You cannot grade your own proposal, so nothing was recorded.',
  no_round: 'No review round is open, so there was nowhere to file that grade. An organizer opens one from the call-for-papers screen.',
};

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.roles.includes('reviewer') && !user.roles.includes('organizer')) {
    return (
      <Notice tone="bad">
        This page is for programme-committee reviewers. Ask an organizer to add you.
      </Notice>
    );
  }

  const params = await searchParams;
  const tab = params.tab === 'done' ? 'done' : 'queue';
  const refusal = typeof params.grade === 'string' ? GRADE_REFUSALS[params.grade] : undefined;

  const [event, round] = await Promise.all([getEvent(), activeRound()]);

  // Grading happens in a round. With none open there is nothing to grade into,
  // and a queue that accepted scores would be filing them nowhere.
  if (!round) {
    return (
      <Notice tone="warn">
        No review round is open. An organizer opens one from the call-for-papers
        screen, and grading resumes here the moment they do.
      </Notice>
    );
  }

  const assignments = await assignmentCount(user.id, round.id);

  // No assignments means the committee has not run the distributor yet. Falling
  // back to every open submission is what this page did before assignments
  // existed, and it is better than an empty screen that looks broken.
  const usingFallback = assignments === 0;
  const queue = usingFallback
    ? await openSubmissionQueue(user.id, round.id)
    : await assignedQueue(user.id, round.id);

  const completed = await myCompletedReviews(user.id);

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
    .where(and(eq(reviews.source, 'ai'), eq(reviews.roundId, round.id)));
  const aiBySubmission = new Map(aiNotes.map((n) => [n.submissionId, n]));

  // The organizer-configured answers, in one query for the whole queue. Nothing
  // in it joins `users`, so it does not open a hole in the blind read.
  const answers = await answersByQuestion(queue.map((row) => row.id));

  const graded = queue.filter((row) => row.myScore !== null).length;
  const now = Date.now();
  const overdue = queue.filter(
    (row) => row.myScore === null && row.dueAt !== null && row.dueAt.getTime() < now,
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Review queue · ${round.name}`}
        description={`${graded} of ${queue.length} graded${overdue > 0 ? ` · ${overdue} past due` : ''}.`}
      />

      <nav className="flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1 text-sm">
        <Link
          href="/review"
          className={
            tab === 'queue'
              ? 'rounded-md bg-accent-soft px-3 py-1.5 font-medium text-accent'
              : 'rounded-md px-3 py-1.5 text-muted hover:bg-slate-100 hover:text-ink'
          }
          data-testid="tab-queue"
        >
          To grade ({queue.length})
        </Link>
        <Link
          href="/review?tab=done"
          className={
            tab === 'done'
              ? 'rounded-md bg-accent-soft px-3 py-1.5 font-medium text-accent'
              : 'rounded-md px-3 py-1.5 text-muted hover:bg-slate-100 hover:text-ink'
          }
          data-testid="tab-done"
        >
          My reviews ({completed.length})
        </Link>
      </nav>

      {refusal ? (
        <Notice tone="bad">
          <span data-testid="grade-refusal">{refusal}</span>
        </Notice>
      ) : null}

      <Notice tone="accent">
        Reviews are blind: speaker names and bios are not loaded on this page. Grade the proposal,
        not the person.
      </Notice>

      {tab === 'queue' ? (
        <>
          {usingFallback ? (
            <Notice>
              You have no assignments yet, so this is every proposal still open for grading.
            </Notice>
          ) : null}

          {queue.length === 0 ? <Empty>Nothing awaiting review.</Empty> : null}

          {queue.map((row) => {
            const ai = aiBySubmission.get(row.id);
            const isOverdue =
              row.myScore === null && row.dueAt !== null && row.dueAt.getTime() < now;
            return (
              <Card key={row.id} className="space-y-3" data-testid={`review-card-${row.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="font-medium text-ink">{row.title}</h2>
                  <div className="flex items-center gap-2">
                    {row.dueAt ? (
                      <Badge
                        tone={isOverdue ? 'bad' : 'warn'}
                        data-testid={`due-${row.id}`}
                        title={row.dueAt.toISOString()}
                      >
                        {isOverdue ? 'overdue ' : 'due '}
                        {dayLabel(row.dueAt, event.timezone)}
                      </Badge>
                    ) : null}
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

                <AnswerList answers={answers.get(row.id) ?? []} />

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
                  <div className="grid gap-3 sm:grid-cols-4">
                    {RUBRIC_KEYS.map((key) => (
                      <label key={key} className="block" title={RUBRIC[key]}>
                        <span className="mb-1 block text-xs font-medium text-ink">
                          {RUBRIC_LABELS[key]}
                        </span>
                        <Select
                          name={`rubric-${key}`}
                          defaultValue={defaultFor(row, key).toString()}
                          data-testid={`score-${key}-${row.id}`}
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </Select>
                      </label>
                    ))}
                  </div>
                  <Textarea
                    name="comment"
                    className="min-h-20"
                    defaultValue={row.myComment ?? ''}
                    placeholder="Notes for the rest of the committee (optional)"
                  />
                  <Button type="submit" data-testid={`grade-${row.id}`}>
                    {row.myScore === null ? 'Grade' : 'Update grade'}
                  </Button>
                </form>
              </Card>
            );
          })}
        </>
      ) : (
        <>
          {completed.length === 0 ? <Empty>You have not graded anything yet.</Empty> : null}

          {completed.map((row) => (
            <Card
              key={`${row.roundId}-${row.submissionId}`}
              className="space-y-2"
              data-testid={`completed-${row.submissionId}`}
              data-round={row.roundId}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="font-medium text-ink">{row.title}</h2>
                <div className="flex items-center gap-2">
                  {/* This list spans rounds, so which one a grade belongs to is part
                      of what it says. The same proposal read twice is two rows. */}
                  <Badge data-testid={`round-badge-${row.roundId}-${row.submissionId}`}>
                    {row.roundName}
                  </Badge>
                  <Badge tone="good">you scored {row.score}</Badge>
                  <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                </div>
              </div>

              <p className="text-xs text-muted">
                {FORMAT_LABELS[row.format]} · {LEVEL_LABELS[row.audienceLevel]}
                {row.trackName ? ` · ${row.trackName}` : ''} · graded{' '}
                {dayLabel(row.gradedAt, event.timezone)}
              </p>

              {row.rubric ? (
                <ul className="flex flex-wrap gap-3 text-xs text-muted">
                  {RUBRIC_KEYS.filter((key) => typeof row.rubric?.[key] === 'number').map((key) => (
                    <li key={key}>
                      {RUBRIC_LABELS[key]}:{' '}
                      <span className="tabular-nums text-ink">{row.rubric?.[key]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                // Grades filed before the rubric existed carry one integer and no
                // breakdown. They are shown as they were stored rather than
                // back-filled with a number nobody actually chose.
                <p className="text-xs text-muted">Graded before per-criterion scoring.</p>
              )}

              {row.comment ? (
                <p className="whitespace-pre-wrap text-sm text-ink">{row.comment}</p>
              ) : null}
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
