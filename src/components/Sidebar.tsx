'use client';

import Link from 'next/link';
import { Badge, cn } from '@/components/ui';
import { PUBLIC_LINKS, type NavSection, type NavUser } from '@/lib/nav-links';

function isActive(href: string, activePath: string): boolean {
  const [base] = href.split('?');
  if (!activePath) return false;
  return activePath === base || activePath.startsWith(base + '/');
}

export function Sidebar({
  user,
  sections,
  activePath,
  mobileOpen,
  onClose,
}: {
  user: NavUser | null;
  sections: NavSection[];
  activePath: string;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          'z-40 w-56 shrink-0 border-r border-line bg-white',
          'fixed left-0 top-14 h-[calc(100vh-3.5rem)] transform transition-transform',
          'lg:sticky lg:top-14 lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          !user && 'lg:hidden',
        )}
      >
        <div className="flex h-full flex-col overflow-y-auto p-4">
          <div className="mb-4 flex items-center justify-between lg:hidden">
            <span className="text-sm font-semibold text-ink">Menu</span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted hover:bg-subtle hover:text-ink"
              aria-label="Close menu"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          <Section
            title="Public"
            links={PUBLIC_LINKS}
            activePath={activePath}
            onClick={onClose}
            className="lg:hidden"
          />

          {sections.map((section) => (
            <Section
              key={section.title}
              title={section.title}
              links={section.links}
              activePath={activePath}
              onClick={onClose}
            />
          ))}

          {user ? (
            <div className="mt-auto border-t border-line pt-4 lg:hidden">
              <p className="mb-2 text-xs text-muted">{user.email}</p>
              <div className="mb-3 flex flex-wrap gap-1">
                {user.roles.includes('organizer') && <Badge tone="accent">organizer</Badge>}
                {user.roles.includes('reviewer') && <Badge tone="neutral">reviewer</Badge>}
              </div>
              <form method="post" action="/auth/logout">
                <button
                  type="submit"
                  className="text-sm text-muted hover:text-ink"
                  data-testid="sign-out"
                >
                  Sign out
                </button>
              </form>
            </div>
          ) : (
            <div className="mt-auto border-t border-line pt-4 lg:hidden">
              <Link
                href="/login"
                className="text-sm text-muted hover:text-ink"
                onClick={onClose}
              >
                Sign in
              </Link>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Section({
  title,
  links,
  activePath,
  onClick,
  className,
}: {
  title: string;
  links: NavSection['links'];
  activePath: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <div className={cn('mb-6', className)}>
      <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </p>
      <ul className="space-y-0.5">
        {links.map((link) => {
          const active = isActive(link.href, activePath);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onClick}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted hover:bg-subtle hover:text-ink',
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}
