import { agendaFeed, embedDocument, isEmbedPreview, renderAgendaHtml } from '@/lib/embed';

/**
 * The iframe fallback for the schedule itinerary. Same document shape as
 * `/embed/speakers`; see the comment at the top of `src/lib/embed.ts` for why
 * three surfaces exist rather than one.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const feed = await agendaFeed(params, { preview: await isEmbedPreview(params) });
  return embedDocument(`Schedule · ${feed.event.name}`, renderAgendaHtml(feed));
}
