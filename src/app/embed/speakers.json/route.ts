import { feedResponse, preflightResponse, speakerFeed } from '@/lib/embed';

export function OPTIONS(): Response {
  return preflightResponse();
}

/**
 * The speaker gallery as data, for a host page that would rather render it
 * itself than take our markup. `?q=` and `?track=` narrow it exactly as they do
 * on `/speakers`.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return feedResponse(await speakerFeed(params));
}
