'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/components/ui';
import { clearSlot, placeSubmission } from './actions';

export type PoolItem = {
  id: string;
  title: string;
  speakerName: string | null;
  trackColour: string | null;
};

export type Cell = {
  slotId: string;
  roomId: string;
  submissionId: string | null;
  title: string | null;
  speakerName: string | null;
  trackColour: string | null;
  conflicted: boolean;
};

export type Band = {
  key: string;
  dayLabel: string;
  timeLabel: string;
  cells: Cell[];
};

/**
 * Placement works two ways on purpose. Dragging is what an organizer reaches
 * for with a mouse; click-to-select then click-to-place is the same operation
 * without a pointer, and it is the path the end-to-end test drives, because
 * HTML5 drag events are not reliably synthesisable in a browser automation
 * harness. Both call the same server action.
 */
export function ScheduleGrid({
  roomNames,
  bands,
  pool,
}: {
  roomNames: { id: string; name: string }[];
  bands: Band[];
  pool: PoolItem[];
}) {
  const [held, setHeld] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function place(slotId: string, submissionId: string) {
    const data = new FormData();
    data.set('slotId', slotId);
    data.set('submissionId', submissionId);
    startTransition(async () => {
      await placeSubmission(data);
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
    gridTemplateColumns: `7rem repeat(${roomNames.length}, minmax(9rem, 1fr))`,
  };

  let lastDay = '';

  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">
          Unscheduled ({pool.length})
        </h2>
        <p className="text-xs text-muted">
          {held
            ? 'Now click an empty slot to place it.'
            : 'Click a talk to pick it up, or drag it onto the grid.'}
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
                ? 'border-accent bg-accent-soft ring-2 ring-accent/30'
                : 'border-line bg-white hover:border-accent',
            )}
            style={{ borderLeft: `3px solid ${item.trackColour ?? '#cbd5e1'}` }}
          >
            <span className="block font-medium text-ink">{item.title}</span>
            <span className="block text-muted">{item.speakerName ?? 'Unnamed'}</span>
          </button>
        ))}
      </aside>

      <div className="overflow-x-auto">
        <div className={cn('schedule-grid', pending && 'opacity-60')} style={gridStyle}>
          <div />
          {roomNames.map((room) => (
            <div key={room.id} className="px-2 pb-1 text-xs font-semibold text-ink">
              {room.name}
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
                <div className="py-2 pr-2 text-right text-xs tabular-nums text-muted">
                  {band.timeLabel}
                </div>
                {band.cells.map((cell) => (
                  <div
                    key={cell.slotId}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain');
                      if (id) place(cell.slotId, id);
                    }}
                    onClick={() => {
                      if (held) place(cell.slotId, held);
                      else if (cell.submissionId) setHeld(cell.submissionId);
                    }}
                    data-testid={`slot-${cell.slotId}`}
                    className={cn(
                      'min-h-16 cursor-pointer rounded-md border p-2 text-xs transition-colors',
                      cell.submissionId
                        ? 'border-line bg-white'
                        : 'border-dashed border-line bg-slate-50 hover:border-accent hover:bg-accent-soft',
                      cell.conflicted && 'border-red-300 bg-red-50',
                      held === cell.submissionId && 'ring-2 ring-accent/40',
                    )}
                    style={
                      cell.trackColour
                        ? { borderLeft: `3px solid ${cell.trackColour}` }
                        : undefined
                    }
                  >
                    {cell.submissionId ? (
                      <>
                        <span className="block font-medium text-ink">{cell.title}</span>
                        <span className="block text-muted">
                          {cell.speakerName ?? 'Unnamed'}
                        </span>
                        {cell.conflicted ? (
                          <span className="mt-1 block font-medium text-red-700">
                            speaker double-booked
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
  );
}
