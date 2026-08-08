'use client';

import { useActionState, useState } from 'react';
import { Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import type { AudienceLevel, SubmissionFormat, Track } from '@/db/schema';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';
import { submitProposal, type CfpState } from './actions';

export function CfpForm({
  tracks,
  knownEmail,
  knownName,
  knownBio,
}: {
  tracks: Track[];
  knownEmail: string | null;
  knownName: string | null;
  knownBio: string | null;
}) {
  const [state, action, pending] = useActionState<CfpState, FormData>(submitProposal, {});
  const [format, setFormat] = useState<SubmissionFormat>('talk_25');

  return (
    <form action={action} className="space-y-6">
      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">About you</h2>
        <Field
          label="Email"
          hint={knownEmail ? 'Signed in — proposals are filed against this address.' : undefined}
        >
          <Input
            name="email"
            type="email"
            required
            defaultValue={knownEmail ?? ''}
            readOnly={Boolean(knownEmail)}
            data-testid="cfp-email"
          />
        </Field>
        <Field label="Name">
          <Input name="name" required defaultValue={knownName ?? ''} data-testid="cfp-name" />
        </Field>
        <Field label="Short bio" hint="Shown on the public agenda beside your talk.">
          <Textarea name="bio" defaultValue={knownBio ?? ''} className="min-h-24" />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">The proposal</h2>
        <Field label="Title">
          <Input name="title" required maxLength={200} data-testid="cfp-title" />
        </Field>
        <Field
          label="Abstract"
          hint="Reviewers see this without your name attached. Say what the audience will see and take away."
        >
          <Textarea name="abstract" required minLength={120} data-testid="cfp-abstract" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Format">
            <Select
              name="format"
              value={format}
              onChange={(e) => setFormat(e.target.value as SubmissionFormat)}
              data-testid="cfp-format"
            >
              {(Object.keys(FORMAT_LABELS) as SubmissionFormat[]).map((key) => (
                <option key={key} value={key}>
                  {FORMAT_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Audience level">
            <Select name="audienceLevel" defaultValue="intermediate" data-testid="cfp-level">
              {(Object.keys(LEVEL_LABELS) as AudienceLevel[]).map((key) => (
                <option key={key} value={key}>
                  {LEVEL_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Track">
            <Select name="trackId" defaultValue="" data-testid="cfp-track">
              <option value="">No preference</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Keywords"
          hint="Comma separated, up to 12. They help organizers route your proposal to the right reviewers."
        >
          <Input
            name="keywords"
            maxLength={400}
            placeholder="observability, postgres, migrations"
            data-testid="cfp-keywords"
          />
        </Field>

        {format === 'poster' ? (
          <Field
            label="Poster artwork URL"
            hint="A link to the PDF or image. It appears in the public poster gallery once accepted."
          >
            <Input name="posterUrl" type="url" required data-testid="cfp-poster-url" />
          </Field>
        ) : null}
      </Card>

      <Button type="submit" disabled={pending} data-testid="cfp-submit">
        {pending ? 'Submitting…' : 'Submit proposal'}
      </Button>
    </form>
  );
}
