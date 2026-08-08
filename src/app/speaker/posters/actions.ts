'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { submissions } from '@/db/schema';
import { requireUser } from '@/lib/auth';

const posterSchema = z.object({
  submissionId: z.string().uuid(),
  posterUrl: z.string().url().nullable(),
});

/**
 * Set or replace the artwork for one of the caller's own posters.
 *
 * Every refusal is a WHERE clause, not a check before the query, so a forged
 * submission id updates zero rows rather than someone else's poster:
 *
 *   - `speakerId` is the caller's, so it has to be theirs;
 *   - `format` must be 'poster', so this cannot smuggle artwork onto a talk;
 *   - `lockedFields` must not name posterUrl, which is the freeze an organizer
 *     sets when the printed programme has gone to the venue.
 *
 * Zero rows updated is reported as a refusal rather than a silent success,
 * because a speaker who pasted a URL and saw nothing change would paste it
 * again.
 */
export async function savePosterUrl(formData: FormData): Promise<void> {
  const user = await requireUser();

  const raw = (formData.get('posterUrl') as string | null)?.trim() ?? '';
  const parsed = posterSchema.safeParse({
    submissionId: formData.get('submissionId'),
    // Empty clears the artwork; that is the "replace" flow half-done, not an error.
    posterUrl: raw === '' ? null : raw,
  });
  if (!parsed.success) redirect('/speaker/posters?error=url');

  const updated = await db
    .update(submissions)
    .set({ posterUrl: parsed.data.posterUrl, updatedAt: new Date() })
    .where(
      and(
        eq(submissions.id, parsed.data.submissionId),
        eq(submissions.speakerId, user.id),
        eq(submissions.format, 'poster'),
        sql`not (${submissions.lockedFields} @> '["posterUrl"]'::jsonb)`,
      ),
    )
    .returning({ id: submissions.id });

  if (updated.length === 0) redirect('/speaker/posters?error=refused');

  revalidatePath('/speaker/posters');
  revalidatePath('/posters');
  revalidatePath(`/posters/${parsed.data.submissionId}`);
  redirect('/speaker/posters?saved=1');
}
