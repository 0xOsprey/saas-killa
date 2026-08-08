'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { awardNominees, awardVotes } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { MAX_CRITERION_SCORE, MIN_CRITERION_SCORE, awardDetail, committeeOpen } from '@/lib/awards';

/**
 * Cast or move a committee ballot.
 *
 * This action lives under `/awards/judge` rather than `/organizer/awards`
 * because a reviewer holds no organizer role: under the organizer layout the
 * page answered "Organizer access only.", so the reviewer half of this check
 * was unreachable through the UI and committee judging was organizer-only in
 * practice.
 */
export async function castCommitteeVote(formData: FormData): Promise<void> {
  const judge = await requireRole('organizer', 'reviewer');
  const input = z
    .object({ awardId: z.string().uuid(), submissionId: z.string().uuid() })
    .parse({
      awardId: formData.get('awardId'),
      submissionId: formData.get('submissionId'),
    });

  const detail = await awardDetail(input.awardId);
  if (!detail) redirect('/awards/judge?ballot=unknown');
  if (!committeeOpen(detail.award)) redirect('/awards/judge?ballot=closed');

  const nominee = await db.query.awardNominees.findFirst({
    where: and(
      eq(awardNominees.awardId, input.awardId),
      eq(awardNominees.submissionId, input.submissionId),
    ),
  });
  if (!nominee) redirect('/awards/judge?ballot=not_nominated');

  /**
   * A rubric award wants a score per criterion; an award with no criteria
   * behaves exactly as v1 did, one unweighted pick with a null breakdown. A
   * partially filled rubric is rejected rather than averaged over the answers
   * given, which would let a judge raise a mean by leaving a weak criterion
   * blank.
   */
  let scores: Record<string, number> | null = null;
  if (detail.criteria.length > 0) {
    const collected: Record<string, number> = {};
    for (const criterion of detail.criteria) {
      const raw = Number(formData.get(`score_${criterion.key}`));
      if (
        !Number.isInteger(raw) ||
        raw < MIN_CRITERION_SCORE ||
        raw > MAX_CRITERION_SCORE
      ) {
        redirect('/awards/judge?ballot=incomplete');
      }
      collected[criterion.key] = raw;
    }
    scores = collected;
  }

  await db
    .insert(awardVotes)
    .values({
      awardId: input.awardId,
      submissionId: input.submissionId,
      judgeId: judge.id,
      channel: 'committee',
      scores,
    })
    .onConflictDoUpdate({
      target: [awardVotes.awardId, awardVotes.judgeId, awardVotes.channel],
      set: { submissionId: input.submissionId, scores, createdAt: sql`now()` },
    });

  revalidatePath('/awards/judge');
  revalidatePath('/awards');
  revalidatePath('/organizer/awards');
  redirect('/awards/judge?ballot=ok');
}
