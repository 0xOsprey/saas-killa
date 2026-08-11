'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useMemo, useState } from 'react';
import { ICONS } from '@/lib/icons';
import { cn } from '@/components/ui';
import { PUBLIC_LINKS, roleSections } from '@/lib/nav-links';
import type { CurrentUser } from '@/lib/auth';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';

function isActive(href: string, activePath: string): boolean {
  const [base] = href.split('?');
  if (!activePath) return false;
  return activePath === base || activePath.startsWith(base + '/');
}

export function AppShell({
  user,
  eventName,
  theme,
  children,
}: {
  user: CurrentUser | null;
  eventName: string | null;
  theme: 'light' | 'ai-engineer';
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const [activePath, setActivePath] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  useLayoutEffect(() => {
    setActivePath(pathname);
  }, [pathname]);

  const sections = useMemo(() => (user ? roleSections(user.roles) : []), [user]);

  const homeHref = useMemo(() => {
    if (!user) return '/';
    if (user.roles.includes('organizer')) return '/organizer';
    if (user.roles.includes('reviewer')) return '/review';
    return '/speaker';
  }, [user]);

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-50 border-b border-line/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="-ml-2 rounded-md p-2 text-muted transition-colors hover:bg-ink/5 hover:text-ink lg:hidden"
            aria-label="Open menu"
          >
            <ICONS.Menu className="h-5 w-5" />
          </button>

          <Link
            href={homeHref}
            className="font-display text-lg tracking-tight text-ink"
          >
            {eventName ?? 'Saas Killa'}
          </Link>

          <nav className="hidden items-center gap-1 text-xs font-mono uppercase tracking-wider md:flex">
            {PUBLIC_LINKS.map((link) => {
              const PublicIcon = link.icon ? ICONS[link.icon] : undefined;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors',
                    isActive(link.href, activePath)
                      ? 'bg-ink/10 font-medium text-ink'
                      : 'text-muted hover:bg-ink/5 hover:text-ink',
                  )}
                >
                  {PublicIcon ? <PublicIcon className="h-4 w-4" aria-hidden="true" /> : null}
                  {link.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link
              href={`/theme?set=${theme === 'ai-engineer' ? 'light' : 'ai-engineer'}&redirect=${encodeURIComponent(pathname)}`}
              className="rounded-full border border-line/50 bg-surface px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ink transition-colors hover:bg-ink/5"
              aria-label={theme === 'ai-engineer' ? 'Switch to light theme' : 'Switch to AI Engineer theme'}
            >
              {theme === 'ai-engineer' ? 'Light' : 'AI Engineer'}
            </Link>
            {user ? (
              <UserMenu
                user={user}
                homeHref={
                  user.roles.includes('organizer')
                    ? '/organizer'
                    : user.roles.includes('reviewer')
                      ? '/review'
                      : '/speaker'
                }
              />
            ) : (
              <Link
                href="/login"
                className="rounded-full border border-line/50 bg-surface px-4 py-1.5 text-xs font-mono uppercase tracking-wider text-ink transition-colors hover:bg-ink/5"
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
