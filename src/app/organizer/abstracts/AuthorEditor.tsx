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
 *
 * `accessAction` is the exception, and it is optional because the two sides
 * differ in more than the action: only the speaker who filed a proposal may
 * hand out write access to it. Passing nothing renders the access column as a
 * badge, which is what an organizer needs to see who can act on a submission
 * without being able to change it.
 */
export function AuthorEditor({
  submissionId,
  speakerId,
  authors,
  addAction,
  removeAction,
  accessAction,
}: {
  submissionId: string;
  speakerId: string;
  authors: AuthorRow[];
  addAction: FormAction;
  removeAction: FormAction;
  accessAction?: FormAction;
}) {
  const [addState, add, adding] = useActionState<AbstractActionState, FormData>(addAction, {});
  const [removeState, remove] = useActionState<AbstractActionState, FormData>(removeAction, {});
  const [accessState, setAccess] = useActionState<AbstractActionState, FormData>(
    accessAction ?? (async (prev) => prev),
    {},
  );

  return (
    <div className="space-y-4">
      {addState.error ? <Notice tone="bad">{addState.error}</Notice> : null}
      {addState.notice ? <Notice tone="good">{addState.notice}</Notice> : null}
      {removeState.error ? <Notice tone="bad">{removeState.error}</Notice> : null}
      {accessState.error ? <Notice tone="bad">{accessState.error}</Notice> : null}
      {accessState.notice ? <Notice tone="good">{accessState.notice}</Notice> : null}

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
                {/* Spelled out here rather than imported from `@/lib/abstracts`,
                    where the same derivation lives for the server-rendered
                    lists. This is a client component, and importing a value out
                    of that module would drag the database client into the
                    browser bundle behind a two-line helper. */}
                <Badge
                  tone={isFiler ? 'accent' : 'neutral'}
                  data-testid={`author-role-${author.userId}`}
                >
                  {isFiler ? 'Submitter' : author.isPresenter ? 'Co-presenter' : 'Co-author'}
                </Badge>
                {isFiler ? <Badge tone="accent">filed this</Badge> : null}
                {!isFiler && author.canEdit ? <Badge tone="good">can edit</Badge> : null}

                {accessAction && !isFiler ? (
                  <form action={setAccess}>
                    <input type="hidden" name="submissionId" value={submissionId} />
                    <input type="hidden" name="userId" value={author.userId} />
                    <input type="hidden" name="canEdit" value={author.canEdit ? '' : 'on'} />
                    <Button
                      type="submit"
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      data-testid={`access-${author.userId}`}
                    >
                      {author.canEdit ? 'Revoke editing' : 'Let them edit'}
                    </Button>
                  </form>
                ) : null}

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
        {accessAction ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="canEdit" className="h-4 w-4" data-testid="grant-edit" />
            Can edit this proposal, not only be credited on it
          </label>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          disabled={adding}
          title={adding ? 'Adding the co-author…' : 'Add this co-author to the proposal'}
        >
          {adding ? 'Adding…' : 'Add co-author'}
        </Button>
      </form>
    </div>
  );
}
