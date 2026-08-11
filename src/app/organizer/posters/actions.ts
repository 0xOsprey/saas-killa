'use server';

import { and, eq, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { acceptedPosterIdsInTrackOrder } from '@/lib/poster-queries';

const boardSchema = z.object({
  submissionId: z.string().uuid(),
  // A board number is what is printed on the physical board: short, and free
  // text because halls number in "12", "P12" and "B-12" with equal conviction.
  boardNumber: z.string().trim().max(16),
});

export async function setBoardNumber(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = boardSchema.parse({
    submissionId: formData.get('submissionId'),
    boardNumber: formData.get('boardNumber') ?? '',
  });

  await db
    .update(submissions)
    .set({ boardNumber: input.boardNumber || null, updatedAt: new Date() })
    .where(and(eq(submissions.id, input.submissionId), eq(submissions.format, 'poster')));

  revalidatePath('/organizer/posters');
  revalidatePath('/posters');
}

/**
 * Number every accepted poster in track order, 1..n.
 *
 * Contiguous numbers within a track are the point: an attendee walking the hall
 * in board order walks one topic at a time, and an ops team hanging boards
 * works down one track's pile before opening the next. Plain integers rather
 * than a per-track prefix, because the number has to match whatever the venue
 * already printed on the boards.
 *
 * It overwrites, and it now asks first when there is something to overwrite.
 *
 * Overwriting is not the defect. Skipping rows that already carry a number
 * would leave two posters sharing a board, which is worse than a number an
 * organizer has to type back in, so the sweep stays total. What was wrong is
 * that it was silent: one press replaced every hand-set number in the hall
 * with no warning and no way back. So `?confirmRenumber=1` and a second press
 * carrying `confirm=yes`, but only when a number exists to lose. On a hall
 * nobody has numbered yet there is nothing to ask about.
 */
export async function autoNumberBoards(formData: FormData): Promise<void> {
  await requireRole('organizer');

  if (formData.get('confirm') !== 'yes') {
    const [held] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.format, 'poster'),
          eq(submissions.status, 'accepted'),
          isNotNull(submissions.boardNumber),
        ),
      )
      .limit(1);
    if (held) {
      redirect('/organizer/posters?confirmRenumber=1');
    }
  }

  const ids = await acceptedPosterIdsInTrackOrder();
  for (const [index, id] of ids.entries()) {
    await db
      .update(submissions)
      .set({ boardNumber: String(index + 1), updatedAt: new Date() })
      .where(eq(submissions.id, id));
  }

  revalidatePath('/organizer/posters');
  revalidatePath('/posters');
  // Back to the bare path. A revalidate alone re-renders the same URL, so the
  // confirmation banner would still be sitting over a hall that has just been
  // renumbered, offering to do it again.
  redirect('/organizer/posters');
}
