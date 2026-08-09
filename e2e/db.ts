import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * A direct connection to the same database the app under test is using.
 *
 * Every other spec drives the browser, which is the right default: a test that
 * writes to the database proves the row and not the feature. This exists for the
 * one claim no screen can show, `sweepExpiredAuth`, whose whole subject is a row
 * that has already stopped being usable and so cannot be reached through a
 * cookie or a link.
 *
 * `DATABASE_URL` is read out of `.env.local` by hand. The app gets it from Next,
 * which loads that file itself, and the seed gets it from tsx's
 * `--env-file-if-exists`; the Playwright process is the only participant with
 * neither, and `@/lib/env` is unreachable from here because `tsconfig.json`
 * excludes `e2e` and so never applies the `@/*` path mapping to it.
 */
function databaseUrl(): string {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of raw.split('\n')) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    return match[1]!.trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('DATABASE_URL is not in .env.local');
}

/**
 * Open a connection, hand it to `run`, and close it whatever happens. One
 * connection per call rather than a shared pool: the suite is a single worker,
 * these calls are rare, and a pool left open holds the Playwright process alive
 * after the last test.
 */
export async function withDb<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl(), { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
