import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { TASK_KIND_LABELS } from '@/lib/speaker-labels';
import { createSpeakerTaskAction } from '../actions';

/**
 * Add one task to one speaker. `submissionId` is optional because an account
 * level chase — a headshot, a bio — spans every talk they are giving, while
 * slides belong to one.
 */
export function TaskForm({
  userId,
  submissions,
}: {
  userId: string;
  submissions: { id: string; title: string }[];
}) {
  return (
    <form action={createSpeakerTaskAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What is owed">
          <Select name="kind" defaultValue="headshot" data-testid="task-kind">
            {Object.entries(TASK_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label">
          <Input
            name="label"
            required
            maxLength={200}
            placeholder="Send us a headshot"
            data-testid="task-label"
          />
        </Field>
        <Field label="Due" hint="Optional.">
          <Input type="datetime-local" name="dueAt" data-testid="task-due" />
        </Field>
        <Field label="About a submission" hint="Optional. Leave off for an account-level task.">
          <Select name="submissionId" defaultValue="">
            <option value="">Not about one talk</option>
            {submissions.map((submission) => (
              <option key={submission.id} value={submission.id}>
                {submission.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Instructions" hint="Optional. Shown to the speaker alongside the task.">
        <Textarea
          name="instructions"
          maxLength={2000}
          placeholder="For file requests: what you need, size, format, background."
          className="min-h-20"
          data-testid="task-instructions"
        />
      </Field>

      <Button type="submit" variant="secondary" data-testid="task-add">
        Add task
      </Button>
    </form>
  );
}
