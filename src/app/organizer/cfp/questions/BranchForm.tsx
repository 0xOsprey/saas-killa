'use client';

import { useState } from 'react';
import { Button, Select } from '@/components/ui';
import { branchValues, type QuestionShape } from '@/lib/questions';

/**
 * Point a question at the answer that reveals it.
 *
 * Only earlier questions are offered, and only those with a fixed set of
 * answers: a branch off a free-text field would be keyed to a string nobody
 * types twice. `possibleParents` on the server decides the list; this decides
 * which values that parent can offer, which changes as the parent changes.
 */
export function BranchForm({
  action,
  questionId,
  parents,
  showIfQuestionId,
  showIfValue,
}: {
  action: (formData: FormData) => void;
  questionId: string;
  parents: QuestionShape[];
  showIfQuestionId: string | null;
  showIfValue: string | null;
}) {
  const branchable = parents.filter((parent) => branchValues(parent).length > 0);
  const [parentId, setParentId] = useState(showIfQuestionId ?? '');

  if (branchable.length === 0) {
    return (
      <p className="text-xs text-muted">
        Always shown. Move a yes/no or choose-one question above this one to branch off it.
      </p>
    );
  }

  const parent = branchable.find((row) => row.id === parentId) ?? null;
  const values = parent ? branchValues(parent) : [];

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="questionId" value={questionId} />

      <label className="text-xs text-muted">
        <span className="mb-1 block">Show when</span>
        <Select
          name="showIfQuestionId"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="max-w-64"
        >
          <option value="">Always</option>
          {branchable.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.prompt}
            </option>
          ))}
        </Select>
      </label>

      {parent ? (
        <label className="text-xs text-muted">
          <span className="mb-1 block">is</span>
          <Select
            name="showIfValue"
            defaultValue={parent.id === showIfQuestionId ? (showIfValue ?? '') : ''}
          >
            {values.map((value) => (
              <option key={value} value={value}>
                {parent.kind === 'checkbox' ? 'ticked' : value}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      <Button type="submit" variant="ghost">
        Save rule
      </Button>
    </form>
  );
}
