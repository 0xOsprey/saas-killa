import { guardRoute } from '@/lib/auth';
import { fileExportById, readExportBytes } from '@/lib/uploads';

/**
 * Handing back a finished archive.
 *
 * Its own route rather than `/files/<id>`, because that one answers from the
 * `uploads` table and an export is not an upload: nobody sent it to us, and its
 * access rule is not per-kind. This one is flat — organizers only — which is
 * the honest rule for a bundle that may hold every supporting document a
 * committee was ever sent, including the private ones.
 *
 * `guardRoute` rather than `requireRole`, which throws: a thrown authorisation
 * error in a route handler is a 500 that reads like an outage.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await guardRoute('organizer');
  if (gate instanceof Response) return gate;

  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const row = await fileExportById(id);
  if (!row || row.status !== 'ready') return notFound();

  const bytes = await readExportBytes(row);
  if (!bytes) return notFound();

  return new Response(bytes, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(bytes.byteLength),
      'x-content-type-options': 'nosniff',
      // An attachment, not inline: this one is meant to land in a folder rather
      // than render, and the name says which export it was.
      'content-disposition': `attachment; filename="session-files-${row.id.slice(0, 8)}.zip"`,
      'cache-control': 'private, no-store, max-age=0',
    },
  });
}
