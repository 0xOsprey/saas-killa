import { currentUser } from '@/lib/auth';
import { agendaSlots, parseAgendaFilters, type AgendaSearchParams } from '@/lib/agenda-filters';
import { getEvent } from '@/lib/queries';
import { buildCalendar, calendarResponse } from '../ics';

/**
 * The current filter selection as a calendar. It reads the same query string
 * the page does, so "one track, day two" is a URL an attendee can subscribe to
 * and a chair can paste into a group chat.
 */
export async function GET(request: Request): Promise<Response> {
  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;
  if (!event.agendaPublished && !isOrganizer) {
    return new Response('Not found', { status: 404 });
  }

  const params: AgendaSearchParams = Object.fromEntries(new URL(request.url).searchParams);
  const filters = parseAgendaFilters(params);
  const entries = await agendaSlots(filters, event.timezone, user?.id ?? null);

  return calendarResponse(
    buildCalendar(entries, { calendarName: `${event.name} (filtered)` }),
    'agenda-filtered.ics',
  );
}
