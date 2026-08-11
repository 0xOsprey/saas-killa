import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  reviewAssignments,
  reviewConflicts,
  reviewRounds,
  reviews,
  roundCriteria,
  roundReviewers,
  submissions,
  users,
} from '@/db/schema';
import type { CriterionKind, ReviewRound, RoundCriterion } from '@/db/schema';
import { DEFAULT_CRITERIA } from './rubric';

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

/**
 * The scorecard.
 *
 * A round with no criteria rows is a round created before scorecards were
 * configurable, or one created by a code path that does not know about them. It
 * gets the four the app has always graded on rather than an empty form, which
 * is why every reader goes through here instead of selecting the table
 * directly: a queue that renders no fields looks exactly like a bug and
 * silently records nothing.
 *
 * `onConflictDoNothing` on the (round, key) index makes the seeding safe under
 * two reviewers opening the page at the same moment.
 */
export async function ensureRoundCriteria(roundId: string): Promise<RoundCriterion[]> {
  const existing = await db
    .select()
    .from(roundCriteria)
    .where(eq(roundCriteria.roundId, roundId))
    .orderBy(asc(roundCriteria.position), asc(roundCriteria.createdAt));
  if (existing.length > 0) return existing;

  await db
    .insert(roundCriteria)
    .values(DEFAULT_CRITERIA.map((criterion) => ({ ...criterion, roundId })))
    .onConflictDoNothing();

  return db
    .select()
    .from(roundCriteria)
    .where(eq(roundCriteria.roundId, roundId))
    .orderBy(asc(roundCriteria.position), asc(roundCriteria.createdAt));
}

/** What a reviewer actually fills in: the scorecard minus anything archived. */
export async function activeCriteria(roundId: string): Promise<RoundCriterion[]> {
  const all = await ensureRoundCriteria(roundId);
  return all.filter((criterion) => criterion.archivedAt === null);
}

/** Every criterion for every round in one read, for a page listing all of them. */
export async function criteriaByRound(): Promise<Map<string, RoundCriterion[]>> {
  const rows = await db
    .select()
    .from(roundCriteria)
    .orderBy(asc(roundCriteria.position), asc(roundCriteria.createdAt));
  const byRound = new Map<string, RoundCriterion[]>();
  for (const row of rows) {
    const held = byRound.get(row.roundId);
    if (held) held.push(row);
    else byRound.set(row.roundId, [row]);
  }
  return byRound;
}

export async function addCriterion(input: {
  roundId: string;
  key: string;
  label: string;
  kind: CriterionKind;
  helpText: string | null;
  scaleMin: number;
  scaleMax: number;
  options: string[];
  weight: number;
}): Promise<void> {
  // Seed first. Adding a fifth criterion to a round that has never been opened
  // would otherwise leave it with exactly one, and every grade already filed
  // against the original four would render against a scorecard missing them.
  const existing = await ensureRoundCriteria(input.roundId);
  const position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;

  await db
    .insert(roundCriteria)
    .values({ ...input, position })
    // A key that is already taken is the organizer re-adding a criterion they
    // archived, so this un-archives it and takes the new wording rather than
    // erroring on a collision they cannot see.
    .onConflictDoUpdate({
      target: [roundCriteria.roundId, roundCriteria.key],
      set: {
        label: input.label,
        kind: input.kind,
        helpText: input.helpText,
        scaleMin: input.scaleMin,
        scaleMax: input.scaleMax,
        options: input.options,
        weight: input.weight,
        archivedAt: null,
      },
    });
}

export async function updateCriterion(input: {
  criterionId: string;
  label: string;
  kind: CriterionKind;
  helpText: string | null;
  scaleMin: number;
  scaleMax: number;
  options: string[];
  weight: number;
}): Promise<void> {
  const { criterionId, ...set } = input;
  // `key` is deliberately absent from the set. It is the join to every score
  // already stored under this criterion, and a rename is a display change.
  await db.update(roundCriteria).set(set).where(eq(roundCriteria.id, criterionId));
}

/**
 * Take a criterion off the scorecard without destroying what was scored on it.
 * A deleted criterion would take its column of `reviews.rubric` out of every
 * reader's reach, and those numbers are what a committee decided on.
 */
export async function archiveCriterion(criterionId: string): Promise<void> {
  await db
    .update(roundCriteria)
    .set({ archivedAt: new Date() })
    .where(eq(roundCriteria.id, criterionId));
}

export async function restoreCriterion(criterionId: string): Promise<void> {
  await db.update(roundCriteria).set({ archivedAt: null }).where(eq(roundCriteria.id, criterionId));
}

export type PoolMember = {
  reviewerId: string;
  name: string | null;
  email: string;
};

/** Who sits on this round's committee. Empty means everyone with the role. */
export async function roundPool(roundId: string): Promise<PoolMember[]> {
  return db
    .select({ reviewerId: users.id, name: users.name, email: users.email })
    .from(roundReviewers)
    .innerJoin(users, eq(users.id, roundReviewers.reviewerId))
    .where(eq(roundReviewers.roundId, roundId))
    .orderBy(asc(users.name), asc(users.email));
}

/** The pools of every round at once, for a page comparing them side by side. */
export async function poolsByRound(): Promise<Map<string, PoolMember[]>> {
  const rows = await db
    .select({
      roundId: roundReviewers.roundId,
      reviewerId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(roundReviewers)
    .innerJoin(users, eq(users.id, roundReviewers.reviewerId))
    .orderBy(asc(users.name), asc(users.email));

  const byRound = new Map<string, PoolMember[]>();
  for (const { roundId, ...member } of rows) {
    const held = byRound.get(roundId);
    if (held) held.push(member);
    else byRound.set(roundId, [member]);
  }
  return byRound;
}

export async function addToPool(roundId: string, reviewerId: string): Promise<void> {
  await db.insert(roundReviewers).values({ roundId, reviewerId }).onConflictDoNothing();
}

/**
 * Take somebody off a round's committee.
 *
 * Their assignments and their grades stay. Membership says who may be handed new
 * work in this pass; it is not a claim about what they already did, and clearing
 * that would move the round's completion rate under an organizer who only meant
 * to stop the distributor picking them.
 */
export async function removeFromPool(roundId: string, reviewerId: string): Promise<void> {
  await db
    .delete(roundReviewers)
    .where(
      and(eq(roundReviewers.roundId, roundId), eq(roundReviewers.reviewerId, reviewerId)),
    );
}

/** The reviewer ids a round is scoped to, or null when it is open to everyone. */
export async function poolMemberIds(roundId: string): Promise<Set<string> | null> {
  const rows = await db
    .select({ reviewerId: roundReviewers.reviewerId })
    .from(roundReviewers)
    .where(eq(roundReviewers.roundId, roundId));
  if (rows.length === 0) return null;
  return new Set(rows.map((row) => row.reviewerId));
}

export async function setRoundBlind(roundId: string, blind: boolean): Promise<void> {
  await db.update(reviewRounds).set({ blind }).where(eq(reviewRounds.id, roundId));
}

export async function renameRound(input: {
  roundId: string;
  name: string;
  opensAt: Date | null;
  dueAt: Date | null;
}): Promise<void> {
  const { roundId, ...set } = input;
  await db.update(reviewRounds).set(set).where(eq(reviewRounds.id, roundId));
}

export type ConflictRow = {
  submissionId: string;
  submissionTitle: string;
  reviewerId: string;
  reviewerName: string | null;
  reviewerEmail: string;
  reason: string | null;
  declaredAt: Date;
};

/** Every recusal in a round, for the organizer who has to cover the gap. */
export async function conflictsForRound(roundId: string): Promise<ConflictRow[]> {
  return db
    .select({
      submissionId: reviewConflicts.submissionId,
      submissionTitle: submissions.title,
      reviewerId: reviewConflicts.reviewerId,
      reviewerName: users.name,
      reviewerEmail: users.email,
      reason: reviewConflicts.reason,
      declaredAt: reviewConflicts.declaredAt,
    })
    .from(reviewConflicts)
    .innerJoin(submissions, eq(submissions.id, reviewConflicts.submissionId))
    .innerJoin(users, eq(users.id, reviewConflicts.reviewerId))
    .where(eq(reviewConflicts.roundId, roundId))
    .orderBy(asc(submissions.title), asc(users.email));
}

/**
 * What this reviewer has recused themselves from in this round.
 *
 * A set rather than a list because the caller's question is always "is this one
 * of them", once per card in a queue.
 */
export async function conflictedSubmissionIds(
  reviewerId: string,
  roundId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ submissionId: reviewConflicts.submissionId })
    .from(reviewConflicts)
    .where(
      and(eq(reviewConflicts.reviewerId, reviewerId), eq(reviewConflicts.roundId, roundId)),
    );
  return new Set(rows.map((row) => row.submissionId));
}

/**
 * Record a recusal. Idempotent on the (round, submission, reviewer) key, so a
 * reviewer who presses it twice restates their reason rather than seeing an
 * error about a declaration they already made.
 */
export async function declareConflict(input: {
  roundId: string;
  submissionId: string;
  reviewerId: string;
  reason: string | null;
}): Promise<void> {
  await db
    .insert(reviewConflicts)
    .values(input)
    .onConflictDoUpdate({
      target: [
        reviewConflicts.roundId,
        reviewConflicts.submissionId,
        reviewConflicts.reviewerId,
      ],
      set: { reason: input.reason, declaredAt: new Date() },
    });
}

/** Undo a recusal, which is what makes the control safe to press to find out what it does. */
export async function withdrawConflict(input: {
  roundId: string;
  submissionId: string;
  reviewerId: string;
}): Promise<void> {
  await db
    .delete(reviewConflicts)
    .where(
      and(
        eq(reviewConflicts.roundId, input.roundId),
        eq(reviewConflicts.submissionId, input.submissionId),
        eq(reviewConflicts.reviewerId, input.reviewerId),
      ),
    );
}
