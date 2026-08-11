import { apiOptions, apiResponse, paginate, parsePagination, publicSpeakerList } from '@/lib/api';

export function OPTIONS(): Response {
  return apiOptions();
}

/**
 * Public speaker directory. Only speakers with at least one accepted submission.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { page, pageSize } = parsePagination(url);
  const q = url.searchParams.get('q') ?? undefined;
  const trackId = url.searchParams.get('track') ?? undefined;

  const speakers = await publicSpeakerList(q, trackId);
  return apiResponse(paginate(speakers, page, pageSize));
}
