import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Badge, Button, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { FORMAT_LABELS, STATUS_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { TASK_KIND_LABELS } from '@/lib/speaker-labels';
import { billing, speakerDetail } from '@/lib/speakers';
import { formatBytes, headshotUpload, uploadHref } from '@/lib/uploads';
import { Headshot } from '@/app/speakers/Headshot';
import {
  completeSpeakerTaskAction,
  deleteAvailabilityAction,
  deleteSpeakerTaskAction,
  reopenSpeakerTaskAction,
  setAttendanceAction,
} from '../actions';
import { ReminderForm } from '../ReminderForm';
import { AvailabilityForm } from './AvailabilityForm';
import { ProfileForm } from './ProfileForm';
import { TaskForm } from './TaskForm';

/** The three states `speakerConfirmedAt` and `speakerDeclinedAt` encode between them. */
type AttendanceState = 'confirmed' | 'declined' | 'pending';

const ATTENDANCE_BADGES = {
  confirmed: { tone: 'good', label: 'confirmed' },
  declined: { tone: 'bad', label: 'declined' },
  pending: { tone: 'warn', label: 'not confirmed' },
} as const;

const ATTENDANCE_BUTTONS = {
  confirmed: 'Mark confirmed',
  declined: 'Mark declined',
  pending: 'Not heard yet',
} as const;

/**
 * The confirmation badge, and the control that sets it.
 *
 * This was a badge alone until now, which made the one fact an organizer chases
 * hardest the one fact they could not record: most answers arrive by email or in
 * a corridor, never through the speaker's own portal. `setAttendanceAction`
 * writes the same two columns the speaker-side pair writes, from an
 * organizer-gated action, so the speaker-side ownership predicate stays intact.
 *
 * Every state but the current one gets a button, so the control is one press
 * from anywhere to anywhere and never renders a button that does nothing.
 * `pending` is on that list because "we have not heard" is a state worth being
 * able to get back to after a misclick, and clearing both columns is the only
 * route there.
 */
function Attendance({
  submissionId,
  userId,
  state,
}: {
  submissionId: string;
  userId: string;
  state: AttendanceState;
}) {
  const badge = ATTENDANCE_BADGES[state];
  const others = (['confirmed', 'declined', 'pending'] as const).filter((next) => next !== state);

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={badge.tone} data-testid="attendance-badge">
        {badge.label}
      </Badge>
      {others.map((next) => (
        <form key={next} action={setAttendanceAction}>
          <input type="hidden" name="submissionId" value={submissionId} />
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="state" value={next} />
          <Button
            type="submit"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid={`attendance-${next}`}
          >
            {ATTENDANCE_BUTTONS[next]}
          </Button>
        </form>
      ))}
    </span>
  );
}

export default async function SpeakerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirmTask?: string }>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const [event, detail, headshot, query] = await Promise.all([
    getEvent(),
    speakerDetail(parsed.data),
    headshotUpload(parsed.data),
    searchParams,
  ]);
  if (!detail) notFound();

  const { user, roles, submissions, tasks, availability } = detail;
  const open = tasks.filter((task) => task.completedAt === null);
  const done = tasks.filter((task) => task.completedAt !== null);
  const hasAccepted = submissions.some((submission) => submission.status === 'accepted');
  const taskToDelete = tasks.find((task) => task.id === query.confirmTask);

  return (
    <div className="space-y-5">
      <PageHeader
        title={user.name ?? user.email}
        // Joined here rather than interpolated, so an account with no byline
        // gets no leading separator on the line it does have.
        description={[billing(user.title, user.company), user.email, roles.join(', ') || 'no roles']
          .filter((part): part is string => Boolean(part))
          .join(' · ')}
        action={
          <div className="flex items-center gap-2">
            {hasAccepted ? (
              <Link
                href={`/speakers/${user.id}`}
                className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
              >
                Public profile
              </Link>
            ) : null}
            <Link
              href="/organizer/speakers"
              className="px-2 py-2 text-sm text-muted hover:text-ink"
            >
              Back to the roster
            </Link>
          </div>
        }
      />

      {taskToDelete ? (
        <Notice tone="bad">
          {/* The testid goes on a child. `Notice` takes `tone` and `children`
              and nothing else, and a hyphenated JSX attribute on a component is
              the one kind TypeScript does not check. */}
          <div className="space-y-2" data-testid="confirm-delete-task">
            <p>
              Deleting “{taskToDelete.label}” removes its deadline and its chase history too.{' '}
              {taskToDelete.completedAt
                ? 'It is marked done, so this also erases the record that they did it.'
                : 'It is still outstanding.'}
            </p>
            <div className="flex items-center gap-3">
              <form action={deleteSpeakerTaskAction}>
                <input type="hidden" name="taskId" value={taskToDelete.id} />
                <input type="hidden" name="userId" value={user.id} />
                <input type="hidden" name="confirm" value="yes" />
                <Button type="submit" variant="danger" data-testid="confirm-delete-task-submit">
                  Delete the task
                </Button>
              </form>
              <Link
                href={`/organizer/speakers/${user.id}`}
                className="text-sm text-accent hover:underline"
              >
                Keep it
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <Headshot src={user.headshotUrl} name={user.name} size="lg" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Profile</h2>
            {/*
              The photo as a file, not only as a picture. An organizer chasing a
              headshot needs the thing an email attachment has: a name, a size,
              a date and something to click. The `img` above answers "has it
              arrived", and stops there.

              Absent when the column holds a pasted URL rather than an upload,
              because there is no file of ours to describe and inventing a row
              for somebody else's hotlink would be a lie about where it lives.
            */}
            {headshot ? (
              <p className="text-xs text-muted" data-testid="headshot-file-meta">
                <a
                  href={uploadHref(headshot)}
                  target="_blank"
                  rel="noopener"
                  className="font-medium text-accent hover:underline"
                  data-testid="headshot-file-link"
                >
                  {headshot.filename}
                </a>{' '}
                · {formatBytes(headshot.bytes)} · uploaded{' '}
                {dayLabel(headshot.createdAt, event.timezone)} at{' '}
                {timeOfDay(headshot.createdAt, event.timezone)} by {user.name ?? user.email}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {user.headshotUrl ? 'Headshot set by URL, not uploaded here.' : 'No headshot yet.'}
              </p>
            )}
          </div>
        </div>
        <ProfileForm
          userId={user.id}
          name={user.name}
          title={user.title}
          company={user.company}
          bio={user.bio}
          travelNotes={user.travelNotes}
          headshotUrl={user.headshotUrl}
        />
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Tasks — {open.length} outstanding, {done.length} done
          </h2>
          {open.length > 0 ? (
            <ReminderForm
              scope="user"
              userId={user.id}
              label="Remind about everything outstanding"
            />
          ) : null}
        </div>

        {open.length === 0 && done.length === 0 ? (
          <Empty>Nothing on their list yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {[...open, ...done].map((task) => {
              const overdue =
                task.completedAt === null && task.dueAt !== null && task.dueAt < new Date();
              return (
                <li
                  key={task.id}
                  data-testid={`speaker-task-${task.id}`}
                  className="flex flex-wrap items-start gap-3 rounded-md border border-line p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {task.label}{' '}
                      <Badge tone="neutral">{TASK_KIND_LABELS[task.kind]}</Badge>{' '}
                      {task.completedAt ? <Badge tone="good">done</Badge> : null}
                      {overdue ? <Badge tone="bad">overdue</Badge> : null}
                    </p>
                    <p className="text-xs text-muted">
                      {task.dueAt
                        ? `Due ${dayLabel(task.dueAt, event.timezone)} at ${timeOfDay(task.dueAt, event.timezone)}`
                        : 'No deadline'}
                      {task.submissionTitle ? ` · ${task.submissionTitle}` : ''}
                      {task.lastRemindedAt
                        ? ` · last reminded ${dayLabel(task.lastRemindedAt, event.timezone)}`
                        : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-start gap-1.5">
                    {task.completedAt === null ? (
                      <>
                        <ReminderForm
                          scope="task"
                          userId={user.id}
                          taskId={task.id}
                          label="Remind"
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                        />
                        <form action={completeSpeakerTaskAction}>
                          <input type="hidden" name="taskId" value={task.id} />
                          <input type="hidden" name="userId" value={user.id} />
                          <Button
                            type="submit"
                            variant="secondary"
                            className="px-2 py-1 text-xs"
                            data-testid="task-complete"
                          >
                            Mark done
                          </Button>
                        </form>
                      </>
                    ) : (
                      <form action={reopenSpeakerTaskAction}>
                        <input type="hidden" name="taskId" value={task.id} />
                        <input type="hidden" name="userId" value={user.id} />
                        <Button
                          type="submit"
                          variant="secondary"
                          className="px-2 py-1 text-xs"
                          data-testid="task-reopen"
                        >
                          Not done after all
                        </Button>
                      </form>
                    )}
                    <form action={deleteSpeakerTaskAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="userId" value={user.id} />
                      <Button
                        type="submit"
                        variant="danger"
                        className="px-2 py-1 text-xs"
                        data-testid="task-delete"
                      >
                        Delete
                      </Button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="border-t border-line pt-4">
          <TaskForm
            userId={user.id}
            submissions={submissions.map((s) => ({ id: s.id, title: s.title }))}
          />
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">
          Unavailable — read by the scheduling conflict checker
        </h2>

        {availability.length === 0 ? (
          <Empty>No blocked time recorded.</Empty>
        ) : (
          <ul className="space-y-2">
            {availability.map((block) => (
              <li
                key={block.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {dayLabel(block.startsAt, event.timezone)} ·{' '}
                    {timeOfDay(block.startsAt, event.timezone)} to{' '}
                    {timeOfDay(block.endsAt, event.timezone)}
                  </p>
                  {block.note ? <p className="text-xs text-muted">{block.note}</p> : null}
                </div>
                <form action={deleteAvailabilityAction}>
                  <input type="hidden" name="availabilityId" value={block.id} />
                  <input type="hidden" name="userId" value={user.id} />
                  <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line pt-4">
          <AvailabilityForm userId={user.id} timezone={event.timezone} />
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Submissions</h2>
        {submissions.length === 0 ? (
          <Empty>Nothing filed under this account.</Empty>
        ) : (
          <ul className="space-y-2">
            {submissions.map((submission) => (
              <li key={submission.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/agenda/${submission.id}`} className="font-medium text-ink hover:underline">
                  {submission.title}
                </Link>
                <Badge>{STATUS_LABELS[submission.status]}</Badge>
                <Badge>{FORMAT_LABELS[submission.format]}</Badge>
                {submission.trackName ? <Badge tone="accent">{submission.trackName}</Badge> : null}
                {/*
                  Three states, not two. "not confirmed" is a chase; "declined"
                  is somebody who has already answered, and telling an organizer
                  to chase them is telling them to ask a question that has been
                  answered.
                */}
                {submission.status === 'accepted' ? (
                  <Attendance
                    submissionId={submission.id}
                    userId={user.id}
                    state={
                      submission.speakerDeclinedAt
                        ? 'declined'
                        : submission.speakerConfirmedAt
                          ? 'confirmed'
                          : 'pending'
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
