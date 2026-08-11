'use client';

import { useActionState } from 'react';
import { Button, Field, FieldAction, Input, Notice, Textarea } from '@/components/ui';
import { Headshot } from '@/app/speakers/Headshot';
import { updateSpeakerProfileAction, type ProfileState } from '../actions';

const EMPTY: ProfileState = {};

/**
 * The organizer's copy of the speaker profile. The preview beside the URL field
 * is the point of it: a headshot URL is usually pasted from somewhere else, and
 * a broken paste should be visible here rather than on the published agenda.
 *
 * The photo has two doors in one form — attach a file, or paste a URL — and one
 * Save. Conference staff get the headshot by email far more often than the
 * speaker ever uploads one, so "upload it for them" has to be here and not only
 * on the speaker's own page; and an organizer fixing a bio and attaching the
 * photo in the same sitting should press Save once, not lose one to the other.
 *
 * `accept` and the size limit are props rather than imports. They come from
 * `UPLOAD_KINDS` in `@/lib/uploads`, which opens the database, and a client
 * component cannot pull that in.
 */
export function ProfileForm({
  userId,
  name,
  title,
  company,
  bio,
  travelNotes,
  headshotUrl,
  headshotAccept,
  headshotLimit,
}: {
  userId: string;
  name: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  travelNotes: string | null;
  headshotUrl: string | null;
  headshotAccept: string;
  headshotLimit: string;
}) {
  const [state, formAction, pending] = useActionState(updateSpeakerProfileAction, EMPTY);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />

      <Field label="Name">
        <Input name="name" defaultValue={name ?? ''} maxLength={120} data-testid="profile-name" />
      </Field>

      {/*
        Both halves of the byline, side by side, because they are read as one
        line and an organizer typing a job title into a company field is the
        mistake that separating them invites. Neither is required: a speaker
        billed by name alone is a real speaker, and every surface that prints
        this drops the line rather than showing half of it.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Job title">
          <Input
            name="title"
            defaultValue={title ?? ''}
            maxLength={120}
            placeholder="Principal Engineer"
            data-testid="profile-title"
          />
        </Field>
        <Field label="Company">
          <Input
            name="company"
            defaultValue={company ?? ''}
            maxLength={120}
            placeholder="Latticework Systems"
            data-testid="profile-company"
          />
        </Field>
      </div>

      <Field label="Bio" hint="Shown on the agenda detail page and the public directory.">
        <Textarea name="bio" defaultValue={bio ?? ''} maxLength={4000} data-testid="profile-bio" />
      </Field>

      {/*
        The hint is doing real work. This box sits directly under the bio, which
        is published everywhere, and the two are one keystroke apart. Whoever
        types an allergy or a flight number into the wrong one has put it on the
        public agenda, so the field says out loud that it is the one nobody else
        sees.
      */}
      <Field
        label="Travel and logistics"
        hint="Organizer-only. Never shown to the speaker or on any public page."
      >
        <Textarea
          name="travelNotes"
          defaultValue={travelNotes ?? ''}
          maxLength={2000}
          placeholder="Arriving Friday evening, vegetarian, hotel booked by us."
          data-testid="profile-travel-notes"
        />
      </Field>

      <Field
        label="Headshot photo"
        hint={`PNG, JPEG, GIF or WebP, up to ${headshotLimit}. It replaces whatever photo is there now, and saves with the rest of the profile.`}
      >
        <input
          type="file"
          name="headshotFile"
          accept={headshotAccept}
          data-testid="headshot-file"
          className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-50"
        />
      </Field>

      <div className="flex items-start gap-3">
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

              Keyed on the stored value so an upload's new path replaces what is
              in the box. `defaultValue` is read once at mount, and an
              uncontrolled input left holding the previous path would post it
              back on the next save — over bytes the upload has already deleted.
            */}
            <Input
              key={headshotUrl ?? ''}
              type="text"
              name="headshotUrl"
              defaultValue={headshotUrl ?? ''}
              placeholder="https://… or /files/…"
              data-testid="profile-headshot-url"
            />
          </Field>
        </div>
        <FieldAction>
          <Headshot src={headshotUrl} name={name} size="md" />
        </FieldAction>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending} data-testid="profile-save">
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
        {/*
          The same submit, under the name somebody who just picked a file goes
          looking for. It posts this whole form, so reaching for it instead of
          Save costs nothing: the bio typed a moment ago is saved either way.
        */}
        <Button
          type="submit"
          variant="secondary"
          disabled={pending}
          data-testid="headshot-upload"
        >
          {pending ? 'Uploading…' : 'Upload headshot'}
        </Button>
      </div>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.saved ? (
        <Notice tone="good">
          <span data-testid="profile-saved">
            Saved.
            {state.uploaded ? (
              <span data-testid="headshot-uploaded">
                {' '}
                {state.uploaded} is now this speaker&rsquo;s headshot.
              </span>
            ) : null}
          </span>
        </Notice>
      ) : null}
    </form>
  );
}
