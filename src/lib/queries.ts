import { and, asc, desc, eq, ilike, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { events, reviews, rooms, slots, submissions, tracks, users } from '@/db/schema';
import type {
  AudienceLevel,
  ContentStatus,
  Event,
  SubmissionFormat,
  SubmissionStatus,
} from '@/db/schema';
import { writableBy } from './abstracts';
import { EFFECTIVE_SCORE } from './rubric';
import { UNSCHEDULED } from './speaker-calendar';

export async function getEvent(): Promise<Event> {
  const found = await db.query.events.findFirst({ orderBy: asc(events.createdAt) });
  if (!found) {
    throw new Error('No event row. Run `pnpm db:seed` to create one.');
  }
  return found;
}

export function cfpIsOpen(event: Event, now = new Date()): boolean {
  return now >= event.cfpOpensAt && now <= event.cfpClosesAt;
}

export type ReviewQueueRow = {
  id: string;
  title: string;
  abstract: string;
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  trackName: string | null;
  reviewCount: number;
  averageScore: number | null;
  myScore: number | null;
};

/**
 * The review queue, deliberately free of speaker columns. Blind review is
 * enforced here rather than in the template: the identity never enters the
 * payload, so it cannot leak through a stray render or a client component
 * receiving props it did not need.
 *
 * Ordered least-reviewed first so reviewer effort spreads across the pool
 * instead of piling onto whatever sorts first.
 */
export async function reviewQueue(reviewerId: string): Promise<ReviewQueueRow[]> {
  const rows = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      reviewCount: sql<number>`count(${reviews.id})::int`,
      averageScore: sql<number | null>`avg(${reviews.score})::float`,
      myScore: sql<
        number | null
      >`max(${reviews.score}) filter (where ${reviews.reviewerId} = ${reviewerId})::int`,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .where(eq(submissions.status, 'submitted'))
    .groupBy(submissions.id, tracks.name)
    .orderBy(sql`count(${reviews.id}) asc`, asc(submissions.createdAt));

  return rows;
}

export type OrganizerRow = {
  id: string;
  title: string;
  abstract: string;
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  status: SubmissionStatus;
  trackName: string | null;
  speakerName: string | null;
  speakerEmail: string;
  reviewCount: number;
  averageScore: number | null;
  decisionEmailedAt: Date | null;
  scheduled: boolean;
};

export type ReviewCommentRow = {
  submissionId: string;
  reviewerName: string | null;
  reviewerEmail: string;
  score: number;
  comment: string | null;
};

export const ORGANIZER_SORTS = [
  { value: 'grade', label: 'Average grade' },
  { value: 'newest', label: 'Newest first' },
  { value: 'title', label: 'Title' },
] as const;

export type OrganizerSort = (typeof ORGANIZER_SORTS)[number]['value'];

/**
 * Which end of the chosen sort comes first. Every mode used to have one fixed
 * direction, which on `grade` meant the weakest proposals were the ones a chair
 * could never bring to the top: they sit at the bottom of a paged list, so on a
 * board of any size they are on a page nobody opens.
 */
export type OrganizerDirection = 'asc' | 'desc';

/**
 * The direction each mode has always had, so an address with no `direction=` in
 * it returns exactly the order it did before the toggle existed. Titles read A
 * to Z; the other two put the interesting end first.
 */
export const ORGANIZER_DEFAULT_DIRECTION: Record<OrganizerSort, OrganizerDirection> = {
  grade: 'desc',
  newest: 'desc',
  title: 'asc',
};

export type OrganizerFilters = {
  q?: string | null;
  status?: SubmissionStatus | null;
  trackId?: string | null;
  content?: ContentStatus | null;
};

export type OrganizerQuery = OrganizerFilters & {
  sort?: OrganizerSort;
  direction?: OrganizerDirection;
  limit?: number;
  offset?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The WHERE the board and its counter share. Written once because a pager built
 * on two predicates that drift is a pager that says "of 40" over 12 rows.
 *
 * A uuid is matched against the id rather than treated as text to find inside a
 * title. The id is what `/organizer/abstracts/export` puts in its first column
 * and what every organizer URL in this app ends with, so pasting one into the
 * search box is the ordinary way back to a row you already have a handle on.
 */
function organizerConditions(filters: OrganizerFilters): SQL[] {
  const conditions: SQL[] = [];

  const q = filters.q?.trim();
  if (q) {
    const pattern = `%${q}%`;
    const match = UUID.test(q)
      ? eq(submissions.id, q)
      : or(
          ilike(submissions.title, pattern),
          ilike(submissions.abstract, pattern),
          ilike(users.name, pattern),
          ilike(users.email, pattern),
        );
    if (match) conditions.push(match);
  }
  if (filters.status) conditions.push(eq(submissions.status, filters.status));
  if (filters.trackId) conditions.push(eq(submissions.trackId, filters.trackId));
  if (filters.content) conditions.push(eq(submissions.contentStatus, filters.content));

  return conditions;
}

/**
 * Every sort ends on the id. Without a total order Postgres is free to return
 * tied rows in any order it likes on each query, and two rows tied across a page
 * boundary is a row rendered twice on page 1 and never on page 2.
 */
/**
 * The direction is applied to the sort key only. `nulls last` does not flip with
 * it: an ungraded proposal is not the lowest-scoring one, and floating forty of
 * them to the top is not what a chair asking for the weakest proposals wants.
 *
 * The id tiebreaker stays ascending in both directions for the same reason it
 * exists: it is there to make the order total, and a tiebreaker that moves is
 * one more thing that can shuffle a row across a page boundary.
 */
function organizerOrder(sort: OrganizerSort, direction: OrganizerDirection): SQL[] {
  const flip = <T extends SQL>(ascending: T, descending: T) =>
    direction === 'asc' ? ascending : descending;

  switch (sort) {
    case 'grade':
      // The same collapse the row displays, so the order and the number on
      // screen are the same fact. Sorting on `avg(reviews.score)` while showing
      // the effective mean is how a board ends up listing a 2.0 above a 4.0.
      return [
        direction === 'asc'
          ? sql`avg(${EFFECTIVE_SCORE}) asc nulls last`
          : sql`avg(${EFFECTIVE_SCORE}) desc nulls last`,
        asc(submissions.createdAt),
        asc(submissions.id),
      ];
    case 'newest':
      return [flip(asc(submissions.createdAt), desc(submissions.createdAt)), asc(submissions.id)];
    case 'title':
      return [flip(asc(submissions.title), desc(submissions.title)), asc(submissions.id)];
  }
}

/**
 * The organizer view. Unlike the review queue this one carries speaker identity
 * and average score, because deciding is exactly where both are needed. Sorted
 * by score descending by default, so the strongest proposals are at the top.
 *
 * Filtered, sorted and paged in SQL rather than in the page. The board used to
 * read the whole call for papers and narrow it in JavaScript, which renders
 * every row that has ever been filed on a screen whose job is to decide the next
 * one: at 40 submissions that is 17,000 pixels of page and 2,500 DOM nodes, and
 * the number only goes up.
 */
export async function organizerSubmissions(options: OrganizerQuery = {}): Promise<OrganizerRow[]> {
  const conditions = organizerConditions(options);

  const rows = db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      status: submissions.status,
      trackName: tracks.name,
      speakerName: users.name,
      speakerEmail: users.email,
      reviewCount: sql<number>`count(distinct ${reviews.id})::int`,
      averageScore: sql<number | null>`avg(${EFFECTIVE_SCORE})::float`,
      decisionEmailedAt: submissions.decisionEmailedAt,
      scheduled: sql<boolean>`bool_or(${slots.id} is not null)`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(submissions.id, tracks.name, users.name, users.email)
    .orderBy(
      ...organizerOrder(
        options.sort ?? 'grade',
        options.direction ?? ORGANIZER_DEFAULT_DIRECTION[options.sort ?? 'grade'],
      ),
    );

  if (options.limit === undefined) return rows;
  return rows.limit(options.limit).offset(options.offset ?? 0);
}

/**
 * The latest human reviewer comments per submission, for the decision board.
 * A chair deciding on a proposal should not have to leave the submissions list
 * to find the reasoning behind the average score.
 */
export async function organizerReviewComments(
  submissionIds: string[],
): Promise<ReviewCommentRow[]> {
  if (submissionIds.length === 0) return [];

  const ranked = db
    .select({
      submissionId: reviews.submissionId,
      reviewerName: users.name,
      reviewerEmail: users.email,
      score: sql<number>`coalesce(${reviews.overrideScore}, ${reviews.score})`.as('score'),
      comment: reviews.comment,
      rowNumber: sql<number>`row_number() over (partition by ${reviews.submissionId} order by ${reviews.createdAt} desc)`.as(
        'row_number',
      ),
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.reviewerId))
    .where(and(inArray(reviews.submissionId, submissionIds), eq(reviews.source, 'human')))
    .as('ranked');

  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rowNumber, 5));

  return rows.map((row) => ({
    submissionId: row.submissionId,
    reviewerName: row.reviewerName,
    reviewerEmail: row.reviewerEmail,
    score: row.score,
    comment: row.comment,
  }));
}

/** How many submissions the same filters match, for the pager. */
export async function organizerSubmissionCount(filters: OrganizerFilters = {}): Promise<number> {
  const conditions = organizerConditions(filters);

  // `users` is joined whether or not the search needs it: the join is on a
  // foreign key to a primary key, so it can neither add a row nor drop one.
  const [row] = await db
    .select({ matching: sql<number>`count(*)::int` })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row?.matching ?? 0;
}

export type OrganizerTotals = {
  total: number;
  submitted: number;
  accepted: number;
  rejected: number;
  awaitingEmail: number;
  draft: number;
  pending: number;
  approved: number;
};

const NO_SUBMISSIONS: OrganizerTotals = {
  total: 0,
  submitted: 0,
  accepted: 0,
  rejected: 0,
  awaitingEmail: 0,
  draft: 0,
  pending: 0,
  approved: 0,
};

/**
 * The header counts, over the whole call for papers rather than the page.
 *
 * These are deliberately not derived from the rows on screen. "12 undecided"
 * and "Send 3 decision email(s)" describe the work outstanding, and the button
 * beside them acts on every decided row in the database, not on the 25 an
 * organizer happens to be looking at. A count that shrank when a filter was
 * applied would be a count of the wrong thing.
 */
export async function organizerTotals(): Promise<OrganizerTotals> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      submitted: sql<number>`count(*) filter (where ${submissions.status} = 'submitted')::int`,
      accepted: sql<number>`count(*) filter (where ${submissions.status} = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where ${submissions.status} = 'rejected')::int`,
      awaitingEmail: sql<number>`count(*) filter (where ${submissions.status} in ('accepted', 'rejected') and ${submissions.decisionEmailedAt} is null)::int`,
      draft: sql<number>`count(*) filter (where ${submissions.contentStatus} = 'draft')::int`,
      pending: sql<number>`count(*) filter (where ${submissions.contentStatus} = 'pending')::int`,
      approved: sql<number>`count(*) filter (where ${submissions.contentStatus} = 'approved')::int`,
    })
    .from(submissions);

  return row ?? NO_SUBMISSIONS;
}

export type AgendaEntry = {
  slotId: string;
  roomId: string;
  roomName: string;
  startsAt: Date;
  endsAt: Date;
  submissionId: string | null;
  title: string | null;
  abstract: string | null;
  format: SubmissionFormat | null;
  trackName: string | null;
  trackColour: string | null;
  speakerName: string | null;
  speakerBio: string | null;
};

export async function agenda(): Promise<AgendaEntry[]> {
  return db
    .select({
      slotId: slots.id,
      roomId: rooms.id,
      roomName: rooms.name,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      submissionId: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      trackName: tracks.name,
      trackColour: tracks.colour,
      speakerName: users.name,
      speakerBio: users.bio,
    })
    .from(slots)
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(submissions, eq(submissions.id, slots.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(users, eq(users.id, submissions.speakerId))
    .orderBy(asc(slots.startsAt), asc(rooms.position), asc(rooms.name));
}

/** Accepted submissions with no slot yet — the pool the organizer drags from. */
export async function unscheduledAccepted() {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      format: submissions.format,
      trackName: tracks.name,
      trackColour: tracks.colour,
      speakerName: users.name,
      speakerId: submissions.speakerId,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.status, 'accepted'),
        sql`${slots.id} is null`,
        // A poster is displayed on a board, not slotted into a time band, and
        // its format is worth zero minutes. Before any poster was accepted this
        // filter was invisible; now that the fixture accepts three, without it
        // the scheduling pool offers three items no band can hold.
        ne(submissions.format, 'poster'),
      ),
    )
    .orderBy(asc(submissions.title));
}

/**
 * Everything this person may act on: what they filed, plus anything a filer
 * granted them write access to. `isOwner` distinguishes the two, because the
 * things only a filer may do (withdraw, confirm attendance, hand out access)
 * are hidden from a co-author rather than offered and then refused.
 */
export async function mySubmissions(speakerId: string) {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      status: submissions.status,
      trackName: tracks.name,
      createdAt: submissions.createdAt,
      slotStartsAt: slots.startsAt,
      slotRoomId: slots.roomId,
      roomName: rooms.name,
      speakerConfirmedAt: submissions.speakerConfirmedAt,
      speakerDeclinedAt: submissions.speakerDeclinedAt,
      // What the organizers have actually sent, as opposed to what they have
      // decided. Both are idempotency keys on the organizer's side and both are
      // the only record of whether this speaker was ever told; a portal that
      // shows the decision without them says "accepted" to somebody who has had
      // no email and cannot tell whether one is coming.
      decisionEmailedAt: submissions.decisionEmailedAt,
      scheduleNoticeKey: submissions.scheduleNoticeKey,
      slidesUrl: submissions.slidesUrl,
      recordingUrl: submissions.recordingUrl,
      resourcesNote: submissions.resourcesNote,
      posterUrl: submissions.posterUrl,
      isOwner: sql<boolean>`${submissions.speakerId} = ${speakerId}`,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(writableBy(speakerId))
    .orderBy(asc(submissions.createdAt));
}

export type NoticedPlacement = { startsAt: Date; roomName: string | null };

/**
 * The placements a set of `scheduleNoticeKey` values describe: what the speaker
 * was last emailed, not where the talk is now.
 *
 * `slotFromNoticeKey` in `speaker-calendar.ts` does the same decoding, but it
 * builds a whole `AgendaSlot` because its caller has to put one in a
 * cancellation VEVENT. A portal only needs a time and a room name, and it needs
 * them for every row on the page, so this resolves the whole set in one room
 * lookup rather than one per talk.
 *
 * An unparseable or `unscheduled` key yields no entry. The caller renders the
 * absence as "we have not emailed you about a time", which is what a key
 * naming no placement means.
 */
export async function placementsFromNoticeKeys(
  keys: (string | null)[],
): Promise<Map<string, NoticedPlacement>> {
  const parsed = new Map<string, { startsAt: Date; roomId: string }>();
  for (const key of keys) {
    if (!key || key === UNSCHEDULED || parsed.has(key)) continue;
    const [startsAtIso, roomId] = key.split('|');
    if (!startsAtIso || !roomId) continue;
    const startsAt = new Date(startsAtIso);
    if (Number.isNaN(startsAt.getTime())) continue;
    parsed.set(key, { startsAt, roomId });
  }
  if (parsed.size === 0) return new Map();

  const roomIds = [...new Set([...parsed.values()].map((entry) => entry.roomId))];
  const found = await db
    .select({ id: rooms.id, name: rooms.name })
    .from(rooms)
    .where(inArray(rooms.id, roomIds));
  const names = new Map(found.map((room) => [room.id, room.name]));

  // A deleted room leaves the time, which is the half a speaker acts on. Losing
  // the whole line because the room row went away would hide the move itself.
  return new Map(
    [...parsed].map(([key, entry]) => [
      key,
      { startsAt: entry.startsAt, roomName: names.get(entry.roomId) ?? null },
    ]),
  );
}

export async function allTracks() {
  return db.select().from(tracks).orderBy(asc(tracks.name));
}

export async function allRooms() {
  return db.select().from(rooms).orderBy(asc(rooms.position), asc(rooms.name));
}
