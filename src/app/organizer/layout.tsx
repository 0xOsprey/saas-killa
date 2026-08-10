import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Notice } from '@/components/ui';
import { currentUser } from '@/lib/auth';

/**
 * The organization's own people, not this event's. Split out of the event tabs
 * and rendered above them because a contact directory nested inside one event's
 * menu reads as that event's roster, which is the thing it is not: these rows
 * outlive any single conference and carry the history across all of them. The
 * caption above each group is what makes the boundary legible without a second
 * page load, so the two lists are never merged back into one row.
 */
const ORG_TABS = [
  { href: '/organizer/contacts', label: 'Contacts' },
  { href: '/organizer/contacts/pipeline', label: 'Pipeline' },
  { href: '/organizer/contacts/import', label: 'Import' },
];

/**
 * Ordered by the shape of the job rather than alphabetically: open the call,
 * decide on what came in, build the programme, then run the event's people and
 * prizes. Settings sits last because it is the tab you visit once.
 */
const TABS = [
  { href: '/organizer', label: 'Overview' },
  { href: '/organizer/cfp', label: 'Call for papers' },
  { href: '/organizer/rounds', label: 'Review rounds' },
  { href: '/organizer/submissions', label: 'Submissions' },
  { href: '/organizer/abstracts', label: 'Abstracts' },
  { href: '/organizer/files', label: 'Files' },
  { href: '/organizer/evaluators', label: 'Evaluators' },
  { href: '/organizer/schedule', label: 'Schedule' },
  { href: '/organizer/rooms', label: 'Rooms & tracks' },
  { href: '/organizer/posters', label: 'Posters' },
  { href: '/organizer/speakers', label: 'Speakers' },
  { href: '/organizer/onboarding', label: 'Onboarding' },
  { href: '/organizer/awards', label: 'Awards' },
  { href: '/organizer/pages', label: 'Speaker info' },
  { href: '/organizer/email', label: 'Email log' },
  { href: '/organizer/embed', label: 'Embed' },
  { href: '/organizer/integrations', label: 'Accelevents' },
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
      <div className="space-y-2">
        <nav className="rounded-lg border border-line bg-white p-1 text-sm">
          <p className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Organization
          </p>
          <div className="flex flex-wrap gap-1">
            {ORG_TABS.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className="rounded-md px-3 py-1.5 text-muted hover:bg-slate-100 hover:text-ink"
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
        <nav className="rounded-lg border border-line bg-white p-1 text-sm">
          <p className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            This event
          </p>
          <div className="flex flex-wrap gap-1">
            {TABS.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className="rounded-md px-3 py-1.5 text-muted hover:bg-slate-100 hover:text-ink"
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
      {children}
    </div>
  );
}
