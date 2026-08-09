import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { rooms, slots, submissions, tracks, users } from '@/db/schema';
import type { AgendaSlot } from './agenda-filters';
import { buildCalendar, type CalendarMethod, type CalendarParty } from './ics';

/**
 * A speaker's own talk as a calendar invitation.
 *
 * Deliberately built from the same `AgendaSlot` shape and the same
 * `toVevents` the public agenda exports use, rather than from a second
 * hand-written VEVENT. The UID is derived from the submission id there, and
 * that stability is the entire mechanism by which a schedule change updates
 * the entry already in the speaker's calendar instead of adding a second one
 * an hour after the first.
 */

export type Placement = {
  submissionId: string;
  speakerId: string;
  speakerName: string | null;
  speakerEmail: string;
  title: string;
  /** Null once the talk has been taken off the grid. */
  slot: AgendaSlot | null;
  /** `<startsAt ISO>|<roomId>`, or 'unscheduled'. Compared against `scheduleNoticeKey`. */
  key: string;
  noticeKey: string | null;
  noticeSeq: number;
};

export const UNSCHEDULED = 'unscheduled';

/**
 * The key format `submissions.scheduleNoticeKey` stores. Exported and typed on
 * the two fields it actually reads, so the speaker portal can build the same key
 * from a row that carries a start and a room id without inventing a second
 * spelling of the format. A key written under one spelling and compared under
 * another would report every talk as moved.
 */
export function placementKey(slot: { startsAt: Date; roomId: string } | null): string {
  return slot ? `${slot.startsAt.toISOString()}|${slot.roomId}` : UNSCHEDULED;
}

/**
 * Every accepted submission, with its slot when it has one.
 *
 * A left join rather than an inner one, because a talk that was scheduled,
 * emailed about, and then pulled off the grid is exactly the case a schedule
 * notice most needs to cover, and an inner join drops it.
 */
export async function placements(ids?: string[]): Promise<Placement[]> {
  const where = [eq(submissions.status, 'accepted')];
  if (ids) where.push(inArray(submissions.id, ids));

  const rows = await db
    .select({
      submissionId: submissions.id,
      speakerId: submissions.speakerId,
      speakerName: users.name,
      speakerEmail: users.email,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      trackColour: tracks.colour,
      noticeKey: submissions.scheduleNoticeKey,
      noticeSeq: submissions.scheduleNoticeSeq,
      slotId: slots.id,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      roomId: rooms.id,
      roomName: rooms.name,
      roomCapacity: rooms.capacity,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(and(...where))
    .orderBy(asc(slots.startsAt), asc(submissions.title));

  return rows.map((row) => {
    const slot: AgendaSlot | null =
      row.slotId && row.startsAt && row.endsAt && row.roomId
        ? {
            slotId: row.slotId,
            roomId: row.roomId,
            roomName: row.roomName ?? '',
            roomCapacity: row.roomCapacity,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            label: null,
            submissionId: row.submissionId,
            title: row.title,
            abstract: row.abstract,
            format: row.format,
            audienceLevel: row.audienceLevel,
            trackName: row.trackName,
            trackColour: row.trackColour,
            speakerName: row.speakerName,
            // Nobody bookmarks their own talk into an invitation.
            bookmarkCount: 0,
            bookmarkedByMe: false,
            // The stored counter. Every caller on this path passes its own
            // `sequence` to `buildCalendar`, which overrides this, because an
            // invitation has to send the next value rather than the one on
            // file. It is filled in so the shape is honest, not because it is
            // read here.
            sequence: row.noticeSeq,
          }
        : null;

    return {
      submissionId: row.submissionId,
      speakerId: row.speakerId,
      speakerName: row.speakerName,
      speakerEmail: row.speakerEmail,
      title: row.title,
      slot,
      key: placementKey(slot),
      noticeKey: row.noticeKey,
      noticeSeq: row.noticeSeq,
    };
  });
}

/** One placement by submission id, or null when it is not an accepted talk. */
export async function placementFor(submissionId: string): Promise<Placement | null> {
  const [row] = await placements([submissionId]);
  return row ?? null;
}

/**
 * The invitation for one placement.
 *
 * `sequence` is the caller's next value, not the stored one: RFC 5545 says a
 * client applies an update only when the sequence has risen, so sending the
 * number already on file is the same as sending nothing.
 */
export function inviteFor(
  placement: Placement,
  options: { eventName: string; organizer: CalendarParty; sequence: number; method?: CalendarMethod },
): string | null {
  if (!placement.slot) return null;
  return buildCalendar([placement.slot], {
    calendarName: options.eventName,
    includeBlocks: false,
    method: options.method ?? 'REQUEST',
    sequence: options.sequence,
    organizer: options.organizer,
    attendee: { name: placement.speakerName, email: placement.speakerEmail },
  });
}

/**
 * The cancellation for a talk that has come off the grid.
 *
 * Built from the placement the speaker was last told about rather than from the
 * current row, which no longer has a time at all. Without the old DTSTART the
 * VEVENT is not a valid cancellation and the stale entry survives.
 */
export function cancellationFor(
  placement: Placement,
  lastNotified: AgendaSlot,
  options: { eventName: string; organizer: CalendarParty; sequence: number },
): string {
  return buildCalendar([lastNotified], {
    calendarName: options.eventName,
    includeBlocks: false,
    method: 'CANCEL',
    sequence: options.sequence,
    organizer: options.organizer,
    attendee: { name: placement.speakerName, email: placement.speakerEmail },
  });
}

/**
 * The slot a `scheduleNoticeKey` names, rebuilt well enough to cancel.
 *
 * A cancellation needs a UID, a start and an end. The key carries the start and
 * the room; the end comes from the slot row if that band still exists, and
 * falls back to an hour when the whole band was deleted, which is the case that
 * produced the cancellation in the first place.
 */
export async function slotFromNoticeKey(
  placement: Placement,
  key: string,
): Promise<AgendaSlot | null> {
  if (key === UNSCHEDULED) return null;
  const [startsAtIso, roomId] = key.split('|');
  if (!startsAtIso || !roomId) return null;
  const startsAt = new Date(startsAtIso);
  if (Number.isNaN(startsAt.getTime())) return null;

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  const [band] = await db
    .select({ endsAt: slots.endsAt })
    .from(slots)
    .where(and(eq(slots.roomId, roomId), eq(slots.startsAt, startsAt), isNotNull(slots.id)))
    .limit(1);

  return {
    slotId: `${placement.submissionId}-cancelled`,
    roomId,
    roomName: room?.name ?? '',
    roomCapacity: room?.capacity ?? null,
    startsAt,
    endsAt: band?.endsAt ?? new Date(startsAt.getTime() + 60 * 60_000),
    label: null,
    submissionId: placement.submissionId,
    title: placement.title,
    abstract: null,
    format: null,
    audienceLevel: null,
    trackName: null,
    trackColour: null,
    speakerName: placement.speakerName,
    bookmarkCount: 0,
    bookmarkedByMe: false,
    // `cancellationFor` passes the next sequence explicitly, which overrides
    // this. Present so the shape is complete, not because it is read.
    sequence: placement.noticeSeq,
  };
}
