'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { rooms, slots, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { overlaps, speakerBookings } from '@/lib/conflicts';
import { FORMAT_MINUTES, wallClockToInstant } from '@/lib/format';
import { getEvent, unscheduledAccepted } from '@/lib/queries';
import { bookmarkDemand, openSlots } from './queries';

function revalidateSchedule() {
  revalidatePath('/organizer/schedule');
  revalidatePath('/organizer/submissions');
  revalidatePath('/organizer/rooms');
  revalidatePath('/agenda');
  revalidatePath('/speaker');
}

const placeSchema = z.object({
  slotId: z.string().uuid(),
  submissionId: z.string().uuid(),
});

/**
 * The talk that was sitting in the target slot, if the placement displaced one.
 *
 * Returned rather than blocked. Dropping onto an occupied box is a normal move
 * while an organizer rearranges, and the grid's whole design is to report
 * rather than refuse; what it must not do is happen in silence, which is what
 * it did — the sitting talk went back to the unscheduled pool with no trace on
 * screen and nothing to say which one had moved.
 */
export type PlacementResult = { evicted: { id: string; title: string } | null };

/**
 * Put an accepted submission into a slot.
 *
 * Two writes in one transaction. The first clears any slot the submission
 * already occupies, because `slots_submission_idx` is unique and a move would
 * otherwise collide with the row it is moving out of. The second fills the
 * target. Both in a transaction so a failure between them cannot leave the
 * submission unscheduled.
 */
export async function placeSubmission(formData: FormData): Promise<PlacementResult> {
  await requireRole('organizer');
  const input = placeSchema.parse({
    slotId: formData.get('slotId'),
    submissionId: formData.get('submissionId'),
  });

  const target = await db.query.submissions.findFirst({
    where: eq(submissions.id, input.submissionId),
  });
  // Only accepted work goes on the schedule. Scheduling something still under
  // review would publish a decision that has not been made.
  if (!target || target.status !== 'accepted') return { evicted: null };

  // Read before the write: after it, the slot holds the new talk and there is
  // no way back to who was in it.
  const [occupant] = await db
    .select({ id: submissions.id, title: submissions.title })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .where(eq(slots.id, input.slotId))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx
      .update(slots)
      .set({ submissionId: null })
      .where(eq(slots.submissionId, input.submissionId));
    // Dropping a talk onto "Lunch" makes the box a talk. A slot is either a
    // named block or a placement, never both, so the label goes with the write
    // that fills the box rather than needing an organizer to clear it first.
    await tx
      .update(slots)
      .set({ submissionId: input.submissionId, label: null })
      .where(eq(slots.id, input.slotId));
  });

  revalidateSchedule();
  // A talk dragged back onto its own box displaces itself, which is not news.
  return { evicted: occupant && occupant.id !== input.submissionId ? occupant : null };
}

/**
 * Compare two ranking keys left to right, first difference wins. The keys are
 * fixed-length tuples of numbers built in `autoSchedule`, so this is a plain
 * lexicographic sort with no tie-break left to insertion order.
 */
function ranksBefore(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * Fill the empty boxes with the accepted talks that have no slot yet.
 *
 * Deterministic and local. There is no model call and nothing here reads
 * `ANTHROPIC_API_KEY`: the assist an organizer wants at this point is not a
 * judgement call, it is the tedium of dragging twenty talks onto a grid, and a
 * control that renders disabled on a deployment with no key configured is an
 * assist nobody can use.
 *
 * Three rules, in order of how much they matter.
 *
 * It never evicts. Only slots that are already empty are candidates, and the
 * write carries `submission_id is null` in its own WHERE clause, so a talk
 * dropped by hand between the read and the write survives and its box is simply
 * skipped rather than overwritten.
 *
 * It never double-books a speaker. The check is `overlaps` from
 * `src/lib/conflicts.ts`, the same predicate the banner on this page grades
 * against, consulted against both the placements already on the grid and the
 * ones made earlier in this same pass.
 *
 * After that it prefers a band the talk actually fits and a room big enough for
 * the interest in it, in that order, then the earliest start. Those two are
 * preferences and not conditions: a talk with nowhere ideal still gets placed,
 * because a half-filled grid an organizer must finish by hand is worse than a
 * full one they can adjust. Rooms carry no track, so there is nothing to match a
 * talk's track against and no attempt is made to.
 */
export async function autoSchedule(): Promise<void> {
  await requireRole('organizer');

  const [open, pool, booked, demand] = await Promise.all([
    openSlots(),
    unscheduledAccepted(),
    speakerBookings(),
    bookmarkDemand(),
  ]);

  const busy = booked.map((row) => ({
    speakerId: row.speakerId,
    start: row.startsAt.getTime(),
    end: row.endsAt.getTime(),
  }));
  const taken = new Set<string>();
  const placements: { slotId: string; submissionId: string }[] = [];

  // Most-starred first, so when the big rooms run out they have gone to the
  // talks the most people said they wanted to be in the room for. Title breaks
  // the tie, which keeps two runs over unchanged data identical.
  const ordered = [...pool].sort(
    (a, b) => (demand.get(b.id) ?? 0) - (demand.get(a.id) ?? 0) || a.title.localeCompare(b.title),
  );

  for (const talk of ordered) {
    const minutes = FORMAT_MINUTES[talk.format];
    const wanted = demand.get(talk.id) ?? 0;

    let best: (typeof open)[number] | null = null;
    let bestRank: number[] | null = null;

    for (const slot of open) {
      if (taken.has(slot.id)) continue;
      const start = slot.startsAt.getTime();
      const end = slot.endsAt.getTime();
      if (busy.some((b) => b.speakerId === talk.speakerId && overlaps(start, end, b.start, b.end))) {
        continue;
      }

      const rank = [
        end - start < minutes * 60_000 ? 1 : 0,
        slot.capacity !== null && wanted > slot.capacity ? 1 : 0,
        start,
        // Negated, so the roomiest of two equally early boxes wins.
        -(slot.capacity ?? 0),
      ];
      if (bestRank === null || ranksBefore(rank, bestRank)) {
        best = slot;
        bestRank = rank;
      }
    }

    if (!best) continue;
    taken.add(best.id);
    busy.push({
      speakerId: talk.speakerId,
      start: best.startsAt.getTime(),
      end: best.endsAt.getTime(),
    });
    placements.push({ slotId: best.id, submissionId: talk.id });
  }

  // Counted from what the database actually changed, not from what was planned.
  // The `is null` guard is what makes "never evicts" true against a hand
  // placement that landed between the read and the write, and a run that reports
  // the plan would claim a talk it had just declined to place.
  let written = 0;
  if (placements.length > 0) {
    written = await db.transaction(async (tx) => {
      let count = 0;
      for (const placement of placements) {
        const rows = await tx
          .update(slots)
          .set({ submissionId: placement.submissionId })
          .where(and(eq(slots.id, placement.slotId), isNull(slots.submissionId)))
          .returning({ id: slots.id });
        count += rows.length;
      }
      return count;
    });
    revalidateSchedule();
  }

  // Both counts, always, including zero. A bulk action that says nothing on a
  // press that placed nothing is indistinguishable from a button that does not
  // work, and "there was nowhere to put them" is the answer an organizer needs.
  redirect(`/organizer/schedule?placed=${written}&unplaced=${pool.length - written}`);
}

/**
 * The same placement for a plain form.
 *
 * `<form action={...}>` types the action as returning nothing, and the eviction
 * a script can render into a notice has nowhere to go on a page with scripting
 * off. The fallback form warns before the press instead, in the slot list.
 */
export async function placeSubmissionFromForm(formData: FormData): Promise<void> {
  await placeSubmission(formData);
}

/** Empty a slot. Also drops a label, so one control clears whatever is in the box. */
export async function clearSlot(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const slotId = z.string().uuid().parse(formData.get('slotId'));
  await db.update(slots).set({ submissionId: null, label: null }).where(eq(slots.id, slotId));
  revalidateSchedule();
}

const addSlotSchema = z.object({
  startsAt: z.string().min(16),
  minutes: z.coerce.number().int().min(5).max(480),
});

/**
 * Add one time band across every room. A schedule is a grid, so a band is the
 * unit an organizer actually thinks in; creating slots room by room would be
 * the same work multiplied by the room count.
 *
 * The form sends a bare wall-clock string with no offset. It is read as a time
 * in the event's timezone, not the server's, so the same schedule comes out the
 * same whether this runs on a UTC host or a laptop in California.
 */
export async function addTimeBand(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = addSlotSchema.parse({
    startsAt: formData.get('startsAt'),
    minutes: formData.get('minutes'),
  });

  const [allRooms, event] = await Promise.all([db.select().from(rooms), getEvent()]);
  if (allRooms.length === 0) return;

  const startsAt = wallClockToInstant(input.startsAt, event.timezone);
  const endsAt = new Date(startsAt.getTime() + input.minutes * 60_000);
  await db
    .insert(slots)
    .values(allRooms.map((room) => ({ roomId: room.id, startsAt, endsAt })))
    // A band that already exists is a double-submit, not an error worth showing.
    .onConflictDoNothing();

  revalidateSchedule();
}

const blockSchema = addSlotSchema.extend({ label: z.string().trim().min(1).max(80) });

/**
 * Add a named non-session block — "Lunch", "Registration" — across every room.
 *
 * A break spanning the venue is one labelled slot per room, which is the shape
 * the grid already draws; the public agenda collapses them back into one line.
 * Where a slot already exists at that time it is relabelled, but only if it is
 * empty: an organizer adding lunch over a band that already has talks in it
 * means the gaps, not "unplace everything".
 */
export async function addBreakBand(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = blockSchema.parse({
    startsAt: formData.get('startsAt'),
    minutes: formData.get('minutes'),
    label: formData.get('label'),
  });

  const [allRooms, event] = await Promise.all([db.select().from(rooms), getEvent()]);
  if (allRooms.length === 0) return;

  const startsAt = wallClockToInstant(input.startsAt, event.timezone);
  const endsAt = new Date(startsAt.getTime() + input.minutes * 60_000);

  await db
    .insert(slots)
    .values(allRooms.map((room) => ({ roomId: room.id, startsAt, endsAt, label: input.label })))
    .onConflictDoUpdate({
      target: [slots.roomId, slots.startsAt],
      // Only the label. Rewriting `endsAt` here would leave a band ragged —
      // the empty boxes lengthened, the ones with talks in them not — because
      // `setWhere` skips the occupied rows. Naming an existing band keeps that
      // band's length.
      set: { label: input.label },
      setWhere: isNull(slots.submissionId),
    });

  revalidateSchedule();
}

/** Strip the label from a band, leaving the boxes as ordinary empty slots. */
export async function clearBreakBand(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const startsAt = z.coerce.date().parse(formData.get('startsAt'));
  await db.update(slots).set({ label: null }).where(eq(slots.startsAt, startsAt));
  revalidateSchedule();
}

/**
 * Delete a whole time band.
 *
 * This used to run straight off a one-click form and silently unplace whatever
 * was in it — the slots go, and every talk in them quietly returns to the
 * unscheduled pool with nothing said. It now refuses without an explicit
 * confirmation, and the screen that asks for it names the count and the talks.
 */
export async function deleteTimeBand(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const startsAt = z.coerce.date().parse(formData.get('startsAt'));

  // Unconfirmed, this bounces to the confirmation screen rather than erroring:
  // the organizer asked for something reasonable and is owed the count first.
  if (formData.get('confirm') !== 'yes') {
    redirect(`/organizer/schedule?confirmDelete=${encodeURIComponent(startsAt.toISOString())}`);
  }

  await db.delete(slots).where(eq(slots.startsAt, startsAt));
  revalidateSchedule();
  redirect('/organizer/schedule');
}

export async function setAgendaPublished(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const published = formData.get('published') === 'true';
  const { events } = await import('@/db/schema');
  const [event] = await db.select().from(events).limit(1);
  if (!event) return;
  await db.update(events).set({ agendaPublished: published }).where(eq(events.id, event.id));
  revalidateSchedule();
}
