import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Notice } from '@/components/ui';
import { currentUser } from '@/lib/auth';

/**
 * Ordered by the shape of the job rather than alphabetically: open the call,
 * decide on what came in, build the programme, then run the event's people and
 * prizes. Settings sits last because it is the tab you visit once.
 */
const TABS = [
  { href: '/organizer', label: 'Overview' },
  { href: '/organizer/cfp', label: 'Call for papers' },
  { href: '/organizer/submissions', label: 'Submissions' },
  { href: '/organizer/abstracts', label: 'Abstracts' },
  { href: '/organizer/evaluators', label: 'Evaluators' },
  { href: '/organizer/schedule', label: 'Schedule' },
  { href: '/organizer/rooms', label: 'Rooms & tracks' },
  { href: '/organizer/posters', label: 'Posters' },
  { href: '/organizer/speakers', label: 'Speakers' },
  { href: '/organizer/onboarding', label: 'Onboarding' },
  { href: '/organizer/awards', label: 'Awards' },
  { href: '/organizer/pages', label: 'Speaker info' },
  { href: '/organizer/embed', label: 'Embed' },
  { href: '/organizer/settings', label: 'Settings' },
];

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

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1 text-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="rounded-md px-3 py-1.5 text-muted hover:bg-slate-100 hover:text-ink"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
