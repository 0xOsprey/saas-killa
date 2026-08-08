import { redirect } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Empty,
  LinkButton,
  Notice,
  PageHeader,
  cn,
} from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, STATUS_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import {
  TASK_KIND_LABELS,
  describeGaps,
  isOverdue,
  profileGaps,
  speakerTasksFor,
  taskTargetsProfile,
  type SpeakerTaskRow,
} from '@/lib/portal';
import { cfpIsOpen, getEvent, mySubmissions } from '@/lib/queries';
import { completeTask, confirmAttendance, withdrawSubmission } from './actions';
import { Headshot } from './profile/Headshot';

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

  const [event, mine, tasks, params] = await Promise.all([
    getEvent(),
    mySubmissions(user.id),
    speakerTasksFor(user.id),
    searchParams,
  ]);

  const gaps = profileGaps(user);

  // Split the task list the way it will be read: a task naming a submission
  // belongs under that submission's card, everything else is account-level. A
  // task pointing at a submission this speaker no longer owns would otherwise
  // render nowhere, so it falls back to the account list rather than vanishing.
  const ownIds = new Set(mine.map((row) => row.id));
  const bySubmission = new Map<string, SpeakerTaskRow[]>();
  const accountTasks: SpeakerTaskRow[] = [];
  for (const task of tasks) {
    if (task.submissionId && ownIds.has(task.submissionId)) {
      const bucket = bySubmission.get(task.submissionId) ?? [];
      bucket.push(task);
      bySubmission.set(task.submissionId, bucket);
    } else {
      accountTasks.push(task);
    }
  }
  const outstanding = tasks.filter((task) => task.completedAt === null).length;

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

      <Card className="flex flex-wrap items-center gap-4">
        <Headshot url={user.headshotUrl} name={user.name} email={user.email} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{user.name ?? 'Unnamed'}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
          {gaps.length > 0 ? (
            <p className="mt-1 text-xs text-amber-800" data-testid="profile-prompt">
              Your profile is missing {describeGaps(gaps)}. Attendees read it beside your talk on
              the agenda.
            </p>
          ) : null}
        </div>
        <LinkButton
          href="/speaker/profile"
          variant={gaps.length > 0 ? 'primary' : 'secondary'}
          data-testid="edit-profile"
        >
          {gaps.length > 0 ? 'Complete your profile' : 'Edit profile'}
        </LinkButton>
      </Card>

      <section className="space-y-2" data-testid="speaker-tasks">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">What organizers need from you</h2>
          {tasks.length > 0 ? (
            <span className="text-xs text-muted">
              {outstanding} outstanding of {tasks.length}
            </span>
          ) : null}
        </div>

        {tasks.length === 0 ? (
          <Empty>
            Nothing outstanding. Anything the organizers need from you will appear here with its
            deadline.
          </Empty>
        ) : null}

        {accountTasks.length > 0 ? (
          <Card>
            <ul>
              {accountTasks.map((task) => (
                <TaskRow key={task.id} task={task} timezone={event.timezone} showSubmission />
              ))}
            </ul>
          </Card>
        ) : null}
      </section>

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
        const rowTasks = bySubmission.get(row.id) ?? [];
        return (
          <Card key={row.id} className="space-y-4" data-testid={`submission-card-${row.id}`}>
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

            {rowTasks.length > 0 ? (
              <ul className="rounded-md border border-line px-3" data-testid={`tasks-${row.id}`}>
                {rowTasks.map((task) => (
                  <TaskRow key={task.id} task={task} timezone={event.timezone} />
                ))}
              </ul>
            ) : null}

            {row.isOwner ? null : (
              <p className="text-xs text-muted" data-testid={`coauthor-${row.id}`}>
                You are a co-author here. You can edit the proposal; withdrawing it and confirming
                attendance stay with the speaker who filed it.
              </p>
            )}

            {row.isOwner && accepted && !row.speakerConfirmedAt ? (
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

            {row.isOwner && accepted && row.speakerConfirmedAt ? (
              <Notice tone="good">Attendance confirmed. Thank you.</Notice>
            ) : null}

            {/*
              Everything a speaker can still change about this proposal, in the
              order they will want it. Each destination enforces its own rules —
              the edit form refuses a locked field, materials will not go public
              without organizer approval — so these are links rather than forms.
            */}
            <div className="flex flex-wrap items-center gap-2">
              {row.status !== 'withdrawn' ? (
                <LinkButton
                  href={`/speaker/submissions/${row.id}/edit`}
                  variant="secondary"
                  className="text-xs"
                  data-testid={`edit-${row.id}`}
                >
                  Edit proposal
                </LinkButton>
              ) : null}

              {accepted ? (
                <LinkButton
                  href="/speaker/content"
                  variant="ghost"
                  className="text-xs"
                  data-testid={`content-${row.id}`}
                >
                  Slides, recording and resources
                </LinkButton>
              ) : null}

              {accepted && row.format === 'poster' ? (
                <LinkButton
                  href="/speaker/posters"
                  variant="ghost"
                  className="text-xs"
                  data-testid={`poster-${row.id}`}
                >
                  Poster artwork
                </LinkButton>
              ) : null}

              {row.isOwner && row.status !== 'withdrawn' ? (
                <form action={withdrawSubmission}>
                  <input type="hidden" name="submissionId" value={row.id} />
                  <Button type="submit" variant="ghost" className="text-xs">
                    Withdraw
                  </Button>
                </form>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  timezone,
  showSubmission = false,
}: {
  task: SpeakerTaskRow;
  timezone: string;
  showSubmission?: boolean;
}) {
  const done = task.completedAt !== null;
  const overdue = isOverdue(task);

  return (
    <li
      className="flex flex-wrap items-center gap-3 border-t border-line py-2 first:border-t-0"
      data-testid={`task-${task.id}`}
    >
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', done ? 'text-muted line-through' : 'text-ink')}>{task.label}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{TASK_KIND_LABELS[task.kind]}</span>
          {showSubmission && task.submissionTitle ? <span>· {task.submissionTitle}</span> : null}
          <span>{task.dueAt ? `due ${dayLabel(task.dueAt, timezone)}` : 'no deadline'}</span>
          {overdue ? <Badge tone="bad">overdue</Badge> : null}
          {done ? <Badge tone="good">done</Badge> : null}
        </p>
      </div>

      {!done && taskTargetsProfile(task.kind) ? (
        <LinkButton href="/speaker/profile" variant="ghost" className="text-xs">
          Update profile
        </LinkButton>
      ) : null}

      {!done ? (
        <form action={completeTask}>
          <input type="hidden" name="taskId" value={task.id} />
          <Button
            type="submit"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid={`complete-${task.id}`}
          >
            Mark done
          </Button>
        </form>
      ) : null}
    </li>
  );
}
