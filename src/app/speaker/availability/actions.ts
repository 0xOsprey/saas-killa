'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { speakerAvailability } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';

/**
 * The speaker's own half of `speaker_availability`.
 *
 * The organizer's actions in `organizer/speakers/actions.ts` are the template,
 * with one deliberate difference: they take a `userId` off the form because an
 * organizer is allowed to name a speaker, and these do not, because a speaker is
 * not. The id comes from the session and goes into the WHERE clause, so a forged
 * one touches zero rows rather than somebody else's calendar.
 *
 * A block an organizer typed is editable here, and that is a decision rather
 * than an oversight. Availability is a fact about the speaker's own life; the
 * organizer only ever holds it because the speaker emailed it to them, and the
 * whole reason this screen exists is that being unable to write it down yourself
 * leaves the data stale. A speaker whose flight moves has to be able to fix the
 * block that flight produced, whoever typed it in the first place. The rejected
 * alternative was an origin column with organizer-entered rows read-only, which
 * is more honest about provenance and reintroduces exactly the dependency the
 * gap is about. Scope stays `userId`, which admits both by construction.
 */

/** Mirrors the organizer form's state, which is the same form for a different caller. */
export type AvailabilityState = { error?: string; saved?: boolean };

const blockSchema = z.object({
  startsAt: z.string().min(1, 'Give the block a start'),
  endsAt: z.string().min(1, 'Give the block an end'),
  note: z.string().max(200).nullable(),
});

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

export async function addAvailabilityBlock(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const user = await requireUser();

  const parsed = blockSchema.safeParse({
    startsAt: optional(formData.get('startsAt')),
    endsAt: optional(formData.get('endsAt')),
    note: optional(formData.get('note')),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;

  // Wall clock in the event's timezone, the same convention the organizer's form
  // and the schedule grid post. A block typed here has to line up with the slot
  // it is meant to rule out, and the conflict checker compares instants.
  const event = await getEvent();
  const startsAt = wallClockToInstant(input.startsAt, event.timezone);
  const endsAt = wallClockToInstant(input.endsAt, event.timezone);
  if (endsAt <= startsAt) return { error: 'The block has to end after it starts.' };

  await db.insert(speakerAvailability).values({
    userId: user.id,
    startsAt,
    endsAt,
    note: input.note,
  });

  revalidate(user.id);
  return { saved: true };
}

/**
 * Take a block back down.
 *
 * `?removed=1` goes out whether or not a row matched. Given that the scope is
 * the caller's own id, a miss is either a double submit, where "removed"
 * describes the end state correctly, or somebody else's block id, where naming
 * the miss would say whether that id exists. Same reasoning as `removeDocument`.
 */
export async function removeAvailabilityBlock(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('availabilityId'));

  await db
    .delete(speakerAvailability)
    .where(and(eq(speakerAvailability.id, id), eq(speakerAvailability.userId, user.id)));

  revalidate(user.id);
  redirect('/speaker/availability?removed=1');
}

/**
 * Everything that reads these rows. The organizer's schedule screen flags a talk
 * booked into a window its speaker declared away, and their per-speaker page
 * renders the same list, so both go stale the moment one changes. This is the
 * speaker-side mirror of `refreshSpeakerScreens`.
 */
function revalidate(userId: string): void {
  revalidatePath('/speaker/availability');
  revalidatePath('/organizer/schedule');
  revalidatePath('/organizer/speakers');
  revalidatePath(`/organizer/speakers/${userId}`);
}
