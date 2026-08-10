'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { restoreRevision } from '@/lib/revisions';

/**
 * The restore control on the revision history.
 *
 * A plain server-action form rather than `useActionState`, so the history page
 * stays a server component and the panel it renders is read back from the
 * database after the write instead of from a client component's held state.
 * The outcome travels in the query string, which is also what makes the reload
 * an organizer does next show the restored text rather than a stale render.
 *
 * The role is re-checked here. The layout guard does not run for a direct
 * action invocation.
 */

const schema = z.object({
  submissionId: z.string().uuid(),
  revisionId: z.string().uuid(),
});

export async function restoreRevisionAction(formData: FormData): Promise<void> {
  const organizer = await requireRole('organizer');

  const parsed = schema.safeParse({
    submissionId: formData.get('submissionId'),
    revisionId: formData.get('revisionId'),
  });
  if (!parsed.success) redirect('/organizer/abstracts');
  const { submissionId, revisionId } = parsed.data;

  const result = await restoreRevision({ revisionId, submissionId, editorId: organizer.id });

  const history = `/organizer/abstracts/${submissionId}/history`;
  if (!result.ok) {
    redirect(`${history}?error=${encodeURIComponent(result.reason)}`);
  }

  revalidatePath('/organizer/abstracts');
  revalidatePath(`/organizer/abstracts/${submissionId}`);
  revalidatePath(history);
  revalidatePath('/organizer/abstracts/book');
  revalidatePath('/organizer/submissions');
  revalidatePath(`/agenda/${submissionId}`);
  revalidatePath('/speaker');

  // "Nothing changed" is a real outcome worth saying out loud: it means the
  // field already held that version, which an organizer who pressed the wrong
  // card needs told rather than left to infer from an unchanged page.
  redirect(`${history}?restored=${result.changed ? '1' : 'same'}&field=${result.field}`);
}
