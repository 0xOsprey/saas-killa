'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Menu } from 'lucide-react';
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
  children,
}: {
  user: CurrentUser | null;
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
            <Menu className="h-5 w-5" />
          </button>

          <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
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

          <div className="ml-auto flex items-center text-sm">
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
