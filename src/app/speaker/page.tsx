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
import { FORMAT_LABELS, STATUS_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { cfpIsOpen, getEvent, mySubmissions } from '@/lib/queries';
import { confirmAttendance, saveContent, withdrawSubmission } from './actions';

const STATUS_TONE = {
  submitted: 'neutral',
  accepted: 'good',
  rejected: 'bad',
  withdrawn: 'neutral',
} as const;

export default async function SpeakerPage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const [event, mine, params] = await Promise.all([
    getEvent(),
    mySubmissions(user.id),
    searchParams,
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My submissions"
        description={`${user.email} · ${event.name}`}
        action={
          cfpIsOpen(event) ? <LinkButton href="/cfp">Submit another</LinkButton> : undefined
        }
      />

      {params.submitted ? (
        <Notice tone="good">
          <span data-testid="submitted-confirmation">
            Proposal received. You will hear from the programme committee after review.
          </span>
        </Notice>
      ) : null}

      {mine.length === 0 ? (
        <Empty>
          Nothing submitted yet.{' '}
          {cfpIsOpen(event) ? (
            <a className="underline" href="/cfp">
              The call for papers is open.
            </a>
          ) : (
            'The call for papers is closed.'
          )}
        </Empty>
      ) : null}

      {mine.map((row) => {
        const accepted = row.status === 'accepted';
        return (
          <Card key={row.id} className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium text-ink">{row.title}</h2>
                <p className="mt-0.5 text-xs text-muted">
                  {FORMAT_LABELS[row.format]}
                  {row.trackName ? ` · ${row.trackName}` : ''}
                </p>
              </div>
              <Badge tone={STATUS_TONE[row.status]} data-testid={`status-${row.id}`}>
                {STATUS_LABELS[row.status]}
              </Badge>
            </div>

            {row.slotStartsAt && row.roomName ? (
              <p className="text-sm text-ink">
                {dayLabel(row.slotStartsAt, event.timezone)} at{' '}
                {timeOfDay(row.slotStartsAt, event.timezone)} in {row.roomName}
              </p>
            ) : null}

            {accepted && !row.speakerConfirmedAt ? (
              <form action={confirmAttendance} className="flex items-center gap-3">
                <input type="hidden" name="submissionId" value={row.id} />
                <Button type="submit" data-testid={`confirm-${row.id}`}>
                  Confirm I will present
                </Button>
                <span className="text-xs text-muted">
                  Organizers schedule confirmed talks first.
                </span>
              </form>
            ) : null}

            {accepted && row.speakerConfirmedAt ? (
              <Notice tone="good">Attendance confirmed. Thank you.</Notice>
            ) : null}

            {accepted ? (
              <details className="rounded-md border border-line p-3">
                <summary className="cursor-pointer text-sm font-medium text-ink">
                  Slides, recording and resources
                </summary>
                <form action={saveContent} className="mt-3 space-y-3">
                  <input type="hidden" name="submissionId" value={row.id} />
                  <Field label="Slides URL">
                    <Input name="slidesUrl" type="url" defaultValue={row.slidesUrl ?? ''} />
                  </Field>
                  <Field label="Recording URL">
                    <Input
                      name="recordingUrl"
                      type="url"
                      defaultValue={row.recordingUrl ?? ''}
                    />
                  </Field>
                  <Field label="Resources" hint="Repos, links, further reading. Plain text.">
                    <Textarea
                      name="resourcesNote"
                      className="min-h-20"
                      defaultValue={row.resourcesNote ?? ''}
                    />
                  </Field>
                  <Button type="submit" variant="secondary">
                    Save
                  </Button>
                </form>
              </details>
            ) : null}

            {row.status !== 'withdrawn' ? (
              <form action={withdrawSubmission}>
                <input type="hidden" name="submissionId" value={row.id} />
                <Button type="submit" variant="ghost" className="text-xs">
                  Withdraw
                </Button>
              </form>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
