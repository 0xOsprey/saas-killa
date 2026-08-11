'use client';

import { useActionState } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { createAvailabilityAction, type AvailabilityState } from '../actions';

const EMPTY: AvailabilityState = {};

/**
 * When a speaker cannot be put on the grid: a flight, a clashing commitment, a
 * hard stop. Times are wall clock in the event's timezone, the same convention
 * the schedule grid posts, so a block typed here lines up with the slot it is
 * meant to rule out.
 */
export function AvailabilityForm({ userId, timezone }: { userId: string; timezone: string }) {
  const [state, formAction, pending] = useActionState(createAvailabilityAction, EMPTY);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From" hint={timezone}>
          <Input type="datetime-local" name="startsAt" required />
        </Field>
        <Field label="Until" hint={timezone}>
          <Input type="datetime-local" name="endsAt" required />
        </Field>
        <Field label="Note" hint="Optional.">
          <Input name="note" maxLength={200} placeholder="Flight lands 14:00" />
        </Field>
      </div>

      <Button
        type="submit"
        variant="secondary"
        disabled={pending}
        title={pending ? 'Adding the unavailable block…' : 'Add this unavailable window'}
      >
        {pending ? 'Adding…' : 'Add unavailable block'}
      </Button>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.saved ? <Notice tone="good">Added.</Notice> : null}
    </form>
  );
}
