'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { rooms, slots, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';

function revalidateSchedule() {
  revalidatePath('/organizer/schedule');
  revalidatePath('/organizer/submissions');
  revalidatePath('/agenda');
  revalidatePath('/speaker');
}

const placeSchema = z.object({
  slotId: z.string().uuid(),
  submissionId: z.string().uuid(),
});

/**
 * Put an accepted submission into a slot.
 *
 * Two writes in one transaction. The first clears any slot the submission
 * already occupies, because `slots_submission_idx` is unique and a move would
 * otherwise collide with the row it is moving out of. The second fills the
 * target. Both in a transaction so a failure between them cannot leave the
 * submission unscheduled.
 */
export async function placeSubmission(formData: FormData): Promise<void> {
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
  if (!target || target.status !== 'accepted') return;

  await db.transaction(async (tx) => {
    await tx
      .update(slots)
      .set({ submissionId: null })
      .where(eq(slots.submissionId, input.submissionId));
    await tx
      .update(slots)
      .set({ submissionId: input.submissionId })
      .where(eq(slots.id, input.slotId));
  });

  revalidateSchedule();
}

export async function clearSlot(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const slotId = z.string().uuid().parse(formData.get('slotId'));
  await db.update(slots).set({ submissionId: null }).where(eq(slots.id, slotId));
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

export async function deleteTimeBand(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const startsAt = z.coerce.date().parse(formData.get('startsAt'));
  await db.delete(slots).where(eq(slots.startsAt, startsAt));
  revalidateSchedule();
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
