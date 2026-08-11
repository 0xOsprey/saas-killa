import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/ui';
import { currentUser } from '@/lib/auth';

/**
 * The organizer gate. This is defence in depth, not the control: every server
 * action under this route calls `requireRole('organizer')` itself, because a
 * layout guard does not run for a direct action invocation.
 */
export default async function OrganizerLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.roles.includes('organizer')) {
    return <Notice tone="bad">Organizer access only.</Notice>;
  }

  return <>{children}</>;
}
