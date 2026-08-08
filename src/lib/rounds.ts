import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { reviewAssignments, reviewRounds, reviews, submissions } from '@/db/schema';
import type { ReviewRound } from '@/db/schema';

/**
 * Committee review in passes.
 *
 * A round owns assignments and grades. Round one is the whole pile; a later
 * round is a shortlist re-read by a committee that has already seen the scores.
 * Because the round is part of the key on both tables, the second read does not
 * overwrite the first, and "what did we think before we met" stays answerable.
 */

export function roundIsOpen(round: Pick<ReviewRound, 'closedAt' | 'opensAt'>, now = new Date()): boolean {
  if (round.closedAt !== null) return false;
  if (round.opensAt && now < round.opensAt) return false;
  return true;
}

export async function allRounds(): Promise<ReviewRound[]> {
  return db
    .select()
    .from(reviewRounds)
    .orderBy(asc(reviewRounds.position), asc(reviewRounds.createdAt));
}

/**
 * The round grading happens in right now: the furthest-along open one.
 *
 * Null is a real answer, not an error. Before the first round is created, and
 * after the last one closes, there is no round to grade in, and the review queue
 * says so rather than silently accepting scores into a closed pass.
 */
export async function activeRound(now = new Date()): Promise<ReviewRound | null> {
  const open = await db
    .select()
    .from(reviewRounds)
    .where(isNull(reviewRounds.closedAt))
    .orderBy(desc(reviewRounds.position), desc(reviewRounds.createdAt));

  return open.find((round) => roundIsOpen(round, now)) ?? null;
}

export async function findRound(id: string): Promise<ReviewRound | null> {
  const [found] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, id)).limit(1);
  return found ?? null;
}

/** The round a fresh install has to have before anybody can be assigned anything. */
export async function ensureFirstRound(): Promise<ReviewRound> {
  const existing = await allRounds();
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(reviewRounds)
    .values({ name: 'Round 1', position: 0 })
    .returning();
  return created!;
}

/**
 * The round immediately before this one in the running order.
 *
 * Both the shortlist panel and the action behind it need this, and they had
 * each worked it out for themselves: the panel took the second-to-last round,
 * the action took the one before the active one. Those agree in every
 * arrangement the UI can currently produce, which is exactly why the
 * disagreement would have surfaced as a panel listing candidates from one round
 * and a button carrying reviewers forward from another.
 */
export async function previousRound(roundId: string): Promise<ReviewRound | null> {
  const rounds = await allRounds();
  const index = rounds.findIndex((row) => row.id === roundId);
  return index > 0 ? rounds[index - 1]! : null;
}

export type RoundSummary = ReviewRound & {
  open: boolean;
  assignments: number;
  graded: number;
  submissionsCovered: number;
  meanScore: number | null;
};

/** Every round with the numbers an organizer compares them on. */
export async function roundSummaries(now = new Date()): Promise<RoundSummary[]> {
  const [rounds, assignmentCounts, reviewCounts] = await Promise.all([
    allRounds(),
    db
      .select({
        roundId: reviewAssignments.roundId,
        assignments: sql<number>`count(*)::int`,
        submissionsCovered: sql<number>`count(distinct ${reviewAssignments.submissionId})::int`,
      })
      .from(reviewAssignments)
      .groupBy(reviewAssignments.roundId),
    db
      .select({
        roundId: reviews.roundId,
        graded: sql<number>`count(*)::int`,
        meanScore: sql<number | null>`avg(${reviews.score})::float`,
      })
      .from(reviews)
      .groupBy(reviews.roundId),
  ]);

  const byAssignment = new Map(assignmentCounts.map((row) => [row.roundId, row]));
  const byReview = new Map(reviewCounts.map((row) => [row.roundId, row]));

  return rounds.map((round) => ({
    ...round,
    open: roundIsOpen(round, now),
    assignments: byAssignment.get(round.id)?.assignments ?? 0,
    submissionsCovered: byAssignment.get(round.id)?.submissionsCovered ?? 0,
    graded: byReview.get(round.id)?.graded ?? 0,
    meanScore: byReview.get(round.id)?.meanScore ?? null,
  }));
}

export type CarryCandidate = {
  submissionId: string;
  title: string;
  meanScore: number | null;
  reviewCount: number;
};

/**
 * What a later round could look at: still-undecided submissions, ranked by how
 * the previous round scored them. An organizer shortlists from the top of this
 * rather than retyping ids.
 */
export async function carryCandidates(fromRoundId: string): Promise<CarryCandidate[]> {
  return db
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      meanScore: sql<number | null>`avg(${reviews.score})::float`,
      reviewCount: sql<number>`count(${reviews.id})::int`,
    })
    .from(submissions)
    .leftJoin(
      reviews,
      and(eq(reviews.submissionId, submissions.id), eq(reviews.roundId, fromRoundId)),
    )
    .where(eq(submissions.status, 'submitted'))
    .groupBy(submissions.id)
    .orderBy(sql`avg(${reviews.score}) desc nulls last`, asc(submissions.title));
}

/**
 * Copy a round's reviewers onto the same submissions in a later round.
 *
 * The committee that read a proposal first is the committee best placed to
 * re-read it, so carrying the assignment forward is the default rather than
 * redistributing. `onConflictDoNothing` makes a second press of the button a
 * no-op instead of an error, which matters because the button is next to a list
 * an organizer will be adjusting.
 */
export async function carryForward(opts: {
  fromRoundId: string;
  toRoundId: string;
  submissionIds: string[];
  dueAt?: Date | null;
}): Promise<number> {
  if (opts.submissionIds.length === 0) return 0;

  const previous = await db
    .select({
      submissionId: reviewAssignments.submissionId,
      reviewerId: reviewAssignments.reviewerId,
    })
    .from(reviewAssignments)
    .where(
      and(
        eq(reviewAssignments.roundId, opts.fromRoundId),
        inArray(reviewAssignments.submissionId, opts.submissionIds),
      ),
    );

  if (previous.length === 0) return 0;

  await db
    .insert(reviewAssignments)
    .values(
      previous.map((row) => ({
        roundId: opts.toRoundId,
        submissionId: row.submissionId,
        reviewerId: row.reviewerId,
        dueAt: opts.dueAt ?? null,
      })),
    )
    .onConflictDoNothing();

  return previous.length;
}
