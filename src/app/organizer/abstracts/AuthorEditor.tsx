'use client';

import { useActionState } from 'react';
import { Badge, Button, Field, Input, Notice } from '@/components/ui';
import type { AbstractActionState, AuthorRow } from '@/lib/abstracts';

type FormAction = (
  prev: AbstractActionState,
  formData: FormData,
) => Promise<AbstractActionState>;

/**
 * Co-author management, shared by the organizer editor and the speaker editor.
 * The two differ only in which actions they hand in, and those actions carry
 * their own authorisation.
 */
export function AuthorEditor({
  submissionId,
  speakerId,
  authors,
  addAction,
  removeAction,
}: {
  submissionId: string;
  speakerId: string;
  authors: AuthorRow[];
  addAction: FormAction;
  removeAction: FormAction;
}) {
  const [addState, add, adding] = useActionState<AbstractActionState, FormData>(addAction, {});
  const [removeState, remove] = useActionState<AbstractActionState, FormData>(removeAction, {});

  return (
    <div className="space-y-4">
      {addState.error ? <Notice tone="bad">{addState.error}</Notice> : null}
      {addState.notice ? <Notice tone="good">{addState.notice}</Notice> : null}
      {removeState.error ? <Notice tone="bad">{removeState.error}</Notice> : null}

      <ol className="space-y-2">
        {authors.map((author) => {
          const isFiler = author.userId === speakerId;
          return (
            <li
              key={author.userId}
              className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2"
            >
              <span className="w-6 text-xs tabular-nums text-muted">{author.position}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">
                  {author.name ?? author.email}
                </span>
                <span className="block text-xs text-muted">
                  {author.email}
                  {author.affiliation ? ` · ${author.affiliation}` : ''}
                </span>
              </span>
              <span className="ml-auto flex items-center gap-2">
                {isFiler ? <Badge tone="accent">filed this</Badge> : null}
                {author.isPresenter ? null : <Badge>not presenting</Badge>}
                {isFiler ? null : (
                  <form action={remove}>
                    <input type="hidden" name="submissionId" value={submissionId} />
                    <input type="hidden" name="userId" value={author.userId} />
                    <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                      Remove
                    </Button>
                  </form>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <form action={add} className="space-y-3 border-t border-line pt-4">
        <input type="hidden" name="submissionId" value={submissionId} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Co-author email" hint="An account is created if there is none.">
            <Input name="email" type="email" required />
          </Field>
          <Field label="Name">
            <Input name="name" maxLength={120} />
          </Field>
          <Field label="Affiliation">
            <Input name="affiliation" maxLength={200} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="isPresenter" defaultChecked className="h-4 w-4" />
          Will be in the room
        </label>
        <Button type="submit" variant="secondary" disabled={adding}>
          {adding ? 'Adding…' : 'Add co-author'}
        </Button>
      </form>
    </div>
  );
}
