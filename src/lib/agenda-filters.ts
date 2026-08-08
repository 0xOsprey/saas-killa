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
  bookmarkCount: number;
  bookmarkedByMe: boolean;
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
  const bookmarkCount = sql<number>`(
    select count(*) from ${bookmarks}
    where ${bookmarks.submissionId} = ${slots.submissionId}
  )::int`;

  const bookmarkedByMe = viewerId
    ? sql<boolean>`exists (
        select 1 from ${bookmarks}
        where ${bookmarks.submissionId} = ${slots.submissionId}
          and ${bookmarks.userId} = ${viewerId}
      )`
    : sql<boolean>`false`;

  // Only accepted work is public. A submission placed and later withdrawn would
  // otherwise keep its slot on the published agenda.
  const sessionLeg: SQL[] = [eq(submissions.status, 'accepted')];
  if (filters.trackId) sessionLeg.push(eq(submissions.trackId, filters.trackId));
  if (filters.format) sessionLeg.push(eq(submissions.format, filters.format));
  if (filters.level) sessionLeg.push(eq(submissions.audienceLevel, filters.level));
  if (filters.q) {
    const pattern = likePattern(filters.q);
    sessionLeg.push(
      or(ilike(submissions.title, pattern), ilike(submissions.abstract, pattern)) as SQL,
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
      bookmarkCount,
      bookmarkedByMe,
    })
    .from(slots)
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(submissions, eq(submissions.id, slots.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(users, eq(users.id, submissions.speakerId))
    .where(and(...where))
    .orderBy(asc(slots.startsAt), asc(rooms.position), asc(rooms.name));
}

/** Days that have any slot at all, for the day filter. */
export async function agendaDays(timezone: string): Promise<{ key: string; label: string }[]> {
  const rows = await db
    .selectDistinct({ startsAt: slots.startsAt })
    .from(slots)
    .orderBy(asc(slots.startsAt));

  const days = new Map<string, { key: string; label: string }>();
  for (const row of rows) {
    const key = dayKey(row.startsAt, timezone);
    if (!days.has(key)) days.set(key, { key, label: dayLabel(row.startsAt, timezone) });
  }
  return [...days.values()];
}
