import { timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRoles } from '@/db/schema';
import type { Role } from '@/db/schema';
import { env } from '@/lib/env';
import { grantRole, startSession, upsertUserByEmail } from '@/lib/auth';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;

const attempts = new Map<string, { count: number; resetAt: number }>();

const DEMO_USERS: Record<
  Role,
  { email: string; name: string; roles: Role[]; home: string }
> = {
  organizer: {
    email: 'demo-organizer@example.com',
    name: 'Demo Organizer',
    roles: ['organizer', 'reviewer'],
    home: '/organizer',
  },
  reviewer: {
    email: 'demo-reviewer@example.com',
    name: 'Demo Reviewer',
    roles: ['reviewer'],
    home: '/review',
  },
  speaker: {
    email: 'demo-speaker@example.com',
    name: 'Demo Speaker',
    roles: ['speaker'],
    home: '/speaker',
  },
};

export function demoMode(): 'off' | 'open' | 'secret' {
  return env().DEMO_MODE;
}

export function isDemoUser(user: { email: string } | null): boolean {
  if (!user) return false;
  return Object.values(DEMO_USERS).some((u) => u.email === user.email);
}

export function demoHomeFor(role: Role): string {
  return DEMO_USERS[role]?.home ?? '/';
}

async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return h.get('x-real-ip') ?? 'unknown';
}

export class DemoAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoAccessError';
  }
}

export class DemoRateLimitError extends DemoAccessError {
  constructor() {
    super('Too many demo attempts. Try again in a minute.');
    this.name = 'DemoRateLimitError';
  }
}

async function checkDemoRateLimit(): Promise<void> {
  const ip = await clientIp();
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    throw new DemoRateLimitError();
  }
  entry.count += 1;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function loadDemoUser(role: Role) {
  const cfg = DEMO_USERS[role];
  if (!cfg) throw new DemoAccessError(`Unknown demo role: ${role}`);

  const user = await upsertUserByEmail(cfg.email, cfg.name);

  // Remove any leftover roles from earlier config changes.
  const held = await db.select().from(userRoles).where(eq(userRoles.userId, user.id));
  const wanted = new Set(cfg.roles);
  for (const row of held) {
    if (!wanted.has(row.role)) {
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, user.id), eq(userRoles.role, row.role)));
    }
  }

  // Grant exactly the demo role set; `upsertUserByEmail` only adds `speaker`.
  for (const r of cfg.roles) {
    await grantRole(user.id, r);
  }

  return { user, cfg };
}

/**
 * Start a session for a demo user with the requested role.
 * Call this only from a server action or route handler where `startSession`
 * can set the session cookie.
 */
export async function startDemoSession(
  role: Role,
  providedSecret?: string,
): Promise<string> {
  const mode = demoMode();
  if (mode === 'off') {
    throw new DemoAccessError('Demo mode is not enabled.');
  }

  if (mode === 'secret') {
    const expected = env().DEMO_SECRET;
    if (!expected || expected.length < 32) {
      throw new DemoAccessError('Demo secret is not configured.');
    }
    if (!providedSecret || !constantTimeEqual(providedSecret, expected)) {
      throw new DemoAccessError('Invalid demo secret.');
    }
  }

  await checkDemoRateLimit();

  const { user, cfg } = await loadDemoUser(role);
  await startSession(user.id);
  return cfg.home;
}

/**
 * Organizer-only: start a session as a demo role without the demo secret.
 * This is an admin tool for the owner to preview a portal.
 */
export async function startImpersonationSession(role: Role): Promise<string> {
  const { user, cfg } = await loadDemoUser(role);
  await startSession(user.id);
  return cfg.home;
}
