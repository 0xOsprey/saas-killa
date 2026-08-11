'use client';

import { useActionState } from 'react';
import { Button, Notice, cn } from '@/components/ui';
import { sendConfirmationRemindersAction, type ConfirmationReminderState } from './actions';

const EMPTY: ConfirmationReminderState = {};

/**
 * Bulk nudge for accepted speakers who have not confirmed or declined.
 *
 * The result is rendered because the skipped count (already reminded in the
 * last 24 hours) is the number that tells an organizer whether the button did
 * anything.
 */
export function ConfirmationReminderForm({
  count,
  variant = 'secondary',
  className,
  buttonClassName,
}: {
  count: number;
  variant?: 'primary' | 'secondary' | 'ghost';
  className?: string;
  buttonClassName?: string;
}) {
  const [state, formAction, pending] = useActionState(sendConfirmationRemindersAction, EMPTY);

  return (
    <form action={formAction} className={cn('space-y-2', className)}>
      <Button
        type="submit"
        variant={variant}
        className={buttonClassName}
        disabled={pending || count === 0}
        title={
          count === 0
            ? 'No unconfirmed speakers to chase'
            : pending
              ? 'Sending reminders…'
              : `Remind ${count} unconfirmed speaker(s)`
        }
      >
        {pending ? 'Sending…' : `Remind ${count} unconfirmed speaker(s)`}
      </Button>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.sent !== undefined ? (
        <Notice tone={state.sent > 0 ? 'good' : 'accent'}>
          {state.sent} reminder(s) sent · {state.skipped} skipped, reminded within the last 24
          hours.
        </Notice>
      ) : null}
    </form>
  );
}
