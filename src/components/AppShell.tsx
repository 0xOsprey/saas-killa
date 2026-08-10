'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Badge, cn } from '@/components/ui';
import {
  EVENT_SECTION,
  ORGANIZATION_SECTION,
  PUBLIC_LINKS,
  REVIEWER_SECTION,
  SPEAKER_SECTION,
  type NavSection,
  type NavUser,
} from '@/lib/nav-links';
import { Sidebar } from './Sidebar';

function roleSections(roles: string[]): NavSection[] {
  if (roles.includes('organizer')) return [ORGANIZATION_SECTION, EVENT_SECTION];
  if (roles.includes('reviewer')) return [REVIEWER_SECTION];
  if (roles.includes('speaker')) return [SPEAKER_SECTION];
  return [];
}

function isActive(href: string, activePath: string): boolean {
  const [base] = href.split('?');
  if (!activePath) return false;
  return activePath === base || activePath.startsWith(base + '/');
}

export function AppShell({
  user,
  eventName,
  children,
}: {
  user: NavUser | null;
  eventName: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const [activePath, setActivePath] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setActivePath(pathname);
  }, [pathname]);

  const sections = useMemo(() => (user ? roleSections(user.roles) : []), [user]);

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="sticky top-0 z-50 border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="-ml-2 rounded-md p-2 text-muted hover:bg-subtle hover:text-ink lg:hidden"
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <Link
            href="/"
            className="text-sm font-semibold tracking-tight text-ink"
          >
            {eventName ?? 'Saas Killa'}
          </Link>

          <nav className="hidden items-center gap-1 text-sm md:flex">
            {PUBLIC_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'rounded-md px-2.5 py-1.5 transition-colors',
                  isActive(link.href, activePath)
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted hover:bg-subtle hover:text-ink',
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            {user ? (
              <>
                <span
                  className="hidden text-muted sm:inline"
                  data-testid="current-user"
                >
                  {user.email}
                </span>
                {user.roles.includes('organizer') && (
                  <Badge tone="accent">organizer</Badge>
                )}
                <form method="post" action="/auth/logout">
                  <button
                    type="submit"
                    className="text-muted hover:text-ink"
                    data-testid="sign-out"
                  >
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link
                href="/login"
                className="rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-subtle hover:text-ink"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="relative mx-auto flex w-full max-w-7xl flex-1">
        <Sidebar
          user={user}
          sections={sections}
          activePath={activePath}
          mobileOpen={mobileOpen}
          onClose={() => setMobileOpen(false)}
        />

        <main
          className={cn(
            'w-full px-4 py-8',
            user ? 'flex-1 max-w-6xl' : 'mx-auto max-w-6xl',
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
        clipRule="evenodd"
      />
    </svg>
  );
}
