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

/**
 * How a speaker is billed under their name: "Principal Engineer at Latticework
 * Systems", or whichever half of that exists.
 *
 * One function rather than a join in each template because both columns are
 * nullable and most accounts carry neither. The bug this exists to prevent is a
 * card that renders " at Latticework Systems", or a bare separator hanging in
 * front of nothing, on the six surfaces that print a byline. Null when there is
 * nothing to say, so a caller can drop the whole element rather than print an
 * empty one.
 */
export function billing(title: string | null, company: string | null): string | null {
  if (title && company) return `${title} at ${company}`;
  return title ?? company ?? null;
}

/**
 * Order the public directory by surname.
 *
 * This app holds one `name` field, deliberately: a programme has no business
 * insisting a person's name splits in two, and `splitName` in `accelevents.ts`
 * carries the same note where the export is forced to guess. So "surname" here
 * is the last whitespace-separated token and nothing cleverer. "Ada Lovelace"
 * sorts under Lovelace, which is the point; "Ingrid van der Berg" sorts under
 * Berg and a mononym sorts under itself, which are both wrong and both visible
 * rather than hidden behind a heuristic that guesses at particles.
 *
 * `[[:space:]]` rather than `\s`: this is a JavaScript template literal, where
 * an unrecognised escape silently becomes the bare letter, and `^.*s+` would
 * cut names off at their last letter s.
 */
const SURNAME_KEY = sql`lower(regexp_replace(coalesce(${users.name}, ${users.email}), '^.*[[:space:]]', ''))`;

export type OpenTask = {
  id: string;
  kind: SpeakerTaskKind;
  label: string;
  instructions: string | null;
  dueAt: Date | null;
  lastRemindedAt: Date | null;
  submissionId: string | null;
  overdue: boolean;
};

export type RosterRow = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  company: string | null;
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
  /** Accepted talks the speaker has said they cannot give. Never both with `confirmed`. */
  declined: number;
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
  confirmed: 'Confirmed to present',
  unconfirmed: 'Accepted, not confirmed',
  declined: 'Declined',
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
    case 'confirmed':
      return row.confirmed > 0;
    // Subtracting declines as well as confirmations, so this stays what its
    // label says it is: the chase list. Somebody who has answered "I cannot
    // present" has not left the question open, and the detail screen has drawn
    // those two as different states since before this filter existed.
    case 'unconfirmed':
      return row.accepted > row.confirmed + row.declined;
    case 'declined':
      return row.declined > 0;
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
  // Company is in the search because "who have we got from Latticework" is the
  // question an organizer asks the roster while assembling a panel, and the
  // answer is not in anybody's name. Job title comes along for the same reason:
  // it is now on screen beside the name, and a field an organizer can read but
  // not search reads as a broken search box.
  const search = q
    ? or(
        ilike(users.name, likeTerm(q)),
        ilike(users.email, likeTerm(q)),
        ilike(users.title, likeTerm(q)),
        ilike(users.company, likeTerm(q)),
      )
    : undefined;

  const people = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      title: users.title,
      company: users.company,
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
      declined: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.speakerDeclinedAt} is not null)::int`,
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
      instructions: speakerTasks.instructions,
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
      instructions: row.instructions,
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
        instructions: speakerTasks.instructions,
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
  title: string | null;
  company: string | null;
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
      title: users.title,
      company: users.company,
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
    // Surname first, then the whole name, so two Okafors keep a stable order
    // instead of Postgres choosing one per query.
    .orderBy(asc(SURNAME_KEY), asc(sql`lower(coalesce(${users.name}, ${users.email}))`));
}

export type DirectoryProfile = {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
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
    title: user.title,
    company: user.company,
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
  'job_title',
  'company',
  'roles',
  'submitted',
  'accepted',
  'rejected',
  'withdrawn',
  'confirmed',
  'declined',
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
        csvCell(row.title),
        csvCell(row.company),
        csvCell([...row.roles].sort().join(' ')),
        csvCell(row.submitted),
        csvCell(row.accepted),
        csvCell(row.rejected),
        csvCell(row.withdrawn),
        csvCell(row.confirmed),
        csvCell(row.declined),
        csvCell(row.bio ? 'yes' : 'no'),
        csvCell(row.headshotUrl ? 'yes' : 'no'),
        csvCell(row.outstanding),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
