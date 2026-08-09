'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { speakerTasks, submissions } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { alertOrganizers, attendanceDeclinedMail } from '@/lib/email';
import { dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { placementFor } from '@/lib/speaker-calendar';

/**
 * Every action here scopes its WHERE clause to the caller's own speaker id.
 * Ownership is a query condition, not a check before the query, so a forged
 * submission id updates zero rows instead of someone else's talk.
 */

/**
 * Confirming clears any earlier decline, so the two columns can never both be
 * set and no reader has to decide which of them wins. It is also the undo for
 * `declineAttendance`, which is why neither of them asks twice.
 */
export async function confirmAttendance(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));

  await db
    .update(submissions)
    .set({ speakerConfirmedAt: new Date(), speakerDeclinedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(submissions.id, id),
        eq(submissions.speakerId, user.id),
        eq(submissions.status, 'accepted'),
      ),
    );

  revalidatePath('/speaker');
  revalidatePath('/organizer/schedule');
}

/**
 * "I can no longer present this." The smaller move, and deliberately not
 * `withdrawSubmission`: that sets `status: 'withdrawn'` and pulls an accepted
 * talk off the programme, which is the wrong instrument for a speaker who is
 * ill, has lost their travel, or has a co-presenter who can give it instead.
 *
 * No confirm-on-second-press, unlike the destructive actions elsewhere. The
 * house rule is that a press asks first when what it destroys cannot be got
 * back; confirming is the exact opposite action, it is the button rendered
 * directly beneath, and the only thing a stray click costs is a confirmation
 * timestamp that pressing it again replaces.
 *
 * Offered whether or not they confirmed first. Somebody who knew in March that
 * they could not come has the same thing to tell the organizers as somebody who
 * confirmed in March and broke their leg in June.
 *
 * The organizers are emailed rather than left to notice a column: a declined
 * speaker is still on the grid, and the schedule that has to change is
 * elsewhere in the app from the screen this was pressed on.
 */
export async function declineAttendance(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));

  // The ownership predicate is in the WHERE clause, so `updated` is empty for a
  // forged id rather than for a decline that failed, and the mail below goes out
  // only for a row that actually moved.
  const updated = await db
    .update(submissions)
    .set({ speakerDeclinedAt: new Date(), speakerConfirmedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(submissions.id, id),
        eq(submissions.speakerId, user.id),
        eq(submissions.status, 'accepted'),
        isNull(submissions.speakerDeclinedAt),
      ),
    )
    .returning({ id: submissions.id, title: submissions.title });

  const row = updated[0];
  if (row) {
    const [event, placement] = await Promise.all([getEvent(), placementFor(row.id)]);
    await alertOrganizers(
      (to) =>
        attendanceDeclinedMail({
          to,
          title: row.title,
          speakerName: user.name ?? user.email,
          eventName: event.name,
          placement:
            placement?.slot != null
              ? {
                  when: `${dayLabel(placement.slot.startsAt, event.timezone)}, ${timeOfDay(
                    placement.slot.startsAt,
                    event.timezone,
                  )}`,
                  room: placement.slot.roomName,
                }
              : null,
        }),
      { kind: 'attendance_declined', submissionId: row.id },
    );
  }

  revalidatePath('/speaker');
  revalidatePath('/organizer/schedule');
}

export async function withdrawSubmission(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));

  await db
    .update(submissions)
    .set({ status: 'withdrawn', updatedAt: new Date() })
    .where(and(eq(submissions.id, id), eq(submissions.speakerId, user.id)));

  revalidatePath('/speaker');
  revalidatePath('/agenda');
}

/*
 * Materials used to be saved by a `saveContent` action here, from a form folded
 * into each card on /speaker. It was written before /speaker/content existed and
 * the two were built in parallel, so they ended up as two doors onto one job.
 * The one here was the weaker door: it wrote the URLs straight through without
 * moving `contentStatus`, so a speaker filled it in and nothing ever became
 * visible, and it ignored `lockedFields`, so it could overwrite a field an
 * organizer had frozen. /speaker/content is the single remaining route, and this
 * page links to it.
 */

/**
 * Tick off one of the things the organizer is chasing. `completedAt IS NULL` is
 * in the WHERE clause as well as the ownership predicate, so a double submit
 * cannot move a completion time that has already been recorded.
 */
export async function completeTask(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('taskId'));

  await db
    .update(speakerTasks)
    .set({ completedAt: new Date() })
    .where(
      and(
        eq(speakerTasks.id, id),
        eq(speakerTasks.userId, user.id),
        isNull(speakerTasks.completedAt),
      ),
    );

  revalidatePath('/speaker');
}
