import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { emailLog, reviewAssignments, reviews, submissions, tracks, userRoles, users } from '@/db/schema';
import type { AudienceLevel, SubmissionFormat, SubmissionStatus } from '@/db/schema';

/**
 * Queries behind the call for papers and its grading. They live here rather
 * than in `queries.ts` so the blind-review rule has one place to be checked:
 * every reviewer-facing select below joins `review_assignments` to
 * `submissions` and stops there. None of them reaches `users` through
 * `submissions.speakerId`.
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
  overdue: number;
  completionPct: number | null;
};

/**
 * Per-reviewer completion, aggregated in Postgres. Doing it here rather than by
 * pulling every assignment into the page keeps the cost flat as the committee
 * grows, and the `filter (where ...)` clauses are the only place the three
 * different meanings of "not done" are spelled out:
 *
 *   assigned    every row the reviewer owns, ever, decided or not
 *   outstanding ungraded AND the submission is still open, so still real work
 *   overdue     outstanding and past its dueAt
 *
 * `assigned` deliberately keeps rows whose submission was later accepted or
 * rejected: the reviewer was asked and never answered, and hiding that would
 * flatter the completion rate.
 */
export async function reviewerCompletion(): Promise<ReviewerCompletionRow[]> {
  return db
    .select({
      reviewerId: users.id,
      name: users.name,
      email: users.email,
      assigned: sql<number>`count(${reviewAssignments.submissionId})::int`,
      graded: sql<number>`count(${reviews.id})::int`,
      outstanding: sql<number>`count(*) filter (
        where ${reviewAssignments.submissionId} is not null
          and ${reviews.id} is null
          and ${submissions.status} = 'submitted'
      )::int`,
      overdue: sql<number>`count(*) filter (
        where ${reviewAssignments.submissionId} is not null
          and ${reviews.id} is null
          and ${submissions.status} = 'submitted'
          and ${reviewAssignments.dueAt} is not null
          and ${reviewAssignments.dueAt} < now()
      )::int`,
      completionPct: sql<number | null>`case
        when count(${reviewAssignments.submissionId}) = 0 then null
        else round(100.0 * count(${reviews.id}) / count(${reviewAssignments.submissionId}))::int
      end`,
    })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, 'reviewer')))
    .leftJoin(reviewAssignments, eq(reviewAssignments.reviewerId, users.id))
    .leftJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .leftJoin(
      reviews,
      and(
        eq(reviews.submissionId, reviewAssignments.submissionId),
        eq(reviews.reviewerId, users.id),
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
  reviewCount: number;
  myScore: number | null;
  myRubric: Record<string, number> | null;
  myComment: string | null;
  dueAt: Date | null;
};

/**
 * `max(...) filter (where reviewer = me)` reads this reviewer's own grade out of
 * the same aggregate that counts everyone's, so the page needs one query rather
 * than one plus a lookup. `array_agg(...)[1]` is the same trick for the two
 * columns no aggregate exists for; the unique index on (submission, reviewer)
 * guarantees there is at most one element to take.
 */
const MY_GRADE = (reviewerId: string) => ({
  reviewCount: sql<number>`count(${reviews.id})::int`,
  myScore: sql<
    number | null
  >`max(${reviews.score}) filter (where ${reviews.reviewerId} = ${reviewerId})::int`,
  myRubric: sql<
    Record<string, number> | null
  >`(array_agg(${reviews.rubric}) filter (where ${reviews.reviewerId} = ${reviewerId}))[1]`,
  myComment: sql<
    string | null
  >`(array_agg(${reviews.comment}) filter (where ${reviews.reviewerId} = ${reviewerId}))[1]`,
});

/**
 * This reviewer's queue: their `review_assignments` rows, narrowed to
 * submissions still open for grading. An assignment on a decided submission is
 * not actionable — `submitReview` refuses it — so leaving it in the queue would
 * show a card whose form cannot do anything.
 */
export async function assignedQueue(reviewerId: string): Promise<ReviewerQueueRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      dueAt: reviewAssignments.dueAt,
      ...MY_GRADE(reviewerId),
    })
    .from(reviewAssignments)
    .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .where(
      and(eq(reviewAssignments.reviewerId, reviewerId), eq(submissions.status, 'submitted')),
    )
    .groupBy(submissions.id, tracks.name, reviewAssignments.dueAt)
    .orderBy(
      sql`${reviewAssignments.dueAt} asc nulls last`,
      sql`count(${reviews.id}) asc`,
      asc(submissions.createdAt),
    );
}

/**
 * The unassigned fallback: every open submission, which is how the queue
 * behaved before assignments existed. The seed ships no assignments, so a
 * committee that has not run the distributor still has a usable page.
 */
export async function openSubmissionQueue(reviewerId: string): Promise<ReviewerQueueRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      dueAt: sql<Date | null>`null::timestamptz`,
      ...MY_GRADE(reviewerId),
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .where(eq(submissions.status, 'submitted'))
    .groupBy(submissions.id, tracks.name)
    .orderBy(sql`count(${reviews.id}) asc`, asc(submissions.createdAt));
}

export async function assignmentCount(reviewerId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reviewAssignments)
    .where(eq(reviewAssignments.reviewerId, reviewerId));
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
  comment: string | null;
  gradedAt: Date;
};

/**
 * Everything this reviewer has graded, at any status. The queue can only show
 * open submissions, so without this a reviewer loses sight of their own work
 * the moment an organizer decides. Still no speaker column: a reviewer's own
 * history is not a hole in blind review.
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
      comment: reviews.comment,
      gradedAt: reviews.createdAt,
    })
    .from(reviews)
    .innerJoin(submissions, eq(submissions.id, reviews.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(eq(reviews.reviewerId, reviewerId))
    .orderBy(sql`${reviews.createdAt} desc`);
}

export type CoverageRow = {
  submissionId: string;
  title: string;
  trackName: string | null;
  assigned: number;
  reviewCount: number;
};

/** Assignment coverage per open submission, thinnest first — the gaps read top-down. */
export async function submissionCoverage(): Promise<CoverageRow[]> {
  return db
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      trackName: tracks.name,
      assigned: sql<number>`count(distinct ${reviewAssignments.reviewerId})::int`,
      reviewCount: sql<number>`count(distinct ${reviews.id})::int`,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviewAssignments, eq(reviewAssignments.submissionId, submissions.id))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .where(eq(submissions.status, 'submitted'))
    .groupBy(submissions.id, tracks.name)
    .orderBy(sql`count(distinct ${reviewAssignments.reviewerId}) asc`, asc(submissions.title));
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
 * Every assignment on an open submission, with the reviewer's identity. This is
 * the organizer's screen, where knowing who is holding what is the entire
 * point; the join is to the reviewer, never to the speaker.
 */
export async function assignmentRoster(): Promise<AssignmentRow[]> {
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
      ),
    )
    .where(eq(submissions.status, 'submitted'))
    .orderBy(asc(users.name), asc(users.email));
}

export type ReminderTarget = {
  reviewerId: string;
  name: string | null;
  email: string;
  outstanding: number;
  overdue: number;
};

/** Reviewers who still owe a grade on an open submission. */
export async function reviewersWithOutstanding(): Promise<ReminderTarget[]> {
  const rows = await reviewerCompletion();
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
 * Everything `planAssignments` needs, in three flat reads. Bot users are left
 * out: an evaluator persona grades on its own schedule through the AI runner,
 * and a reminder mail addressed to one goes nowhere a human will read it.
 */
export async function distributionInputs(): Promise<{
  submissions: PlannerSubmission[];
  reviewers: PlannerReviewer[];
}> {
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
      .where(eq(submissions.status, 'submitted')),
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
    reviewers: roster.map((row) => ({
      id: row.id,
      load: load.get(row.id) ?? 0,
      trackLoad: trackLoad.get(row.id) ?? {},
    })),
  };
}
