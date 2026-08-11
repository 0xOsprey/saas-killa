import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * One pool per process. Next's dev server re-evaluates modules on every edit,
 * so the client is parked on globalThis to stop hot reload opening a new pool
 * per change and exhausting Postgres connections.
 */
const globalForDb = globalThis as unknown as {
  __saasKillaSql?: ReturnType<typeof postgres>;
};

function client() {
  if (!globalForDb.__saasKillaSql) {
    globalForDb.__saasKillaSql = postgres(env().DATABASE_URL, { max: 10 });
  }
  return globalForDb.__saasKillaSql;
}

export const db = drizzle(client(), { schema });
export { schema };
