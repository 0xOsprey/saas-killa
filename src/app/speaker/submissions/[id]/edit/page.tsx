import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { Badge, Card, LinkButton, Notice, PageHeader } from '@/components/ui';
import {
  EDITABLE_FIELDS,
  authorsForDisplay,
  currentValues,
  fieldLabel,
  isFieldLocked,
  submissionForEdit,
} from '@/lib/abstracts';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, LEVEL_LABELS, STATUS_LABELS, inEventZone } from '@/lib/format';
import { cfpIsOpen, getEvent } from '@/lib/queries';
import { AbstractEditor } from '@/app/organizer/abstracts/AbstractEditor';
import { AbstractFields } from '@/app/organizer/abstracts/AbstractFields';
import { AuthorEditor } from '@/app/organizer/abstracts/AuthorEditor';
import { addMyAuthor, removeMyAuthor, saveMyAbstract } from '../../actions';

export default async function EditSubmissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const submission = await submissionForEdit(parsed.data);
  // Someone else's submission is not "forbidden", it is not theirs to know about.
  if (!submission || submission.speakerId !== user.id) notFound();

  const [event, authors] = await Promise.all([getEvent(), authorsForDisplay(submission.id)]);
  const open = cfpIsOpen(event);
  const locked = EDITABLE_FIELDS.filter((field) =>
    isFieldLocked(submission.lockedFields, field),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Edit submission"
        description={`${FORMAT_LABELS[submission.format]} · ${
          LEVEL_LABELS[submission.audienceLevel]
        }${submission.trackName ? ` · ${submission.trackName}` : ''}`}
        action={
          <LinkButton href="/speaker" variant="secondary">
            My submissions
          </LinkButton>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge>{STATUS_LABELS[submission.status]}</Badge>
        {locked.length > 0 ? (
          <Badge tone="warn">locked: {locked.map(fieldLabel).join(', ')}</Badge>
        ) : null}
      </div>

      {open ? null : (
        <Notice>
          The call for papers closed on{' '}
          {inEventZone(event.cfpClosesAt, event.timezone, { dateStyle: 'medium' })}, so the
          proposal text is read only. An organizer can still make a correction for you.
        </Notice>
      )}

      {locked.length > 0 && open ? (
        <Notice>
          The organizers have frozen {locked.map(fieldLabel).join(' and ')} on this submission.
          Everything else is yours to change.
        </Notice>
      ) : null}

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Your proposal</h2>
        {open ? (
          <AbstractEditor
            submissionId={submission.id}
            values={currentValues(submission)}
            locked={locked}
            action={saveMyAbstract}
          />
        ) : (
          <AbstractFields
            values={currentValues(submission)}
            locked={[...EDITABLE_FIELDS]}
            lockLabel="read only"
          />
        )}
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Co-authors</h2>
        <p className="text-xs text-muted">
          Everyone credited on the billing, in order. You filed this, so you stay on it. Co-authors
          can be added after the call for papers closes — a colleague joining the panel is normal
          long after the text is fixed.
        </p>
        <AuthorEditor
          submissionId={submission.id}
          speakerId={submission.speakerId}
          authors={authors}
          addAction={addMyAuthor}
          removeAction={removeMyAuthor}
        />
      </Card>
    </div>
  );
}
