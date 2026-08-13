'use server';

import { redirect } from 'next/navigation';
import type { Role } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { DemoAccessError, startImpersonationSession } from '@/lib/demo';

export type ImpersonateState = { error?: string };

export async function impersonateRole(
  _prev: ImpersonateState,
  formData: FormData,
): Promise<ImpersonateState> {
  await requireRole('organizer');

  const role = formData.get('role') as Role | null;
  if (!role) return { error: 'Pick a role.' };

  try {
    const home = await startImpersonationSession(role);
    redirect(home);
  } catch (err) {
    if (err instanceof DemoAccessError) {
      return { error: err.message };
    }
    throw err;
  }
}
