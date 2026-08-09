import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '@/db';
import {
  rooms,
  slots,
  speakerAvailability,
  speakerTasks,
  submissions,
  tracks,
  userRoles,
  users,
} from '@/db/schema';
import type {
  Role,
  SpeakerAvailability,
  SpeakerTask,
  SpeakerTaskKind,
  SubmissionFormat,
  SubmissionStatus,
  User,
} from '@/db/schema';

/**
 * `%` and `_` are wildcards to LIKE. Escaping them keeps a search for "C_C" from
 * quietly matching "CFC"; the default escape character is a backslash, which is
 * why it escapes itself first.
 */
function likeTerm(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type OpenTask = {
  id: string;
  kind: SpeakerTaskKind;
  label: string;
  dueAt: Date | null;
  lastRemindedAt: Date | null;
  submissionId: string | null;
  overdue: boolean;
};

export type RosterRow = {
  id: string;
  email: string;
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
  isBot: boolean;
  roles: Role[];
  total: number;
  submitted: number;
  accepted: number;
  rejected: number;
  withdrawn: number;
  confirmed: number;
  openTasks: OpenTask[];
  outstanding: number;
  overdue: number;
};

/**
 * The saved views on the roster. They are keys rather than free-form predicates
 * because the bulk actions resolve their target set by re-running the same
 * filter server-side: the browser posts the name of a view, never a list of
 * ids, so what an organizer saw and what the action writes cannot diverge.
 */
export const ROSTER_FILTERS = {
  all: 'Everyone',
  accepted: 'Has an accepted talk',
  unconfirmed: 'Accepted, not confirmed',
  missing_bio: 'No bio',
  missing_headshot: 'No headshot',
  outstanding: 'Has an open task',
  overdue: 'Has an overdue task',
} as const;

export type RosterFilter = keyof typeof ROSTER_FILTERS;

export function isRosterFilter(value: unknown): value is RosterFilter {
  return typeof value === 'string' && value in ROSTER_FILTERS;
}

function matchesFilter(row: RosterRow, filter: RosterFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'accepted':
      return row.accepted > 0;
    case 'unconfirmed':
      return row.accepted > row.confirmed;
    case 'missing_bio':
      return row.accepted > 0 && !row.bio;
    case 'missing_headshot':
      return row.accepted > 0 && !row.headshotUrl;
    case 'outstanding':
      return row.outstanding > 0;
    case 'overdue':
      return row.overdue > 0;
  }
}

/**
 * Every account with its submission tallies and its open tasks.
 *
 * The task counts are derived from the fetched task rows rather than aggregated
 * alongside the submission counts. Two SQL aggregates over two joined tables
 * fan out against each other, and more to the point "overdue" would then have
 * one definition in SQL and another in the template; here it has one.
 */
export async function speakerRoster(
  options: { q?: string; filter?: RosterFilter } = {},
): Promise<RosterRow[]> {
  const q = options.q?.trim();
  const search = q ? or(ilike(users.name, likeTerm(q)), ilike(users.email, likeTerm(q))) : undefined;

  const people = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      bio: users.bio,
      headshotUrl: users.headshotUrl,
      isBot: users.isBot,
      roles: sql<
        Role[]
      >`coalesce(array_agg(distinct ${userRoles.role}) filter (where ${userRoles.role} is not null), '{}')`,
      total: sql<number>`count(distinct ${submissions.id})::int`,
      submitted: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.status} = 'submitted')::int`,
      accepted: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.status} = 'accepted')::int`,
      rejected: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.status} = 'rejected')::int`,
      withdrawn: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.status} = 'withdrawn')::int`,
      confirmed: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.speakerConfirmedAt} is not null)::int`,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(submissions, eq(submissions.speakerId, users.id))
    .where(search)
    .groupBy(users.id)
    .orderBy(asc(users.email));

  const openByUser = await openTasksByUser(people.map((p) => p.id));

  const rows: RosterRow[] = people.map((person) => {
    const openTasks = openByUser.get(person.id) ?? [];
    return {
      ...person,
      openTasks,
      outstanding: openTasks.length,
      overdue: openTasks.filter((t) => t.overdue).length,
    };
  });

  const filter = options.filter ?? 'all';
  return rows.filter((row) => matchesFilter(row, filter));
}

/** Incomplete tasks for the given accounts, soonest deadline first. */
export async function openTasksByUser(userIds: string[]): Promise<Map<string, OpenTask[]>> {
  const grouped = new Map<string, OpenTask[]>();
  if (userIds.length === 0) return grouped;

  const now = Date.now();
  const rows = await db
    .select({
      id: speakerTasks.id,
      userId: speakerTasks.userId,
      kind: speakerTasks.kind,
      label: speakerTasks.label,
      dueAt: speakerTasks.dueAt,
      lastRemindedAt: speakerTasks.lastRemindedAt,
      submissionId: speakerTasks.submissionId,
    })
    .from(speakerTasks)
    .where(and(inArray(speakerTasks.userId, userIds), isNull(speakerTasks.completedAt)))
    // Undated tasks sort last: ASC puts NULLs at the end in Postgres.
    .orderBy(asc(speakerTasks.dueAt), asc(speakerTasks.label));

  for (const row of rows) {
    const list = grouped.get(row.userId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      label: row.label,
      dueAt: row.dueAt,
      lastRemindedAt: row.lastRemindedAt,
      submissionId: row.submissionId,
      overdue: row.dueAt !== null && row.dueAt.getTime() < now,
    });
    grouped.set(row.userId, list);
  }
  return grouped;
}

export type SpeakerSubmissionRow = {
  id: string;
  title: string;
  status: SubmissionStatus;
  format: SubmissionFormat;
  trackName: string | null;
  speakerConfirmedAt: Date | null;
  /** Set once they have said they cannot present. Distinct from never answering. */
  speakerDeclinedAt: Date | null;
};

export type SpeakerDetail = {
  user: User;
  roles: Role[];
  submissions: SpeakerSubmissionRow[];
  tasks: (SpeakerTask & { submissionTitle: string | null })[];
  availability: SpeakerAvailability[];
};

/** Everything the organizer edit screen renders for one account. */
export async function speakerDetail(userId: string): Promise<SpeakerDetail | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;

  const [held, mine, tasks, availability] = await Promise.all([
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)),
    db
      .select({
        id: submissions.id,
        title: submissions.title,
        status: submissions.status,
        format: submissions.format,
        trackName: tracks.name,
        speakerConfirmedAt: submissions.speakerConfirmedAt,
        speakerDeclinedAt: submissions.speakerDeclinedAt,
      })
      .from(submissions)
      .leftJoin(tracks, eq(tracks.id, submissions.trackId))
      .where(eq(submissions.speakerId, userId))
      .orderBy(asc(submissions.createdAt)),
    db
      .select({
        id: speakerTasks.id,
        userId: speakerTasks.userId,
        submissionId: speakerTasks.submissionId,
        kind: speakerTasks.kind,
        label: speakerTasks.label,
        dueAt: speakerTasks.dueAt,
        completedAt: speakerTasks.completedAt,
        lastRemindedAt: speakerTasks.lastRemindedAt,
        createdAt: speakerTasks.createdAt,
        submissionTitle: submissions.title,
      })
      .from(speakerTasks)
      .leftJoin(submissions, eq(submissions.id, speakerTasks.submissionId))
      .where(eq(speakerTasks.userId, userId))
      .orderBy(asc(speakerTasks.completedAt), asc(speakerTasks.dueAt)),
    db
      .select()
      .from(speakerAvailability)
      .where(eq(speakerAvailability.userId, userId))
      .orderBy(asc(speakerAvailability.startsAt)),
  ]);

  return { user, roles: held.map((r) => r.role), submissions: mine, tasks, availability };
}

/**
 * True when stripping the speaker role would orphan someone from their own
 * portal. `/speaker` is where a submission is confirmed, withdrawn and given its
 * slides, and every action there is speaker-gated.
 */
export async function hasSubmissions(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(submissions)
    .where(eq(submissions.speakerId, userId));
  return (row?.n ?? 0) > 0;
}

export type DirectoryRow = {
  id: string;
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
  acceptedCount: number;
  trackNames: string[];
  keywords: string[];
};

/**
 * The public directory: anyone with at least one accepted submission, which the
 * inner join expresses directly. Search spans the speaker's name, the titles of
 * their accepted submissions and the keywords on them, because "who works on
 * Postgres" is a keyword question and nobody puts it in their name.
 */
export async function speakerDirectory(
  options: { q?: string; trackId?: string } = {},
): Promise<DirectoryRow[]> {
  const q = options.q?.trim();
  // `or()` is typed as possibly-undefined, and `and()` accepts that, so the
  // array carries it rather than the call site asserting it away.
  const conditions: (SQL | undefined)[] = [];

  if (q) {
    const term = likeTerm(q);
    conditions.push(
      or(
        ilike(users.name, term),
        sql`exists (
          select 1 from ${submissions} sq
          where sq.speaker_id = ${users.id} and sq.status = 'accepted'
            and (sq.title ilike ${term}
                 or exists (select 1 from unnest(sq.keywords) kw where kw ilike ${term}))
        )`,
      ),
    );
  }
  if (options.trackId) {
    conditions.push(
      sql`exists (
        select 1 from ${submissions} st
        where st.speaker_id = ${users.id} and st.status = 'accepted'
          and st.track_id = ${options.trackId}
      )`,
    );
  }

  return db
    .select({
      id: users.id,
      name: users.name,
      bio: users.bio,
      headshotUrl: users.headshotUrl,
      acceptedCount: sql<number>`count(distinct ${submissions.id})::int`,
      trackNames: sql<
        string[]
      >`coalesce(array_agg(distinct ${tracks.name}) filter (where ${tracks.name} is not null), '{}')`,
      keywords: sql<string[]>`coalesce((
        select array_agg(distinct kw)
        from ${submissions} sk, unnest(sk.keywords) kw
        where sk.speaker_id = ${users.id} and sk.status = 'accepted'
      ), '{}')`,
    })
    .from(users)
    .innerJoin(
      submissions,
      and(eq(submissions.speakerId, users.id), eq(submissions.status, 'accepted')),
    )
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(users.id)
    .orderBy(asc(sql`coalesce(${users.name}, ${users.email})`));
}

export type DirectoryProfile = {
  id: string;
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
  acceptedSubmissions: {
    id: string;
    title: string;
    format: SubmissionFormat;
    keywords: string[];
    trackName: string | null;
    trackColour: string | null;
    startsAt: Date | null;
    roomName: string | null;
  }[];
};

/**
 * One public profile. Null when the account holds nothing accepted, so the
 * route 404s rather than turning every registered address into a public page.
 */
export async function speakerProfile(userId: string): Promise<DirectoryProfile | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;

  const accepted = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      format: submissions.format,
      keywords: submissions.keywords,
      trackName: tracks.name,
      trackColour: tracks.colour,
      startsAt: slots.startsAt,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(and(eq(submissions.speakerId, userId), eq(submissions.status, 'accepted')))
    .orderBy(asc(slots.startsAt), asc(submissions.title));

  if (accepted.length === 0) return null;

  return {
    id: user.id,
    name: user.name,
    bio: user.bio,
    headshotUrl: user.headshotUrl,
    acceptedSubmissions: accepted,
  };
}

/**
 * Quote every field rather than only the ones that need it: the rule is then
 * one line long instead of a predicate someone has to trust.
 *
 * The leading apostrophe on a formula-looking value is the spreadsheet-injection
 * guard. Names and bios are typed by whoever signed up, and a cell opening with
 * `=` or `+` is executed on open by Excel and Sheets.
 */
function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const ROSTER_CSV_HEADER = [
  'name',
  'email',
  'roles',
  'submitted',
  'accepted',
  'rejected',
  'withdrawn',
  'confirmed',
  'bio_present',
  'headshot_present',
  'outstanding_tasks',
] as const;

/** RFC 4180: CRLF line endings, every field quoted. */
export function rosterCsv(rows: RosterRow[]): string {
  const lines = [ROSTER_CSV_HEADER.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.name),
        csvCell(row.email),
        csvCell([...row.roles].sort().join(' ')),
        csvCell(row.submitted),
        csvCell(row.accepted),
        csvCell(row.rejected),
        csvCell(row.withdrawn),
        csvCell(row.confirmed),
        csvCell(row.bio ? 'yes' : 'no'),
        csvCell(row.headshotUrl ? 'yes' : 'no'),
        csvCell(row.outstanding),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
