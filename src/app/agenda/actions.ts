'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { bookmarks } from '@/db/schema';
import { currentUser } from '@/lib/auth';

/**
 * Star or unstar a submission. One gesture on one row: the poster gallery's
 * star writes the same `bookmarks` row, so starring a poster in the gallery and
 * starring it on the agenda are the same act, not two.
 *
 * Delete-then-insert rather than read-then-branch. The delete reports whether
 * it removed anything, which is the state read the branch needed, so two
 * concurrent taps settle on a state instead of racing between the read and the
 * write.
 */
export async function toggleBookmark(formData: FormData): Promise<void> {
  const user = await currentUser();
  // A signed-out star is a sign-in prompt, not a failure. The page renders a
  // link straight to /login for this case; the redirect here covers a direct
  // invocation, which the layout guard never sees.
  if (!user) redirect('/login');

  const submissionId = z.string().uuid().parse(formData.get('submissionId'));

  const [removed] = await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.submissionId, submissionId)))
    .returning();

  if (!removed) {
    // No status check on the submission, on purpose. Refusing to star anything
    // but an accepted talk would turn this action into an oracle for decisions
    // that have not been announced. A bookmark on a row the agenda does not
    // publish is inert: every read path filters to accepted anyway.
    await db.insert(bookmarks).values({ userId: user.id, submissionId }).onConflictDoNothing();
  }

  revalidatePath('/agenda');
  revalidatePath('/posters');
}
