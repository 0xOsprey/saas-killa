import Link from 'next/link';
import { Badge, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { inEventZone } from '@/lib/format';
import { onboardingOverview } from '@/lib/onboarding';
import { getEvent } from '@/lib/queries';
import { TASK_KIND_LABELS } from '@/lib/speaker-labels';
import { AutoRefresh } from './AutoRefresh';

/**
 * Speaker onboarding at a glance.
 *
 * `force-dynamic` because the figures are the point. A cached copy of this
 * screen is a screen that says nothing changed while an organizer watches
 * tasks land, and the whole reason it exists is to be looked at during the
 * fortnight when it changes hourly.
 */
export const dynamic = 'force-dynamic';

function Tile({
  label,
  value,
  hint,
  tone,
  testId,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'bad' | 'good';
  testId: string;
  href?: string;
}) {
  const body = (
    <Card className="h-full">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p
        data-testid={testId}
        className={`mt-1 text-3xl font-semibold ${
          tone === 'bad' && value > 0 ? 'text-rose-600' : tone === 'good' ? 'text-emerald-600' : ''
        }`}
      >
        {value}
      </p>
      {hint ? (
        <p data-testid={`${testId}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </Card>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function OnboardingDashboard() {
  const [event, view] = await Promise.all([getEvent(), onboardingOverview()]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Onboarding"
        description={`Read at ${inEventZone(view.readAt, event.timezone, {
          timeStyle: 'medium',
        })}.`}
        action={<AutoRefresh />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Ready"
          value={view.clear}
          hint={`${view.accepted} accepted speaker(s) in all`}
          tone="good"
          testId="tile-clear"
        />
        <Tile
          label="Outstanding"
          value={view.outstandingPeople}
          hint={`${view.outstandingTasks} task(s) between them`}
          testId="tile-outstanding"
          href="/organizer/speakers?filter=outstanding"
        />
        <Tile
          label="Overdue"
          value={view.overduePeople}
          hint={`${view.overdueTasks} task(s) past their date`}
          tone="bad"
          testId="tile-overdue"
          href="/organizer/speakers?filter=overdue"
        />
        <Tile
          label="Done this week"
          value={view.completedThisWeek}
          hint="Tasks completed in the last 7 days"
          tone="good"
          testId="tile-completed"
        />
      </div>

      {/*
        Confirmation is a different question from tasks and is kept visually
        apart from the tiles for that reason. A speaker can owe nothing and
        still not have said whether they are coming, and that person is the one
        an organizer most needs to see: every other number on this screen counts
        them as fine.
      */}
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">Confirmed to attend</h2>
          <p className="text-sm text-muted" data-testid="confirmation-mix">
            {view.confirmed} of {view.accepted} accepted speaker(s)
          </p>
        </div>
        <div
          className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label={`${view.confirmed} confirmed, ${view.unconfirmed} not confirmed`}
        >
          <div
            className="bg-emerald-500"
            style={{ width: `${view.accepted ? (view.confirmed / view.accepted) * 100 : 0}%` }}
          />
        </div>
        {view.unconfirmed > 0 ? (
          <p className="mt-3 text-sm">
            <Link
              href="/organizer/speakers?filter=unconfirmed"
              className="text-accent hover:underline"
              data-testid="unconfirmed-link"
            >
              {view.unconfirmed} speaker(s) have not confirmed
            </Link>{' '}
            <span className="text-muted">— chase these before the programme goes out.</span>
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">Everyone accepted has confirmed.</p>
        )}
      </Card>

      {view.undated > 0 ? (
        <Notice>
          <span data-testid="undated-notice">
            {view.undated} open task(s) have no due date, so they are in the outstanding count and
            can never reach the overdue one. A task nobody dated is a task nobody is chasing.
          </span>
        </Notice>
      ) : null}

      <Card>
        <h2 className="mb-3 font-medium">What is outstanding</h2>
        {view.byKind.length === 0 ? (
          <Empty>Nothing outstanding. Every speaker task is complete.</Empty>
        ) : (
          <table className="w-full text-sm" data-testid="by-kind">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2">Task</th>
                <th className="py-2">Speakers</th>
                <th className="py-2">Open</th>
                <th className="py-2">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {view.byKind.map((row) => (
                <tr key={row.kind} className="border-b border-line/60" data-testid={`kind-${row.kind}`}>
                  <td className="py-2">{TASK_KIND_LABELS[row.kind]}</td>
                  <td className="py-2">{row.people}</td>
                  <td className="py-2">{row.outstanding}</td>
                  <td className="py-2">
                    {row.overdue > 0 ? (
                      <Badge tone="bad">{row.overdue}</Badge>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 font-medium">Who to chase first</h2>
        <p className="mb-3 text-xs text-muted">
          Overdue before volume: the person three weeks late matters more than the person with four
          fresh tasks.
        </p>
        {view.stuck.length === 0 ? (
          <Empty>Nobody is outstanding.</Empty>
        ) : (
          <ul className="space-y-2" data-testid="stuck-list">
            {view.stuck.map((person) => (
              <li
                key={person.id}
                data-testid={`stuck-${person.id}`}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2 text-sm last:border-0"
              >
                <div>
                  <Link
                    href={`/organizer/speakers/${person.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {person.name ?? person.email}
                  </Link>
                  <p className="text-xs text-muted">{person.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  {person.daysLate !== null ? (
                    <Badge tone="bad">{person.daysLate} day(s) late</Badge>
                  ) : null}
                  <Badge>{person.outstanding} open</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
