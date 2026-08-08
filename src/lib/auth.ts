import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { db } from '@/db';
import { authSessions, magicLinkTokens, userRoles, users } from '@/db/schema';
import type { Role, User } from '@/db/schema';
import { env } from './env';

export const SESSION_COOKIE = 'sb_session';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sign(sessionId: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(sessionId).digest('hex');
}

/**
 * Compare in constant time. `timingSafeEqual` throws on a length mismatch, so
 * the lengths are checked first rather than letting a forged cookie of the
 * wrong size produce an exception instead of a clean rejection.
 */
function signatureMatches(sessionId: string, signature: string): boolean {
  const expected = Buffer.from(sign(sessionId), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Find the user by email, or create one. Login and signup are the same act. */
export async function upsertUserByEmail(rawEmail: string, name?: string): Promise<User> {
  const email = normaliseEmail(rawEmail);
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    if (name && !existing.name) {
      const [updated] = await db
        .update(users)
        .set({ name })
        .where(eq(users.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }
  const [created] = await db.insert(users).values({ email, name: name ?? null }).returning();
  if (!created) throw new Error(`failed to create user for ${email}`);
  // Anyone who arrives through the CFP is a speaker. Reviewer and organizer are
  // granted by an organizer, never self-assigned.
  await db.insert(userRoles).values({ userId: created.id, role: 'speaker' }).onConflictDoNothing();
  return created;
}

/**
 * Mint a magic link. The raw token is returned to the caller so it can go into
 * the email; only its hash is written to the database, so a database read never
 * yields a usable link.
 */
export async function issueMagicLink(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(magicLinkTokens).values({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  return token;
}

/**
 * Redeem a magic link and open a session. Single use: the update is conditional
 * on `consumedAt IS NULL`, so two concurrent redemptions of the same link race
 * on the row and exactly one wins.
 */
export async function consumeMagicLink(token: string): Promise<User | null> {
  const now = new Date();
  const [claimed] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(magicLinkTokens.tokenHash, sha256(token)),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) return null;
  return (await db.query.users.findFirst({ where: eq(users.id, claimed.userId) })) ?? null;
}

export async function startSession(userId: string): Promise<void> {
  const [session] = await db
    .insert(authSessions)
    .values({ userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .returning();
  if (!session) throw new Error('failed to create auth session');

  const jar = await cookies();
  jar.set(SESSION_COOKIE, `${session.id}.${sign(session.id)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: session.expiresAt,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  if (!raw) return;
  const [sessionId] = raw.split('.');
  if (sessionId) await db.delete(authSessions).where(eq(authSessions.id, sessionId));
}

export type CurrentUser = User & { roles: Role[] };

/**
 * Resolve the signed-in user, or null. Every check has to pass: the cookie's
 * HMAC, the session row's existence, and its expiry. An expired row is left for
 * cleanup rather than deleted here, because this runs during render and Next
 * forbids writes from a render pass.
 */
export async function currentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const sessionId = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!signatureMatches(sessionId, signature)) return null;

  const session = await db.query.authSessions.findFirst({
    where: eq(authSessions.id, sessionId),
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (!user) return null;

  const held = await db.select().from(userRoles).where(eq(userRoles.userId, user.id));
  return { ...user, roles: held.map((r) => r.role) };
}

export class NotAuthorised extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthorised';
  }
}

/** Throw unless the signed-in user holds at least one of `allowed`. */
export async function requireRole(...allowed: Role[]): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) throw new NotAuthorised('not signed in');
  if (!allowed.some((role) => user.roles.includes(role))) {
    throw new NotAuthorised(`requires one of: ${allowed.join(', ')}`);
  }
  return user;
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) throw new NotAuthorised('not signed in');
  return user;
}

export async function grantRole(userId: string, role: Role): Promise<void> {
  await db.insert(userRoles).values({ userId, role }).onConflictDoNothing();
}
