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
import { saveContentDraft, submitContentForReview, withdrawContentFromReview } from './actions';

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
                  type="url"
                  defaultValue={row.slidesUrl ?? ''}
                  disabled={locks.slidesUrl}
                  data-testid={`slides-${row.id}`}
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
