import Link from 'next/link';
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
  UPLOAD_KIND_LABELS,
  acceptAttribute,
  commentsForSeries,
  fileSeriesList,
  formatBytes,
  type FileSeries,
} from '@/lib/uploads';
import { FileCommentThread, FileVersionList } from '@/app/files/FilePanels';
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
  unpublished: {
    tone: 'warn',
    text: 'Saved, and taken off the public agenda. Editing approved content makes it a draft again, so submit it for review when you are happy with it.',
  },
  empty: {
    tone: 'warn',
    text: 'Add slides, a recording or a resources note before submitting for review.',
  },
  document: {
    tone: 'good',
    text: 'Document attached. Supporting documents go to the organizers only, never to the public agenda.',
  },
  removed: { tone: 'accent', text: 'Document removed.' },
  commented: {
    tone: 'good',
    text: 'Comment posted. The organizers read the same thread you do.',
  },
};

/**
 * Slides first, then the poster, then the handouts in the order they arrived.
 * The deliverable an organizer is chasing is the deck, so it is the one that
 * should not need scrolling to.
 */
const KIND_ORDER: Record<string, number> = { slides: 0, poster: 1, document: 2 };

function byKindThenAge(a: FileSeries, b: FileSeries): number {
  const kinds = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  return kinds !== 0 ? kinds : a.firstUploadedAt.getTime() - b.firstUploadedAt.getTime();
}

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

  // Every file on these talks, folded into version chains, with the thread on
  // each. The deck and the handouts are read the same way here on purpose: a
  // speaker asked to send a newer file should not have to learn two rules about
  // what happens to the old one.
  const files = await fileSeriesList({
    submissionIds: rows.map((row) => row.id),
    kinds: ['slides', 'poster', 'document'],
  });
  const threads = await commentsForSeries(files.map((series) => series.seriesId));
  const filesBySubmission = new Map<string, FileSeries[]>();
  for (const series of files) {
    if (!series.submissionId) continue;
    const list = filesBySubmission.get(series.submissionId) ?? [];
    list.push(series);
    filesBySubmission.set(series.submissionId, list);
  }
  for (const list of filesBySubmission.values()) list.sort(byKindThenAge);

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
          Nothing to add content to yet.{' '}
          <Link href="/speaker" className="text-accent hover:underline">
            View your submissions
          </Link>
          ; this screen fills up once a proposal is accepted.
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

            {/*
              The reason lived only in the email, so this screen showed a draft
              the speaker thought they had submitted and said nothing about why.
              Gated on 'draft' as well as on the column being set: the column is
              cleared by every status move, and the pair means a reason can only
              ever describe the draft actually in front of them.
            */}
            {row.contentStatus === 'draft' && row.contentReturnReason ? (
              <Notice tone="warn">
                <p className="font-medium">The organizers sent this back for changes.</p>
                {/* Not `return-reason-`: the organizer board already uses that
                    for the textarea this text came out of. */}
                <p className="mt-1 whitespace-pre-line" data-testid={`content-returned-${row.id}`}>
                  {row.contentReturnReason}
                </p>
                <p className="mt-1 text-xs">
                  Make the changes below and submit it for review again.
                </p>
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
                <h3 className="text-sm font-medium text-ink">Files and versions</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Every file on this talk. Sending a newer one keeps the old one: it becomes an
                  earlier version and stays at its own link. Handouts, appendices and releases go
                  to the organizers only and never reach the public agenda.
                </p>
              </div>

              {(filesBySubmission.get(row.id) ?? []).length === 0 ? (
                <p className="text-xs text-muted">Nothing attached yet.</p>
              ) : (
                <div className="space-y-3">
                  {(filesBySubmission.get(row.id) ?? []).map((series) => (
                    <div
                      key={series.seriesId}
                      className="space-y-3 rounded-md border border-line bg-white p-3"
                      data-testid={`file-${series.seriesId}`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-ink">
                          {series.latest.filename}
                        </span>
                        <Badge>{UPLOAD_KIND_LABELS[series.kind]}</Badge>
                      </div>

                      <FileVersionList series={series} timezone={event.timezone} />

                      {/* Only a handout can be taken down here, and only your
                          own. Removing a deck version would leave the Slides URL
                          the agenda links to pointing at bytes that are gone;
                          replacing it with a newer upload is the move. A
                          co-author may withdraw their own material without being
                          able to delete the filer's release form. */}
                      {series.kind === 'document' ? (
                        <div className="flex flex-wrap gap-2">
                          {series.versions
                            .filter((version) => version.ownerId === user.id)
                            .map((version) => (
                              <form key={version.id} action={removeDocument}>
                                <input type="hidden" name="submissionId" value={row.id} />
                                <input type="hidden" name="uploadId" value={version.id} />
                                <Button
                                  type="submit"
                                  variant="ghost"
                                  className="text-xs"
                                  data-testid={`document-remove-${version.id}`}
                                >
                                  Remove v{version.version}
                                </Button>
                              </form>
                            ))}
                        </div>
                      ) : null}

                      <FileCommentThread
                        series={series}
                        comments={threads.get(series.seriesId) ?? []}
                        timezone={event.timezone}
                        returnTo="/speaker/content?commented=1"
                      />
                    </div>
                  ))}
                </div>
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
                <p className="text-xs text-muted">
                  A PDF or an image, up to {formatBytes(UPLOAD_KINDS.document.maxBytes)}. Attaching
                  a file that is already listed adds a version to it rather than a second row.
                </p>
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
