'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { awardNominees, awardVotes, awards } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { communityWindow } from '@/lib/awards';

/**
 * Cast or move an attendee's ballot.
 *
 * The window is enforced here, not by hiding the button. Hiding it is a
 * courtesy to someone reading the page; this is the control, and it is what a
 * form replayed after the deadline meets.
 */
export async function castCommunityVote(formData: FormData): Promise<void> {
  const voter = await requireUser();
  const input = z
    .object({ awardId: z.string().uuid(), submissionId: z.string().uuid() })
    .parse({
      awardId: formData.get('awardId'),
      submissionId: formData.get('submissionId'),
    });

  const award = await db.query.awards.findFirst({ where: eq(awards.id, input.awardId) });
  if (!award) redirect('/awards?vote=unknown');
  if (communityWindow(award) !== 'open') redirect('/awards?vote=closed');

  // Only a nominee can be voted for, so a hand-posted submission id cannot
  // enter a tally the organizers never put it in.
  const nominee = await db.query.awardNominees.findFirst({
    where: and(
      eq(awardNominees.awardId, input.awardId),
      eq(awardNominees.submissionId, input.submissionId),
    ),
  });
  if (!nominee) redirect('/awards?vote=not_nominated');

  // One ballot per person per award per channel, enforced by the primary key
  // rather than by a read-then-write that two tabs could race.
  await db
    .insert(awardVotes)
    .values({
      awardId: input.awardId,
      submissionId: input.submissionId,
      judgeId: voter.id,
      channel: 'community',
      scores: null,
    })
    .onConflictDoUpdate({
      target: [awardVotes.awardId, awardVotes.judgeId, awardVotes.channel],
      set: { submissionId: input.submissionId, createdAt: sql`now()` },
    });

  revalidatePath('/awards');
  revalidatePath('/organizer/awards');
  redirect('/awards?vote=ok');
}
