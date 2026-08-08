'use client';

import { useState } from 'react';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { QUESTION_KIND_LABELS, type QuestionShape } from '@/lib/questions';
import type { QuestionKind } from '@/db/schema';

export type TrackChoice = { id: string; name: string };

/**
 * Add or edit one question.
 *
 * Client-side only so the choices textarea can appear and disappear with the
 * kind. Everything it enforces is enforced again in the action: this decides
 * what is worth showing, not what is allowed.
 */
export function QuestionForm({
  action,
  question,
  tracks,
  formats,
  submitLabel,
}: {
  action: (formData: FormData) => void;
  question?: QuestionShape;
  tracks: TrackChoice[];
  formats: readonly string[];
  submitLabel: string;
}) {
  const [kind, setKind] = useState<QuestionKind>(question?.kind ?? 'short_text');

  return (
    <form action={action} className="space-y-3">
      {question ? <input type="hidden" name="questionId" value={question.id} /> : null}

      <Field label="Question">
        <Input
          name="prompt"
          defaultValue={question?.prompt}
          required
          minLength={3}
          maxLength={300}
          placeholder="What is the one thing an attendee should leave knowing?"
        />
      </Field>

      <Field label="Help text" hint="Optional. Shown under the question in smaller type.">
        <Input name="helpText" defaultValue={question?.helpText ?? ''} maxLength={500} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Answer type">
          <Select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as QuestionKind)}
          >
            {Object.entries(QUESTION_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Required">
          <label className="flex h-9 items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="required" defaultChecked={question?.required ?? false} />
            <span>A speaker cannot submit without answering</span>
          </label>
        </Field>
      </div>

      {kind === 'select' ? (
        <Field label="Choices" hint="One per line. At least two.">
          <Textarea
            name="options"
            defaultValue={(question?.options ?? []).join('\n')}
            className="min-h-24"
            placeholder={'Beginner\nIntermediate\nAdvanced'}
          />
        </Field>
      ) : null}

      <fieldset className="rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-muted">Ask this question of</legend>
        <p className="mb-2 text-xs text-muted">
          Tick nothing to ask everyone. Ticking narrows.
        </p>

        <div className="flex flex-wrap gap-3">
          {formats.map((format) => (
            <label key={format} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                name="formats"
                value={format}
                defaultChecked={question?.formats.includes(format) ?? false}
              />
              <span className="capitalize">{format.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>

        {tracks.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-3 border-t border-line pt-2">
            {tracks.map((track) => (
              <label key={track.id} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  name="trackIds"
                  value={track.id}
                  defaultChecked={question?.trackIds.includes(track.id) ?? false}
                />
                <span>{track.name}</span>
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>

      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}
