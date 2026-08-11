import { join } from 'node:path';

/**
 * Where uploaded files live. Gitignored, and deliberately outside `public/`:
 * everything under `public/` is served by the static handler with no session
 * and no check, and a supporting document a speaker sent the committee is not
 * public. Reads go through `/files/<id>` instead.
 *
 * Its own module because two very different programs need the same path. The
 * app reaches it through `src/lib/uploads.ts`, which pulls in the database, the
 * session and half of Next; `src/db/seed.ts` is a plain node script run under
 * tsx and can afford none of that. Naming the directory twice would mean a
 * `--reset` that quietly stopped clearing the files it was meant to clear.
 */
export const UPLOAD_DIR = join(process.cwd(), 'uploads');
