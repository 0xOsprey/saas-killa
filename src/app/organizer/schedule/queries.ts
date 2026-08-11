import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { bookmarks, rooms, slots, submissions } from '@/db/schema';

/**
 * Reads for the schedule screen. Kept out of `actions.ts` on purpose: that file
 * is `'use server'`, and every function exported from one is a callable
 * endpoint. A read helper living there would be an unauthenticated door that
 * looks like a local function.
 */

export type TimeBandImpact = { slots: number; placed: number; titles: string[] };

/** What deleting this band would cost, in the words the confirmation shows. */
export async function timeBandImpact(startsAt: Date): Promise<TimeBandImpact> {
  const rows = await db
    .select({ title: submissions.title })
    .from(slots)
    .leftJoin(submissions, eq(submissions.id, slots.submissionId))
    .where(eq(slots.startsAt, startsAt));

  const titles = rows
    .map((row) => row.title)
    .filter((title): title is string => title !== null)
    .sort();

  return { slots: rows.length, placed: titles.length, titles };
}

export type OpenSlot = {
  id: string;
  roomId: string;
  capacity: number | null;
  startsAt: Date;
  endsAt: Date;
};

/**
 * Boxes the auto-scheduler may write into: empty, and not a break.
 *
 * The label test is the half that matters. A named block is an empty slot as far
 * as `submission_id` is concerned, so without it one press would fill lunch and
 * registration with talks, which is a schedule nobody asked for and a tedious
 * one to undo box by box.
 */
export async function openSlots(): Promise<OpenSlot[]> {
  return db
    .select({
      id: slots.id,
      roomId: slots.roomId,
      capacity: rooms.capacity,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
    })
    .from(slots)
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .where(and(isNull(slots.submissionId), isNull(slots.label)))
    .orderBy(asc(slots.startsAt), asc(rooms.position));
}

/**
 * Bookmarks per submission, which is the only demand signal this app has.
 *
 * A separate read rather than a column on the pool, so the question "which talks
 * still need a slot" keeps its single answer in `unscheduledAccepted()`. That
 * filter carries a poster exclusion and an accepted-status check that are easy
 * to get subtly wrong in a second copy.
 */
export async function bookmarkDemand(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      submissionId: bookmarks.submissionId,
      count: sql<number>`count(*)::int`,
    })
    .from(bookmarks)
    .groupBy(bookmarks.submissionId);

  return new Map(rows.map((row) => [row.submissionId, row.count]));
}

/**
 * Labels by slot id. The grid is still built from `agenda()`, which does not
 * select `label`; fetching only the labelled slots and joining them in memory
 * adds the one column without forking that query or duplicating its joins.
 */
export async function slotLabels(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: slots.id, label: slots.label })
    .from(slots)
    .where(isNotNull(slots.label));

  const labels = new Map<string, string>();
  for (const row of rows) {
    if (row.label !== null) labels.set(row.id, row.label);
  }
  return labels;
}
