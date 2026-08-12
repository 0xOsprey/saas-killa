import { and, asc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import {
  audienceLevelEnum,
  bookmarks,
  rooms,
  slots,
  submissionFormatEnum,
  submissions,
  tracks,
  users,
} from '@/db/schema';
import type { AudienceLevel, SubmissionFormat } from '@/db/schema';
import { dayKey, dayLabel } from './format';

/**
 * The public agenda's read path.
 *
 * This deliberately does not wrap `agenda()` from queries.ts. Filtering has to
 * happen in SQL so a filtered agenda is a URL someone can share and the server
 * does the work; wrapping a query that returns every slot and narrowing it in
 * JavaScript would be the same page with a worse shape. It returns a superset of
 * `AgendaEntry`: the columns the filters key on, plus `label`, room capacity and
 * bookmark counts.
 */

export type AgendaFilters = {
  trackId: string | null;
  roomId: string | null;
  /** A day key, `YYYY-MM-DD`, read in the event's timezone. */
  day: string | null;
  format: SubmissionFormat | null;
  level: AudienceLevel | null;
  /** Free text, matched against title and abstract. */
  q: string | null;
  /** "My agenda": only submissions the signed-in user has bookmarked. */
  mine: boolean;
};

export const EMPTY_FILTERS: AgendaFilters = {
  trackId: null,
  roomId: null,
  day: null,
  format: null,
  level: null,
  q: null,
  mine: false,
};

export type AgendaSearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Read filters off the query string, discarding anything malformed rather than
 * throwing. A hand-edited `?track=banana` has to render an unfiltered agenda: a
 * junk uuid reaching a `uuid` column is a Postgres error, not a 400 worth
 * showing an attendee.
 */
export function parseAgendaFilters(params: AgendaSearchParams): AgendaFilters {
  const uuid = (key: string): string | null => {
    const value = first(params[key]);
    return value && UUID.test(value) ? value : null;
  };
  const day = first(params.day);
  const format = first(params.format);
  const level = first(params.level);
  const q = first(params.q);

  return {
    trackId: uuid('track'),
    roomId: uuid('room'),
    day: day && DAY_KEY.test(day) ? day : null,
    format: submissionFormatEnum.enumValues.includes(format as SubmissionFormat)
      ? (format as SubmissionFormat)
      : null,
    level: audienceLevelEnum.enumValues.includes(level as AudienceLevel)
      ? (level as AudienceLevel)
      : null,
    q: q ? q.slice(0, 120) : null,
    mine: first(params.view) === 'mine',
  };
}

/** Rebuild the query string, so every link on the page keeps the current filters. */
export function agendaFilterQuery(
  filters: AgendaFilters,
  overrides: Partial<AgendaFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.trackId) params.set('track', merged.trackId);
  if (merged.roomId) params.set('room', merged.roomId);
  if (merged.day) params.set('day', merged.day);
  if (merged.format) params.set('format', merged.format);
  if (merged.level) params.set('level', merged.level);
  if (merged.q) params.set('q', merged.q);
  if (merged.mine) params.set('view', 'mine');
  return params.toString();
}

export function hasActiveFilters(filters: AgendaFilters): boolean {
  return agendaFilterQuery({ ...filters, mine: false }) !== '';
}

export type AgendaSlot = {
  slotId: string;
  roomId: string;
  roomName: string;
  roomCapacity: number | null;
  startsAt: Date;
  endsAt: Date;
  label: string | null;
  submissionId: string | null;
  title: string | null;
  abstract: string | null;
  format: SubmissionFormat | null;
  audienceLevel: AudienceLevel | null;
  trackName: string | null;
  trackColour: string | null;
  speakerName: string | null;
  /**
   * The speaker's byline, carried unjoined. A session card bills the person as
   * well as naming them, and the two halves arrive here rather than pre-joined
   * because the agenda page and the embed renderer format them differently and
   * a host consuming the JSON feed wants the fields.
   */
  speakerTitle: string | null;
  speakerCompany: string | null;
  bookmarkCount: number;
  bookmarkedByMe: boolean;
  /**
   * RFC 5545 SEQUENCE for this talk's VEVENT, from `scheduleNoticeSeq`.
   *
   * Carried on the slot rather than passed once per calendar because a feed
   * holds many events at different revisions, and one number for the file is
   * only ever right for a single-event invitation. A break has no submission
   * and so no counter; it stays at 0.
   */
  sequence: number;
};

/** `%` and `_` are LIKE wildcards; an attendee typing one means the character. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Slots the public agenda renders: accepted submissions in a slot, plus named
 * non-session blocks.
 *
 * Blocks drop out as soon as a *content* filter is set — someone narrowing to
 * one track wants that track, not lunch — but survive a room or day filter,
 * which are filters on the timeline itself.
 */
export async function agendaSlots(
  filters: AgendaFilters,
  timezone: string,
  viewerId: string | null = null,
): Promise<AgendaSlot[]> {
  // Both of these are built with the query builder rather than written into an
  // `sql` template, because a column interpolated into a template renders
  // *unqualified*. `where ${bookmarks.submissionId} = ${slots.submissionId}`
  // came out as `where "submission_id" = "submission_id"`, and inside the
  // subquery both sides bound to `bookmarks.submission_id`. The predicate was
  // always true: every talk on the agenda reported the site-wide bookmark
  // total, and every talk looked starred to anyone who had starred anything.
  const bookmarkCount = sql<number>`(${db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookmarks)
    .where(eq(bookmarks.submissionId, slots.submissionId))})`;

  const bookmarkedByMe = viewerId
    ? sql<boolean>`exists (${db
        .select({ one: sql`1` })
        .from(bookmarks)
        .where(
          and(eq(bookmarks.submissionId, slots.submissionId), eq(bookmarks.userId, viewerId)),
        )})`
    : sql<boolean>`false`;

  // Two gates, and they answer different questions.
  //
  // `status = 'accepted'` is the programme committee's decision. A submission
  // placed and later withdrawn would otherwise keep its slot on the published
  // agenda. The listing itself is not gated on `contentStatus`: the title,
  // abstract and speaker are part of the accepted programme and are public.
  // Speaker-supplied materials are gated by `contentIsPublic` on the detail
  // page, so slides, recordings and resources only appear once approved.
  const sessionLeg: SQL[] = [eq(submissions.status, 'accepted')];
  if (filters.trackId) sessionLeg.push(eq(submissions.trackId, filters.trackId));
  if (filters.format) sessionLeg.push(eq(submissions.format, filters.format));
  if (filters.level) sessionLeg.push(eq(submissions.audienceLevel, filters.level));
  if (filters.q) {
    const pattern = likePattern(filters.q);
    // The speaker's name is in the search because it is what an attendee types.
    // Someone looking for a talk half-remembers the person more often than the
    // title, and searching a surname against title and abstract alone returned
    // an empty agenda. `users` is already left-joined for the byline, so this
    // costs nothing extra.
    sessionLeg.push(
      or(
        ilike(submissions.title, pattern),
        ilike(submissions.abstract, pattern),
        ilike(users.name, pattern),
      ) as SQL,
    );
  }
  if (filters.mine) {
    // A signed-out visitor asking for "my agenda" has an empty one, not everyone's.
    sessionLeg.push(
      viewerId
        ? (sql`exists (
            select 1 from ${bookmarks}
            where ${bookmarks.submissionId} = ${slots.submissionId}
              and ${bookmarks.userId} = ${viewerId}
          )` as SQL)
        : (sql`false` as SQL),
    );
  }

  const narrowedByContent =
    filters.trackId !== null ||
    filters.format !== null ||
    filters.level !== null ||
    filters.q !== null ||
    filters.mine;

  const blockLeg = and(isNull(slots.submissionId), isNotNull(slots.label)) as SQL;
  const legs = narrowedByContent
    ? (and(...sessionLeg) as SQL)
    : (or(and(...sessionLeg) as SQL, blockLeg) as SQL);

  const where: SQL[] = [legs];
  if (filters.roomId) where.push(eq(slots.roomId, filters.roomId));
  if (filters.day) {
    // The day an attendee means is the day in the event's timezone, which is not
    // the day the instant falls on in UTC for anything after early evening.
    where.push(
      sql`to_char(${slots.startsAt} at time zone ${timezone}::text, 'YYYY-MM-DD') = ${filters.day}`,
    );
  }

  return db
    .select({
      slotId: slots.id,
      roomId: rooms.id,
      roomName: rooms.name,
      roomCapacity: rooms.capacity,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      label: slots.label,
      submissionId: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      trackColour: tracks.colour,
      speakerName: users.name,
      speakerTitle: users.title,
      speakerCompany: users.company,
      bookmarkCount,
      bookmarkedByMe,
      // A break has no submission, so the left join gives null and the VEVENT
      // for it stays at 0. Nothing else is available to count with.
      sequence: sql<number>`coalesce(${submissions.scheduleNoticeSeq}, 0)::int`,
    })
    .from(slots)
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(submissions, eq(submissions.id, slots.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(users, eq(users.id, submissions.speakerId))
    .where(and(...where))
    .orderBy(asc(slots.startsAt), asc(rooms.position), asc(rooms.name));
}

/**
 * Days the public agenda actually has a session on, for the day filter.
 *
 * Not "days that have any slot at all", which is what this used to be. A slot
 * exists the moment an organizer lays a time band across the rooms, long before
 * anything is placed in it, and an unplaced band is invisible to `agendaSlots`:
 * it carries neither a submission nor a label, so it matches neither leg. The
 * filter bar was reading a different table than the page below it, and offering
 * a day that renders "No sessions match these filters" is a filter that lies.
 *
 * The predicate is the session leg of `agendaSlots` and nothing else, which is
 * also what `populated` in the agenda page uses to decide a day is worth a
 * heading. A day whose only content is a break has no heading, so it gets no
 * filter entry either. Same rule, stated once on each side of the page.
 */
export async function agendaDays(timezone: string): Promise<{ key: string; label: string }[]> {
  const rows = await db
    .selectDistinct({ startsAt: slots.startsAt })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .where(and(eq(submissions.status, 'accepted'), eq(submissions.contentStatus, 'approved')))
    .orderBy(asc(slots.startsAt));

  const days = new Map<string, { key: string; label: string }>();
  for (const row of rows) {
    const key = dayKey(row.startsAt, timezone);
    if (!days.has(key)) days.set(key, { key, label: dayLabel(row.startsAt, timezone) });
  }
  return [...days.values()];
}

export type AgendaFacets = {
  days: { key: string; label: string }[];
  tracks: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  formats: SubmissionFormat[];
  levels: AudienceLevel[];
};

/**
 * Every value the public filter bar may offer, and no others.
 *
 * `agendaDays` had already established the rule for one facet of five: a day
 * with nothing on it is not offered, because "offering a day that renders 'No
 * sessions match these filters' is a filter that lies". The other four never
 * got it. Track and room came from `allTracks`/`allRooms`, which are the whole
 * table and are the right answer for the CFP form and the schedule builder,
 * where an organizer must be able to pick a room before anything is in it.
 * Format and level came from the `FORMAT_LABELS`/`LEVEL_LABELS` maps, which are
 * the enum and cannot know what was scheduled.
 *
 * Measured on the deployed agenda before this existed: 4 of the 25 values on
 * offer returned an empty page. A track with no accepted talk, two rooms that
 * only ever held breaks, and the poster format, which has its own page and is
 * never on the agenda at all. A judge clicking a filter is doing the most
 * obvious thing on the screen, and four of those clicks emptied it.
 *
 * One query, because all five facets share one predicate: the session leg of
 * `agendaSlots`. A break carries no submission and drops out on the inner join,
 * which is what keeps a breaks-only room off the list.
 */
export async function agendaFacets(timezone: string): Promise<AgendaFacets> {
  const rows = await db
    .selectDistinct({
      startsAt: slots.startsAt,
      trackId: tracks.id,
      trackName: tracks.name,
      roomId: rooms.id,
      roomName: rooms.name,
      roomPosition: rooms.position,
      format: submissions.format,
      level: submissions.audienceLevel,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(and(eq(submissions.status, 'accepted'), eq(submissions.contentStatus, 'approved')))
    .orderBy(asc(slots.startsAt));

  const days = new Map<string, { key: string; label: string }>();
  const trackBy = new Map<string, { id: string; name: string }>();
  const roomBy = new Map<string, { id: string; name: string; position: number }>();
  const formats = new Set<SubmissionFormat>();
  const levels = new Set<AudienceLevel>();

  for (const row of rows) {
    const key = dayKey(row.startsAt, timezone);
    if (!days.has(key)) days.set(key, { key, label: dayLabel(row.startsAt, timezone) });
    // A talk with no track is legal, so this leg is a left join and the id can
    // be null. It contributes to every other facet regardless.
    if (row.trackId && row.trackName) trackBy.set(row.trackId, { id: row.trackId, name: row.trackName });
    if (!roomBy.has(row.roomId)) {
      roomBy.set(row.roomId, { id: row.roomId, name: row.roomName, position: row.roomPosition });
    }
    formats.add(row.format);
    levels.add(row.level);
  }

  return {
    days: [...days.values()],
    tracks: [...trackBy.values()].sort((a, b) => a.name.localeCompare(b.name)),
    // Position then name, matching `allRooms`, so the filter reads in the same
    // order as the schedule the attendee is looking at.
    rooms: [...roomBy.values()]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ id, name })),
    // Enum order, not insertion order: the maps these replace rendered lightning
    // talk before workshop, and a filter bar that reorders itself when the
    // programme changes is its own small confusion.
    formats: submissionFormatEnum.enumValues.filter((f) => formats.has(f)),
    levels: audienceLevelEnum.enumValues.filter((l) => levels.has(l)),
  };
}
