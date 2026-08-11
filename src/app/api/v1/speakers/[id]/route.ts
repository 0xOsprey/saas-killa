import { apiError, apiOptions, apiResponse, publicSpeakerById } from '@/lib/api';

export function OPTIONS(): Response {
  return apiOptions();
}

/**
 * Single public speaker by id, with the sessions they are presenting.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const speaker = await publicSpeakerById(id);
  if (!speaker) return apiError('Speaker not found', 404);
  return apiResponse(speaker);
}
