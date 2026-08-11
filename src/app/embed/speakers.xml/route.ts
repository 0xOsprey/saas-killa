import { isEmbedPreview, preflightResponse, speakerFeed, speakersXml, xmlResponse } from '@/lib/embed';

export function OPTIONS(): Response {
  return preflightResponse();
}

/**
 * The speaker gallery as XML. The counterpart to `/embed/speakers.json`, for a
 * host whose importer takes a feed URL rather than running our script; `?q=`,
 * `?track=` and `?fields=` narrow it exactly as they do there.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return xmlResponse(speakersXml(await speakerFeed(params, { preview: await isEmbedPreview(params) })));
}
