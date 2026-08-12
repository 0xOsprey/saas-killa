import { and, eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { reviews } from '@/db/schema';
import type { RoundCriterion } from '@/db/schema';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { AuthorList } from '@/components/AuthorList';
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
import { activeCriteria, activeRound, conflictedSubmissionIds, criteriaByRound } from '@/lib/rounds';
import { declareConflictOfInterest, submitReview, withdrawConflictOfInterest } from './actions';
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
 *
 * The fallback is the scale's own midpoint rather than a hardcoded 3, because a
 * round scored out of 10 has no reason to default to the bottom third.
 */
function defaultFor(row: ReviewerQueueRow, criterion: RoundCriterion): number {
  const stored = row.myRubric?.[criterion.key];
  if (typeof stored === 'number') return stored;
  if (row.myScore !== null && criterion.scaleMin === 1 && criterion.scaleMax === 5) {
    return row.myScore;
  }
  return Math.round((criterion.scaleMin + criterion.scaleMax) / 2);
}

/** A scale short enough to pick from a list; anything wider gets a number box. */
const MAX_SCALE_OPTIONS = 20;

function scaleValues(criterion: RoundCriterion): number[] {
  const values: number[] = [];
  for (let value = criterion.scaleMin; value <= criterion.scaleMax; value += 1) {
    values.push(value);
  }
  return values;
}

/**
 * Why a grade was not recorded. `submitReview` refuses on five conditions and
 * used to do it with a bare `return`, so the page came back unchanged and the
 * reviewer's criteria and comment were gone with no explanation.
 */
const GRADE_REFUSALS: Record<string, string> = {
  withdrawn: 'The speaker withdrew that proposal, so the grade was not recorded. There is nothing left to decide about it.',
  decided: 'This proposal has already been decided, so the grade was not recorded. Only proposals still under review can be graded.',
  own: 'You cannot grade your own proposal, so nothing was recorded.',
  no_round: 'No review round is open, so there was nowhere to file that grade. An organizer opens one from the review rounds screen.',
  recused: 'You have declared a conflict of interest on that proposal, so no grade was recorded. Withdraw the declaration first if you meant to review it.',
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
        No review round is open. An organizer opens one from the review rounds screen, and grading
        resumes here the moment they do.
      </Notice>
    );
  }

  const assignments = await assignmentCount(user.id, round.id);

  // No assignments means the committee has not run the distributor yet. Falling
  // back to every open submission is what this page did before assignments
  // existed, and it is better than an empty screen that looks broken.
  const usingFallback = assignments === 0;
  const [everything, completed, criteria, conflicted, roundCriteria] = await Promise.all([
    usingFallback
      ? openSubmissionQueue(user.id, round.id)
      : assignedQueue(user.id, round.id),
    myCompletedReviews(user.id),
    activeCriteria(round.id),
    conflictedSubmissionIds(user.id, round.id),
    criteriaByRound(),
  ]);

  // A recusal takes a proposal out of the actionable queue without taking it off
  // the screen. Hiding it entirely would leave a reviewer unable to see, let
  // alone undo, a declaration they may have made by mistake.
  const queue = everything.filter((row) => !conflicted.has(row.id));
  const recused = everything.filter((row) => conflicted.has(row.id));

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
  const answers = await answersByQuestion(everything.map((row) => row.id));

  const graded = queue.filter((row) => row.myScore !== null).length;
  const now = Date.now();
  const overdue = queue.filter(
    (row) => row.myScore === null && row.dueAt !== null && row.dueAt.getTime() < now,
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Review queue · ${round.name}`}
        description={`${graded} of ${queue.length} graded${overdue > 0 ? ` · ${overdue} past due` : ''}${
          recused.length > 0 ? ` · ${recused.length} recused` : ''
        }.`}
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
      {params.declared ? (
        <Notice tone="good">
          <span data-testid="conflict-declared">
            Conflict declared. That proposal has left your queue and no grade of yours will be
            accepted on it until you withdraw the declaration.
          </span>
        </Notice>
      ) : null}
      {params.withdrawn ? (
        <Notice tone="good">Declaration withdrawn. The proposal is back in your queue.</Notice>
      ) : null}

      {round.blind ? (
        <Notice tone="accent">
          Reviews in this round are blind: speaker names and bios are not loaded on this page. Grade
          the proposal, not the person.
        </Notice>
      ) : (
        <Notice tone="warn">
          This round is not blind. The organizers have chosen to show you who wrote each proposal.
        </Notice>
      )}

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
                    {/* Said before the reviewer types, not after they submit. A
                        grade on a decided proposal is accepted and it does not
                        move the decision, which is a thing worth knowing while
                        you are deciding how much effort to put in. */}
                    {row.status === 'submitted' ? null : (
                      <Badge tone={STATUS_TONE[row.status]} data-testid={`queue-status-${row.id}`}>
                        already {STATUS_LABELS[row.status]}
                      </Badge>
                    )}
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
                      <Link href={`#grade-${row.id}`} className="inline-flex" data-testid={`ungraded-${row.id}`}>
                        <Badge>ungraded</Badge>
                      </Link>
                    )}
                    <Badge>{row.reviewCount} review(s)</Badge>
                  </div>
                </div>

                <p className="text-xs text-muted">
                  {FORMAT_LABELS[row.format]} · {LEVEL_LABELS[row.audienceLevel]}
                  {row.trackName ? ` · ${row.trackName}` : ''}
                </p>

                {/* Only reached when the round is not blind, and it is a second
                    query rather than a wider queue: `assignedQueue` selects no
                    speaker column, and that is what makes a blind round blind. */}
                {round.blind ? null : <AuthorList submissionId={row.id} />}

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

                <form
                  id={`grade-${row.id}`}
                  action={submitReview}
                  className="space-y-3 border-t border-line pt-3"
                >
                  <input type="hidden" name="submissionId" value={row.id} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    {criteria.map((criterion) => (
                      <CriterionField key={criterion.id} row={row} criterion={criterion} />
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

                {/* A sibling of the grade form, never inside it: a form within a
                    form is dropped by the browser, and this one has to be able
                    to post on its own. */}
                <details className="border-t border-line pt-3">
                  <summary
                    className="cursor-pointer text-xs font-medium text-muted"
                    data-testid={`conflict-toggle-${row.id}`}
                  >
                    I have a conflict of interest
                  </summary>
                  <form action={declareConflictOfInterest} className="mt-2 space-y-2">
                    <input type="hidden" name="submissionId" value={row.id} />
                    <p className="text-xs text-muted">
                      Declaring takes this proposal out of your queue and stops any grade of yours
                      being accepted on it. The organizers see the declaration. You can withdraw it.
                    </p>
                    <Input
                      name="reason"
                      maxLength={500}
                      placeholder="Same employer, co-author, or however you would put it (optional)"
                      data-testid={`conflict-reason-${row.id}`}
                    />
                    <Button
                      type="submit"
                      variant="danger"
                      className="text-xs"
                      data-testid={`declare-conflict-${row.id}`}
                    >
                      Declare conflict and recuse myself
                    </Button>
                  </form>
                </details>
              </Card>
            );
          })}

          {recused.length > 0 ? (
            <Card className="space-y-3" data-testid="recused-list">
              <div>
                <h2 className="text-sm font-semibold text-ink">Recused</h2>
                <p className="mt-0.5 text-xs text-muted">
                  You declared a conflict on these, so they are not yours to grade. They stay here
                  rather than disappearing, because a declaration you cannot see is one you cannot
                  take back.
                </p>
              </div>
              {recused.map((row) => (
                <form
                  key={row.id}
                  action={withdrawConflictOfInterest}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2"
                  data-testid={`recused-${row.id}`}
                >
                  <input type="hidden" name="submissionId" value={row.id} />
                  <span className="text-sm text-ink">{row.title}</span>
                  <div className="flex items-center gap-2">
                    <Badge tone="warn">conflict declared</Badge>
                    <Button type="submit" variant="ghost" className="text-xs">
                      Withdraw declaration
                    </Button>
                  </div>
                </form>
              ))}
            </Card>
          ) : null}

        </>
      ) : (
        <>
          {completed.length === 0 ? <Empty>You have not graded anything yet.</Empty> : null}

          {completed.map((row) => {
            // Labels come from the round the grade was filed in, not from the
            // round that happens to be open: the same key can be "Relevance" in
            // one pass and have been renamed by the next.
            const labels = new Map(
              (roundCriteria.get(row.roundId) ?? []).map((criterion) => [
                criterion.key,
                criterion.label,
              ]),
            );
            return (
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

                {row.rubric && Object.keys(row.rubric).length > 0 ? (
                  <ul className="flex flex-wrap gap-3 text-xs text-muted">
                    {Object.entries(row.rubric).map(([key, value]) => (
                      <li key={key}>
                        {labels.get(key) ?? key}:{' '}
                        <span className="tabular-nums text-ink">{value}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Grades filed before the rubric existed carry one integer and no
                  // breakdown. They are shown as they were stored rather than
                  // back-filled with a number nobody actually chose.
                  <p className="text-xs text-muted">Graded before per-criterion scoring.</p>
                )}

                {row.answers && Object.keys(row.answers).length > 0 ? (
                  <ul className="space-y-1 text-xs text-muted">
                    {Object.entries(row.answers).map(([key, value]) => (
                      <li key={key}>
                        {labels.get(key) ?? key}: <span className="text-ink">{value}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {row.comment ? (
                  <p className="whitespace-pre-wrap text-sm text-ink">{row.comment}</p>
                ) : null}
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * One field of the round's scorecard, rendered as whatever its kind says.
 *
 * The input name carries the criterion key rather than its position, so a round
 * with a criterion added or archived between the page rendering and the form
 * posting files what it can rather than shifting every answer by one.
 */
function CriterionField({
  row,
  criterion,
}: {
  row: ReviewerQueueRow;
  criterion: RoundCriterion;
}) {
  const name = `criterion-${criterion.key}`;
  const testId = `score-${criterion.key}-${row.id}`;
  const stored = row.myAnswers?.[criterion.key] ?? '';

  if (criterion.kind === 'text') {
    return (
      <label className="block sm:col-span-2" title={criterion.helpText ?? undefined}>
        <span className="mb-1 block text-xs font-medium text-ink">{criterion.label}</span>
        <Textarea name={name} className="min-h-16" defaultValue={stored} data-testid={testId} />
        {criterion.helpText ? (
          <span className="mt-1 block text-xs text-muted">{criterion.helpText}</span>
        ) : null}
      </label>
    );
  }

  if (criterion.kind === 'select') {
    return (
      <label className="block" title={criterion.helpText ?? undefined}>
        <span className="mb-1 block text-xs font-medium text-ink">{criterion.label}</span>
        <Select name={name} defaultValue={stored} data-testid={testId}>
          <option value="">No answer</option>
          {criterion.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        {criterion.helpText ? (
          <span className="mt-1 block text-xs text-muted">{criterion.helpText}</span>
        ) : null}
      </label>
    );
  }

  const values = scaleValues(criterion);
  return (
    <label className="block" title={criterion.helpText ?? undefined}>
      <span className="mb-1 block text-xs font-medium text-ink">
        {criterion.label}{' '}
        <span className="font-normal text-muted">
          ({criterion.scaleMin}-{criterion.scaleMax}
          {criterion.weight === 1 ? '' : `, weight ${criterion.weight}`})
        </span>
      </span>
      {values.length <= MAX_SCALE_OPTIONS ? (
        <Select name={name} defaultValue={defaultFor(row, criterion).toString()} data-testid={testId}>
          {values.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          type="number"
          name={name}
          min={criterion.scaleMin}
          max={criterion.scaleMax}
          defaultValue={defaultFor(row, criterion)}
          data-testid={testId}
        />
      )}
      {criterion.helpText ? (
        <span className="mt-1 block text-xs text-muted">{criterion.helpText}</span>
      ) : null}
    </label>
  );
}
