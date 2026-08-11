import { feedResponse, isEmbedPreview, preflightResponse, speakerFeed } from '@/lib/embed';

export function OPTIONS(): Response {
  return preflightResponse();
}

/**
 * The speaker gallery as data, for a host page that would rather render it
 * itself than take our markup. `?q=` and `?track=` narrow it exactly as they do
 * on `/speakers`, and `?fields=` drops the keys the host does not want.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return feedResponse(await speakerFeed(params, { preview: await isEmbedPreview(params) }));
}
