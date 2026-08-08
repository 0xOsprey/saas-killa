import { notFound } from 'next/navigation';
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
import { FORMAT_LABELS, LEVEL_LABELS, STATUS_LABELS } from '@/lib/format';
import { AbstractEditor } from '../AbstractEditor';
import { AuthorEditor } from '../AuthorEditor';
import { addAuthorAction, removeAuthorAction, saveAbstract } from '../actions';

export default async function OrganizerAbstractPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const submission = await submissionForEdit(parsed.data);
  if (!submission) notFound();

  const authors = await authorsForDisplay(submission.id);
  const locked = EDITABLE_FIELDS.filter((field) =>
    isFieldLocked(submission.lockedFields, field),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={submission.title}
        description={`${submission.speakerName ?? 'Unnamed'} · ${submission.speakerEmail} · ${
          FORMAT_LABELS[submission.format]
        } · ${LEVEL_LABELS[submission.audienceLevel]}${
          submission.trackName ? ` · ${submission.trackName}` : ''
        }`}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/organizer/abstracts/${submission.id}/history`} variant="secondary">
              Revision history
            </LinkButton>
            <LinkButton href="/organizer/abstracts" variant="ghost">
              All abstracts
            </LinkButton>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge>{STATUS_LABELS[submission.status]}</Badge>
        {locked.length > 0 ? (
          <Badge tone="warn">
            frozen against the speaker: {locked.map(fieldLabel).join(', ')}
          </Badge>
        ) : null}
      </div>

      {locked.length > 0 ? (
        <Notice>
          Locked fields stop the <em>speaker</em> editing them. An organizer can always fix copy,
          so every field below is editable here.
        </Notice>
      ) : null}

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Abstract</h2>
        <AbstractEditor
          submissionId={submission.id}
          values={currentValues(submission)}
          action={saveAbstract}
        />
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Authors</h2>
        <p className="text-xs text-muted">
          Position 0 is the account that filed the submission and stays on the billing. Everyone
          else can be added, re-credited or removed.
        </p>
        <AuthorEditor
          submissionId={submission.id}
          speakerId={submission.speakerId}
          authors={authors}
          addAction={addAuthorAction}
          removeAction={removeAuthorAction}
        />
      </Card>
    </div>
  );
}
