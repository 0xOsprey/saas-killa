import Link from 'next/link';
import { cn } from '@/components/ui';

type StatusTab = {
  value: string | null;
  label: string;
  count?: number;
};

export function StatusTabs({
  tabs,
  active,
  buildHref,
}: {
  tabs: StatusTab[];
  active: string | null;
  buildHref: (value: string | null) => string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-line">
      {tabs.map((tab) => {
        const isActive = active === tab.value;
        return (
          <Link
            key={tab.value ?? 'all'}
            href={buildHref(tab.value)}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors',
              isActive
                ? '-mb-px border-b-2 border-accent text-accent'
                : 'text-muted hover:text-ink',
            )}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span
                className={cn(
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-xs',
                  isActive ? 'bg-accent-soft text-accent' : 'bg-slate-100 text-slate-600',
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
