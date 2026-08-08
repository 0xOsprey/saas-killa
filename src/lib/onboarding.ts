import { and, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { speakerTasks, submissions, users, type SpeakerTaskKind } from '@/db/schema';

/**
 * Where speaker onboarding is stuck, right now.
 *
 * The roster at /organizer/speakers already answers "what does this person
 * still owe us". This answers the other question, the one an organizer has
 * three weeks out: how many people are outstanding, on what, and who is
 * furthest past their date. Different question, so different aggregates rather
 * than the roster's rows counted in the page.
 *
 * Every figure is a SQL aggregate. The roster pulls a row per speaker with its
 * tasks attached, which is right for a screen you scroll and wrong for a screen
 * that refreshes itself every fifteen seconds and renders nine numbers.
 */

export type KindRow = {
  kind: SpeakerTaskKind;
  outstanding: number;
  overdue: number;
  /** Speakers with at least one open task of this kind, not tasks. */
  people: number;
};

export type StuckSpeaker = {
  id: string;
  name: string | null;
  email: string;
  outstanding: number;
  overdue: number;
  /** Days past the earliest overdue date, floored. Null when nothing is overdue. */
  daysLate: number | null;
  earliestDue: Date | null;
};

export type OnboardingOverview = {
  /** Speakers holding at least one accepted talk. The population being onboarded. */
  accepted: number;
  /** Of those, how many owe nothing. */
  clear: number;
  /**
   * Everyone with an open task, accepted or not.
   *
   * Deliberately a wider population than `clear` is measured against, because
   * this figure is a link to `/organizer/speakers?filter=outstanding` and a
   * tile whose number disagrees with the list it opens is worse than no tile.
   * A task on someone whose talk was not accepted is unusual and is exactly the
   * kind of thing an organizer should see rather than have filtered away.
   */
  outstandingPeople: number;
  /** Everyone with an open task whose date has passed. Same population as above. */
  overduePeople: number;
  outstandingTasks: number;
  overdueTasks: number;
  /** Open tasks with no due date at all, which no overdue count will ever catch. */
  undated: number;
  /** Tasks completed in the last seven days, as the sign of movement. */
  completedThisWeek: number;
  byKind: KindRow[];
  stuck: StuckSpeaker[];
  /** When these numbers were read, so the screen can say how fresh it is. */
  readAt: Date;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An open task is one with no `completedAt`. Overdue additionally has a
 * `dueAt` in the past, which is why `undated` is reported separately: a task
 * nobody put a date on is invisible to every overdue count on this screen, and
 * an organizer reading "0 overdue" deserves to know how many were never in the
 * running.
 */
export async function onboardingOverview(now = new Date()): Promise<OnboardingOverview> {
  const open = isNull(speakerTasks.completedAt);
  const overdue = and(open, isNotNull(speakerTasks.dueAt), lt(speakerTasks.dueAt, now));

  const [totals, kinds, people, stuck, completed] = await Promise.all([
    db
      .select({
        outstanding: sql<number>`count(*) filter (where ${open})::int`,
        overdue: sql<number>`count(*) filter (where ${overdue})::int`,
        undated: sql<number>`count(*) filter (where ${and(open, isNull(speakerTasks.dueAt))})::int`,
        outstandingPeople: sql<number>`count(distinct ${speakerTasks.userId}) filter (where ${open})::int`,
        overduePeople: sql<number>`count(distinct ${speakerTasks.userId}) filter (where ${overdue})::int`,
      })
      .from(speakerTasks),

    db
      .select({
        kind: speakerTasks.kind,
        outstanding: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${overdue})::int`,
        people: sql<number>`count(distinct ${speakerTasks.userId})::int`,
      })
      .from(speakerTasks)
      .where(open)
      .groupBy(speakerTasks.kind),

    // "Ready" is measured against the accepted population and nothing else. A
    // speaker whose talk was not accepted is not being onboarded, so counting
    // them as ready would make the one encouraging number on this screen read
    // better than it is.
    db
      .select({
        accepted: sql<number>`count(distinct ${submissions.speakerId})::int`,
        withOpenTask: sql<number>`count(distinct ${submissions.speakerId}) filter (
          where exists (
            select 1 from ${speakerTasks} t
            where t.user_id = ${submissions.speakerId} and t.completed_at is null
          )
        )::int`,
      })
      .from(submissions)
      .where(eq(submissions.status, 'accepted')),

    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        outstanding: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${overdue})::int`,
        // A bare aggregate has no column behind it, so the driver hands back the
        // wire text rather than a `Date`. Typed as what actually arrives and
        // parsed below, because `sql<Date>` here would be a claim the runtime
        // does not honour.
        earliestDue: sql<string | null>`min(${speakerTasks.dueAt}) filter (where ${overdue})`,
      })
      .from(speakerTasks)
      .innerJoin(users, eq(users.id, speakerTasks.userId))
      .where(open)
      .groupBy(users.id, users.name, users.email)
      // Overdue first, then volume. An organizer chasing people works down the
      // list in that order, and sorting by volume alone buries the one person
      // who is three weeks late behind five who are merely busy.
      .orderBy(
        sql`count(*) filter (where ${overdue}) desc`,
        sql`min(${speakerTasks.dueAt}) asc nulls last`,
        sql`count(*) desc`,
      )
      .limit(8),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(speakerTasks)
      .where(gt(speakerTasks.completedAt, new Date(now.getTime() - WEEK_MS))),
  ]);

  const population = people[0] ?? { accepted: 0, withOpenTask: 0 };

  return {
    accepted: population.accepted,
    clear: Math.max(population.accepted - population.withOpenTask, 0),
    outstandingPeople: totals[0]?.outstandingPeople ?? 0,
    overduePeople: totals[0]?.overduePeople ?? 0,
    outstandingTasks: totals[0]?.outstanding ?? 0,
    overdueTasks: totals[0]?.overdue ?? 0,
    undated: totals[0]?.undated ?? 0,
    completedThisWeek: completed[0]?.count ?? 0,
    byKind: kinds
      .map((row) => ({
        kind: row.kind,
        outstanding: row.outstanding,
        overdue: row.overdue,
        people: row.people,
      }))
      .sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding),
    stuck: stuck.map((row) => {
      const earliestDue = row.earliestDue ? new Date(row.earliestDue) : null;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        outstanding: row.outstanding,
        overdue: row.overdue,
        earliestDue,
        daysLate: earliestDue
          ? Math.floor((now.getTime() - earliestDue.getTime()) / (24 * 60 * 60 * 1000))
          : null,
      };
    }),
    readAt: now,
  };
}
