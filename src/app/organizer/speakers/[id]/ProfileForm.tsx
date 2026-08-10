'use client';

import { useActionState } from 'react';
import { Button, Field, Input, Notice, Textarea } from '@/components/ui';
import { Headshot } from '@/app/speakers/Headshot';
import { updateSpeakerProfileAction, type ProfileState } from '../actions';

const EMPTY: ProfileState = {};

/**
 * The organizer's copy of the speaker profile. The preview beside the URL field
 * is the point of it: a headshot URL is usually pasted from somewhere else, and
 * a broken paste should be visible here rather than on the published agenda.
 */
export function ProfileForm({
  userId,
  name,
  bio,
  headshotUrl,
}: {
  userId: string;
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
}) {
  const [state, formAction, pending] = useActionState(updateSpeakerProfileAction, EMPTY);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />

      <Field label="Name">
        <Input name="name" defaultValue={name ?? ''} maxLength={120} data-testid="profile-name" />
      </Field>

      <Field label="Bio" hint="Shown on the agenda detail page and the public directory.">
        <Textarea name="bio" defaultValue={bio ?? ''} maxLength={4000} />
      </Field>

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Field
            label="Headshot URL"
            hint="A full URL, or an uploaded file's own /files/… path. Left blank, initials are shown instead."
          >
            {/*
              Not `type="url"`. An uploaded headshot is stored as an app-relative
              `/files/<id>/…` path, which fails HTML5 url validation and blocks
              the whole form silently, with no message anywhere. `linkField` on
              the server accepts both shapes and rejects everything else.
            */}
            <Input
              type="text"
              name="headshotUrl"
              defaultValue={headshotUrl ?? ''}
              placeholder="https://… or /files/…"
            />
          </Field>
        </div>
        <Headshot src={headshotUrl} name={name} size="md" />
      </div>

      <Button type="submit" disabled={pending} data-testid="profile-save">
        {pending ? 'Saving…' : 'Save profile'}
      </Button>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.saved ? (
        <Notice tone="good">
          <span data-testid="profile-saved">Saved.</span>
        </Notice>
      ) : null}
    </form>
  );
}
