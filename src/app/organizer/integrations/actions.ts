'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth';
import { runExport } from '@/lib/accelevents';

/**
 * Push the programme to Accelevents.
 *
 * `requireRole` again rather than relying on the organizer layout: a layout
 * guard does not run for a direct action invocation, and this is the one button
 * in the app that can put data on somebody else's server.
 *
 * The redirect lands on the run that was just made, so the screen after the
 * click is the list of calls rather than a page that says "done".
 */
export async function runAcceleventsExport(): Promise<void> {
  const actor = await requireRole('organizer');
  const result = await runExport({ actorId: actor.id });
  revalidatePath('/organizer/integrations');
  redirect(`/organizer/integrations?run=${result.runId}`);
}
