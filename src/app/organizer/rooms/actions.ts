'use server';

import { asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { rooms, tracks } from '@/db/schema';
import { requireRole } from '@/lib/auth';

function revalidateRooms() {
  revalidatePath('/organizer/rooms');
  revalidatePath('/organizer/schedule');
  revalidatePath('/agenda');
}

/** An empty capacity field means "not recorded", which is not the same as zero. */
const capacity = z.preprocess(
  (value) => (value === '' || value === null ? null : value),
  z.coerce.number().int().min(1).max(100_000).nullable(),
);

const colour = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour is six hex digits behind a #');

export async function createRoom(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ name: z.string().trim().min(1).max(80), capacity })
    .parse({ name: formData.get('name'), capacity: formData.get('capacity') });

  // New rooms land on the right of the grid rather than in the middle of it.
  const existing = await db.select({ position: rooms.position }).from(rooms);
  const nextPosition = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;

  await db.insert(rooms).values({
    name: input.name,
    capacity: input.capacity,
    position: nextPosition,
  });
  revalidateRooms();
}

export async function updateRoom(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), capacity })
    .parse({
      id: formData.get('id'),
      name: formData.get('name'),
      capacity: formData.get('capacity'),
    });

  await db
    .update(rooms)
    .set({ name: input.name, capacity: input.capacity })
    .where(eq(rooms.id, input.id));
  revalidateRooms();
}

/**
 * Move a room one place along the grid.
 *
 * Every room is renumbered from zero rather than swapping two `position`
 * values. Positions are free to collide — the seed's are distinct but nothing
 * enforces it — and swapping two rows that already share a number moves
 * nothing, which reads to an organizer as a broken button.
 */
export async function moveRoom(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) })
    .parse({ id: formData.get('id'), direction: formData.get('direction') });

  await db.transaction(async (tx) => {
    const ordered = await tx.select().from(rooms).orderBy(asc(rooms.position), asc(rooms.name));
    const index = ordered.findIndex((room) => room.id === input.id);
    if (index === -1) return;

    const destination = input.direction === 'up' ? index - 1 : index + 1;
    if (destination < 0 || destination >= ordered.length) return;

    const reordered = [...ordered];
    const [moved] = reordered.splice(index, 1);
    if (!moved) return;
    reordered.splice(destination, 0, moved);

    for (const [position, room] of reordered.entries()) {
      if (room.position !== position) {
        await tx.update(rooms).set({ position }).where(eq(rooms.id, room.id));
      }
    }
  });

  revalidateRooms();
}

/**
 * Delete a room and, by cascade, every slot in it.
 *
 * Refused without an explicit confirmation. The page that asks for it names the
 * slot count and the talks that would be unplaced, because the cascade is
 * invisible from here: `slots.roomId` is `on delete cascade`, so this one row
 * takes a column of the grid with it.
 */
export async function deleteRoom(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('id'));

  if (formData.get('confirm') !== 'yes') {
    redirect(`/organizer/rooms?confirmRoom=${id}`);
  }

  await db.delete(rooms).where(eq(rooms.id, id));
  revalidateRooms();
  redirect('/organizer/rooms');
}

export async function createTrack(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ name: z.string().trim().min(1).max(80), colour })
    .parse({ name: formData.get('name'), colour: formData.get('colour') });

  await db.insert(tracks).values({ name: input.name, colour: input.colour });
  revalidateRooms();
}

export async function updateTrack(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), colour })
    .parse({
      id: formData.get('id'),
      name: formData.get('name'),
      colour: formData.get('colour'),
    });

  await db
    .update(tracks)
    .set({ name: input.name, colour: input.colour })
    .where(eq(tracks.id, input.id));
  revalidateRooms();
}

/**
 * Delete a track. `submissions.trackId` is `on delete set null`, so the
 * proposals survive untracked rather than disappearing — but they lose a
 * grouping nobody can restore from here, so this confirms too.
 */
export async function deleteTrack(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('id'));

  if (formData.get('confirm') !== 'yes') {
    redirect(`/organizer/rooms?confirmTrack=${id}`);
  }

  await db.delete(tracks).where(eq(tracks.id, id));
  revalidateRooms();
  redirect('/organizer/rooms');
}
