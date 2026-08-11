'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { currentUser } from '@/lib/auth';
import { addFileComment as writeComment, commentableSeries, commentField } from '@/lib/uploads';

/**
 * Commenting on a file, from either side.
 *
 * One action rather than a speaker copy and an organizer copy, because the
 * thread is one thread: two actions writing the same table would be two places
 * for the authorization rule to drift, and the rule is the whole feature. Who
 * may post is decided by `commentableSeries`, which is narrower than who may
 * read the file.
 */

const commentSchema = z.object({
  seriesId: z.string().uuid(),
  body: commentField,
  returnTo: z.string(),
});

/**
 * The screens this action will send a browser back to.
 *
 * A form field naming the destination is an open redirect unless something
 * checks it, and "starts with /" is not that check: `//evil.example` starts
 * with a slash and is an absolute URL to a browser.
 */
const RETURN_ROUTES = ['/speaker/content', '/organizer/files'];

function safeReturn(raw: string): string {
  const route = RETURN_ROUTES.find(
    (allowed) => raw === allowed || raw.startsWith(`${allowed}/`) || raw.startsWith(`${allowed}?`),
  );
  return route ? raw : '/organizer/files';
}

export async function addFileComment(formData: FormData): Promise<void> {
  const viewer = await currentUser();
  const input = commentSchema.parse({
    seriesId: formData.get('seriesId'),
    body: formData.get('body'),
    returnTo: formData.get('returnTo'),
  });

  const destination = safeReturn(input.returnTo);
  const seriesId = await commentableSeries(input.seriesId, viewer);
  // A refusal is a silent return to the same screen, matching `/files/<id>`:
  // saying "you may not comment on that file" tells an outsider the file is
  // there, which is most of what the read rule is protecting.
  if (!seriesId || !viewer) redirect(destination);

  await writeComment({ seriesId, authorId: viewer.id, body: input.body });

  revalidatePath('/speaker/content');
  revalidatePath('/organizer/files');
  revalidatePath(`/organizer/files/${seriesId}`);
  redirect(destination);
}
