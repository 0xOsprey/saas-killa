import { apiOptions, apiResponse, publicEvent } from '@/lib/api';

export function OPTIONS(): Response {
  return apiOptions();
}

/**
 * Public event metadata. Mirrors the `GET /v1/event/{eventId}` shape from the
 * Sessionboard API: a single event object with the basic conference details.
 */
export async function GET(): Promise<Response> {
  return apiResponse(await publicEvent());
}
