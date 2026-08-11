'use client';

import { ChevronDown, LogOut, Moon, Settings, Sun, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Avatar, cn } from '@/components/ui';
import type { CurrentUser } from '@/lib/auth';

export function UserMenu({
  user,
  homeHref,
  theme,
}: {
  user: CurrentUser;
  homeHref: string;
  theme: 'light' | 'ai-engineer';
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? '';
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const onOrganizer = pathname.startsWith('/organizer');
  const onSpeakerOrReviewer =
    pathname.startsWith('/speaker') || pathname.startsWith('/review');
  const showAdmin = user.roles.includes('organizer') && !onOrganizer;

  const profileHref = user.roles.includes('speaker')
    ? '/speaker/profile'
    : '/organizer/settings';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex items-center gap-2 rounded-full border border-line/50 bg-surface p-1 pr-2.5 text-sm',
          'transition-colors hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
          open && 'bg-ink/5',
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar
          src={user.headshotUrl}
          name={user.name}
          email={user.email}
          size="sm"
        />
        <span className="sr-only" data-testid="current-user">
          {user.email}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          className={cn(
            'absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg border border-line/50 bg-surface shadow-lg',
            'origin-top-right',
          )}
          role="menu"
          aria-label="User menu"
        >
          <div className="border-b border-line px-4 py-3">
            {user.name ? (
              <>
                <p className="truncate text-sm font-medium text-ink">
                  {user.name}
                </p>
                <p className="truncate text-xs text-muted">{user.email}</p>
              </>
            ) : (
              <p className="truncate text-sm font-medium text-ink">
                {user.email}
              </p>
            )}
          </div>

          <div className="py-1">
            <Link
              href={profileHref}
              onClick={() => setOpen(false)}
              className={cn(
                'flex items-center gap-2.5 px-4 py-2 text-sm text-muted transition-colors',
                'hover:bg-ink/5 hover:text-ink',
              )}
              role="menuitem"
            >
              <User className="h-4 w-4" aria-hidden="true" />
              Profile
            </Link>

            <form
              method="get"
              action="/theme"
              className="contents"
            >
              <input type="hidden" name="set" value={theme === 'ai-engineer' ? 'light' : 'ai-engineer'} />
              <input type="hidden" name="redirect" value={pathname} />
              <button
                type="submit"
                className={cn(
                  'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-muted transition-colors',
                  'hover:bg-ink/5 hover:text-ink',
                )}
                role="menuitem"
              >
                {theme === 'ai-engineer' ? (
                  <Sun className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Moon className="h-4 w-4" aria-hidden="true" />
                )}
                {theme === 'ai-engineer' ? 'Switch to light mode' : 'Switch to dark mode'}
              </button>
            </form>

            {showAdmin && (
              <Link
                href={homeHref}
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2.5 px-4 py-2 text-sm text-muted transition-colors',
                  'hover:bg-ink/5 hover:text-ink',
                )}
                role="menuitem"
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
                {onSpeakerOrReviewer ? 'Back to Admin Mode' : 'Admin'}
              </Link>
            )}

            <form
              method="post"
              action="/auth/logout"
              className="contents"
            >
              <button
                type="submit"
                data-testid="sign-out"
                className={cn(
                  'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-muted transition-colors',
                  'hover:bg-ink/5 hover:text-ink',
                )}
                role="menuitem"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
