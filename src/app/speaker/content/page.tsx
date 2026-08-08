import { redirect } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LinkButton,
  Notice,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { currentUser } from '@/lib/auth';
import {
  CONTENT_STATUS_LABELS,
  contentIsPublic,
  fieldLabel,
  isLocked,
  myContent,
} from '@/lib/content';
import { FORMAT_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import {
  UPLOAD_KINDS,
  acceptAttribute,
  documentsFor,
  formatBytes,
  uploadHref,
} from '@/lib/uploads';
import {
  removeDocument,
  saveContentDraft,
  submitContentForReview,
  uploadDocument,
  withdrawContentFromReview,
} from './actions';

const FILE_INPUT =
  'block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-50';

const CONTENT_TONE = {
  draft: 'neutral',
  pending: 'warn',
  approved: 'good',
} as const;

const FLASH: Record<string, { tone: 'good' | 'warn' | 'accent'; text: string }> = {
  saved: {
    tone: 'good',
    text: 'Saved. Nothing here is public until you submit it and an organizer approves it.',
  },
  review: {
    tone: 'good',
    text: 'Sent to the organizers. They will approve it or send it back with a note.',
  },
  pulled: { tone: 'accent', text: 'Pulled back out of review. Edit away and resubmit.' },
  empty: {
    tone: 'warn',
    text: 'Add slides, a recording or a resources note before submitting for review.',
  },
  document: {
    tone: 'good',
    text: 'Document attached. Supporting documents go to the organizers only, never to the public agenda.',
  },
  removed: { tone: 'accent', text: 'Document removed.' },
};

/**
 * Where a speaker hands over slides, a recording and resources, and asks an
 * organizer to publish them. Separate from /speaker, which is about the
 * proposal and the decision on it: this screen is only about what the audience
 * will see afterwards, and it is the only one with a review queue behind it.
 */
export default async function SpeakerContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const [event, rows, params] = await Promise.all([getEvent(), myContent(user.id), searchParams]);
  const flash = Object.keys(FLASH).find((key) => params[key]);
  const documents = await documentsFor(rows.map((row) => row.id));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Session content"
        description={`Slides, recordings and resources for your talks at ${event.name}.`}
        action={
          <LinkButton href="/speaker" variant="secondary">
            My submissions
          </LinkButton>
        }
      />

      {flash ? (
        <Notice tone={FLASH[flash]!.tone}>
          <span data-testid="content-flash">{FLASH[flash]!.text}</span>
        </Notice>
      ) : null}

      {/* A refused upload names the rule it hit. The message comes back on the
          query string because the action redirects, and a speaker who picked
          the wrong file needs to know which file to pick instead. */}
      {typeof params.error === 'string' ? (
        <Notice tone="bad">
          <span data-testid="upload-error">{params.error}</span>
        </Notice>
      ) : null}

      {rows.length === 0 ? (
        <Empty>
          Nothing to add content to yet. This screen fills up once a proposal is accepted.
        </Empty>
      ) : null}

      {rows.map((row) => {
        const locks = {
          slidesUrl: isLocked(row.lockedFields, 'slidesUrl'),
          recordingUrl: isLocked(row.lockedFields, 'recordingUrl'),
          resourcesNote: isLocked(row.lockedFields, 'resourcesNote'),
        };
        const frozen = Object.values(locks).every(Boolean);
        const pending = row.contentStatus === 'pending';

        return (
          <Card key={row.id} className="space-y-4" data-testid={`content-${row.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-medium text-ink">{row.title}</h2>
                <p className="mt-0.5 text-xs text-muted">
                  {FORMAT_LABELS[row.format]}
                  {row.trackName ? ` · ${row.trackName}` : ''}
                  {row.slotStartsAt && row.roomName
                    ? ` · ${dayLabel(row.slotStartsAt, event.timezone)} at ${timeOfDay(
                        row.slotStartsAt,
                        event.timezone,
                      )} in ${row.roomName}`
                    : ''}
                </p>
              </div>
              <Badge tone={CONTENT_TONE[row.contentStatus]} data-testid={`content-status-${row.id}`}>
                {CONTENT_STATUS_LABELS[row.contentStatus]}
              </Badge>
            </div>

            {pending ? (
              <Notice>
                With the organizers for review. It is off the public page until they approve it.
              </Notice>
            ) : null}

            {row.contentStatus === 'approved' ? (
              <Notice tone="good">
                Approved and live on the agenda. Editing it below moves it back to a draft you
                will need to resubmit.
              </Notice>
            ) : null}

            {frozen ? (
              <Notice>An organizer has frozen every field here. Ask them to unlock it.</Notice>
            ) : null}

            <form action={saveContentDraft} className="space-y-3">
              <input type="hidden" name="submissionId" value={row.id} />

              <Field
                label="Slides URL"
                hint={hint(locks.slidesUrl, contentIsPublic(row.contentStatus, row.slidesUrl))}
              >
                <Input
                  name="slidesUrl"
                  // Not `type="url"`: an uploaded deck stores an app-relative
                  // `/files/…` path here, and the browser's own URL validation
                  // would refuse to submit the form on a value this app wrote.
                  defaultValue={row.slidesUrl ?? ''}
                  disabled={locks.slidesUrl}
                  data-testid={`slides-${row.id}`}
                />
              </Field>

              <Field
                label="Or upload the deck"
                hint={`PDF or an image, up to ${formatBytes(
                  UPLOAD_KINDS.slides.maxBytes,
                )}. A file replaces the URL above.`}
              >
                <input
                  type="file"
                  name="slidesFile"
                  accept={acceptAttribute('slides')}
                  disabled={locks.slidesUrl}
                  data-testid={`slides-file-${row.id}`}
                  className={FILE_INPUT}
                />
              </Field>

              <Field
                label="Recording URL"
                hint={hint(
                  locks.recordingUrl,
                  contentIsPublic(row.contentStatus, row.recordingUrl),
                )}
              >
                <Input
                  name="recordingUrl"
                  type="url"
                  defaultValue={row.recordingUrl ?? ''}
                  disabled={locks.recordingUrl}
                />
              </Field>

              <Field
                label="Resources"
                hint={hint(
                  locks.resourcesNote,
                  contentIsPublic(row.contentStatus, row.resourcesNote),
                )}
              >
                <Textarea
                  name="resourcesNote"
                  className="min-h-20"
                  defaultValue={row.resourcesNote ?? ''}
                  disabled={locks.resourcesNote}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="secondary" disabled={frozen}>
                  Save draft
                </Button>
                <Button
                  type="submit"
                  formAction={submitContentForReview}
                  disabled={frozen || pending}
                  data-testid={`submit-review-${row.id}`}
                >
                  Submit for review
                </Button>
              </div>
            </form>

            <div
              className="space-y-3 rounded-md border border-line p-3"
              data-testid={`documents-${row.id}`}
            >
              <div>
                <h3 className="text-sm font-medium text-ink">Supporting documents</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Handouts, a data appendix, a signed release. Organizers only — these never
                  appear on the public agenda.
                </p>
              </div>

              {(documents.get(row.id) ?? []).length === 0 ? (
                <p className="text-xs text-muted">Nothing attached yet.</p>
              ) : (
                <ul className="space-y-1">
                  {(documents.get(row.id) ?? []).map((document) => (
                    <li
                      key={document.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                      data-testid={`document-${document.id}`}
                    >
                      <a
                        href={uploadHref(document)}
                        className="min-w-0 flex-1 truncate underline hover:text-ink"
                      >
                        {document.filename}
                      </a>
                      <span className="text-xs text-muted">{formatBytes(document.bytes)}</span>
                      {/* Only your own. A co-author may attach and withdraw their
                          own material without being able to delete the filer's. */}
                      {document.ownerId === user.id ? (
                        <form action={removeDocument}>
                          <input type="hidden" name="submissionId" value={row.id} />
                          <input type="hidden" name="uploadId" value={document.id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            className="text-xs"
                            data-testid={`document-remove-${document.id}`}
                          >
                            Remove
                          </Button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <form action={uploadDocument} className="space-y-2">
                <input type="hidden" name="submissionId" value={row.id} />
                <input
                  type="file"
                  name="documentFile"
                  accept={acceptAttribute('document')}
                  required
                  data-testid={`document-file-${row.id}`}
                  className={FILE_INPUT}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  className="text-xs"
                  data-testid={`document-upload-${row.id}`}
                >
                  Attach document
                </Button>
              </form>
            </div>

            {pending ? (
              <form action={withdrawContentFromReview}>
                <input type="hidden" name="submissionId" value={row.id} />
                <Button type="submit" variant="ghost" className="text-xs">
                  Pull back out of review
                </Button>
              </form>
            ) : null}

            {row.lockedFields.length > 0 && !frozen ? (
              <p className="text-xs text-muted">
                Frozen by an organizer:{' '}
                {row.lockedFields.map((field) => fieldLabel(field)).join(', ')}
              </p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

function hint(locked: boolean, live: boolean): string {
  if (locked) return 'Frozen by an organizer. Ask them to unlock it.';
  return live ? 'Currently visible on the public agenda.' : 'Not public yet.';
}
