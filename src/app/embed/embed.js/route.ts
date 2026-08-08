import { embedScript } from '@/lib/embed-script';
import { preflightResponse } from '@/lib/embed';

/**
 * The widget script.
 *
 * It carries the same CORS and private-network headers as the feeds. A script
 * tag is not normally subject to CORS at all, but Chrome preflights *any*
 * subresource when the host page sits in a less private address space than the
 * server, so an app served from inside a venue's network needs this to be
 * loadable from the conference's public website at all.
 */
export function OPTIONS(): Response {
  return preflightResponse();
}

export function GET(): Response {
  return new Response(embedScript(), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-private-network': 'true',
      // Short rather than immutable: the URL has no content hash in it, because
      // an organizer pastes it into a CMS once and never revisits it.
      'cache-control': 'public, max-age=300',
    },
  });
}
