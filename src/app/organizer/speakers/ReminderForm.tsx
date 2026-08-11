'use client';

import { useActionState } from 'react';
import { Button, Notice, cn } from '@/components/ui';
import { sendTaskRemindersAction, type ReminderState } from './actions';

const EMPTY: ReminderState = {};

/**
 * Chase outstanding tasks. Used at three scopes with the same action: every
 * speaker on screen, one speaker, one task.
 *
 * The result is rendered rather than swallowed because "skipped" is the
 * interesting number. A second press an hour later reports 0 sent and every
 * task skipped, which is the cooldown working and needs to look like it.
 */
export function ReminderForm({
  scope,
  filter,
  q,
  userId,
  taskId,
  label,
  variant = 'secondary',
  className,
  buttonClassName,
}: {
  scope: 'all' | 'user' | 'task';
  filter?: string;
  q?: string;
  userId?: string;
  taskId?: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  className?: string;
  buttonClassName?: string;
}) {
  const [state, formAction, pending] = useActionState(sendTaskRemindersAction, EMPTY);

  return (
    <form action={formAction} className={cn('space-y-2', className)}>
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="filter" value={filter ?? 'all'} />
      <input type="hidden" name="q" value={q ?? ''} />
      {userId ? <input type="hidden" name="userId" value={userId} /> : null}
      {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}

      <Button type="submit" variant={variant} className={buttonClassName} disabled={pending}>
        {pending ? 'Sending…' : label}
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
