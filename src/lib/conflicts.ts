import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { rooms, slots, submissions, users } from '@/db/schema';

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
