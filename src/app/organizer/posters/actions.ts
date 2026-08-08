'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
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
 * It overwrites. A partial renumber would leave two posters sharing a board,
 * which is worse than a number an organizer has to type back in.
 */
export async function autoNumberBoards(): Promise<void> {
  await requireRole('organizer');

  const ids = await acceptedPosterIdsInTrackOrder();
  for (const [index, id] of ids.entries()) {
    await db
      .update(submissions)
      .set({ boardNumber: String(index + 1), updatedAt: new Date() })
      .where(eq(submissions.id, id));
  }

  revalidatePath('/organizer/posters');
  revalidatePath('/posters');
}
