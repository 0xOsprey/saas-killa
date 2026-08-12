import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { bookmarks, rooms, slots, speakerAvailability, submissions, users } from '@/db/schema';
import type { ContentStatus } from '@/db/schema';
import { FORMAT_MINUTES } from '@/lib/format';

/**
 * The half-open overlap test, in milliseconds, and the only definition of it in
 * this file. A talk ending at 14:00 and the next starting at 14:00 are back to
 * back, not overlapping.
 *
 * Exported because the auto-scheduler has to ask this before it writes rather
 * than after. Two functions that each decide what "at the same time" means is
 * how a placer comes to disagree with the banner that grades its work.
 */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export type SpeakerBooking = { speakerId: string; startsAt: Date; endsAt: Date };

/**
 * Every placement on the grid, as the interval its speaker is spoken for.
 *
 * The slot's own interval, not the format-extended one `roomConflicts` uses. It
 * has to be the interval `speakerConflicts` tests, because this is what the
 * auto-scheduler consults before placing, and a placer working to a stricter
 * rule than the banner would refuse slots the screen says are free.
 */
export async function speakerBookings(): Promise<SpeakerBooking[]> {
  return db
    .select({
      speakerId: submissions.speakerId,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId));
}

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

export type RoomConflict = {
  roomId: string;
  roomName: string;
  slots: { slotId: string; title: string; startsAt: Date; runsUntil: Date }[];
};

/**
 * The other half of the double-booking rule: one room cannot run two talks at
 * once either.
 *
 * What that means here follows from the table. `slots` is unique on (room,
 * start), so two talks can never share one box, and dropping onto an occupied
 * box moves the sitting talk out rather than stacking on it. Every overlap this
 * can find is therefore between two different slots in the same room, and it
 * arrives two ways.
 *
 * Bands are added at any start with any length, so a 90 minute band at 10:00 and
 * a 45 minute band at 10:30 are separate rows in every room and both take a
 * talk. And a talk is as long as its format says, not as long as the box it was
 * dropped into, so a 90 minute workshop in a 45 minute band runs into the next
 * band in that room even though the grid draws it inside one cell.
 *
 * Effective end is therefore `max(slot end, start + format length)`. A talk
 * shorter than its band still holds the whole band, because the band is what the
 * programme publishes and what the next talk waits for; only running over the
 * end is a claim on somebody else's time.
 *
 * The overlap is computed in TypeScript rather than pushed into SQL, unlike
 * `speakerConflicts`, because a format's length lives in `FORMAT_MINUTES`. A
 * CASE expression restating those five numbers would be a second copy of how
 * long a talk is, free to drift from the one the agenda, the `.ics` feeds and
 * the Accelevents push all render from.
 *
 * Reported, never blocked, like every other warning on this grid.
 */
export async function roomConflicts(): Promise<RoomConflict[]> {
  const placed = await db
    .select({
      slotId: slots.id,
      roomId: slots.roomId,
      roomName: rooms.name,
      title: submissions.title,
      format: submissions.format,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .orderBy(asc(rooms.name), asc(slots.startsAt));

  type Placement = (typeof placed)[number] & { runsUntil: number };

  const byRoom = new Map<string, Placement[]>();
  for (const row of placed) {
    const placement: Placement = {
      ...row,
      runsUntil: Math.max(
        row.endsAt.getTime(),
        row.startsAt.getTime() + FORMAT_MINUTES[row.format] * 60_000,
      ),
    };
    const inRoom = byRoom.get(row.roomId);
    if (inRoom) inRoom.push(placement);
    else byRoom.set(row.roomId, [placement]);
  }

  const conflicts: RoomConflict[] = [];
  for (const inRoom of byRoom.values()) {
    // Pair by pair rather than a sweep. One room holds a day's worth of bands,
    // so the quadratic is a rounding error, and every talk that overlaps any
    // other has to be named in the warning rather than only the later one.
    const overlapping = inRoom.filter((row) =>
      inRoom.some(
        (other) =>
          other.slotId !== row.slotId &&
          overlaps(row.startsAt.getTime(), row.runsUntil, other.startsAt.getTime(), other.runsUntil),
      ),
    );
    const first = overlapping[0];
    if (!first) continue;
    conflicts.push({
      roomId: first.roomId,
      roomName: first.roomName,
      slots: overlapping.map((row) => ({
        slotId: row.slotId,
        title: row.title,
        startsAt: row.startsAt,
        runsUntil: new Date(row.runsUntil),
      })),
    });
  }
  return conflicts;
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

export type DeclinedPlacement = {
  slotId: string;
  speakerName: string | null;
  speakerEmail: string;
  title: string;
  roomName: string;
  startsAt: Date;
};

/**
 * A talk still on the grid whose speaker has said they cannot present it.
 *
 * Alongside the other two warnings rather than in a queue of its own, because
 * this is the screen where the fact costs something: the slot is the thing that
 * has to change, and an organizer looking at the grid is the person who can
 * change it. The decline itself also mails them, which is the half that reaches
 * somebody who is not on this page.
 *
 * Reported, never blocked, matching the others. A speaker who declines and then
 * finds a co-presenter has changed nothing an organizer needs to undo, and the
 * warning clears by itself if they confirm again.
 *
 * Withdrawn talks are excluded, because they have their own warning below. This
 * banner tells the organizer that "nothing has been withdrawn", and for a
 * speaker who declined and then withdrew that was false in the reassuring
 * direction: the one screen that could have shown the hole in the programme was
 * denying there was one.
 */
export async function declinedPlacements(): Promise<DeclinedPlacement[]> {
  return db
    .select({
      slotId: slots.id,
      speakerName: users.name,
      speakerEmail: users.email,
      title: submissions.title,
      roomName: rooms.name,
      startsAt: slots.startsAt,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .where(and(isNotNull(submissions.speakerDeclinedAt), ne(submissions.status, 'withdrawn')))
    .orderBy(asc(slots.startsAt), asc(users.email));
}

export type WithdrawnPlacement = DeclinedPlacement;

/**
 * A talk still holding a slot that its speaker has withdrawn.
 *
 * Withdrawing does not clear the placement, deliberately: the grid belongs to
 * the organizer, and an app that silently emptied a box would take a decision
 * away from the only person who can fill it. What it must not do is stay quiet.
 * It used to — the talk sat in its box looking scheduled while `/agenda` and the
 * calendar feeds had already dropped it, so the two views of one programme
 * disagreed and nobody was told.
 *
 * Separate from the declined warning because the remedy differs. A decline can
 * resolve itself when a co-presenter steps in. A withdrawal will not, and the
 * slot is empty whatever the grid draws in it.
 */
export async function withdrawnPlacements(): Promise<WithdrawnPlacement[]> {
  return db
    .select({
      slotId: slots.id,
      speakerName: users.name,
      speakerEmail: users.email,
      title: submissions.title,
      roomName: rooms.name,
      startsAt: slots.startsAt,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .where(eq(submissions.status, 'withdrawn'))
    .orderBy(asc(slots.startsAt), asc(users.email));
}

export type UnapprovedPlacement = {
  slotId: string;
  submissionId: string;
  title: string;
  roomName: string;
  startsAt: Date;
  contentStatus: ContentStatus;
};

/**
 * A talk on the grid whose materials are not public yet.
 *
 * `agendaSlots` in `src/lib/agenda-filters.ts` lists every accepted, placed
 * submission. The title, abstract and speaker are public; speaker-supplied
 * materials are gated by `contentIsPublic` on the detail page. So an organizer
 * can drop a talk into a box, press Publish, open `/agenda` and find the session
 * there, but the slides/recording/resources are not visible until the content is
 * approved. This warning exists so an organizer does not wonder why a session's
 * materials are missing.
 *
 * The content leg is the only one reported here. A withdrawn or unaccepted talk
 * is not placed, or is already warned about elsewhere.
 *
 * `contentStatus` rides along because draft and pending are different problems
 * wearing the same absence. Draft means the speaker has not sent it for review;
 * pending means they have and it is sitting with an organizer. Only one of those
 * is the organizer's move to make.
 */
export async function unapprovedPlacements(): Promise<UnapprovedPlacement[]> {
  return db
    .select({
      slotId: slots.id,
      submissionId: submissions.id,
      title: submissions.title,
      roomName: rooms.name,
      startsAt: slots.startsAt,
      contentStatus: submissions.contentStatus,
    })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .where(and(eq(submissions.status, 'accepted'), ne(submissions.contentStatus, 'approved')))
    .orderBy(asc(slots.startsAt), asc(submissions.title));
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
