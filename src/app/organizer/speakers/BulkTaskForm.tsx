'use client';

import { useActionState } from 'react';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { TASK_KIND_LABELS } from '@/lib/speaker-labels';
import { bulkCreateTasksAction, type BulkTaskState } from './actions';

const EMPTY: BulkTaskState = {};

/**
 * Set one deadline against everyone currently on screen. The filter and search
 * term are posted rather than a list of ids, so the action re-resolves the same
 * roster query and cannot act on a set the organizer never saw.
 */
export function BulkTaskForm({
  filter,
  q,
  targetCount,
}: {
  filter: string;
  q: string;
  targetCount: number;
}) {
  const [state, formAction, pending] = useActionState(bulkCreateTasksAction, EMPTY);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="filter" value={filter} />
      <input type="hidden" name="q" value={q} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="What is owed">
          <Select name="kind" defaultValue="headshot">
            {Object.entries(TASK_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label">
          <Input name="label" defaultValue="Send us a headshot" maxLength={200} required />
        </Field>
        <Field label="Due" hint="Left blank, the task has no deadline.">
          <Input type="datetime-local" name="dueAt" />
        </Field>
      </div>

      <Field label="Instructions" hint="Optional. Shown to every speaker this task is added for.">
        <Textarea
          name="instructions"
          maxLength={2000}
          placeholder="For file requests: what you need, size, format, background."
          className="min-h-20"
          data-testid="bulk-task-instructions"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || targetCount === 0}>
          {pending ? 'Adding…' : `Add to ${targetCount} speaker(s)`}
        </Button>
        <span className="text-xs text-muted">
          Anyone who already owes a task of this kind is left alone.
        </span>
      </div>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.created !== undefined ? (
        <Notice tone="good">
          {state.created} task(s) added · {state.skipped} already had one.
        </Notice>
      ) : null}
    </form>
  );
}
