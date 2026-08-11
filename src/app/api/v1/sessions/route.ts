import { apiOptions, apiResponse, paginate, parsePagination, publicSessionList } from '@/lib/api';

export function OPTIONS(): Response {
  return apiOptions();
}

/**
 * Public session list. Accepted submissions, with or without a slot, in the
 * Sessionboard-style `{ data: [], pagination: {} }` envelope.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { page, pageSize } = parsePagination(url);
  const q = url.searchParams.get('q') ?? undefined;
  const trackId = url.searchParams.get('track') ?? undefined;
  const roomId = url.searchParams.get('room') ?? undefined;

  const sessions = await publicSessionList(q, trackId, roomId);
  return apiResponse(paginate(sessions, page, pageSize));
}
