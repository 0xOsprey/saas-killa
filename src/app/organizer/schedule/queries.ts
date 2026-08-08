import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { slots, submissions } from '@/db/schema';

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
