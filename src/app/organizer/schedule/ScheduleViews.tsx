import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Card, Empty } from '@/components/ui';
import {
  asWeek,
  byDay,
  byRoom,
  type Group,
  type ReadingView,
  type ScheduleEntry,
} from '@/lib/schedule-views';

/**
 * The reading views: list, week, month, rooms and conflicts.
 *
 * All server-rendered and all links-free. Placement happens in the grid, so
 * nothing here is interactive; the job is answering a question about a schedule
 * that already exists. Warnings carry over from the grid rather than being
 * recomputed, so a double-booking is red in every view that shows it.
 */

/**
 * Both double-bookings are named rather than sharing one badge. "double-booked"
 * alone was the speaker's, and a room collision reading the same way would send
 * an organizer to move the speaker when the thing to move is the talk.
 */
function WarningLink({ slotId, tone, children, testId }: { slotId: string; tone: 'bad' | 'warn'; children: ReactNode; testId?: string }) {
  return (
    <Link
      href={`/organizer/schedule?view=grid#slot-${slotId}`}
      className="inline-flex"
      data-testid={testId}
    >
      <Badge tone={tone}>{children}</Badge>
    </Link>
  );
}

function Warnings({ entry }: { entry: ScheduleEntry }) {
  if (!entry.conflicted && !entry.roomConflicted && !entry.unavailable && !entry.overCapacity) {
    return null;
  }
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1">
      {entry.conflicted ? (
        <WarningLink slotId={entry.slotId} tone="bad">
          speaker double-booked
        </WarningLink>
      ) : null}
      {entry.roomConflicted ? (
        <WarningLink
          slotId={entry.slotId}
          tone="bad"
          testId={`view-room-conflict-${entry.slotId}`}
        >
          room double-booked
        </WarningLink>
      ) : null}
      {entry.unavailable ? (
        <WarningLink slotId={entry.slotId} tone="warn">
          unavailable
        </WarningLink>
      ) : null}
      {entry.overCapacity ? (
        <WarningLink slotId={entry.slotId} tone="warn">
          room too small
        </WarningLink>
      ) : null}
    </span>
  );
}

function Line({ entry, show }: { entry: ScheduleEntry; show: 'room' | 'track' | 'day' }) {
  const isBreak = entry.submissionId === null;
  const context =
    show === 'room'
      ? entry.roomName
      : show === 'track'
        ? (entry.trackName ?? 'No track')
        : entry.dayLabel;

  return (
    <li
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line py-2 first:border-t-0"
      data-testid={`view-entry-${entry.slotId}`}
    >
      <span className="w-12 shrink-0 text-xs tabular-nums text-muted">{entry.time}</span>
      <span className="min-w-0 flex-1">
        <span
          className={isBreak ? 'text-sm italic text-muted' : 'text-sm font-medium text-ink'}
        >
          {entry.title ?? entry.label}
        </span>
        <Warnings entry={entry} />
        <span className="mt-0.5 block text-xs text-muted">
          {[entry.speakerName, context].filter(Boolean).join(' · ')}
        </span>
      </span>
    </li>
  );
}

function GroupCard({ group, show }: { group: Group; show: 'room' | 'track' | 'day' }) {
  return (
    <Card className="space-y-2" data-testid={`view-group-${group.key}`}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        {group.colour ? (
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: group.colour }}
          />
        ) : null}
        {group.label}
        <span className="font-normal text-muted">· {group.entries.length}</span>
      </h3>
      <ul>
        {group.entries.map((entry) => (
          <Line key={entry.slotId} entry={entry} show={show} />
        ))}
      </ul>
    </Card>
  );
}

export function ScheduleViews({
  view,
  entries,
}: {
  view: ReadingView;
  entries: ScheduleEntry[];
}) {
  if (entries.length === 0) {
    return <Empty>Nothing is placed yet. Build the schedule in the grid view first.</Empty>;
  }

  if (view === 'week') {
    const { days, times } = asWeek(entries);
    return (
      <>
        <p className="text-xs text-muted">Scroll to see more days.</p>
        <div className="overflow-x-auto" data-testid="schedule-week">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr>
              <th className="w-16 border-b border-line pb-2 text-left text-xs font-semibold text-muted">
                Time
              </th>
              {days.map((day) => (
                <th
                  key={day.key}
                  className="border-b border-line pb-2 text-left text-xs font-semibold text-ink"
                >
                  {day.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((time) => (
              <tr key={time} className="align-top">
                <td className="border-b border-line py-2 text-xs tabular-nums text-muted">
                  {time}
                </td>
                {days.map((day) => {
                  const cell = day.entries.filter((entry) => entry.time === time);
                  return (
                    <td
                      key={day.key}
                      className="border-b border-line py-2 pr-3"
                      data-testid={`week-${day.key}-${time}`}
                    >
                      {cell.length === 0 ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {cell.map((entry) => (
                            <li key={entry.slotId} className="text-xs">
                              <span
                                className={
                                  entry.submissionId === null
                                    ? 'italic text-muted'
                                    : 'font-medium text-ink'
                                }
                              >
                                {entry.title ?? entry.label}
                              </span>
                              {/*
                                The same badges the other three views carry.
                                Week is the densest view and was the only one
                                showing a placement with nothing said about it,
                                which made it the view most likely to be read as
                                a clean schedule.
                              */}
                              <Warnings entry={entry} />
                              <span className="block text-muted">{entry.roomName}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </>
    );
  }

  const readEntries =
    view === 'conflicts'
      ? entries.filter((entry) => entry.conflicted || entry.roomConflicted || entry.unavailable || entry.overCapacity)
      : entries;

  const groups = view === 'room' ? byRoom(entries) : byDay(readEntries);
  const show = view === 'room' ? 'day' : 'room';

  return (
    <div className="space-y-4" data-testid={`schedule-${view}`}>
      {groups.map((group) => (
        <GroupCard key={group.key} group={group} show={show} />
      ))}
    </div>
  );
}
