import { agendaFeed, feedResponse, preflightResponse } from '@/lib/embed';

export function OPTIONS(): Response {
  return preflightResponse();
}

/**
 * The schedule itinerary as data, grouped into days. Takes the same narrowing
 * parameters as `/agenda` (`track`, `day`, `room`, `format`, `level`, `q`) and
 * discards anything malformed rather than erroring, because a hand-edited
 * `?track=banana` on somebody else's website has to render an agenda.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return feedResponse(await agendaFeed(params));
}
