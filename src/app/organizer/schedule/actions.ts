'use server';

import { eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { rooms, slots, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';

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
