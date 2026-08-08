'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { reviews, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { RUBRIC_KEYS, weightedScore, type RubricKey } from '@/lib/rubric';

const criterion = z.coerce.number().int().min(1).max(5);

const schema = z.object({
  submissionId: z.string().uuid(),
  comment: z.string().max(4000).optional(),
});

/**
 * Record or replace this reviewer's grade. Upsert rather than insert, so a
 * reviewer who changes their mind moves their own score instead of stacking a
 * second one and quietly double-weighting themselves in the average.
 *
 * The form posts four criteria; `reviews.score` is their weighted mean, so the
 * organizer screen, the award tally and the AI comparison all keep reading one
 * integer off the same column they always did.
 */
export async function submitReview(formData: FormData): Promise<void> {
  const reviewer = await requireRole('reviewer', 'organizer');
  const input = schema.parse({
    submissionId: formData.get('submissionId'),
    comment: (formData.get('comment') as string | null)?.trim() || undefined,
  });

  const rubric = Object.fromEntries(
    RUBRIC_KEYS.map((key) => [key, criterion.parse(formData.get(`rubric-${key}`))]),
  ) as Record<RubricKey, number>;
  const score = weightedScore(rubric);

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
      score,
      rubric,
      comment: input.comment ?? null,
      source: 'human',
    })
    .onConflictDoUpdate({
      target: [reviews.submissionId, reviews.reviewerId],
      set: { score, rubric, comment: input.comment ?? null, createdAt: sql`now()` },
    });

  revalidatePath('/review');
  revalidatePath('/organizer/submissions');
  revalidatePath('/organizer/cfp');
}
