'use server';

import { and, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { awardNominees, awardVotes, awards, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';

function revalidateAwards() {
  revalidatePath('/organizer/awards');
  revalidatePath('/agenda');
}

export async function createAward(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ name: z.string().min(2).max(120), description: z.string().max(1000).optional() })
    .parse({
      name: (formData.get('name') as string | null)?.trim(),
      description: (formData.get('description') as string | null)?.trim() || undefined,
    });

  await db.insert(awards).values({ name: input.name, description: input.description ?? null });
  revalidateAwards();
}

const nomineeSchema = z.object({
  awardId: z.string().uuid(),
  submissionId: z.string().uuid(),
});

export async function nominate(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = nomineeSchema.parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
  });

  // Only accepted work can be nominated: an award for a talk nobody will see
  // is not a thing an organizer means to create.
  const target = await db.query.submissions.findFirst({
    where: eq(submissions.id, input.submissionId),
  });
  if (!target || target.status !== 'accepted') return;

  await db.insert(awardNominees).values(input).onConflictDoNothing();
  revalidateAwards();
}

export async function withdrawNomination(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = nomineeSchema.parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
  });
  await db
    .delete(awardNominees)
    .where(
      and(
        eq(awardNominees.awardId, input.awardId),
        eq(awardNominees.submissionId, input.submissionId),
      ),
    );
  revalidateAwards();
}

/**
 * Cast or move a judge's vote. The primary key is (awardId, judgeId), so the
 * upsert enforces one vote per judge per award structurally rather than by a
 * check that could be raced.
 */
export async function castVote(formData: FormData): Promise<void> {
  const judge = await requireRole('organizer', 'reviewer');
  const input = nomineeSchema.parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
  });

  const award = await db.query.awards.findFirst({ where: eq(awards.id, input.awardId) });
  if (!award || award.votingClosedAt) return;

  await db
    .insert(awardVotes)
    .values({ ...input, judgeId: judge.id })
    .onConflictDoUpdate({
      target: [awardVotes.awardId, awardVotes.judgeId],
      set: { submissionId: input.submissionId, createdAt: sql`now()` },
    });

  revalidateAwards();
}

/**
 * Close voting and declare the winner: whichever nominee has the most votes.
 * A tie resolves to the earliest-nominated submission rather than at random,
 * so re-running the close produces the same result.
 */
export async function closeVoting(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));

  const tally = await db
    .select({
      submissionId: awardVotes.submissionId,
      votes: sql<number>`count(*)::int`,
    })
    .from(awardVotes)
    .where(eq(awardVotes.awardId, awardId))
    .groupBy(awardVotes.submissionId)
    .orderBy(desc(sql`count(*)`));

  await db
    .update(awards)
    .set({
      votingClosedAt: new Date(),
      winnerSubmissionId: tally[0]?.submissionId ?? null,
    })
    .where(eq(awards.id, awardId));

  revalidateAwards();
}

export async function reopenVoting(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));
  await db
    .update(awards)
    .set({ votingClosedAt: null, winnerSubmissionId: null })
    .where(eq(awards.id, awardId));
  revalidateAwards();
}
