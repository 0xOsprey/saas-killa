import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '@/components/ui';
import { dayLabel } from '@/lib/format';
import { allTracks, getEvent } from '@/lib/queries';
import { ROSTER_FILTERS, isRosterFilter, speakerRoster } from '@/lib/speakers';
import { Headshot } from '@/app/speakers/Headshot';
import { grantRoleAction, revokeRoleAction } from './actions';
import { BulkTaskForm } from './BulkTaskForm';
import { InviteSpeakerForm } from './InviteSpeakerForm';
import { ReminderForm } from './ReminderForm';

function Panel({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <Card className="p-0">
      <details className="group">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-ink">
          <span className="mr-2 text-muted group-open:hidden">＋</span>
          <span className="mr-2 hidden text-muted group-open:inline">－</span>
          {summary}
        </summary>
        <div className="border-t border-line px-4 py-4">{children}</div>
      </details>
    </Card>
  );
}

export default async function SpeakersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const filter = isRosterFilter(params.filter) ? params.filter : 'all';

  const [event, tracks, people] = await Promise.all([
    getEvent(),
    allTracks(),
    speakerRoster({ q, filter }),
  ]);

  const withAccepted = people.filter((p) => p.accepted > 0).length;
  const outstanding = people.reduce((n, p) => n + p.outstanding, 0);
  const overdue = people.reduce((n, p) => n + p.overdue, 0);
  const exportQuery = new URLSearchParams({ q, filter }).toString();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Speakers"
        description={`${people.length} account(s) · ${withAccepted} with an accepted talk · ${outstanding} task(s) outstanding, ${overdue} overdue`}
        action={
          <Link
            href={`/organizer/speakers/export?${exportQuery}`}
            prefetch={false}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
          >
            Export roster CSV
          </Link>
        }
      />

      {/* A GET form: the filter belongs in the URL so a view is linkable, and so
          the bulk actions can post the same two values back. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Input name="q" defaultValue={q} placeholder="Search name or email" aria-label="Search" />
        </div>
        <Select name="filter" defaultValue={filter} aria-label="Filter" className="w-auto">
          {Object.entries(ROSTER_FILTERS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        {q || filter !== 'all' ? (
          <Link href="/organizer/speakers" className="px-2 py-2 text-sm text-muted hover:text-ink">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel summary="Invite a speaker — files a submission for them, even with the CFP closed">
        <InviteSpeakerForm tracks={tracks} />
      </Panel>

      <Panel summary={`Set a deadline for these ${people.length} speaker(s)`}>
        <BulkTaskForm filter={filter} q={q} targetCount={people.filter((p) => !p.isBot).length} />
      </Panel>

      <Panel summary={`Chase the ${outstanding} outstanding task(s) on this list`}>
        <ReminderForm
          scope="all"
          filter={filter}
          q={q}
          variant="primary"
          label="Remind everyone with an open task"
        />
      </Panel>

      {people.length === 0 ? (
        <Empty>Nobody matches that filter.</Empty>
      ) : (
        <div className="space-y-2">
          {people.map((person) => {
            const missingBio = person.accepted > 0 && !person.bio;
            const missingHeadshot = person.accepted > 0 && !person.headshotUrl;
            const unconfirmed = person.accepted > person.confirmed;
            return (
              <Card
                key={person.id}
                data-testid={`roster-${person.id}`}
                className="flex flex-wrap items-start gap-3"
              >
                <Headshot src={person.headshotUrl} name={person.name} size="sm" />

                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium text-ink">
                    <Link href={`/organizer/speakers/${person.id}`} className="hover:underline">
                      {person.name ?? 'Unnamed'}
                    </Link>{' '}
                    {person.isBot ? <Badge tone="accent">bot</Badge> : null}
                  </p>
                  <p className="text-xs text-muted">{person.email}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>
                      {person.total} submitted · {person.accepted} accepted
                    </span>
                    {missingBio ? <Badge tone="warn">bio missing</Badge> : null}
                    {missingHeadshot ? <Badge tone="warn">headshot missing</Badge> : null}
                    {unconfirmed ? <Badge tone="warn">not confirmed</Badge> : null}
                    {person.overdue > 0 ? (
                      <Badge tone="bad">{person.overdue} overdue</Badge>
                    ) : null}
                  </p>

                  {person.openTasks.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {person.openTasks.map((task) => (
                        <li key={task.id} className="flex flex-wrap items-center gap-2">
                          <span className={task.overdue ? 'text-red-700' : 'text-muted'}>
                            {task.label}
                          </span>
                          <span className="text-muted">
                            {task.dueAt
                              ? `due ${dayLabel(task.dueAt, event.timezone)}`
                              : 'no deadline'}
                          </span>
                          {task.overdue ? <Badge tone="bad">overdue</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {person.roles.map((role) =>
                    // The speaker role is the key to their own portal. Once they
                    // have filed anything the action refuses to revoke it, so the
                    // chip stops offering.
                    role === 'speaker' && person.total > 0 ? (
                      <Badge key={role} title="Has submissions — cannot be revoked">
                        {role}
                      </Badge>
                    ) : (
                      <form action={revokeRoleAction} key={role}>
                        <input type="hidden" name="userId" value={person.id} />
                        <input type="hidden" name="role" value={role} />
                        <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                          {role} ✕
                        </Button>
                      </form>
                    ),
                  )}
                  {(['reviewer', 'organizer'] as const)
                    .filter((role) => !person.roles.includes(role))
                    .map((role) => (
                      <form action={grantRoleAction} key={role}>
                        <input type="hidden" name="userId" value={person.id} />
                        <input type="hidden" name="role" value={role} />
                        <Button
                          type="submit"
                          variant="secondary"
                          className="px-2 py-1 text-xs"
                          data-testid={`grant-${role}-${person.email}`}
                        >
                          + {role}
                        </Button>
                      </form>
                    ))}
                  <Link
                    href={`/organizer/speakers/${person.id}`}
                    className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-slate-50"
                  >
                    Edit
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
