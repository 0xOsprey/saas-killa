import { apiError, apiOptions, apiResponse, publicSessionById } from '@/lib/api';

export function OPTIONS(): Response {
  return apiOptions();
}

/**
 * Single public session by id. Returns 404 for anything that is not accepted.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const session = await publicSessionById(id);
  if (!session) return apiError('Session not found', 404);
  return apiResponse(session);
}
