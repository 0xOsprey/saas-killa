'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { bookmarks } from '@/db/schema';
import { currentUser } from '@/lib/auth';

/**
 * Star or unstar a poster.
 *
 * A signed-out visitor is sent to sign in rather than shown a failure: the star
 * is the whole invitation to make an account, so refusing it with an error page
 * would be the wrong end of the funnel. The gallery already renders a link to
 * /login for a signed-out visitor; this branch catches the direct post.
 */
export async function toggleBookmark(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect('/login');

  const submissionId = z.string().uuid().parse(formData.get('submissionId'));

  // Delete first, insert only if nothing was deleted. One round trip decides,
  // where a read-then-write would let a double press insert twice and race the
  // primary key.
  const removed = await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.submissionId, submissionId)))
    .returning({ userId: bookmarks.userId });

  if (removed.length === 0) {
    await db
      .insert(bookmarks)
      .values({ userId: user.id, submissionId })
      .onConflictDoNothing();
  }

  revalidatePath('/posters');
  revalidatePath(`/posters/${submissionId}`);
  revalidatePath('/organizer/posters');
}
