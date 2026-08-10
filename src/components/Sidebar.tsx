'use client';

import Link from 'next/link';
import * as Lucide from 'lucide-react';
import { cn } from '@/components/ui';
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
              <Lucide.X className="h-5 w-5" />
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
      <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted">
        {title}
      </p>
      <ul className="space-y-0.5">
        {links.map((link) => {
          const active = isActive(link.href, activePath);
          const Icon = link.icon ? (Lucide as any)[link.icon] : undefined;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onClick}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md border-l-2 px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'border-accent bg-accent-soft font-medium text-accent'
                    : 'border-transparent text-muted hover:bg-subtle hover:text-ink',
                )}
              >
                {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
