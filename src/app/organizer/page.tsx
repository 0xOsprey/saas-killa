import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, PageHeader, cn } from '@/components/ui';
import { dayLabel } from '@/lib/format';
import { organizerOverview } from '@/lib/portal';

const TONE_VALUE = {
  neutral: 'text-ink',
  warn: 'text-amber-700',
  good: 'text-emerald-700',
} as const;

/**
 * The organizer landing page. `/organizer` used to 404 while the nav linked
 * past it into `/organizer/submissions`; this is the screen that says what
 * needs doing before the tab that does it.
 */
export default async function OrganizerOverviewPage() {
  const { event, statusCounts, grading, acceptedUnscheduled, tasks, cfp } =
    await organizerOverview();

  const decided = statusCounts.accepted + statusCounts.rejected;
  const gradedPercent =
    grading.assigned > 0 ? Math.round((grading.graded / grading.assigned) * 100) : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overview"
        description={`${event.name} · ${dayLabel(event.startsOn, event.timezone)}`}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          href="/organizer/submissions"
          label="Awaiting a decision"
          value={statusCounts.submitted}
          tone={statusCounts.submitted > 0 ? 'warn' : 'good'}
          hint={`${decided} decided · ${statusCounts.accepted} accepted, ${statusCounts.rejected} rejected, ${statusCounts.withdrawn} withdrawn`}
        />

        <Tile
          href="/organizer/submissions"
          label="Review completion"
          // Before anyone is assigned there is no denominator, so the tile
          // reports the grades that do exist rather than a misleading 0%.
          value={
            grading.assigned > 0 ? `${grading.graded}/${grading.assigned}` : grading.reviewsFiled
          }
          tone={grading.assigned > 0 && gradedPercent < 100 ? 'warn' : 'neutral'}
          hint={
            grading.assigned > 0
              ? `${gradedPercent}% of assignments graded`
              : `${plural(grading.reviewsFiled, 'grade')} filed · nothing assigned yet`
          }
        />

        <Tile
          href="/organizer/schedule"
          label="Accepted, unscheduled"
          value={acceptedUnscheduled}
          tone={acceptedUnscheduled > 0 ? 'warn' : 'good'}
          hint={
            acceptedUnscheduled > 0
              ? 'Waiting for a slot on the grid.'
              : 'Every accepted talk has a slot.'
          }
        />

        <Tile
          href="/organizer/speakers"
          label="Speaker tasks outstanding"
          value={tasks.outstanding}
          tone={tasks.overdue > 0 ? 'warn' : 'neutral'}
          hint={
            tasks.overdue > 0
              ? `${plural(tasks.overdue, 'task')} past the deadline`
              : 'Nothing past its deadline.'
          }
        />

        <Tile
          href="/organizer/cfp"
          label="Call for papers"
          value={cfpValue(cfp)}
          tone={cfp.state === 'open' && cfp.days <= 7 ? 'warn' : 'neutral'}
          hint={`${cfp.state === 'closed' ? 'Closed' : 'Closes'} ${dayLabel(event.cfpClosesAt, event.timezone)}`}
        />

        <Tile
          href="/organizer/schedule"
          label="Agenda"
          value={event.agendaPublished ? 'Published' : 'Draft'}
          tone={event.agendaPublished ? 'good' : 'neutral'}
          hint={
            event.agendaPublished
              ? 'Visible to everyone at /agenda.'
              : 'Not visible to the public yet.'
          }
        />
      </div>
    </div>
  );
}

function cfpValue(cfp: { state: 'before' | 'open' | 'closed'; days: number }): string {
  if (cfp.state === 'open') return `${plural(cfp.days, 'day')} left`;
  if (cfp.state === 'before') return `Opens in ${plural(cfp.days, 'day')}`;
  return 'Closed';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function Tile({
  href,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  href: string;
  label: string;
  value: ReactNode;
  hint: string;
  tone?: keyof typeof TONE_VALUE;
}) {
  return (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-testid={`tile-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
    >
      <Card className="h-full transition-colors hover:border-accent">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className={cn('mt-1 text-2xl font-semibold tabular-nums', TONE_VALUE[tone])}>{value}</p>
        <p className="mt-1 text-xs text-muted">{hint}</p>
      </Card>
    </Link>
  );
}
