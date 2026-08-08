'use client';

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

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Their email">
          <Input type="email" name="email" required placeholder="keynote@example.com" />
        </Field>
        <Field label="Their name">
          <Input name="name" required maxLength={120} />
        </Field>
      </div>

      <Field label="Title">
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
        <Button type="submit" disabled={pending}>
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
