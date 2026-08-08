import { currentUser } from '@/lib/auth';
import { EMPTY_FILTERS, agendaSlots } from '@/lib/agenda-filters';
import { getEvent } from '@/lib/queries';
import { buildCalendar, calendarResponse } from '../ics';

/**
 * The whole published programme as one subscribable file.
 *
 * The publish gate is the same one the page enforces: an unpublished agenda is
 * a 404 for everyone but an organizer, and a route handler is exactly the door
 * someone would try if the page refused them.
 */
export async function GET(): Promise<Response> {
  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;
  if (!event.agendaPublished && !isOrganizer) {
    return new Response('Not found', { status: 404 });
  }

  const entries = await agendaSlots(EMPTY_FILTERS, event.timezone, user?.id ?? null);
  return calendarResponse(
    buildCalendar(entries, { calendarName: event.name }),
    'agenda.ics',
  );
}
