import Link from 'next/link';
import { Button, Card, Field, Input, LinkButton, Notice, PageHeader, Select } from '@/components/ui';
import { availabilityConflicts, capacityWarnings, speakerConflicts } from '@/lib/conflicts';
import { dayLabel, instantToWallClock, timeOfDay } from '@/lib/format';
import { agenda, allRooms, getEvent, unscheduledAccepted } from '@/lib/queries';
import { addBreakBand, addTimeBand, clearBreakBand, deleteTimeBand, setAgendaPublished } from './actions';
import { slotLabels, timeBandImpact } from './queries';
import { ScheduleGrid, type Band, type Cell } from './ScheduleGrid';

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [event, rooms, entries, pool, conflicts, unavailable, tooSmall, labels] = await Promise.all([
    getEvent(),
    allRooms(),
    agenda(),
    unscheduledAccepted(),
    speakerConflicts(),
    availabilityConflicts(),
    capacityWarnings(),
    slotLabels(),
  ]);

  const conflictedSlots = new Set(conflicts.flatMap((c) => c.slots.map((s) => s.slotId)));
  const unavailableSlots = new Map(unavailable.map((row) => [row.slotId, row.note]));
  const overCapacitySlots = new Map(
    tooSmall.map((row) => [row.slotId, { bookmarks: row.bookmarks, capacity: row.capacity }]),
  );

  // Fold the flat slot list into time bands. Slots are already ordered by start
  // then room position, so a band closes as soon as the start time changes.
  const bands: Band[] = [];
  let current: { startsAt: Date; cells: Cell[] } | null = null;

  for (const entry of entries) {
    if (!current || current.startsAt.getTime() !== entry.startsAt.getTime()) {
      if (current) {
        bands.push({
          key: current.startsAt.toISOString(),
          dayLabel: dayLabel(current.startsAt, event.timezone),
          timeLabel: timeOfDay(current.startsAt, event.timezone),
          cells: current.cells,
        });
      }
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
  if (current) {
    bands.push({
      key: current.startsAt.toISOString(),
      dayLabel: dayLabel(current.startsAt, event.timezone),
      timeLabel: timeOfDay(current.startsAt, event.timezone),
      cells: current.cells,
    });
  }

  // Deleting a band is destructive and silent — the slots go and every talk in
  // them is unplaced — so the delete button routes here first and the action
  // refuses without the confirmation this panel supplies.
  const pendingDelete = typeof params.confirmDelete === 'string' ? params.confirmDelete : null;
  const pendingBand = pendingDelete ? bands.find((band) => band.key === pendingDelete) : undefined;
  const impact = pendingBand ? await timeBandImpact(new Date(pendingBand.key)) : null;

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

      {rooms.length === 0 ? (
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
        <ScheduleGrid
          rooms={rooms.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity }))}
          bands={bands}
          pool={pool.map((p) => ({
            id: p.id,
            title: p.title,
            speakerName: p.speakerName,
            trackColour: p.trackColour,
          }))}
        />
      )}

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

      {bands.length > 0 ? (
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
