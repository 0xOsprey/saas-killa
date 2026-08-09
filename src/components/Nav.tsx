import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { getEvent } from '@/lib/queries';
import { Badge } from './ui';

/**
 * Navigation is role-derived. A reviewer never sees an organizer link, which
 * keeps the surface honest: the guard in each server action is the real control,
 * and hiding the link stops the UI from advertising doors it will not open.
 */
export async function Nav() {
  const [user, event] = await Promise.all([
    currentUser(),
    getEvent().catch(() => null),
  ]);

  const links: { href: string; label: string }[] = [
    { href: '/agenda', label: 'Agenda' },
    { href: '/posters', label: 'Posters' },
    { href: '/speakers', label: 'Speakers' },
    { href: '/awards', label: 'Awards' },
  ];
  if (user) {
    links.push({ href: '/speaker', label: 'My submissions' });
    links.push({ href: '/speaker/pages', label: 'Speaker info' });
    // Account-level rather than per-submission, so it has nowhere on the
    // submission cards to hang. Without a link the only route to it is a typed
    // URL, which is how the organizer stayed the table's only writer.
    links.push({ href: '/speaker/availability', label: 'Availability' });
    links.push({ href: '/speaker/profile', label: 'Profile' });
  }
  if (user?.roles.includes('reviewer')) {
    links.push({ href: '/review', label: 'Review' });
    // Load-bearing rather than cosmetic: committee balloting lives outside the
    // organizer layout precisely so a reviewer can reach it, and without this
    // link their only route to it is a typed URL.
    links.push({ href: '/awards/judge', label: 'Judge awards' });
  }
  if (user?.roles.includes('organizer')) {
    links.push({ href: '/organizer', label: 'Organize' });
  }

  return (
    <header className="border-b border-line bg-white">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
          {event?.name ?? 'Sessionboard'}
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-muted hover:text-ink">
              {link.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span className="hidden text-muted sm:inline" data-testid="current-user">
                {user.email}
              </span>
              {user.roles.includes('organizer') ? <Badge tone="accent">organizer</Badge> : null}
              {/* A form, not a link: see the comment in app/auth/logout/route.ts. */}
              <form method="post" action="/auth/logout">
                <button type="submit" className="text-muted hover:text-ink" data-testid="sign-out">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link href="/login" className="text-muted hover:text-ink">
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
