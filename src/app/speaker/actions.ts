'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { speakerTasks, submissions } from '@/db/schema';
import { requireUser } from '@/lib/auth';

/**
 * Every action here scopes its WHERE clause to the caller's own speaker id.
 * Ownership is a query condition, not a check before the query, so a forged
 * submission id updates zero rows instead of someone else's talk.
 */

export async function confirmAttendance(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));

  await db
    .update(submissions)
    .set({ speakerConfirmedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(submissions.id, id),
        eq(submissions.speakerId, user.id),
        eq(submissions.status, 'accepted'),
      ),
    );

  revalidatePath('/speaker');
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
