import { Button, Card, Field, Input, Notice, PageHeader, Select } from '@/components/ui';
import { speakerConflicts } from '@/lib/conflicts';
import { dayLabel, instantToWallClock, timeOfDay } from '@/lib/format';
import { agenda, allRooms, getEvent, unscheduledAccepted } from '@/lib/queries';
import { addTimeBand, deleteTimeBand, setAgendaPublished } from './actions';
import { ScheduleGrid, type Band, type Cell } from './ScheduleGrid';

export default async function SchedulePage() {
  const [event, rooms, entries, pool, conflicts] = await Promise.all([
    getEvent(),
    allRooms(),
    agenda(),
    unscheduledAccepted(),
    speakerConflicts(),
  ]);

  const conflictedSlots = new Set(conflicts.flatMap((c) => c.slots.map((s) => s.slotId)));

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
      conflicted: conflictedSlots.has(entry.slotId),
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedule"
        description={`${rooms.length} room(s) · ${bands.length} time band(s) · ${pool.length} accepted talk(s) still unplaced`}
        action={
          <form action={setAgendaPublished}>
            <input
              type="hidden"
              name="published"
              value={event.agendaPublished ? 'false' : 'true'}
            />
            <Button
              type="submit"
              variant={event.agendaPublished ? 'secondary' : 'primary'}
              data-testid="toggle-publish"
            >
              {event.agendaPublished ? 'Unpublish agenda' : 'Publish agenda'}
            </Button>
          </form>
        }
      />

      {conflicts.length > 0 ? (
        <Notice tone="bad">
          <span data-testid="conflict-warning">
            {conflicts.length} speaker(s) are booked into two rooms at the same time:{' '}
            {conflicts.map((c) => c.speakerName ?? c.speakerEmail).join(', ')}. The grid still
            accepts the placement; the warning stays until you move one.
          </span>
        </Notice>
      ) : null}

      {rooms.length === 0 || bands.length === 0 ? (
        <Notice>
          Add a time band below to start building the grid. Rooms come from the seed; edit them in
          the database or extend this page.
        </Notice>
      ) : (
        <ScheduleGrid
          roomNames={rooms.map((r) => ({ id: r.id, name: r.name }))}
          bands={bands}
          pool={pool.map((p) => ({
            id: p.id,
            title: p.title,
            speakerName: p.speakerName,
            trackColour: p.trackColour,
          }))}
        />
      )}

      <Card className="max-w-xl space-y-3">
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

      {bands.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Remove a time band</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {bands.map((band) => (
              <form action={deleteTimeBand} key={band.key}>
                <input type="hidden" name="startsAt" value={band.key} />
                <Button type="submit" variant="ghost" className="text-xs">
                  {band.dayLabel} {band.timeLabel} ✕
                </Button>
              </form>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
