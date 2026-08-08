import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { bookmarks, rooms, slots, speakerAvailability, submissions, users } from '@/db/schema';

export type SpeakerConflict = {
  speakerId: string;
  speakerName: string | null;
  speakerEmail: string;
  slots: { slotId: string; roomName: string; startsAt: Date; title: string }[];
};

/**
 * The one scheduling rule this app enforces: a speaker cannot be in two rooms
 * at once. Overlap is computed on the half-open interval [startsAt, endsAt), so
 * a talk ending at 14:00 and the next starting at 14:00 is not a conflict.
 *
 * This is reported, never blocked. An organizer mid-rearrangement routinely
 * passes through an invalid state, and refusing the drop would make the grid
 * unusable; the warning persists until it is resolved.
 */
export async function speakerConflicts(): Promise<SpeakerConflict[]> {
  const overlapping = await db
    .select({
      speakerId: submissions.speakerId,
      speakerName: users.name,
      speakerEmail: users.email,
      slotId: slots.id,
      roomName: rooms.name,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      title: submissions.title,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .where(
      sql`exists (
        select 1
        from ${slots} other
        join ${submissions} other_sub on other_sub.id = other.submission_id
        where other.id <> ${slots.id}
          and other_sub.speaker_id = ${submissions.speakerId}
          and other.starts_at < ${slots.endsAt}
          and other.ends_at > ${slots.startsAt}
      )`,
    )
    .orderBy(users.email, slots.startsAt);

  const bySpeaker = new Map<string, SpeakerConflict>();
  for (const row of overlapping) {
    const existing = bySpeaker.get(row.speakerId);
    const entry = {
      slotId: row.slotId,
      roomName: row.roomName,
      startsAt: row.startsAt,
      title: row.title,
    };
    if (existing) {
      existing.slots.push(entry);
    } else {
      bySpeaker.set(row.speakerId, {
        speakerId: row.speakerId,
        speakerName: row.speakerName,
        speakerEmail: row.speakerEmail,
        slots: [entry],
      });
    }
  }
  return [...bySpeaker.values()];
}

export type AvailabilityConflict = {
  slotId: string;
  speakerName: string | null;
  speakerEmail: string;
  title: string;
  roomName: string;
  startsAt: Date;
  note: string | null;
};

/**
 * A talk placed inside a window its speaker declared unavailable. Same overlap
 * arithmetic and same posture as `speakerConflicts`: reported, never blocked,
 * because an organizer often knows something the declaration does not.
 *
 * Only `submissions.speakerId` is checked. A co-presenter listed in
 * `submission_authors` who is not the filing account does not raise this flag;
 * their availability is a separate signal nobody records today.
 *
 * An empty `speaker_availability` table simply produces no rows: the join is an
 * inner one, so the absence of any declaration is the absence of any conflict.
 */
export async function availabilityConflicts(): Promise<AvailabilityConflict[]> {
  return db
    .select({
      slotId: slots.id,
      speakerName: users.name,
      speakerEmail: users.email,
      title: submissions.title,
      roomName: rooms.name,
      startsAt: slots.startsAt,
      note: speakerAvailability.note,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .innerJoin(
      speakerAvailability,
      and(
        eq(speakerAvailability.userId, submissions.speakerId),
        // Half-open [startsAt, endsAt), matching the double-booking rule: a talk
        // ending exactly when a declared window opens is not a conflict.
        sql`${speakerAvailability.startsAt} < ${slots.endsAt}`,
        sql`${speakerAvailability.endsAt} > ${slots.startsAt}`,
      ),
    )
    .orderBy(asc(slots.startsAt), asc(users.email));
}

export type CapacityWarning = {
  slotId: string;
  title: string;
  roomName: string;
  capacity: number;
  bookmarks: number;
};

/**
 * A talk placed in a room smaller than the interest in it. Bookmarks are the
 * only demand signal this app has — there is no registration and no ticketing —
 * so the comparison is deliberately "more people starred it than the room
 * seats", not a prediction of attendance.
 *
 * Rooms with no capacity recorded raise nothing rather than raising everything.
 */
export async function capacityWarnings(): Promise<CapacityWarning[]> {
  return db
    .select({
      slotId: slots.id,
      title: submissions.title,
      roomName: rooms.name,
      capacity: sql<number>`${rooms.capacity}::int`,
      bookmarks: sql<number>`count(${bookmarks.userId})::int`,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(bookmarks, eq(bookmarks.submissionId, submissions.id))
    .where(isNotNull(rooms.capacity))
    .groupBy(slots.id, submissions.title, rooms.name, rooms.capacity)
    .having(sql`count(${bookmarks.userId}) > ${rooms.capacity}`)
    .orderBy(asc(slots.startsAt));
}
