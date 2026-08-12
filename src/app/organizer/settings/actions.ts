'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { events } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { isSupportedTimezone } from '@/lib/content';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(160),
  tagline: z.string().trim().max(240).nullable(),
  timezone: z.string().refine(isSupportedTimezone, {
    message: 'Not an IANA timezone this runtime knows',
  }),
  /**
   * The zone the form was rendered in, echoed back as a hidden field. The wall
   * clocks below were typed against it, so they are read against it — changing
   * the timezone dropdown then changes how every stored instant is *displayed*
   * and moves nothing. Reading them against the newly chosen zone instead would
   * silently shift the event dates by the difference between the two.
   */
  renderedTimezone: z.string().refine(isSupportedTimezone),
  startsOn: z.string().min(16),
  endsOn: z.string().min(16),
  posterEmbargoUntil: z.string().nullable(),
  agendaPublished: z.boolean(),
});

/** Every outcome this page reports comes back as a query string, so the page stays a server component. */
function back(params: Record<string, string | number>): never {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  redirect(`/organizer/settings?${query.toString()}`);
}

function optional(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value.trim();
}

/**
 * Write the event row. Everything but the CFP window lives here; `cfpOpensAt`
 * and `cfpClosesAt` are edited at /organizer/cfp and are deliberately not
 * touched, so saving settings never moves the submission deadline.
 */
export async function saveEventSettings(formData: FormData): Promise<void> {
  await requireRole('organizer');

  const input = settingsSchema.parse({
    name: formData.get('name'),
    tagline: optional(formData, 'tagline'),
    timezone: formData.get('timezone'),
    renderedTimezone: formData.get('renderedTimezone'),
    startsOn: formData.get('startsOn'),
    endsOn: formData.get('endsOn'),
    posterEmbargoUntil: optional(formData, 'posterEmbargoUntil'),
    agendaPublished: formData.get('agendaPublished') === 'on',
  });

  const startsOn = wallClockToInstant(input.startsOn, input.renderedTimezone);
  const endsOn = wallClockToInstant(input.endsOn, input.renderedTimezone);
  if (endsOn < startsOn) {
    back({ error: 'event-order' });
  }

  const current = await getEvent();

  await db
    .update(events)
    .set({
      name: input.name,
      tagline: input.tagline,
      timezone: input.timezone,
      startsOn,
      endsOn,
      posterEmbargoUntil: input.posterEmbargoUntil
        ? wallClockToInstant(input.posterEmbargoUntil, input.renderedTimezone)
        : null,
      agendaPublished: input.agendaPublished,
    })
    .where(eq(events.id, current.id));

  // The event name is in the nav and the timezone formats every rendered
  // timestamp, so a settings change is felt on every page rather than this one.
  revalidatePath('/', 'layout');
  back({ saved: 'settings' });
}
