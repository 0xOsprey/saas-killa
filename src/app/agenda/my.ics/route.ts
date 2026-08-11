import { currentUser } from '@/lib/auth';
import { EMPTY_FILTERS, agendaSlots } from '@/lib/agenda-filters';
import { getEvent } from '@/lib/queries';
import { buildCalendar, calendarResponse } from '@/lib/ics';

/**
 * The signed-in attendee's starred talks.
 *
 * Blocks are left out: a personal calendar is the things this person chose, and
 * nobody bookmarks lunch. It 401s rather than 404s for a signed-out visitor,
 * because the file exists and the caller is simply not anyone yet.
 */
export async function GET(): Promise<Response> {
  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  if (!user) return new Response('Sign in to export your agenda', { status: 401 });

  const isOrganizer = user.roles.includes('organizer');
  if (!event.agendaPublished && !isOrganizer) {
    return new Response('Not found', { status: 404 });
  }

  const entries = await agendaSlots(
    { ...EMPTY_FILTERS, mine: true },
    event.timezone,
    user.id,
  );

  return calendarResponse(
    buildCalendar(entries, { calendarName: `${event.name} — my agenda`, includeBlocks: false }),
    'my-agenda.ics',
  );
}
