import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { reviewAssignments, reviews, slots, speakerTasks, submissions } from '@/db/schema';
import type { Event, SpeakerTaskKind, SubmissionStatus } from '@/db/schema';
import { getEvent, cfpIsOpen } from '@/lib/queries';

const DAY_MS = 24 * 60 * 60 * 1000;

export type OrganizerOverview = {
  event: Event;
  statusCounts: Record<SubmissionStatus, number>;
  /**
   * Grading progress measured against assignments. `assigned` is 0 until an
   * organizer assigns anyone, which is a legitimate state rather than an error,
   * so `reviewsFiled` carries the count that is still meaningful then.
   */
  grading: { assigned: number; graded: number; reviewsFiled: number };
  acceptedUnscheduled: number;
  tasks: { outstanding: number; overdue: number };
  /** `days` counts to the open date, to the close date, or since it closed. */
  cfp: { state: 'before' | 'open' | 'closed'; days: number };
};

const ZERO_STATUS: Record<SubmissionStatus, number> = {
  submitted: 0,
  accepted: 0,
  rejected: 0,
  withdrawn: 0,
};

/**
 * Every figure on the organizer overview, as aggregates rather than rows the
 * page then counts. This is the first screen after sign-in and it never needs
 * the underlying rows, so pulling forty submissions to call `.filter()` on them
 * would be paying for a payload nothing renders.
 */
export async function organizerOverview(): Promise<OrganizerOverview> {
  const now = new Date();

  const [event, byStatus, gradingRows, filedRows, unscheduledRows, taskRows] = await Promise.all([
    getEvent(),

    db
      .select({ status: submissions.status, n: sql<number>`count(*)::int` })
      .from(submissions)
      .groupBy(submissions.status),

    // A grade only counts as delivered when it matches an assignment pair. A
    // reviewer who grades something nobody assigned them must not push the
    // completion rate past its own denominator.
    db
      .select({
        assigned: sql<number>`count(*)::int`,
        graded: sql<number>`count(${reviews.id})::int`,
      })
      .from(reviewAssignments)
      .leftJoin(
        reviews,
        and(
          eq(reviews.submissionId, reviewAssignments.submissionId),
          eq(reviews.reviewerId, reviewAssignments.reviewerId),
        ),
      ),

    db.select({ n: sql<number>`count(*)::int` }).from(reviews),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(submissions)
      .leftJoin(slots, eq(slots.submissionId, submissions.id))
      .where(and(eq(submissions.status, 'accepted'), isNull(slots.id))),

    // `due_at < now()` is null-safe: a task with no deadline is never overdue.
    db
      .select({
        outstanding: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${speakerTasks.dueAt} < now())::int`,
      })
      .from(speakerTasks)
      .where(isNull(speakerTasks.completedAt)),
  ]);

  const statusCounts = { ...ZERO_STATUS };
  for (const row of byStatus) statusCounts[row.status] = row.n;

  const grading = {
    assigned: gradingRows[0]?.assigned ?? 0,
    graded: gradingRows[0]?.graded ?? 0,
    reviewsFiled: filedRows[0]?.n ?? 0,
  };

  return {
    event,
    statusCounts,
    grading,
    acceptedUnscheduled: unscheduledRows[0]?.n ?? 0,
    tasks: {
      outstanding: taskRows[0]?.outstanding ?? 0,
      overdue: taskRows[0]?.overdue ?? 0,
    },
    cfp: cfpWindow(event, now),
  };
}

function cfpWindow(event: Event, now: Date): OrganizerOverview['cfp'] {
  const ms = now.getTime();
  if (cfpIsOpen(event, now)) {
    return { state: 'open', days: Math.ceil((event.cfpClosesAt.getTime() - ms) / DAY_MS) };
  }
  if (now < event.cfpOpensAt) {
    return { state: 'before', days: Math.ceil((event.cfpOpensAt.getTime() - ms) / DAY_MS) };
  }
  return { state: 'closed', days: Math.floor((ms - event.cfpClosesAt.getTime()) / DAY_MS) };
}

export type SpeakerTaskRow = {
  id: string;
  submissionId: string | null;
  kind: SpeakerTaskKind;
  label: string;
  instructions: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  submissionTitle: string | null;
};

/**
 * One speaker's tasks. Scoped by `userId` in the WHERE clause like every other
 * speaker-facing read, and ordered so what is still owed sits above what is
 * already done, soonest deadline first.
 */
export async function speakerTasksFor(userId: string): Promise<SpeakerTaskRow[]> {
  return db
    .select({
      id: speakerTasks.id,
      submissionId: speakerTasks.submissionId,
      kind: speakerTasks.kind,
      label: speakerTasks.label,
      instructions: speakerTasks.instructions,
      dueAt: speakerTasks.dueAt,
      completedAt: speakerTasks.completedAt,
      submissionTitle: submissions.title,
    })
    .from(speakerTasks)
    .leftJoin(submissions, eq(submissions.id, speakerTasks.submissionId))
    .where(eq(speakerTasks.userId, userId))
    .orderBy(
      // false sorts before true in Postgres, so outstanding leads.
      sql`${speakerTasks.completedAt} is not null asc`,
      sql`${speakerTasks.dueAt} asc nulls last`,
      asc(speakerTasks.createdAt),
    );
}

export const TASK_KIND_LABELS: Record<SpeakerTaskKind, string> = {
  headshot: 'Headshot',
  bio: 'Bio',
  slides: 'Slides',
  poster: 'Poster',
  confirm: 'Confirmation',
  other: 'Task',
};

export function isOverdue(
  task: { dueAt: Date | null; completedAt: Date | null },
  now = new Date(),
): boolean {
  return task.completedAt === null && task.dueAt !== null && task.dueAt.getTime() < now.getTime();
}

/** Which task kinds the profile editor is the answer to, rather than a submission. */
const PROFILE_KINDS = new Set<SpeakerTaskKind>(['headshot', 'bio']);

export function taskTargetsProfile(kind: SpeakerTaskKind): boolean {
  return PROFILE_KINDS.has(kind);
}

export type ProfileGap = 'name' | 'bio' | 'headshot';

const GAP_LABELS: Record<ProfileGap, string> = {
  name: 'your name',
  bio: 'a short bio',
  headshot: 'a headshot',
};

/**
 * What a speaker's profile is still missing. The organizer view has always
 * flagged a missing bio; this is the same judgement said to the person who can
 * actually fix it.
 */
export function profileGaps(user: {
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
}): ProfileGap[] {
  const gaps: ProfileGap[] = [];
  if (!user.name?.trim()) gaps.push('name');
  if (!user.bio?.trim()) gaps.push('bio');
  if (!user.headshotUrl?.trim()) gaps.push('headshot');
  return gaps;
}

export function describeGaps(gaps: ProfileGap[]): string {
  const words = gaps.map((gap) => GAP_LABELS[gap]);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
