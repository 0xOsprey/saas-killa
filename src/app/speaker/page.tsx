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
import {
  cfpIsOpen,
  getEvent,
  mySubmissions,
  placementsFromNoticeKeys,
  type NoticedPlacement,
} from '@/lib/queries';
import { UNSCHEDULED, placementKey } from '@/lib/speaker-calendar';
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

  // What the last schedule email described, so a card can say whether the time
  // above it is the time the speaker was told. One lookup for the whole page.
  const noticed = await placementsFromNoticeKeys(mine.map((row) => row.scheduleNoticeKey));

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
        const decided = accepted || row.status === 'rejected';
        const told = scheduleNotice(row, noticed, event.timezone);
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

            {/*
              The status and the slot above are the organizers' current position.
              These two lines are what the speaker has actually been told about
              them, which is the thing they can check their inbox against. An
              organizer flips a status while deciding and moves a talk four times
              while building the grid; neither leaves the building until they
              press send, and a portal that shows only the position invites a
              speaker to act on a decision no email describes.
            */}
            {decided && !row.decisionEmailedAt ? (
              <Notice tone="warn">
                <span data-testid={`decision-unsent-${row.id}`}>
                  The committee has recorded this decision but has not sent it yet. Expect an email
                  once they do.
                </span>
              </Notice>
            ) : null}

            {decided && row.decisionEmailedAt ? (
              <p className="text-xs text-muted" data-testid={`decision-sent-${row.id}`}>
                Decision emailed {dayLabel(row.decisionEmailedAt, event.timezone)}.
              </p>
            ) : null}

            {told ? (
              told.tone === 'good' ? (
                <p className="text-xs text-muted" data-testid={`schedule-notice-${row.id}`}>
                  {told.text}
                </p>
              ) : (
                <Notice tone="warn">
                  <span data-testid={`schedule-notice-${row.id}`}>{told.text}</span>
                </Notice>
              )
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

type ScheduleNotice = { tone: 'good' | 'warn'; text: string };

/**
 * Where this talk is, against where the last schedule email said it was.
 *
 * The comparison is the same one `pendingNotices` makes when deciding who to
 * mail: the stored `scheduleNoticeKey` against the key the current placement
 * produces. Reusing `placementKey` rather than reformatting the string here is
 * deliberate, since a second spelling of the format would report every talk as
 * moved.
 *
 * Never scheduled and never emailed about returns nothing, matching that same
 * rule: a talk nobody has placed yet is not news, and every accepted speaker
 * would otherwise open the portal to a warning about an email that was correct
 * not to have been sent.
 */
function scheduleNotice(
  row: { slotStartsAt: Date | null; slotRoomId: string | null; scheduleNoticeKey: string | null },
  noticed: Map<string, NoticedPlacement>,
  timezone: string,
): ScheduleNotice | null {
  const current = placementKey(
    row.slotStartsAt && row.slotRoomId
      ? { startsAt: row.slotStartsAt, roomId: row.slotRoomId }
      : null,
  );

  if (row.scheduleNoticeKey === null) {
    if (current === UNSCHEDULED) return null;
    return {
      tone: 'warn',
      text: 'This time has not been emailed to you yet. Organizers are still building the schedule, so treat it as provisional.',
    };
  }

  if (row.scheduleNoticeKey === current) {
    // Agreeing on `unscheduled` is still agreement, but the good-news wording
    // would describe a time and a room that are not on the card. This is the
    // talk that was taken off the grid and emailed about, and the speaker is
    // owed the "yes, we told you" half of that rather than silence.
    return current === UNSCHEDULED
      ? { tone: 'good', text: 'Not on the schedule, which is what your last email about it said.' }
      : { tone: 'good', text: 'This is the time and room your last email described.' };
  }

  const previous = noticed.get(row.scheduleNoticeKey);
  if (!previous) {
    // Either the last mail said the talk was unscheduled, or its key names a
    // room that has since been deleted. Both mean the same thing to a speaker:
    // the email in their inbox does not describe the line above.
    return {
      tone: 'warn',
      text: 'This has changed since your last email about it. The email you have does not describe the time above.',
    };
  }

  const when = `${dayLabel(previous.startsAt, timezone)} at ${timeOfDay(previous.startsAt, timezone)}${
    previous.roomName ? ` in ${previous.roomName}` : ''
  }`;

  if (current === UNSCHEDULED) {
    return {
      tone: 'warn',
      text: `Taken off the schedule since your last email, which put you on ${when}.`,
    };
  }

  return { tone: 'warn', text: `Moved since your last email, which said ${when}.` };
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
