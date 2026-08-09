import Link from 'next/link';
import { Button, Card, Field, Input, LinkButton, Notice, PageHeader, Select, cn } from '@/components/ui';
import {
  availabilityConflicts,
  capacityWarnings,
  declinedPlacements,
  speakerConflicts,
  withdrawnPlacements,
} from '@/lib/conflicts';
import { dayKey, dayLabel, instantToWallClock, timeOfDay } from '@/lib/format';
import { agenda, allRooms, getEvent, unscheduledAccepted } from '@/lib/queries';
import {
  SCHEDULE_VIEWS,
  isBuildingView,
  isFilled,
  isScheduleView,
  toScheduleEntries,
  type ScheduleView,
} from '@/lib/schedule-views';
import { pendingNotices } from '@/lib/schedule-notices';
import { placements } from '@/lib/speaker-calendar';
import { notifySchedule } from '../submissions/actions';
import { addBreakBand, addTimeBand, clearBreakBand, deleteTimeBand, setAgendaPublished } from './actions';
import { slotLabels, timeBandImpact } from './queries';
import { ScheduleFallback } from './ScheduleFallback';
import { ScheduleGrid, type Band, type Cell } from './ScheduleGrid';
import { ScheduleViews } from './ScheduleViews';

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [
    event,
    rooms,
    entries,
    pool,
    conflicts,
    unavailable,
    declined,
    withdrawn,
    tooSmall,
    labels,
  ] = await Promise.all([
    getEvent(),
    allRooms(),
    agenda(),
    unscheduledAccepted(),
    speakerConflicts(),
    availabilityConflicts(),
    declinedPlacements(),
    withdrawnPlacements(),
    capacityWarnings(),
    slotLabels(),
  ]);

  const conflictedSlots = new Set(conflicts.flatMap((c) => c.slots.map((s) => s.slotId)));
  const unavailableSlots = new Map(unavailable.map((row) => [row.slotId, row.note]));
  const overCapacitySlots = new Map(
    tooSmall.map((row) => [row.slotId, { bookmarks: row.bookmarks, capacity: row.capacity }]),
  );

  const view: ScheduleView = isScheduleView(params.view) ? params.view : 'grid';

  // One flat, timezone-resolved row per slot. The grid still builds its own
  // bands below from the same `agenda()` rows; this is what the reading views
  // and the fallback form group, so all six views agree about what is placed.
  const flat = toScheduleEntries(entries, labels, event.timezone, {
    conflicted: conflictedSlots,
    unavailable: new Set(unavailableSlots.keys()),
    overCapacity: new Set(overCapacitySlots.keys()),
  });

  // Days in schedule order, deduped. `Map` rather than `Set` because the tab
  // needs the label and the query string needs the key.
  const days = [...new Map(flat.map((row) => [row.dayKey, row.dayLabel])).entries()];
  const requestedDay = typeof params.day === 'string' ? params.day : null;
  const selectedDay =
    view === 'day'
      ? (days.find(([key]) => key === requestedDay)?.[0] ?? days[0]?.[0] ?? null)
      : null;

  // Fold the flat slot list into time bands. Slots are already ordered by start
  // then room position, so a band closes as soon as the start time changes.
  const bands: Band[] = [];
  let current: { startsAt: Date; cells: Cell[] } | null = null;

  function closeBand(open: { startsAt: Date; cells: Cell[] }) {
    bands.push({
      key: open.startsAt.toISOString(),
      dayKey: dayKey(open.startsAt, event.timezone),
      dayLabel: dayLabel(open.startsAt, event.timezone),
      timeLabel: timeOfDay(open.startsAt, event.timezone),
      cells: open.cells,
    });
  }

  for (const entry of entries) {
    if (!current || current.startsAt.getTime() !== entry.startsAt.getTime()) {
      if (current) closeBand(current);
      current = { startsAt: entry.startsAt, cells: [] };
    }
    current.cells.push({
      slotId: entry.slotId,
      roomId: entry.roomId,
      submissionId: entry.submissionId,
      title: entry.title,
      speakerName: entry.speakerName,
      trackColour: entry.trackColour,
      label: labels.get(entry.slotId) ?? null,
      conflicted: conflictedSlots.has(entry.slotId),
      unavailable: unavailableSlots.has(entry.slotId)
        ? { note: unavailableSlots.get(entry.slotId) ?? null }
        : null,
      overCapacity: overCapacitySlots.get(entry.slotId) ?? null,
    });
  }
  if (current) closeBand(current);

  const shownBands = selectedDay ? bands.filter((band) => band.dayKey === selectedDay) : bands;

  // Deleting a band is destructive and silent — the slots go and every talk in
  // them is unplaced — so the delete button routes here first and the action
  // refuses without the confirmation this panel supplies.
  const pendingDelete = typeof params.confirmDelete === 'string' ? params.confirmDelete : null;
  const pendingBand = pendingDelete ? bands.find((band) => band.key === pendingDelete) : undefined;
  const impact = pendingBand ? await timeBandImpact(new Date(pendingBand.key)) : null;

  // Speakers whose placement differs from the one they were last emailed. The
  // count is on the button rather than in a notice, because "how many people am
  // I about to email" is the question an organizer has as they press it.
  const pending = pendingNotices(await placements());

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedule"
        description={`${rooms.length} room(s) · ${bands.length} time band(s) · ${pool.length} accepted talk(s) still unplaced`}
        action={
          <div className="flex items-center gap-2">
            <LinkButton href="/organizer/rooms" variant="secondary">
              Rooms &amp; tracks
            </LinkButton>
            {/*
              Sending is a separate press from moving, for the same reason
              deciding is separate from `notifyDecided`: an organizer drags a
              talk four times while building the grid, and a speaker should get
              one mail about where it ended up rather than four.
            */}
            <form action={notifySchedule}>
              <Button
                type="submit"
                variant="secondary"
                disabled={pending.length === 0}
                data-testid="notify-schedule"
              >
                Email {pending.length} schedule change(s)
              </Button>
            </form>
            <form action={setAgendaPublished}>
              <input type="hidden" name="published" value={event.agendaPublished ? 'false' : 'true'} />
              <Button
                type="submit"
                variant={event.agendaPublished ? 'secondary' : 'primary'}
                data-testid="toggle-publish"
              >
                {event.agendaPublished ? 'Unpublish agenda' : 'Publish agenda'}
              </Button>
            </form>
          </div>
        }
      />

      <nav
        className="flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1 text-sm"
        data-testid="schedule-views"
      >
        {Object.entries(SCHEDULE_VIEWS).map(([key, label]) => (
          <Link
            key={key}
            href={key === 'grid' ? '/organizer/schedule' : `/organizer/schedule?view=${key}`}
            data-testid={`view-${key}`}
            aria-current={view === key ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5',
              view === key ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-slate-100 hover:text-ink',
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {view === 'day' && days.length > 0 ? (
        <div className="flex flex-wrap gap-2 text-sm" data-testid="schedule-day-tabs">
          {days.map(([key, label]) => (
            <Link
              key={key}
              href={`/organizer/schedule?view=day&day=${key}`}
              data-testid={`day-${key}`}
              aria-current={selectedDay === key ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1',
                selectedDay === key
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-muted hover:text-ink',
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      ) : null}

      {pendingBand && impact ? (
        <Notice tone="bad">
          <div className="space-y-2" data-testid="confirm-delete-band">
            <p>
              Deleting {pendingBand.dayLabel} {pendingBand.timeLabel} removes {impact.slots} slot(s)
              and unplaces {impact.placed} talk(s)
              {impact.placed > 0 ? `: ${impact.titles.join(', ')}` : ''}. They return to the
              unscheduled pool; nothing is rejected and nobody is emailed.
            </p>
            <div className="flex items-center gap-3">
              <form action={deleteTimeBand}>
                <input type="hidden" name="startsAt" value={pendingBand.key} />
                <input type="hidden" name="confirm" value="yes" />
                <Button type="submit" variant="danger" data-testid="confirm-delete-band-submit">
                  Delete the band
                </Button>
              </form>
              <Link href="/organizer/schedule" className="text-sm text-muted underline">
                Keep it
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      {conflicts.length > 0 ? (
        <Notice tone="bad">
          <span data-testid="conflict-warning">
            {conflicts.length} speaker(s) are booked into two rooms at the same time:{' '}
            {conflicts.map((c) => c.speakerName ?? c.speakerEmail).join(', ')}. The grid still
            accepts the placement; the warning stays until you move one.
          </span>
        </Notice>
      ) : null}

      {/*
        First of the speaker warnings, because it is the only one where the
        talk is already gone. Withdrawing drops it from /agenda and the calendar
        feeds at once and leaves the grid untouched, so without this the two
        views of one programme disagree and the grid is the one that lies.
      */}
      {withdrawn.length > 0 ? (
        <Notice tone="bad">
          <span data-testid="withdrawn-warning">
            {withdrawn.length} talk(s) still hold a slot after being withdrawn:{' '}
            {withdrawn
              .map((row) => `${row.speakerName ?? row.speakerEmail} (${row.title})`)
              .join(', ')}
            . They have already left the public agenda. Nothing clears a slot for you, so the box is
            yours to reassign or empty.
          </span>
        </Notice>
      ) : null}

      {/*
        Above the availability warning, not below it. A declared window is a
        placement an organizer may still know better than; a decline is the
        speaker saying they will not be there at all, and it is the only one of
        these four that no amount of moving the talk resolves.
      */}
      {declined.length > 0 ? (
        <Notice tone="bad">
          <span data-testid="declined-warning">
            {declined.length} talk(s) are scheduled for a speaker who has said they cannot present:{' '}
            {declined
              .map((row) => `${row.speakerName ?? row.speakerEmail} (${row.title})`)
              .join(', ')}
            . The proposals are still accepted and nothing has been withdrawn, so the slot is yours
            to reassign or clear.
          </span>
        </Notice>
      ) : null}

      {unavailable.length > 0 ? (
        <Notice tone="warn">
          <span data-testid="availability-warning">
            {unavailable.length} talk(s) sit inside a window the speaker declared unavailable:{' '}
            {unavailable.map((row) => `${row.speakerName ?? row.speakerEmail} (${row.title})`).join(', ')}
            . Placement is still allowed — you may know something the declaration does not.
          </span>
        </Notice>
      ) : null}

      {tooSmall.length > 0 ? (
        <Notice tone="warn">
          <span data-testid="capacity-warning">
            {tooSmall.length} talk(s) are in a room smaller than the interest in them:{' '}
            {tooSmall
              .map((row) => `${row.title} (${row.bookmarks} starred, ${row.roomName} seats ${row.capacity})`)
              .join(', ')}
            .
          </span>
        </Notice>
      ) : null}

      {!isBuildingView(view) ? (
        <ScheduleViews view={view} entries={flat.filter(isFilled)} />
      ) : rooms.length === 0 ? (
        <Notice>
          No rooms yet.{' '}
          <Link href="/organizer/rooms" className="underline">
            Add one
          </Link>{' '}
          and then add a time band below.
        </Notice>
      ) : bands.length === 0 ? (
        <Notice>Add a time band below to start building the grid.</Notice>
      ) : (
        <>
          <ScheduleGrid
            rooms={rooms.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity }))}
            bands={shownBands}
            pool={pool.map((p) => ({
              id: p.id,
              title: p.title,
              speakerName: p.speakerName,
              trackColour: p.trackColour,
            }))}
          />
          <ScheduleFallback
            talks={[
              ...pool.map((p) => ({ id: p.id, title: p.title, speakerName: p.speakerName })),
              ...flat
                .filter((row) => row.submissionId !== null)
                .map((row) => ({
                  id: row.submissionId!,
                  title: row.title ?? 'Untitled',
                  speakerName: row.speakerName,
                })),
            ]}
            slots={flat}
          />
        </>
      )}

      {isBuildingView(view) ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3">
            <h2 className="text-sm font-semibold text-ink">Add a time band</h2>
            <p className="text-xs text-muted">
              Creates one slot in every room at this time. Enter the time in {event.timezone}.
            </p>
            <form action={addTimeBand} className="flex flex-wrap items-end gap-3">
              <Field label="Starts">
                <Input
                  type="datetime-local"
                  name="startsAt"
                  required
                  data-testid="band-start"
                  defaultValue={instantToWallClock(event.startsOn, event.timezone)}
                />
              </Field>
              <Field label="Length">
                <Select name="minutes" defaultValue="45" className="w-32">
                  {[10, 25, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="secondary" data-testid="add-band">
                Add band
              </Button>
            </form>
          </Card>

          <Card className="space-y-3">
            <h2 className="text-sm font-semibold text-ink">Add a break</h2>
            <p className="text-xs text-muted">
              A named block across the whole venue — lunch, registration, coffee. It shows on the
              public agenda and holds the time until you drop a talk on it.
            </p>
            <form action={addBreakBand} className="flex flex-wrap items-end gap-3">
              <Field label="Name">
                <Input
                  name="label"
                  required
                  maxLength={80}
                  placeholder="Lunch"
                  className="w-40"
                  data-testid="block-label"
                />
              </Field>
              <Field label="Starts">
                <Input
                  type="datetime-local"
                  name="startsAt"
                  required
                  data-testid="block-start"
                  defaultValue={instantToWallClock(event.startsOn, event.timezone)}
                />
              </Field>
              <Field label="Length">
                <Select name="minutes" defaultValue="60" className="w-32">
                  {[10, 15, 30, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="secondary" data-testid="add-block">
                Add break
              </Button>
            </form>
          </Card>
        </div>
      ) : null}

      {isBuildingView(view) && bands.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Remove a time band or break</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {bands.map((band) => {
              const labelled = band.cells.some((cell) => cell.label !== null);
              return (
                <div key={band.key} className="flex items-center gap-1">
                  <form action={deleteTimeBand}>
                    <input type="hidden" name="startsAt" value={band.key} />
                    <Button type="submit" variant="ghost" className="text-xs">
                      {band.dayLabel} {band.timeLabel} ✕
                    </Button>
                  </form>
                  {labelled ? (
                    <form action={clearBreakBand}>
                      <input type="hidden" name="startsAt" value={band.key} />
                      <Button type="submit" variant="ghost" className="text-xs">
                        unname
                      </Button>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}
