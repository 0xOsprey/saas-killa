import { agendaFeed, agendaXml, isEmbedPreview, preflightResponse, xmlResponse } from '@/lib/embed';

export function OPTIONS(): Response {
  return preflightResponse();
}

/**
 * The schedule itinerary as XML, for a CMS whose feed importer speaks XML and
 * not JSON. Same query string as `/embed/agenda.json`, same narrowing, same
 * `fields=` selection, because it serializes the same feed object rather than
 * asking the database a second question.
 */
export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return xmlResponse(agendaXml(await agendaFeed(params, { preview: await isEmbedPreview(params) })));
}
