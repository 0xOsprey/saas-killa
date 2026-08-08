import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { events, reviews, rooms, slots, submissions, tracks, users } from '@/db/schema';
import type { AudienceLevel, Event, SubmissionFormat, SubmissionStatus } from '@/db/schema';

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

/**
 * The organizer view. Unlike the review queue this one carries speaker identity
 * and average score, because deciding is exactly where both are needed. Sorted
 * by score descending so the strongest proposals are at the top of the page.
 */
export async function organizerSubmissions(): Promise<OrganizerRow[]> {
  return db
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
      averageScore: sql<number | null>`avg(${reviews.score})::float`,
      decisionEmailedAt: submissions.decisionEmailedAt,
      scheduled: sql<boolean>`bool_or(${slots.id} is not null)`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .groupBy(submissions.id, tracks.name, users.name, users.email)
    .orderBy(sql`avg(${reviews.score}) desc nulls last`, asc(submissions.createdAt));
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
      roomName: rooms.name,
      speakerConfirmedAt: submissions.speakerConfirmedAt,
      slidesUrl: submissions.slidesUrl,
      recordingUrl: submissions.recordingUrl,
      resourcesNote: submissions.resourcesNote,
      posterUrl: submissions.posterUrl,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(eq(submissions.speakerId, speakerId))
    .orderBy(asc(submissions.createdAt));
}

export async function allTracks() {
  return db.select().from(tracks).orderBy(asc(tracks.name));
}

export async function allRooms() {
  return db.select().from(rooms).orderBy(asc(rooms.position), asc(rooms.name));
}
