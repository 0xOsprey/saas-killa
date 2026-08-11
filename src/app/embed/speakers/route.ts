import { embedDocument, renderSpeakersHtml, speakerFeed } from '@/lib/embed';

/**
 * The iframe fallback for the speaker gallery: a whole document, server
 * rendered, no JavaScript needed to see the names. For a CMS that allows an
 * iframe but not a third-party script tag.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const feed = await speakerFeed(params);
  return embedDocument(`Speakers · ${feed.event.name}`, renderSpeakersHtml(feed));
}
