import { Button, Field, Select } from '@/components/ui';
import type { ScheduleEntry } from '@/lib/schedule-views';
import { clearSlot, placeSubmissionFromForm } from './actions';

export type FallbackTalk = { id: string; title: string; speakerName: string | null };

/**
 * Placing and clearing without JavaScript.
 *
 * The grid is a client component: dragging, click-to-place and the per-cell
 * remove control are all event handlers, so with scripting off the schedule is
 * a picture. These two plain forms post straight to the same server actions, so
 * the grid is an enhancement over a page that already works rather than the only
 * way in. They are also the keyboard-only path with the shortest number of
 * keystrokes, which is why they are on the page rather than inside `<noscript>`.
 */
export function ScheduleFallback({
  talks,
  slots,
}: {
  talks: FallbackTalk[];
  slots: ScheduleEntry[];
}) {
  const filled = slots.filter((slot) => slot.submissionId !== null || slot.label !== null);

  // An occupied slot stays on offer, because putting a talk where another one is
  // is how a schedule gets rearranged. It says "taken by" rather than naming the
  // occupant alone: with script off there is no notice after the press, so the
  // warning has to be in the option the organizer reads before it.
  function slotLabel(slot: ScheduleEntry): string {
    const where = `${slot.dayLabel} ${slot.time} · ${slot.roomName}`;
    if (slot.title) return `${where} — taken by ${slot.title}`;
    return slot.label ? `${where} — ${slot.label}` : where;
  }

  return (
    <details className="text-sm" data-testid="schedule-fallback">
      <summary className="cursor-pointer text-muted">Place or clear a slot from a form</summary>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <form action={placeSubmissionFromForm} className="flex flex-wrap items-end gap-3">
          <Field label="Talk">
            <Select name="submissionId" required className="w-64" data-testid="fallback-talk">
              <option value="">Choose a talk</option>
              {talks.map((talk) => (
                <option key={talk.id} value={talk.id}>
                  {talk.title}
                  {talk.speakerName ? ` — ${talk.speakerName}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Slot"
            hint="A slot marked “taken by” already holds a talk. Placing into it sends that one back to the unscheduled pool."
          >
            <Select name="slotId" required className="w-72" data-testid="fallback-slot">
              <option value="">Choose a slot</option>
              {slots.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {slotLabel(slot)}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" data-testid="fallback-place">
            Place
          </Button>
        </form>

        <form action={clearSlot} className="flex flex-wrap items-end gap-3">
          <Field label="Empty a slot">
            <Select name="slotId" required className="w-72" data-testid="fallback-clear-slot">
              <option value="">Choose a slot</option>
              {filled.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {slotLabel(slot)}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" data-testid="fallback-clear">
            Clear
          </Button>
        </form>
      </div>
    </details>
  );
}
