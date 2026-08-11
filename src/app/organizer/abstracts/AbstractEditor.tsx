'use client';

import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import type { AbstractActionState, AbstractEdit, EditableField } from '@/lib/abstracts';
import { AbstractFields } from './AbstractFields';

/**
 * The edit form itself, shared by the organizer editor and the speaker editor.
 * Which fields are locked and which action runs are the caller's business; this
 * only renders the fields and reports what came back.
 */
export function AbstractEditor({
  submissionId,
  values,
  locked = [],
  action,
}: {
  submissionId: string;
  values: AbstractEdit;
  locked?: EditableField[];
  action: (prev: AbstractActionState, formData: FormData) => Promise<AbstractActionState>;
}) {
  const [state, submit, pending] = useActionState<AbstractActionState, FormData>(action, {});

  return (
    <form action={submit} className="space-y-4">
      <input type="hidden" name="submissionId" value={submissionId} />
      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.notice ? <Notice tone="good">{state.notice}</Notice> : null}

      <AbstractFields values={values} locked={locked} />

      <Button
        type="submit"
        disabled={pending}
        title={pending ? 'Saving the changes…' : 'Save the changes to this proposal'}
        data-testid="save-abstract"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  );
}
