'use client';

import { useSearchParams } from 'next/navigation';
import { useActionState } from 'react';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import type { Track } from '@/db/schema';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';
import { inviteSpeakerAction, type InviteState } from './actions';

const EMPTY: InviteState = {};

/**
 * Book a speaker the committee approached rather than one who applied. The form
 * is the CFP form minus the window: an invitation is how a keynote is filled,
 * and keynotes are agreed long after the call has closed.
 */
export function InviteSpeakerForm({ tracks }: { tracks: Track[] }) {
  const [state, formAction, pending] = useActionState(inviteSpeakerAction, EMPTY);
  const search = useSearchParams() ?? new URLSearchParams();
  const fromContact = search.get('fromContact');
  const initial = {
    email: search.get('email') ?? '',
    name: search.get('name') ?? '',
    speakerTitle: search.get('speakerTitle') ?? '',
    company: search.get('company') ?? '',
    bio: search.get('bio') ?? '',
  };

  return (
    <form action={formAction} className="space-y-3">
      {fromContact ? <input type="hidden" name="fromContact" value={fromContact} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Their email">
          <Input
            type="email"
            name="email"
            required
            placeholder="keynote@example.com"
            defaultValue={initial.email}
          />
        </Field>
        <Field label="Their name">
          <Input name="name" required maxLength={120} defaultValue={initial.name} />
        </Field>
      </div>

      {/*
        How they are billed, asked for here rather than left to the speaker.
        The committee approached this person and already knows where they work,
        and a keynote announced as a bare name is the thing an invitation is
        supposed to avoid. Both are optional; neither blanks an existing value.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Job title">
          <Input
            name="speakerTitle"
            maxLength={120}
            placeholder="Principal Engineer"
            data-testid="invite-title"
            defaultValue={initial.speakerTitle}
          />
        </Field>
        <Field label="Company">
          <Input
            name="company"
            maxLength={120}
            placeholder="Latticework Systems"
            data-testid="invite-company"
            defaultValue={initial.company}
          />
        </Field>
      </div>

      <Field
        label="Speaker bio"
        hint="Optional. About the person, not the talk. Shown on the public directory."
      >
        <Textarea
          name="bio"
          maxLength={4000}
          className="min-h-20"
          data-testid="invite-bio"
          defaultValue={initial.bio}
        />
      </Field>

      {/* "Talk title", not "Title": the field above it is a job title, and one
          screen with two things called Title is a form people fill in wrong. */}
      <Field label="Talk title">
        <Input name="title" required maxLength={200} />
      </Field>

      <Field label="Abstract" hint="At least 120 characters, same as the call for papers.">
        <Textarea name="abstract" required minLength={120} maxLength={5000} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Format">
          <Select name="format" defaultValue="talk_45">
            {Object.entries(FORMAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Audience level">
          <Select name="audienceLevel" defaultValue="intermediate">
            {Object.entries(LEVEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Track">
          <Select name="trackId" defaultValue="">
            <option value="">No track</option>
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Keywords" hint="Comma separated. Used by the public directory search.">
          <Input name="keywords" placeholder="postgres, replication" />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="acceptNow" className="rounded border-line" />
        Accept it straight away — an invited keynote does not go through review.
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={pending}
          title={pending ? 'Inviting the speaker…' : 'Invite this speaker and send a sign-in link'}
        >
          {pending ? 'Inviting…' : 'Invite and send a sign-in link'}
        </Button>
        <span className="text-xs text-muted">
          The acceptance email still belongs to the send button on Submissions.
        </span>
      </div>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.message ? <Notice tone="good">{state.message}</Notice> : null}
    </form>
  );
}
