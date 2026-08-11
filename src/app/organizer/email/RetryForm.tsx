'use client';

import { useActionState } from 'react';
import { Notice, cn } from '@/components/ui';
import { retryEmailAction, type RetryState } from './actions';

const EMPTY: RetryState = {};

const BADGE_TONE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium wrap-anywhere ' +
  'border border-status-warn-border/20 bg-status-warn-bg/10 text-status-warn-text ' +
  'hover:bg-status-warn-bg/20 active:scale-[0.98]';

/**
 * Turn the "not sent" badge into the action that fixes it.
 *
 * The button is styled as a badge so the status object itself carries the
 * action. State is returned on failure only: a successful retry revalidates
 * the page and the row flips to "delivered".
 */
export function RetryForm({ id, canRetry }: { id: string; canRetry: boolean }) {
  const [state, formAction, pending] = useActionState(retryEmailAction, EMPTY);

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={!canRetry || pending}
        className={cn(BADGE_TONE, (!canRetry || pending) && 'opacity-60')}
        title={
          canRetry
            ? pending
              ? 'Retrying…'
              : 'Resend this email now'
            : 'This email was sent before retry was available'
        }
        data-testid={`email-retry-${id}`}
      >
        {pending ? 'retrying…' : 'not sent'}
      </button>
      {state.error ? (
        <div className="inline-block py-1">
          <Notice tone="bad">
            <span className="text-xs">{state.error}</span>
          </Notice>
        </div>
      ) : null}
    </form>
  );
}
