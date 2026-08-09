/**
 * What a load balancer should ask before it sends anyone here.
 *
 * A listening socket is not readiness. This app needs two things a port cannot
 * tell you about: a valid environment and a database that answers. Both are
 * checked on every hit, and neither is cached, because the point of the route
 * is to notice when one of them stops being true.
 *
 * The imports are dynamic so a broken environment reports 503 rather than
 * throwing on module evaluation and coming back as a 500 the probe cannot
 * distinguish from a crashed page. `src/instrumentation.ts` means the process
 * should not be alive to answer in that state at all; this is the second line.
 *
 * The body names what failed and nothing else. It is unauthenticated, so it
 * must not leak a connection string, a host or a stack.
 */
export const dynamic = 'force-dynamic';

type Check = { name: string; ok: boolean; detail?: string };

async function checkEnv(): Promise<Check> {
  try {
    const { env } = await import('@/lib/env');
    env();
    return { name: 'env', ok: true };
  } catch {
    return { name: 'env', ok: false, detail: 'invalid or incomplete' };
  }
}

async function checkDatabase(): Promise<Check> {
  try {
    const [{ db }, { sql }] = await Promise.all([import('@/db'), import('drizzle-orm')]);
    await db.execute(sql`select 1`);
    return { name: 'database', ok: true };
  } catch {
    return { name: 'database', ok: false, detail: 'unreachable' };
  }
}

export async function GET(): Promise<Response> {
  const checks = [await checkEnv(), await checkDatabase()];
  const ok = checks.every((check) => check.ok);

  return new Response(`${JSON.stringify({ status: ok ? 'ok' : 'unhealthy', checks }, null, 2)}\n`, {
    status: ok ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
