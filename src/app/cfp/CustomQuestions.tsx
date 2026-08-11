'use client';

import { useState } from 'react';
import { Field, Input, Select, Textarea } from '@/components/ui';
import {
  CHECKED,
  fieldName,
  visibleQuestions,
  type AnswerMap,
  type QuestionShape,
} from '@/lib/questions';

/**
 * The organizer-configured half of the submission form.
 *
 * Visibility is recomputed from `visibleQuestions` on every keystroke, the same
 * pure function the server action validates with. A hidden question renders
 * nothing at all rather than a disabled input, so its value never reaches the
 * POST and cannot be revived by a branch reopening later.
 *
 * `initialAnswers` seeds the state once, on mount. These inputs are controlled,
 * so a resumed draft cannot reach them through a `defaultValue` the way the
 * fixed fields above are filled in; the parent remounts this subtree when it
 * restores a draft, which is what makes a mount-time seed enough.
 */
export function CustomQuestions({
  questions,
  format,
  trackId,
  initialAnswers,
}: {
  questions: QuestionShape[];
  format: string;
  trackId: string | null;
  initialAnswers?: AnswerMap;
}) {
  const [answers, setAnswers] = useState<AnswerMap>(initialAnswers ?? {});
  const visible = visibleQuestions(questions, { format, trackId }, answers);

  if (questions.length === 0) return null;

  function set(id: string, value: string) {
    setAnswers((current) => ({ ...current, [id]: value }));
  }

  return (
    <div className="space-y-4" data-testid="custom-questions">
      {visible.length === 0 ? (
        <p className="text-xs text-muted">
          No extra questions apply to this format and track.
        </p>
      ) : null}

      {visible.map((question) => {
        const name = fieldName(question.id);
        const value = answers[question.id] ?? '';
        const testId = `question-${question.id}`;

        if (question.kind === 'checkbox') {
          return (
            <label
              key={question.id}
              className="flex items-start gap-2 text-sm text-ink"
              data-testid={testId}
            >
              <input
                type="checkbox"
                name={name}
                value={CHECKED}
                checked={value === CHECKED}
                onChange={(e) => set(question.id, e.target.checked ? CHECKED : '')}
                className="mt-1"
              />
              <span>
                {question.prompt}
                {question.helpText ? (
                  <span className="mt-0.5 block text-xs text-muted">{question.helpText}</span>
                ) : null}
              </span>
            </label>
          );
        }

        return (
          <Field
            key={question.id}
            label={question.required ? `${question.prompt} *` : question.prompt}
            hint={question.helpText ?? undefined}
          >
            {question.kind === 'long_text' ? (
              <Textarea
                name={name}
                value={value}
                required={question.required}
                maxLength={4000}
                className="min-h-24"
                onChange={(e) => set(question.id, e.target.value)}
                data-testid={testId}
              />
            ) : question.kind === 'select' ? (
              <Select
                name={name}
                value={value}
                required={question.required}
                onChange={(e) => set(question.id, e.target.value)}
                data-testid={testId}
              >
                <option value="">Choose one</option>
                {question.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                name={name}
                type={question.kind === 'url' ? 'url' : 'text'}
                value={value}
                required={question.required}
                maxLength={4000}
                onChange={(e) => set(question.id, e.target.value)}
                data-testid={testId}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
