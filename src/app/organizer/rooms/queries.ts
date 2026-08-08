import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { rooms, slots, submissions, tracks } from '@/db/schema';

/**
 * Reads for the rooms and tracks screen. Deliberately not in `actions.ts`:
 * everything exported from a `'use server'` module is a callable endpoint, and
 * a read helper there would be a door with no lock on it.
 */

export type RoomRow = {
  id: string;
  name: string;
  capacity: number | null;
  position: number;
  slotCount: number;
  placedCount: number;
};

/** Rooms with what a delete would take with them: `slots.roomId` cascades. */
export async function roomsWithUsage(): Promise<RoomRow[]> {
  return db
    .select({
      id: rooms.id,
      name: rooms.name,
      capacity: rooms.capacity,
      position: rooms.position,
      slotCount: sql<number>`count(${slots.id})::int`,
      placedCount: sql<number>`count(${slots.submissionId})::int`,
    })
    .from(rooms)
    .leftJoin(slots, eq(slots.roomId, rooms.id))
    .groupBy(rooms.id)
    .orderBy(asc(rooms.position), asc(rooms.name));
}

export type TrackRow = {
  id: string;
  name: string;
  colour: string;
  submissionCount: number;
};

/** Tracks with the proposals that would be left untracked by a delete. */
export async function tracksWithUsage(): Promise<TrackRow[]> {
  return db
    .select({
      id: tracks.id,
      name: tracks.name,
      colour: tracks.colour,
      submissionCount: sql<number>`count(${submissions.id})::int`,
    })
    .from(tracks)
    .leftJoin(submissions, eq(submissions.trackId, tracks.id))
    .groupBy(tracks.id)
    .orderBy(asc(tracks.name));
}

/** The talks a room delete would unplace, named so the confirmation can list them. */
export async function roomPlacements(roomId: string): Promise<string[]> {
  const rows = await db
    .select({ title: submissions.title })
    .from(slots)
    .innerJoin(submissions, eq(submissions.id, slots.submissionId))
    .where(eq(slots.roomId, roomId))
    .orderBy(asc(slots.startsAt));

  return rows.map((row) => row.title);
}
