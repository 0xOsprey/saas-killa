'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { submissions } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { linkField, saveUpload, uploadHref } from '@/lib/uploads';

const posterSchema = z.object({
  submissionId: z.string().uuid(),
  // Either an uploaded file's own path or a link to somebody else's server.
  posterUrl: linkField,
});

/**
 * Write the artwork onto one of the caller's own posters.
 *
 * Every refusal is a WHERE clause, not a check before the query, so a forged
 * submission id updates zero rows rather than someone else's poster:
 *
 *   - `speakerId` is the caller's, so it has to be theirs;
 *   - `format` must be 'poster', so this cannot smuggle artwork onto a talk;
 *   - `lockedFields` must not name posterUrl, which is the freeze an organizer
 *     sets when the printed programme has gone to the venue.
 *
 * Both doors into the column go through here, so an upload cannot quietly
 * acquire a weaker rule than a pasted link.
 *
 * The lock test is SQL rather than `isLocked`, and stays that way: reading the
 * row first and comparing in JavaScript reopens the gap between the read and
 * the update that putting it in the WHERE clause exists to close. It is safe
 * against the spelling problem `lockKey` guards, because `withLock` is the only
 * writer of this column and always stores the canonical `posterUrl` from
 * `LOCKABLE_FIELDS`.
 */
async function writePosterUrl(
  submissionId: string,
  speakerId: string,
  posterUrl: string | null,
): Promise<boolean> {
  const updated = await db
    .update(submissions)
    .set({ posterUrl, updatedAt: new Date() })
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.speakerId, speakerId),
        eq(submissions.format, 'poster'),
        sql`not (${submissions.lockedFields} @> '["posterUrl"]'::jsonb)`,
      ),
    )
    .returning({ id: submissions.id });
  return updated.length > 0;
}

function refreshPosterViews(submissionId: string): void {
  revalidatePath('/speaker/posters');
  revalidatePath('/posters');
  revalidatePath(`/posters/${submissionId}`);
}

/**
 * Set or replace the artwork by pasting a link.
 *
 * Zero rows updated is reported as a refusal rather than a silent success,
 * because a speaker who pasted a URL and saw nothing change would paste it
 * again.
 */
export async function savePosterUrl(formData: FormData): Promise<void> {
  const user = await requireUser();

  const parsed = posterSchema.safeParse({
    submissionId: formData.get('submissionId'),
    // Empty clears the artwork; that is the "replace" flow half-done, not an error.
    posterUrl: String(formData.get('posterUrl') ?? ''),
  });
  if (!parsed.success) redirect('/speaker/posters?error=url');

  if (!(await writePosterUrl(parsed.data.submissionId, user.id, parsed.data.posterUrl))) {
    redirect('/speaker/posters?error=refused');
  }

  refreshPosterViews(parsed.data.submissionId);
  redirect('/speaker/posters?saved=1');
}

/**
 * Upload the artwork instead of hosting it somewhere.
 *
 * The file is stored before the ownership check runs, and that ordering is
 * deliberate: `writePosterUrl` is the only thing that knows whether this poster
 * is the caller's, and asking it twice would mean two queries to save a few
 * kilobytes on a request that was already a refusal. A refused upload leaves an
 * orphan file, which is a wasted megabyte on a gitignored directory, and the
 * alternative was a second round trip on every legitimate upload.
 */
export async function uploadPoster(formData: FormData): Promise<void> {
  const user = await requireUser();
  const submissionId = z.string().uuid().safeParse(formData.get('submissionId'));
  if (!submissionId.success) redirect('/speaker/posters?error=refused');

  const result = await saveUpload({
    file: formData.get('posterFile'),
    kind: 'poster',
    ownerId: user.id,
    submissionId: submissionId.data,
  });
  if (!result.ok) {
    redirect(`/speaker/posters?message=${encodeURIComponent(result.reason)}`);
  }

  if (!(await writePosterUrl(submissionId.data, user.id, uploadHref(result.upload)))) {
    redirect('/speaker/posters?error=refused');
  }

  refreshPosterViews(submissionId.data);
  redirect('/speaker/posters?saved=1');
}
