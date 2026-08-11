'use client';

import { useState, useTransition } from 'react';
import { Notice, cn } from '@/components/ui';
import { clearSlot, placeSubmission } from './actions';

export type PoolItem = {
  id: string;
  title: string;
  speakerName: string | null;
  trackColour: string | null;
};

export type GridRoom = {
  id: string;
  name: string;
  capacity: number | null;
};

export type Cell = {
  slotId: string;
  roomId: string;
  submissionId: string | null;
  title: string | null;
  speakerName: string | null;
  trackColour: string | null;
  /** Set when the box is a named non-session block rather than a placement. */
  label: string | null;
  conflicted: boolean;
  /**
   * Another talk is running in this room while this one is. Separate from
   * `conflicted`, which is about the speaker: the two are resolved by different
   * moves, and a box can carry both at once.
   */
  roomConflicted: boolean;
  /**
   * The speaker declared this window unavailable. An object rather than the
   * note itself: a declaration with no note is still a declaration, and a bare
   * `string | null` cannot tell that apart from no declaration at all.
   */
  unavailable: { note: string | null } | null;
  /** More people starred this than the room seats. */
  overCapacity: { bookmarks: number; capacity: number } | null;
};

export type Band = {
  key: string;
  dayKey: string;
  dayLabel: string;
  timeLabel: string;
  cells: Cell[];
};

/**
 * Placement works three ways on purpose, and all three call the same server
 * action:
 *
 *   - Drag. From the unscheduled pool onto a box, and from one box to another,
 *     which is how a schedule is actually rearranged: the common gesture is
 *     moving a talk that is already placed, not placing a new one.
 *   - Click to pick up, click to drop. The same operation without a pointer
 *     gesture, reachable from the keyboard because every box takes focus and
 *     answers Enter and Space.
 *   - A plain form, in `ScheduleFallback`, which is what works with scripting
 *     off. This component is an enhancement over that, not the only door.
 *
 * `role="button"` goes on empty boxes only. A filled box holds its own remove
 * control, and a button inside a button is a thing screen readers cannot
 * describe; the box stays focusable and labelled instead.
 *
 * Every warning a cell can carry is reported, never enforced. An organizer
 * mid-rearrangement passes through invalid states as a matter of course, and a
 * grid that refuses the drop is a grid nobody can rearrange.
 */
export function ScheduleGrid({
  rooms,
  bands,
  pool,
}: {
  rooms: GridRoom[];
  bands: Band[];
  pool: PoolItem[];
}) {
  const [held, setHeld] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /**
   * The talk the last placement displaced, and the box it was displaced from.
   *
   * `where` is read off the cell that was dropped on rather than returned by the
   * server action, because the client already knows which box it just wrote to
   * and the action would have to format a time in the event's timezone to say
   * the same thing.
   */
  const [evicted, setEvicted] = useState<{ title: string; where: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function place(slotId: string, submissionId: string, where: string) {
    const data = new FormData();
    data.set('slotId', slotId);
    data.set('submissionId', submissionId);
    startTransition(async () => {
      const result = await placeSubmission(data);
      // Cleared on every placement, so the notice always describes the move
      // just made rather than one from five drags ago.
      setEvicted(result.evicted ? { title: result.evicted.title, where } : null);
      setHeld(null);
    });
  }

  function clear(slotId: string) {
    const data = new FormData();
    data.set('slotId', slotId);
    startTransition(async () => {
      await clearSlot(data);
    });
  }

  const gridStyle = {
    gridTemplateColumns: `7rem repeat(${rooms.length}, minmax(9rem, 1fr))`,
  };

  /**
   * Which column each room owns, so every box is placed from its own `roomId`
   * rather than from how many siblings CSS auto-placement happened to lay down
   * before it.
   *
   * The offset is two: one column is reserved for the time label, and CSS grid
   * lines are 1-indexed. This is not cosmetic. A band is short a cell whenever a
   * room was created after that time band was (`createRoom` never writes `slots`,
   * and `addTimeBand` only writes rows for the rooms that exist at the time), and
   * under auto-placement one missing cell shifts every later box one column left,
   * so a talk renders under a room it is not in.
   */
  const columnOfRoom = new Map(rooms.map((room, index) => [room.id, String(index + 2)]));
  const nameOfRoom = new Map(rooms.map((room) => [room.id, room.name]));

  /**
   * Where a box is, in the words an organizer reads off the grid. The notice
   * after a displacement names the box the talk was displaced from, because
   * "that box was taken" is only useful to someone who still remembers which
   * box they dropped on.
   */
  function boxLabel(band: Band, cell: Cell): string {
    return `${band.dayLabel} ${band.timeLabel} · ${nameOfRoom.get(cell.roomId) ?? 'this room'}`;
  }

  let lastDay = '';

  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Unscheduled ({pool.length})</h2>
        <p className="text-xs text-muted">
          {held
            ? 'Now click a slot to place it.'
            : 'Click a talk to pick it up, or drag it onto the grid. A placed talk drags from one slot to another.'}
        </p>
        {pool.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-xs text-muted">
            Every accepted talk has a slot.
          </p>
        ) : null}
        {pool.map((item) => (
          <button
            key={item.id}
            type="button"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', item.id)}
            onClick={() => setHeld(held === item.id ? null : item.id)}
            data-testid={`pool-${item.id}`}
            className={cn(
              'block w-full rounded-md border p-2 text-left text-xs',
              held === item.id
                ? 'border-ink bg-ink/5 ring-2 ring-ink/20'
                : 'border-line bg-white hover:border-ink',
            )}
          >
            <span className="block font-medium text-ink">{item.title}</span>
            <span className="block text-muted">{item.speakerName ?? 'Unnamed'}</span>
          </button>
        ))}
      </aside>

      <div className="space-y-3">
        {/*
          Red rather than amber, and named a room conflict rather than described
          as a box being taken. One box holds one talk, so this is the same rule
          the persistent room warning above enforces, caught at the one moment it
          cannot survive into a recompute: the displaced talk is unplaced by the
          time the page reloads, and nothing in the database still says the two
          were ever asked to share a room.
        */}
        {evicted ? (
          <Notice tone="bad">
            <span data-testid="eviction-notice">
              Room conflict: {evicted.where} was already running “{evicted.title}”. One box holds
              one talk, so that one is back in the unscheduled pool on the left. Nothing was
              emailed.
            </span>
          </Notice>
        ) : null}

        <div className="overflow-x-auto">
        <div className={cn('schedule-grid', pending && 'opacity-60')} style={gridStyle}>
          <div />
          {rooms.map((room) => (
            <div key={room.id} className="px-2 pb-1 text-xs font-semibold text-ink">
              {room.name}
              {room.capacity !== null ? (
                <span className="ml-1 font-normal text-muted">· {room.capacity} seats</span>
              ) : null}
            </div>
          ))}

          {bands.map((band) => {
            const showDay = band.dayLabel !== lastDay;
            lastDay = band.dayLabel;
            return (
              <div key={band.key} className="contents">
                {showDay ? (
                  <div
                    className="col-span-full mt-3 border-t border-line pt-2 text-xs font-semibold text-muted"
                    style={{ gridColumn: '1 / -1' }}
                  >
                    {band.dayLabel}
                  </div>
                ) : null}
                {/*
                  Pinned to column 1 for the same reason each cell below is
                  pinned to its own room's column. A band only holds cells for
                  the rooms that existed when it was created, so most bands are
                  narrower than the grid; left on auto-placement this label
                  dropped into whichever gap the previous short band left and
                  printed over another room's card a row up. The time axis is
                  the first thing an organizer reads, so it cannot drift.
                */}
                <div
                  className="py-2 pr-2 text-right text-xs tabular-nums text-muted"
                  style={{ gridColumn: '1' }}
                >
                  {band.timeLabel}
                </div>
                {band.cells.map((cell) => (
                  <div
                    key={cell.slotId}
                    // A placed talk is draggable out of its box, which is what
                    // makes this a schedule you rearrange rather than one you
                    // fill once.
                    draggable={cell.submissionId !== null}
                    onDragStart={(e) => {
                      if (cell.submissionId) e.dataTransfer.setData('text/plain', cell.submissionId);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (over !== cell.slotId) setOver(cell.slotId);
                    }}
                    onDragLeave={() => setOver((current) => (current === cell.slotId ? null : current))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setOver(null);
                      const id = e.dataTransfer.getData('text/plain');
                      // A drop onto a labelled block is a placement too; the
                      // action clears the label as part of the same write. A
                      // drop onto the box it came from is a no-op worth skipping.
                      if (id && id !== cell.submissionId) place(cell.slotId, id, boxLabel(band, cell));
                    }}
                    onClick={() => {
                      if (held) place(cell.slotId, held, boxLabel(band, cell));
                      else if (cell.submissionId) setHeld(cell.submissionId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      if (e.target !== e.currentTarget) return;
                      e.preventDefault();
                      if (held) place(cell.slotId, held, boxLabel(band, cell));
                      else if (cell.submissionId) setHeld(cell.submissionId);
                    }}
                    tabIndex={0}
                    role={cell.submissionId === null && cell.label === null ? 'button' : undefined}
                    aria-label={
                      cell.submissionId
                        ? `${cell.title}. Press Enter to pick it up.`
                        : held
                          ? 'Empty slot. Press Enter to place the talk you picked up.'
                          : 'Empty slot.'
                    }
                    data-testid={`slot-${cell.slotId}`}
                    className={cn(
                      'min-h-16 cursor-pointer rounded-md border p-2 text-xs transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
                      cell.submissionId
                        ? 'border-line bg-white'
                        : cell.label
                          ? 'border-slate-300 bg-slate-100'
                          : 'border-dashed border-line bg-slate-50 hover:border-ink hover:bg-ink/5',
                      (cell.conflicted || cell.roomConflicted) && 'border-red-300 bg-red-50',
                      cell.unavailable !== null && 'border-amber-300 bg-amber-50',
                      held === cell.submissionId && 'ring-2 ring-ink/40',
                      over === cell.slotId && 'border-ink bg-ink/5 ring-2 ring-ink/40',
                    )}
                    style={{
                      gridColumn: columnOfRoom.get(cell.roomId),
                    }}
                  >
                    {cell.submissionId ? (
                      <>
                        <span className="block font-medium text-ink">{cell.title}</span>
                        <span className="block text-muted">{cell.speakerName ?? 'Unnamed'}</span>
                        {cell.conflicted ? (
                          <span className="mt-1 block font-medium text-red-700">
                            speaker double-booked
                          </span>
                        ) : null}
                        {cell.roomConflicted ? (
                          <span
                            className="mt-1 block font-medium text-red-700"
                            data-testid={`room-conflict-${cell.slotId}`}
                          >
                            room double-booked
                          </span>
                        ) : null}
                        {cell.unavailable ? (
                          <span
                            className="mt-1 block font-medium text-amber-800"
                            data-testid={`unavailable-${cell.slotId}`}
                          >
                            speaker unavailable
                            {cell.unavailable.note ? `: ${cell.unavailable.note}` : ''}
                          </span>
                        ) : null}
                        {cell.overCapacity ? (
                          <span
                            className="mt-1 block font-medium text-amber-800"
                            data-testid={`over-capacity-${cell.slotId}`}
                          >
                            {cell.overCapacity.bookmarks} starred · room seats{' '}
                            {cell.overCapacity.capacity}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            clear(cell.slotId);
                          }}
                          className="mt-1 text-muted underline hover:text-ink"
                          data-testid={`clear-${cell.slotId}`}
                        >
                          remove
                        </button>
                      </>
                    ) : cell.label ? (
                      <>
                        <span className="block font-medium uppercase tracking-wide text-slate-600">
                          {cell.label}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            clear(cell.slotId);
                          }}
                          className="mt-1 text-muted underline hover:text-ink"
                          data-testid={`clear-${cell.slotId}`}
                        >
                          remove
                        </button>
                      </>
                    ) : (
                      <span className="text-muted">empty</span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        </div>
      </div>
    </div>
  );
}
