'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { reviews, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { activeRound } from '@/lib/rounds';
import { RUBRIC_KEYS, weightedScore, type RubricKey } from '@/lib/rubric';

const criterion = z.coerce.number().int().min(1).max(5);

const schema = z.object({
  submissionId: z.string().uuid(),
  comment: z.string().max(4000).optional(),
});

/**
 * Send the reviewer back to the queue with a reason.
 *
 * Every refusal below used to be a bare `return`: no message, no redirect, no
 * `revalidatePath`. The reviewer filled in four criteria and a comment, pressed
 * Grade, and the page came back identical with the grade gone. `castCommitteeVote`
 * in the award feature already does this properly, and this is the same shape.
 */
function refuse(reason: 'decided' | 'own' | 'no_round'): never {
  redirect(`/review?grade=${reason}`);
}

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
  if (!target || target.status !== 'submitted') refuse('decided');

  // A reviewer may not grade their own proposal.
  if (target.speakerId === reviewer.id) refuse('own');

  // A grade belongs to a round. With no round open there is nothing to file it
  // against, and silently writing it into the last closed one would reopen a
  // pass the committee has already reported on.
  const round = await activeRound();
  if (!round) refuse('no_round');

  await db
    .insert(reviews)
    .values({
      roundId: round.id,
      submissionId: input.submissionId,
      reviewerId: reviewer.id,
      score,
      rubric,
      comment: input.comment ?? null,
      source: 'human',
    })
    .onConflictDoUpdate({
      target: [reviews.roundId, reviews.submissionId, reviews.reviewerId],
      set: { score, rubric, comment: input.comment ?? null, createdAt: sql`now()` },
    });

  revalidatePath('/review');
  revalidatePath('/organizer/submissions');
  revalidatePath('/organizer/cfp');
}
