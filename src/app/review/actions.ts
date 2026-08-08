'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { reviews, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';

const schema = z.object({
  submissionId: z.string().uuid(),
  score: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(4000).optional(),
});

/**
 * Record or replace this reviewer's grade. Upsert rather than insert, so a
 * reviewer who changes their mind moves their own score instead of stacking a
 * second one and quietly double-weighting themselves in the average.
 */
export async function submitReview(formData: FormData): Promise<void> {
  const reviewer = await requireRole('reviewer', 'organizer');
  const input = schema.parse({
    submissionId: formData.get('submissionId'),
    score: formData.get('score'),
    comment: (formData.get('comment') as string | null)?.trim() || undefined,
  });

  // Grading a submission that has already been decided would not change the
  // outcome and would make the average shift under the organizer's feet.
  const target = await db.query.submissions.findFirst({
    where: eq(submissions.id, input.submissionId),
  });
  if (!target || target.status !== 'submitted') return;

  // A reviewer may not grade their own proposal.
  if (target.speakerId === reviewer.id) return;

  await db
    .insert(reviews)
    .values({
      submissionId: input.submissionId,
      reviewerId: reviewer.id,
      score: input.score,
      comment: input.comment ?? null,
      source: 'human',
    })
    .onConflictDoUpdate({
      target: [reviews.submissionId, reviews.reviewerId],
      set: { score: input.score, comment: input.comment ?? null, createdAt: sql`now()` },
    });

  revalidatePath('/review');
  revalidatePath('/organizer/submissions');
}
