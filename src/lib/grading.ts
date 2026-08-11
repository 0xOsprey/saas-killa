import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  emailLog,
  reviewAssignments,
  reviewConflicts,
  reviewRounds,
  reviews,
  roundReviewers,
  submissions,
  tracks,
  userRoles,
  users,
} from '@/db/schema';
import type { AudienceLevel, SubmissionFormat, SubmissionStatus } from '@/db/schema';

/**
 * Queries behind the call for papers and its grading. They live here rather
 * than in `queries.ts` so the blind-review rule has one place to be checked:
 * every reviewer-facing select below joins `review_assignments` to
 * `submissions` and stops there. None of them reaches `users` through
 * `submissions.speakerId`.
 *
 * Almost every function here takes a `roundId`. That is not a convenience
 * parameter: coverage, completion and "what do I still owe" are all questions
 * about one pass of review, and answering them across every round at once would
 * report a reviewer who finished round one as still owing work in round two.
 * The one exception is `myCompletedReviews`, which is a reviewer's own history
 * and spans rounds on purpose.
 */

/** How long a reviewer is left alone after a reminder. */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const REVIEWER_REMINDER_KIND = 'reviewer_reminder';

export type ReviewerCompletionRow = {
  reviewerId: string;
  name: string | null;
  email: string;
  assigned: number;
  graded: number;
  outstanding: number;
  decided: number;
  recused: number;
  overdue: number;
  completionPct: number | null;
};

/**
 * Per-reviewer completion, aggregated in Postgres. Doing it here rather than by
 * pulling every assignment into the page keeps the cost flat as the committee
 * grows, and the `filter (where ...)` clauses are the only place the five
 * different meanings of "not done" are spelled out:
 *
 *   assigned    every row the reviewer owns, ever, decided or not
 *   outstanding ungraded, still open, not recused, so still real work
 *   decided     outstanding, and a chair has already ruled on it
 *   recused     ungraded because this reviewer declared a conflict on it
 *   overdue     outstanding and past its dueAt
 *
 * `assigned` deliberately keeps rows whose submission was later accepted or
 * rejected: the reviewer was asked and never answered, and hiding that would
 * flatter the completion rate. It drops withdrawn ones, which is the opposite
 * case — nobody is owed a read on work its author took back.
 *
 * `decided` is no longer an excuse column. It used to name the rows that had
 * been ruled on before their reviewer got to them, which `submitReview` then
 * refused to accept a grade for; those are gradable now, so the count is a
 * subset of `outstanding` rather than a deduction from it. What it tells a chair
 * is which of the chasing is worth doing first.
 *
 * `completionPct` is over work that could actually be done, not over `assigned`,
 * which is now the same set minus recusals.
 */
export async function reviewerCompletion(roundId: string): Promise<ReviewerCompletionRow[]> {
  // A withdrawn proposal is not work anybody owes, so it is out of `assigned`
  // and therefore out of every column derived from it. The reviewer's own queue
  // stopped listing withdrawn rows at the same time; the two screens report the
  // same set or the chair is chasing work that no longer exists.
  const live = sql`${reviewAssignments.submissionId} is not null and ${submissions.status} <> 'withdrawn'`;
  const ungraded = sql`${live} and ${reviews.id} is null`;
  const recused = sql`${reviewConflicts.reviewerId} is not null`;
  // No status test any more. `submitReview` accepts a grade on a decided
  // proposal, so a decided assignment is work the reviewer can still do and
  // leaving it out of `outstanding` would have reported it as finished.
  const actionable = sql`${ungraded} and not ${recused}`;

  return db
    .select({
      reviewerId: users.id,
      name: users.name,
      email: users.email,
      assigned: sql<number>`count(*) filter (where ${live})::int`,
      graded: sql<number>`count(${reviews.id})::int`,
      outstanding: sql<number>`count(*) filter (where ${actionable})::int`,
      decided: sql<number>`count(*) filter (
        where ${ungraded} and ${submissions.status} in ('accepted', 'rejected')
      )::int`,
      recused: sql<number>`count(*) filter (
        where ${ungraded} and ${submissions.status} = 'submitted' and ${recused}
      )::int`,
      overdue: sql<number>`count(*) filter (
        where ${actionable}
          and ${reviewAssignments.dueAt} is not null
          and ${reviewAssignments.dueAt} < now()
      )::int`,
      completionPct: sql<number | null>`case
        when count(${reviews.id}) + count(*) filter (where ${actionable}) = 0 then null
        else round(
          100.0 * count(${reviews.id})
          / (count(${reviews.id}) + count(*) filter (where ${actionable}))
        )::int
      end`,
    })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, 'reviewer')))
    .leftJoin(
      reviewAssignments,
      and(eq(reviewAssignments.reviewerId, users.id), eq(reviewAssignments.roundId, roundId)),
    )
    .leftJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .leftJoin(
      reviews,
      and(
        eq(reviews.submissionId, reviewAssignments.submissionId),
        eq(reviews.reviewerId, users.id),
        eq(reviews.roundId, roundId),
      ),
    )
    .leftJoin(
      reviewConflicts,
      and(
        eq(reviewConflicts.submissionId, reviewAssignments.submissionId),
        eq(reviewConflicts.reviewerId, users.id),
        eq(reviewConflicts.roundId, roundId),
      ),
    )
    .where(eq(users.isBot, false))
    .groupBy(users.id, users.name, users.email)
    .orderBy(asc(users.name), asc(users.email));
}

export type ReviewerQueueRow = {
  id: string;
  title: string;
  abstract: string;
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  trackName: string | null;
  status: SubmissionStatus;
  reviewCount: number;
  myScore: number | null;
  myRubric: Record<string, number> | null;
  myAnswers: Record<string, string> | null;
  myComment: string | null;
  dueAt: Date | null;
};

/**
 * `max(...) filter (where reviewer = me)` reads this reviewer's own grade out of
 * the same aggregate that counts everyone's, so the page needs one query rather
 * than one plus a lookup. `array_agg(...)[1]` is the same trick for the two
 * columns no aggregate exists for; the unique index on (round, submission,
 * reviewer) guarantees there is at most one element to take, which is why the
 * joins that use this must already be narrowed to one round.
 */
const MY_GRADE = (reviewerId: string) => ({
  reviewCount: sql<number>`count(${reviews.id})::int`,
  myScore: sql<
    number | null
  >`max(${reviews.score}) filter (where ${reviews.reviewerId} = ${reviewerId})::int`,
  myRubric: sql<
    Record<string, number> | null
  >`(array_agg(${reviews.rubric}) filter (where ${reviews.reviewerId} = ${reviewerId}))[1]`,
  myAnswers: sql<
    Record<string, string> | null
  >`(array_agg(${reviews.answers}) filter (where ${reviews.reviewerId} = ${reviewerId}))[1]`,
  myComment: sql<
    string | null
  >`(array_agg(${reviews.comment}) filter (where ${reviews.reviewerId} = ${reviewerId}))[1]`,
});

/**
 * This reviewer's queue: every `review_assignments` row they hold in the round,
 * minus the ones the speaker has withdrawn.
 *
 * It used to stop at `status = 'submitted'`, and a second query listed the
 * decided ones underneath as titles with no body. That split existed because
 * `submitReview` refused a decided proposal, so a card down there would have
 * carried a form that could not fire. `submitReview` now refuses only a
 * withdrawn one, which collapses the two lists back into the one thing a
 * reviewer was ever asked for: here is what the committee gave you, here is
 * where each one stands, grade what you can still say something about.
 *
 * `status` rides along so the card can say so. A reviewer typing a 4 into a
 * proposal that was accepted last week should be able to see that before they
 * type it, not discover it from the chair afterwards.
 */
export async function assignedQueue(
  reviewerId: string,
  roundId: string,
): Promise<ReviewerQueueRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      status: submissions.status,
      dueAt: reviewAssignments.dueAt,
      ...MY_GRADE(reviewerId),
    })
    .from(reviewAssignments)
    .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(
      reviews,
      and(eq(reviews.submissionId, submissions.id), eq(reviews.roundId, roundId)),
    )
    .where(
      and(
        eq(reviewAssignments.reviewerId, reviewerId),
        eq(reviewAssignments.roundId, roundId),
        ne(submissions.status, 'withdrawn'),
      ),
    )
    .groupBy(submissions.id, tracks.name, reviewAssignments.dueAt)
    .orderBy(
      // Still-open work first. A decided proposal is readable and gradable, but
      // it is not what a reviewer opening this page at 11pm needs to see first.
      sql`(${submissions.status} <> 'submitted') asc`,
      sql`${reviewAssignments.dueAt} asc nulls last`,
      sql`count(${reviews.id}) asc`,
      asc(submissions.createdAt),
    );
}

/**
 * The unassigned fallback: every open submission, which is how the queue
 * behaved before assignments existed. The seed ships no assignments, so a
 * committee that has not run the distributor still has a usable page.
 *
 * "Every open submission" stops short of the reviewer's own. `planAssignments`
 * has always excluded a reviewer from their own proposal; this path did not, so
 * a committee that had not run the distributor handed every reviewer who also
 * submitted a card for their own abstract with a live Grade button on it. The
 * exclusion is in the WHERE clause rather than a filter afterwards, so the
 * `count(reviews.id)` ordering is computed over the rows actually offered.
 *
 * The predicate is `ne` and not `isDistinctFrom`, which is safe here because
 * `submissions.speaker_id` is NOT NULL: there is no row this can silently drop.
 */
export async function openSubmissionQueue(
  reviewerId: string,
  roundId: string,
): Promise<ReviewerQueueRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      status: submissions.status,
      dueAt: sql<Date | null>`null::timestamptz`,
      ...MY_GRADE(reviewerId),
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(
      reviews,
      and(eq(reviews.submissionId, submissions.id), eq(reviews.roundId, roundId)),
    )
    .where(and(eq(submissions.status, 'submitted'), ne(submissions.speakerId, reviewerId)))
    .groupBy(submissions.id, tracks.name)
    .orderBy(sql`count(${reviews.id}) asc`, asc(submissions.createdAt));
}

export async function assignmentCount(reviewerId: string, roundId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reviewAssignments)
    .where(
      and(eq(reviewAssignments.reviewerId, reviewerId), eq(reviewAssignments.roundId, roundId)),
    );
  return row?.total ?? 0;
}

export type CompletedReviewRow = {
  submissionId: string;
  title: string;
  status: SubmissionStatus;
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  trackName: string | null;
  score: number;
  rubric: Record<string, number> | null;
  answers: Record<string, string> | null;
  comment: string | null;
  gradedAt: Date;
  roundId: string;
  roundName: string;
};

/**
 * Everything this reviewer has graded, at any status and in any round. The queue
 * can only show open submissions in the open round, so without this a reviewer
 * loses sight of their own work the moment an organizer decides or a round
 * closes. The round name rides along because the same title can appear twice,
 * once per pass, and two rows with one score each is only readable if each says
 * which pass it was. Still no speaker column: a reviewer's own history is not a
 * hole in blind review.
 */
export async function myCompletedReviews(reviewerId: string): Promise<CompletedReviewRow[]> {
  return db
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      score: reviews.score,
      rubric: reviews.rubric,
      answers: reviews.answers,
      comment: reviews.comment,
      gradedAt: reviews.createdAt,
      roundId: reviewRounds.id,
      roundName: reviewRounds.name,
    })
    .from(reviews)
    .innerJoin(submissions, eq(submissions.id, reviews.submissionId))
    .innerJoin(reviewRounds, eq(reviewRounds.id, reviews.roundId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(eq(reviews.reviewerId, reviewerId))
    .orderBy(sql`${reviews.createdAt} desc`);
}

export type CoverageRow = {
  submissionId: string;
  title: string;
  trackName: string | null;
  status: SubmissionStatus;
  assigned: number;
  reviewCount: number;
};

/**
 * Assignment coverage per submission, thinnest first — the gaps read top-down.
 *
 * Every submission the speaker actually filed, not only the ones still open.
 * Scoping this to `status = 'submitted'` meant a chair who worked ahead erased
 * their own record: the moment a proposal was accepted it left this board, and
 * with it went every trace of who had been asked to read it and who had. On the
 * live instance nineteen decided proposals carrying assignments were invisible
 * here, including both of the ones a reviewer was still being chased about.
 *
 * Open ones stay on top, because the thing this screen is for is finding the
 * gaps in work that can still be done. A decided row is history, and it sorts
 * like history.
 */
export async function submissionCoverage(roundId: string): Promise<CoverageRow[]> {
  return db
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      trackName: tracks.name,
      status: submissions.status,
      assigned: sql<number>`count(distinct ${reviewAssignments.reviewerId})::int`,
      reviewCount: sql<number>`count(distinct ${reviews.id})::int`,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(
      reviewAssignments,
      and(
        eq(reviewAssignments.submissionId, submissions.id),
        eq(reviewAssignments.roundId, roundId),
      ),
    )
    .leftJoin(
      reviews,
      and(eq(reviews.submissionId, submissions.id), eq(reviews.roundId, roundId)),
    )
    .where(ne(submissions.status, 'withdrawn'))
    .groupBy(submissions.id, tracks.name)
    .orderBy(
      sql`(${submissions.status} <> 'submitted') asc`,
      sql`count(distinct ${reviewAssignments.reviewerId}) asc`,
      asc(submissions.title),
    );
}

export type AssignmentRow = {
  submissionId: string;
  reviewerId: string;
  reviewerName: string | null;
  reviewerEmail: string;
  dueAt: Date | null;
  graded: boolean;
};

/**
 * Every assignment the committee has made, with the reviewer's identity. This is
 * the organizer's screen, where knowing who is holding what is the entire
 * point; the join is to the reviewer, never to the speaker.
 *
 * Paired with `submissionCoverage` and widened for the same reason: an
 * assignment on a decided proposal is still a thing that happened, and a roster
 * that drops it answers "who reviewed this?" with silence. Only `withdrawn` is
 * out, because the speaker took that work back.
 */
export async function assignmentRoster(roundId: string): Promise<AssignmentRow[]> {
  return db
    .select({
      submissionId: reviewAssignments.submissionId,
      reviewerId: reviewAssignments.reviewerId,
      reviewerName: users.name,
      reviewerEmail: users.email,
      dueAt: reviewAssignments.dueAt,
      graded: sql<boolean>`${reviews.id} is not null`,
    })
    .from(reviewAssignments)
    .innerJoin(users, eq(users.id, reviewAssignments.reviewerId))
    .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .leftJoin(
      reviews,
      and(
        eq(reviews.submissionId, reviewAssignments.submissionId),
        eq(reviews.reviewerId, reviewAssignments.reviewerId),
        eq(reviews.roundId, roundId),
      ),
    )
    .where(and(eq(reviewAssignments.roundId, roundId), ne(submissions.status, 'withdrawn')))
    .orderBy(asc(users.name), asc(users.email));
}

export type ReminderTarget = {
  reviewerId: string;
  name: string | null;
  email: string;
  outstanding: number;
  overdue: number;
};

/** Reviewers who still owe a grade on an open submission, in this round. */
export async function reviewersWithOutstanding(roundId: string): Promise<ReminderTarget[]> {
  const rows = await reviewerCompletion(roundId);
  return rows
    .filter((row) => row.outstanding > 0)
    .map(({ reviewerId, name, email, outstanding, overdue }) => ({
      reviewerId,
      name,
      email,
      outstanding,
      overdue,
    }));
}

/**
 * Reviewers already reminded inside the cooldown. `email_log` is the record of
 * what actually left the building, so it is the right thing to dedupe on: a
 * flag on the reviewer would claim a send that may have thrown.
 */
export async function recentlyRemindedIds(now = new Date()): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ userId: emailLog.userId })
    .from(emailLog)
    .where(
      and(
        eq(emailLog.kind, REVIEWER_REMINDER_KIND),
        gt(emailLog.sentAt, new Date(now.getTime() - REMINDER_COOLDOWN_MS)),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}

export type PlannerSubmission = {
  id: string;
  trackId: string | null;
  speakerId: string;
  assigned: string[];
};

export type PlannerReviewer = {
  id: string;
  /** Assignments already held on open submissions — the live workload the cap governs. */
  load: number;
  /** Assignments already held per track, the signal `matchTrack` sorts on. */
  trackLoad: Record<string, number>;
};

export type PlannedAssignment = { submissionId: string; reviewerId: string };

/**
 * Decide who reviews what. Pure, so the rule is readable in one place and the
 * action below only has to execute it.
 *
 * Track matching has no reviewer-to-track table to read, and inventing one is a
 * schema change. What the schema does record is which tracks a reviewer is
 * already carrying, so "match on track" means "prefer the reviewer who already
 * holds work in this track" — expertise inferred from history rather than
 * declared. With no history it degrades to plain load balancing, which is the
 * unmatched behaviour, so a first run is never worse for turning it on.
 *
 * Every comparison falls through to reviewer id, so a second run over unchanged
 * data plans exactly the same set rather than reshuffling the committee.
 */
export function planAssignments(opts: {
  submissions: PlannerSubmission[];
  reviewers: PlannerReviewer[];
  reviewsPerSubmission: number;
  maxPerReviewer: number;
  matchTrack: boolean;
}): { planned: PlannedAssignment[]; short: number } {
  const { reviewers, reviewsPerSubmission, maxPerReviewer, matchTrack } = opts;

  const load = new Map<string, number>();
  const affinity = new Map<string, number>();
  for (const reviewer of reviewers) {
    load.set(reviewer.id, reviewer.load);
    for (const [trackId, count] of Object.entries(reviewer.trackLoad)) {
      affinity.set(`${reviewer.id}:${trackId}`, count);
    }
  }

  // Thinnest coverage first, so a scarce committee lands on the submissions
  // that have nobody rather than topping up the ones that already have two.
  const queue = [...opts.submissions].sort(
    (a, b) => a.assigned.length - b.assigned.length || (a.id < b.id ? -1 : 1),
  );

  const planned: PlannedAssignment[] = [];
  let short = 0;

  for (const submission of queue) {
    const taken = new Set(submission.assigned);
    let need = reviewsPerSubmission - taken.size;
    if (need <= 0) continue;

    const trackKey = submission.trackId;
    const candidates = reviewers
      .filter(
        (reviewer) =>
          !taken.has(reviewer.id) &&
          // A reviewer may not grade their own proposal, so assigning them one
          // would only manufacture an assignment that can never be completed.
          reviewer.id !== submission.speakerId &&
          (load.get(reviewer.id) ?? 0) < maxPerReviewer,
      )
      .sort((a, b) => {
        if (matchTrack && trackKey) {
          const byTrack =
            (affinity.get(`${b.id}:${trackKey}`) ?? 0) - (affinity.get(`${a.id}:${trackKey}`) ?? 0);
          if (byTrack !== 0) return byTrack;
        }
        const byLoad = (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0);
        if (byLoad !== 0) return byLoad;
        return a.id < b.id ? -1 : 1;
      });

    for (const reviewer of candidates) {
      if (need === 0) break;
      planned.push({ submissionId: submission.id, reviewerId: reviewer.id });
      taken.add(reviewer.id);
      load.set(reviewer.id, (load.get(reviewer.id) ?? 0) + 1);
      if (trackKey) {
        affinity.set(`${reviewer.id}:${trackKey}`, (affinity.get(`${reviewer.id}:${trackKey}`) ?? 0) + 1);
      }
      need -= 1;
    }

    if (need > 0) short += 1;
  }

  return { planned, short };
}

/**
 * Everything `planAssignments` needs, in four flat reads. Bot users are left
 * out: an evaluator persona grades on its own schedule through the AI runner,
 * and a reminder mail addressed to one goes nowhere a human will read it.
 *
 * The roster is narrowed to this round's pool when it has one. An empty pool
 * means every reviewer, which is how the distributor behaved before pools
 * existed and is what stops an organizer who never opened the pool screen from
 * finding their committee has nobody in it.
 */
export async function distributionInputs(roundId: string): Promise<{
  submissions: PlannerSubmission[];
  reviewers: PlannerReviewer[];
}> {
  const pool = await db
    .select({ reviewerId: roundReviewers.reviewerId })
    .from(roundReviewers)
    .where(eq(roundReviewers.roundId, roundId));
  const poolIds = pool.length > 0 ? new Set(pool.map((row) => row.reviewerId)) : null;

  const [open, existing, roster] = await Promise.all([
    db
      .select({
        id: submissions.id,
        trackId: submissions.trackId,
        speakerId: submissions.speakerId,
      })
      .from(submissions)
      .where(eq(submissions.status, 'submitted'))
      .orderBy(asc(submissions.createdAt)),
    db
      .select({
        submissionId: reviewAssignments.submissionId,
        reviewerId: reviewAssignments.reviewerId,
        trackId: submissions.trackId,
      })
      .from(reviewAssignments)
      .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
      .where(and(eq(reviewAssignments.roundId, roundId), eq(submissions.status, 'submitted'))),
    db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, 'reviewer')))
      .where(eq(users.isBot, false))
      .orderBy(asc(users.id)),
  ]);

  const assignedBySubmission = new Map<string, string[]>();
  const load = new Map<string, number>();
  const trackLoad = new Map<string, Record<string, number>>();

  for (const row of existing) {
    const held = assignedBySubmission.get(row.submissionId);
    if (held) held.push(row.reviewerId);
    else assignedBySubmission.set(row.submissionId, [row.reviewerId]);

    load.set(row.reviewerId, (load.get(row.reviewerId) ?? 0) + 1);
    if (row.trackId) {
      const byTrack = trackLoad.get(row.reviewerId) ?? {};
      byTrack[row.trackId] = (byTrack[row.trackId] ?? 0) + 1;
      trackLoad.set(row.reviewerId, byTrack);
    }
  }

  return {
    submissions: open.map((row) => ({
      id: row.id,
      trackId: row.trackId,
      speakerId: row.speakerId,
      assigned: assignedBySubmission.get(row.id) ?? [],
    })),
    reviewers: roster
      .filter((row) => poolIds === null || poolIds.has(row.id))
      .map((row) => ({
        id: row.id,
        load: load.get(row.id) ?? 0,
        trackLoad: trackLoad.get(row.id) ?? {},
      })),
  };
}
