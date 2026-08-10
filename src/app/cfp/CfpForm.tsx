'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import type { AudienceLevel, SubmissionFormat, Track } from '@/db/schema';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';
import { questionIdFromField, type AnswerMap, type QuestionShape } from '@/lib/questions';
import { CustomQuestions } from './CustomQuestions';
import { submitProposal, type CfpState } from './actions';
import {
  clearDraft,
  collectDraftValues,
  draftStamp,
  readDraft,
  restoreDraft,
  writeDraft,
  type CfpDraft,
} from './draft';

export function CfpForm({
  eventId,
  tracks,
  questions,
  knownEmail,
  knownName,
  knownBio,
}: {
  eventId: string;
  tracks: Track[];
  questions: QuestionShape[];
  knownEmail: string | null;
  knownName: string | null;
  knownBio: string | null;
}) {
  const [state, action, pending] = useActionState<CfpState, FormData>(submitProposal, {});
  // Format and track are held here rather than read off the DOM because the
  // organizer's questions narrow on both, so changing either has to re-render
  // the question list below.
  const [format, setFormat] = useState<SubmissionFormat>('talk_25');
  const [trackId, setTrackId] = useState<string>('');

  const formRef = useRef<HTMLFormElement>(null);
  // What the fields start from: nothing on a first visit, the saved draft once
  // the restore effect below has found one.
  const [initial, setInitial] = useState<Record<string, string>>({});
  // Bumped alongside `initial`, and used as the form's key. `defaultValue` is
  // read once when a field mounts and ignored on every render after, so an
  // uncontrolled form cannot be filled in from state without remounting it.
  // The alternative was making all ten fields controlled, which buys a
  // re-render per keystroke to serve one event that happens once per page load.
  const [generation, setGeneration] = useState(0);
  const [draft, setDraft] = useState<CfpDraft | null>(null);
  const [resumed, setResumed] = useState(false);
  const [storageRefused, setStorageRefused] = useState(false);
  const restoredRef = useRef(false);

  // Read after hydration, never during render. `localStorage` does not exist
  // while the server renders this page, so a banner decided during render is a
  // hydration mismatch on the most public screen in the app.
  useEffect(() => {
    // Once per page load. A second pass would overwrite whatever the speaker
    // has typed since with the older saved copy.
    if (restoredRef.current) return;
    restoredRef.current = true;

    const found = readDraft(eventId);
    if (!found) return;

    // Storage is the visitor's to edit, so a restored format has to be one this
    // form actually offers before it reaches a controlled select.
    const savedFormat = found.values.format;
    if (savedFormat && Object.keys(FORMAT_LABELS).includes(savedFormat)) {
      setFormat(savedFormat as SubmissionFormat);
    }
    // A track retired since the draft was saved would leave the select holding
    // a value no option carries, so an unrecognised id falls back to "No
    // preference" instead of being restored.
    const savedTrack = found.values.trackId;
    if (savedTrack && tracks.some((track) => track.id === savedTrack)) setTrackId(savedTrack);

    setInitial(found.values);
    setGeneration((n) => n + 1);
    setDraft(found);
    setResumed(true);
  }, [eventId, tracks]);

  // The draft is taken away as the proposal leaves rather than after it lands.
  // A successful submit ends in a redirect to the speaker's own page, so this
  // component never renders again and has no later moment to clean up in. The
  // copy is held in a ref meanwhile so a refusal from the server action, a
  // closed call or a duplicate title, does not cost the speaker their draft.
  const heldRef = useRef<CfpDraft | null>(null);

  function onSubmit() {
    heldRef.current = draft;
    clearDraft(eventId);
    setDraft(null);
    setResumed(false);
  }

  useEffect(() => {
    if (!state.error) return;
    const held = heldRef.current;
    heldRef.current = null;
    if (!held) return;
    restoreDraft(eventId, held);
    setDraft(held);
  }, [state, eventId]);

  function saveDraft() {
    const form = formRef.current;
    if (!form) return;
    // Every save succeeds, including an empty one. There is no rule about what
    // a half-finished proposal has to contain, and a speaker who saved before
    // typing does not need to be told off for it.
    const saved = writeDraft(eventId, collectDraftValues(form));
    setDraft(saved);
    setStorageRefused(saved === null);
  }

  function discardDraft() {
    clearDraft(eventId);
    setDraft(null);
    setResumed(false);
    setStorageRefused(false);
    setInitial({});
    setGeneration((n) => n + 1);
    setFormat('talk_25');
    setTrackId('');
  }

  // The organizer's questions post under names only known at runtime, so the
  // ones in the draft are handed back to the child by question id rather than
  // by a `defaultValue` this component could write.
  const initialAnswers: AnswerMap = {};
  for (const [name, value] of Object.entries(initial)) {
    const questionId = questionIdFromField(name);
    if (questionId) initialAnswers[questionId] = value;
  }

  return (
    <form key={generation} ref={formRef} action={action} onSubmit={onSubmit} className="space-y-6">
      {resumed && draft ? (
        <Notice tone="accent">
          <div
            className="flex flex-wrap items-center justify-between gap-3"
            data-testid="cfp-draft-resume"
          >
            <span>
              <strong className="font-semibold">Draft resumed.</strong> The fields below are
              filled in from the draft you saved on {draftStamp(draft.savedAt)}. Carry on and
              submit it, or discard it and start over.
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={discardDraft}
              data-testid="cfp-draft-discard"
            >
              Discard draft
            </Button>
          </div>
        </Notice>
      ) : null}

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
            defaultValue={knownEmail ?? initial.email ?? ''}
            readOnly={Boolean(knownEmail)}
            data-testid="cfp-email"
          />
        </Field>
        <Field label="Name">
          <Input
            name="name"
            required
            defaultValue={initial.name ?? knownName ?? ''}
            data-testid="cfp-name"
          />
        </Field>
        <Field label="Short bio" hint="Shown on the public agenda beside your talk.">
          <Textarea
            name="bio"
            defaultValue={initial.bio ?? knownBio ?? ''}
            className="min-h-24"
          />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">The proposal</h2>
        <Field label="Title">
          <Input
            name="title"
            required
            maxLength={200}
            defaultValue={initial.title ?? ''}
            data-testid="cfp-title"
          />
        </Field>
        <Field
          label="Abstract"
          hint="Reviewers see this without your name attached. Say what the audience will see and take away."
        >
          <Textarea
            name="abstract"
            required
            minLength={120}
            defaultValue={initial.abstract ?? ''}
            data-testid="cfp-abstract"
          />
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
            <Select
              name="audienceLevel"
              defaultValue={initial.audienceLevel ?? 'intermediate'}
              data-testid="cfp-level"
            >
              {(Object.keys(LEVEL_LABELS) as AudienceLevel[]).map((key) => (
                <option key={key} value={key}>
                  {LEVEL_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Track">
            <Select
              name="trackId"
              value={trackId}
              onChange={(e) => setTrackId(e.target.value)}
              data-testid="cfp-track"
            >
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
            defaultValue={initial.keywords ?? ''}
            data-testid="cfp-keywords"
          />
        </Field>

        {format === 'poster' ? (
          <Field
            label="Poster artwork URL"
            hint="A link to the PDF or image. It appears in the public poster gallery once accepted."
          >
            <Input
              name="posterUrl"
              type="url"
              required
              defaultValue={initial.posterUrl ?? ''}
              data-testid="cfp-poster-url"
            />
          </Field>
        ) : null}
      </Card>

      {questions.length > 0 ? (
        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-ink">A few more things</h2>
          <CustomQuestions
            questions={questions}
            format={format}
            trackId={trackId === '' ? null : trackId}
            initialAnswers={initialAnswers}
          />
        </Card>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending} data-testid="cfp-submit">
            {pending ? 'Submitting…' : 'Submit proposal'}
          </Button>
          {/*
            `type="button"` is what makes a title-only draft possible at all. A
            submit-typed control is stopped by the browser's own required-field
            check before any handler runs, and this form marks email, name,
            title and abstract required, which is exactly the state a draft is
            for.
          */}
          <Button
            type="button"
            variant="secondary"
            onClick={saveDraft}
            data-testid="cfp-save-draft"
          >
            Save as draft
          </Button>
        </div>

        {draft ? (
          <p className="text-xs text-muted" data-testid="cfp-draft-status">
            Draft saved {draftStamp(draft.savedAt)}. It is kept in this browser only, and it is
            cleared once the proposal is submitted.
          </p>
        ) : (
          <p className="text-xs text-muted">
            Not ready to submit? Save a draft and this form comes back filled in next time. A
            title on its own is enough.
          </p>
        )}

        {storageRefused ? (
          <Notice tone="bad">
            This browser refused to store the draft. Private browsing and blocked site data both
            do that. Submitting still works.
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
