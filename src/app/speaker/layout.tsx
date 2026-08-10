'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Lucide from 'lucide-react';
import { cn } from '@/components/ui';

const TABS = [
  { href: '/speaker', label: 'Submissions', icon: 'FileText' },
  { href: '/speaker/content', label: 'Content', icon: 'FileCheck' },
  { href: '/speaker/availability', label: 'Availability', icon: 'Clock' },
  { href: '/speaker/profile', label: 'Profile', icon: 'User' },
  { href: '/speaker/pages', label: 'Speaker info', icon: 'Info' },
];

export default function SpeakerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 border-b border-line pb-1" aria-label="Speaker portal">
        {TABS.map((tab) => {
          const Icon = (Lucide as any)[tab.icon];
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors',
                active
                  ? '-mb-px border-b-2 border-accent text-accent'
                  : 'text-muted hover:text-ink',
              )}
            >
              {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : null}
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
