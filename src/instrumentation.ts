/**
 * Read the environment once, at startup, and refuse to serve without it.
 *
 * `env()` is lazy and cached, so a misconfigured deploy used to print
 * `✓ Ready`, bind the port, and then return 500 to every request with the
 * reason only in the server log. That is the worst shape a configuration error
 * can take: a platform health check that tests for a listening socket marks the
 * deploy green and routes traffic to it. The security property was never in
 * question — no forgeable cookie key ever shipped, because nothing that needed
 * the secret got one. The operational property was, and this is that half.
 *
 * `process.exit` rather than a rethrow: Next catches what `register` throws and
 * carries on starting, which is the behaviour being fixed.
 */
export async function register(): Promise<void> {
  // `register` runs once per runtime. The edge runtime has neither the full
  // process env nor a `process.exit` worth calling, so the check is the node
  // server's.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { env } = await import('@/lib/env');
  try {
    env();
  } catch (error) {
    console.error(`\n ✗ ${(error as Error).message}\n`);
    process.exit(1);
  }
}
