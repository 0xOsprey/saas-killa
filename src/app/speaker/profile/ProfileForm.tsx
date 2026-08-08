'use client';

import { useActionState, useState } from 'react';
import { Button, Card, Field, Input, Notice, Textarea } from '@/components/ui';
import { Headshot } from './Headshot';
import { saveProfile, type ProfileState } from './actions';

export function ProfileForm({
  email,
  name,
  bio,
  headshotUrl,
}: {
  email: string;
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
}) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveProfile, {});
  // Mirrored into state purely so the preview beside the field tracks typing.
  const [previewName, setPreviewName] = useState(name ?? '');
  const [previewUrl, setPreviewUrl] = useState(headshotUrl ?? '');

  return (
    <form action={action} className="space-y-6">
      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.saved ? (
        <Notice tone="good">
          <span data-testid="profile-saved">Profile saved.</span>
        </Notice>
      ) : null}

      <Card className="space-y-4">
        <div className="flex items-center gap-4">
          <Headshot url={previewUrl} name={previewName || null} email={email} size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{previewName || 'Unnamed'}</p>
            <p className="truncate text-xs text-muted">{email}</p>
          </div>
        </div>

        <Field label="Name" hint="Printed on the agenda beside every talk of yours.">
          <Input
            name="name"
            required
            maxLength={120}
            defaultValue={name ?? ''}
            onChange={(e) => setPreviewName(e.target.value)}
            data-testid="profile-name"
          />
        </Field>

        <Field label="Short bio" hint="A paragraph. Attendees read this before deciding to come.">
          <Textarea
            name="bio"
            maxLength={2000}
            className="min-h-24"
            defaultValue={bio ?? ''}
            data-testid="profile-bio"
          />
        </Field>

        <Field label="Headshot URL" hint="A link to an image. Leave it empty to show your initials.">
          <Input
            name="headshotUrl"
            type="url"
            defaultValue={headshotUrl ?? ''}
            onChange={(e) => setPreviewUrl(e.target.value)}
            placeholder="https://example.com/me.jpg"
            data-testid="profile-headshot-url"
          />
        </Field>
      </Card>

      <Button type="submit" disabled={pending} data-testid="profile-save">
        {pending ? 'Saving…' : 'Save profile'}
      </Button>
    </form>
  );
}
