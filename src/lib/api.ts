import { and, asc, eq, ilike, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { rooms, slots, submissions, tracks, users } from '@/db/schema';
import type { Event } from '@/db/schema';
import { getEvent } from './queries';
import { speakerDirectory, speakerProfile } from './speakers';
import { env } from './env';

function absoluteUrl(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = env().APP_URL;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

export const API_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
} as const;

export const API_CACHE = 'public, s-maxage=180, max-age=0, must-revalidate';

export type Pagination = {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalResults: number;
};

export type ApiList<T> = {
  data: T[];
  pagination: Pagination;
};

export function parsePagination(url: URL) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const rawSize = parseInt(url.searchParams.get('pageSize') ?? '25', 10) || 25;
  const pageSize = Math.min(100, Math.max(1, rawSize));
  return { page, pageSize };
}

export function paginate<T>(items: T[], page: number, pageSize: number): ApiList<T> {
  const totalResults = items.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, pagination: { currentPage, pageSize, totalPages, totalResults } };
}

export function apiResponse<T>(payload: T, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...API_CORS,
      'cache-control': API_CACHE,
    },
  });
}

export function apiError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...API_CORS,
      'cache-control': 'no-store',
    },
  });
}

export function apiOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: API_CORS,
  });
}

export async function publicEvent(): Promise<{
  id: string;
  name: string;
  tagline: string | null;
  timezone: string;
  startsOn: string;
  endsOn: string;
  cfpOpensAt: string | null;
  cfpClosesAt: string | null;
  agendaPublished: boolean;
  url: string;
}> {
  const event = await getEvent();
  return shapeEvent(event);
}

function shapeEvent(event: Event) {
  return {
    id: event.id,
    name: event.name,
    tagline: event.tagline,
    timezone: event.timezone,
    startsOn: event.startsOn.toISOString(),
    endsOn: event.endsOn.toISOString(),
    cfpOpensAt: event.cfpOpensAt?.toISOString() ?? null,
    cfpClosesAt: event.cfpClosesAt?.toISOString() ?? null,
    agendaPublished: event.agendaPublished,
    url: `${env().APP_URL}/`,
  };
}

export type PublicSession = {
  id: string;
  eventId: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  status: string;
  contentStatus: string;
  track: { id: string; name: string | null; colour: string | null } | null;
  room: { id: string; name: string | null; capacity: number | null } | null;
  startsAt: string | null;
  endsAt: string | null;
  speaker: { id: string; name: string | null; title: string | null; company: string | null; bio: string | null; headshotUrl: string | null } | null;
  isAbstract: boolean;
};

export async function publicSessionList(q?: string, trackId?: string | null, roomId?: string | null): Promise<PublicSession[]> {
  const event = await getEvent();

  const conditions: (SQL | undefined)[] = [eq(submissions.status, 'accepted')];
  if (trackId) conditions.push(eq(submissions.trackId, trackId));
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(
        ilike(submissions.title, pattern),
        ilike(submissions.abstract, pattern),
        and(isNotNull(users.name), ilike(users.name, pattern)),
      ) as SQL,
    );
  }

  const rows = await db
    .select({
      submission: submissions,
      track: tracks,
      room: rooms,
      slot: slots,
      speaker: users,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(and(...conditions))
    .orderBy(asc(submissions.title));

  let sessions = rows.map((r) => shapeSession(r, event.id));
  if (roomId) sessions = sessions.filter((s) => s.room?.id === roomId || s.isAbstract);
  return sessions;
}

export async function publicSessionById(id: string): Promise<PublicSession | null> {
  const event = await getEvent();
  const row = await db
    .select({
      submission: submissions,
      track: tracks,
      room: rooms,
      slot: slots,
      speaker: users,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(eq(submissions.id, id))
    .limit(1);
  if (!row[0]) return null;
  if (row[0].submission.status !== 'accepted') return null;
  return shapeSession(row[0], event.id);
}

function shapeSession(
  row: {
    submission: typeof submissions.$inferSelect;
    track: typeof tracks.$inferSelect | null;
    room: typeof rooms.$inferSelect | null;
    slot: typeof slots.$inferSelect | null;
    speaker: typeof users.$inferSelect | null;
  },
  eventId: string,
): PublicSession {
  return {
    id: row.submission.id,
    eventId,
    title: row.submission.title,
    abstract: row.submission.abstract,
    format: row.submission.format,
    level: row.submission.audienceLevel,
    status: row.submission.status,
    contentStatus: row.submission.contentStatus,
    track: row.track ? { id: row.track.id, name: row.track.name, colour: row.track.colour } : null,
    room: row.room ? { id: row.room.id, name: row.room.name, capacity: row.room.capacity } : null,
    startsAt: row.slot?.startsAt?.toISOString() ?? null,
    endsAt: row.slot?.endsAt?.toISOString() ?? null,
    speaker: row.speaker
      ? {
          id: row.speaker.id,
          name: row.speaker.name,
          title: row.speaker.title,
          company: row.speaker.company,
          bio: row.speaker.bio,
          headshotUrl: absoluteUrl(row.speaker.headshotUrl),
        }
      : null,
    isAbstract: !row.slot,
  };
}

export type PublicSpeaker = {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  headshotUrl: string | null;
  acceptedCount: number;
  tracks: string[];
  keywords: string[];
};

export async function publicSpeakerList(q?: string, trackId?: string | null): Promise<PublicSpeaker[]> {
  const rows = await speakerDirectory({ q, trackId: trackId ?? undefined });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    title: r.title,
    company: r.company,
    bio: r.bio,
    headshotUrl: absoluteUrl(r.headshotUrl),
    acceptedCount: r.acceptedCount,
    tracks: r.trackNames,
    keywords: r.keywords,
  }));
}

export type PublicSpeakerDetail = {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  headshotUrl: string | null;
  sessions: { id: string; title: string; format: string; trackName: string | null; trackColour: string | null; startsAt: string | null; roomName: string | null }[];
};

export async function publicSpeakerById(id: string): Promise<PublicSpeakerDetail | null> {
  const profile = await speakerProfile(id);
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    title: profile.title,
    company: profile.company,
    bio: profile.bio,
    headshotUrl: absoluteUrl(profile.headshotUrl),
    sessions: profile.acceptedSubmissions.map((s) => ({
      id: s.id,
      title: s.title,
      format: s.format,
      trackName: s.trackName,
      trackColour: s.trackColour,
      startsAt: s.startsAt?.toISOString() ?? null,
      roomName: s.roomName,
    })),
  };
}
