'use client';

import { useActionState } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { addAvailabilityBlock, type AvailabilityState } from './actions';

const EMPTY: AvailabilityState = {};

/**
 * When this speaker cannot be put on the grid: a flight, a clashing commitment,
 * a hard stop. Times are wall clock in the event's timezone, the same convention
 * the organizer's copy of this form and the schedule grid both post, so a block
 * typed here rules out the slot it is meant to.
 */
export function AvailabilityForm({ timezone }: { timezone: string }) {
  const [state, formAction, pending] = useActionState(addAvailabilityBlock, EMPTY);

  return (
    <form id="add-availability" action={formAction} className="space-y-3" data-testid="availability-form">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From" hint={timezone}>
          <Input type="datetime-local" name="startsAt" required data-testid="availability-from" />
        </Field>
        <Field label="Until" hint={timezone}>
          <Input type="datetime-local" name="endsAt" required data-testid="availability-until" />
        </Field>
        <Field label="Note" hint="Optional. The organizers read it.">
          <Input
            name="note"
            maxLength={200}
            placeholder="Flight lands 14:00"
            data-testid="availability-note"
          />
        </Field>
      </div>

      <Button
        type="submit"
        variant="secondary"
        disabled={pending}
        title={pending ? 'Saving the block…' : 'Add this unavailable window'}
        data-testid="availability-add"
      >
        {pending ? 'Adding…' : 'Add unavailable block'}
      </Button>

      {state.error ? (
        <Notice tone="bad">
          <span data-testid="availability-error">{state.error}</span>
        </Notice>
      ) : null}
      {state.saved ? (
        <Notice tone="good">
          <span data-testid="availability-saved">Added.</span>
        </Notice>
      ) : null}
    </form>
  );
}
