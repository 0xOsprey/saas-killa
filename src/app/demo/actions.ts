'use server';

import { redirect } from 'next/navigation';
import type { Role } from '@/db/schema';
import { DemoAccessError, startDemoSession } from '@/lib/demo';

export type DemoLoginState = { error?: string };

export async function demoLogin(
  _prev: DemoLoginState,
  formData: FormData,
): Promise<DemoLoginState> {
  const role = formData.get('role') as Role | null;
  const secret = (formData.get('secret') as string | null) ?? undefined;

  if (!role) return { error: 'Pick a role.' };

  try {
    const home = await startDemoSession(role, secret);
    redirect(home);
  } catch (err) {
    if (err instanceof DemoAccessError) {
      return { error: err.message };
    }
    throw err;
  }
}
