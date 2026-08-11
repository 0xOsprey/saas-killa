import { currentUser } from '@/lib/auth';
import { readUploadBytes, readableUpload } from '@/lib/uploads';

/**
 * Serving an uploaded file back.
 *
 * Deliberately not `public/`. Everything under `public/` is served by the
 * static handler with no session and no check, and a supporting document a
 * speaker sent the committee is not public. Routing every read through here is
 * what makes `readableUpload` the single access rule.
 *
 * The path is `/files/<id>/<name>`. Only the first segment is read; the rest is
 * the filename, carried so the extension is visible to `classifyPosterUrl` and
 * to a browser's "save as". Nothing from the URL reaches the filesystem — the
 * name on disk comes from the database row — so a `..` in that tail is a
 * caption, not a traversal.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One answer for "no such file" and for "not yours". Splitting them into 404
 * and 403 would let an anonymous prober walk the id space and learn which
 * documents exist, which is most of what the access rule is protecting.
 */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const id = path[0];
  if (!id || !UUID.test(id)) return notFound();

  const viewer = await currentUser();
  const row = await readableUpload(id, viewer);
  if (!row) return notFound();

  const bytes = await readUploadBytes(row);
  if (!bytes) return notFound();

  return new Response(bytes, {
    headers: {
      'content-type': row.contentType,
      'content-length': String(bytes.byteLength),
      // The type served is the one sniffed from the file's own bytes at upload.
      // `nosniff` stops the browser second-guessing it, which is the other half
      // of the defence: a PDF that a heuristic decides is HTML would run as
      // HTML on this origin.
      'x-content-type-options': 'nosniff',
      // Inline, because a poster renders in an `<object>` and a headshot in an
      // `<img>`. Safe for the five accepted types: none of them is HTML, and
      // SVG, the one image format that carries script, is refused at upload.
      'content-disposition': `inline; filename="${row.filename}"`,
      // A headshot is public and appears on every gallery tile, so it is worth
      // caching. A minute rather than an hour because removal here is real:
      // taking a headshot down deletes the bytes, and this window is the only
      // time a browser that already has it can still show it.
      'cache-control':
        row.kind === 'headshot' ? 'public, max-age=60' : 'private, no-store, max-age=0',
    },
  });
}
