import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
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

export class MagicLinkRateLimitError extends Error {
  constructor() {
    super('Too many sign-in links. Try again in 10 minutes.');
    this.name = 'MagicLinkRateLimitError';
  }
}

async function recentMagicLinkCount(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - env().MAGIC_LINK_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(magicLinkTokens)
    .where(and(eq(magicLinkTokens.userId, userId), gt(magicLinkTokens.createdAt, cutoff)));
  return row?.count ?? 0;
}

/**
 * Mint a magic link. The raw token is returned to the caller so it can go into
 * the email; only its hash is written to the database, so a database read never
 * yields a usable link.
 *
 * A rolling window limits each user to three magic links per ten minutes. This
 * is checked before insert so a token is never written when the limit is hit.
 */
export async function issueMagicLink(userId: string): Promise<string> {
  if ((await recentMagicLinkCount(userId)) >= env().MAGIC_LINK_LIMIT) {
    throw new MagicLinkRateLimitError();
  }
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

/**
 * Delete every session and every magic link that has outlived its expiry.
 *
 * `currentUser` refuses an expired session and cannot delete it: it runs during
 * render, and Next forbids writes from a render pass. So the row was left for a
 * cleanup that did not exist, and both tables grew for the life of the
 * deployment with nothing ever removing anything.
 *
 * This is that cleanup, hung off `startSession`. Signing in is the act that puts
 * rows in both tables, so the work scales with the traffic that causes it and an
 * instance nobody is using does none. It is two indexed deletes on a timestamp,
 * which is affordable on a request that already writes.
 *
 * A spent link inside its 15 minutes is left to age out rather than deleted
 * here. Removing it early would change nothing a person sees: `/auth/verify`
 * redirects to `?error=expired` for a link that is spent, one that is stale and
 * one that never existed, all three.
 */
export async function sweepExpiredAuth(now = new Date()): Promise<void> {
  await db.delete(authSessions).where(lte(authSessions.expiresAt, now));
  await db.delete(magicLinkTokens).where(lte(magicLinkTokens.expiresAt, now));
}

export async function startSession(userId: string): Promise<void> {
  const [session] = await db
    .insert(authSessions)
    .values({ userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .returning();
  if (!session) throw new Error('failed to create auth session');

  await sweepExpiredAuth();

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
 * `sweepExpiredAuth` rather than deleted here, because this runs during render
 * and Next forbids writes from a render pass.
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

/**
 * The role gate for a route handler. Returns the user, or the Response to send
 * back instead:
 *
 *     const gate = await guardRoute('organizer');
 *     if (gate instanceof Response) return gate;
 *
 * `requireRole` is wrong here because it throws, and a thrown authorisation
 * error in a route handler is a 500 that reads like an outage. Each handler
 * used to catch it and answer for itself, and the three of them drifted apart:
 * two returned 403 for a signed-out caller and one returned 401. Both codes
 * live here now so there is one place to disagree with.
 *
 * The split is the ordinary one. 401 says the caller is nobody and signing in
 * would fix it; 403 says we know exactly who they are and the answer is still
 * no. Deliberately no `WWW-Authenticate` header on the 401, which RFC 9110
 * asks for: there is no HTTP auth scheme to name here, and sending one makes
 * the browser raise a username-and-password dialog for an app whose only way
 * in is a link in an email.
 */
export async function guardRoute(...allowed: Role[]): Promise<CurrentUser | Response> {
  const user = await currentUser();
  if (!user) {
    return new Response('Sign in first.\n', { status: 401 });
  }
  if (!allowed.some((role) => user.roles.includes(role))) {
    return new Response(`Access is limited to: ${allowed.join(', ')}.\n`, { status: 403 });
  }
  return user;
}

export async function grantRole(userId: string, role: Role): Promise<void> {
  await db.insert(userRoles).values({ userId, role }).onConflictDoNothing();
}

/** The roles a user holds, by id. `currentUser` needs a cookie; this does not. */
export async function rolesFor(userId: string): Promise<Role[]> {
  const held = await db.select().from(userRoles).where(eq(userRoles.userId, userId));
  return held.map((r) => r.role);
}

/**
 * Where a sign-in lands. Everyone used to land on `/speaker`, which put an
 * organizer on their own empty submission list and left the screens they signed
 * in for one unexplained click away in the nav. Ordered most-privileged first,
 * because the bootstrap organizer holds `reviewer` as well.
 */
export function homeForRoles(roles: Role[]): string {
  if (roles.includes('organizer')) return '/organizer';
  if (roles.includes('reviewer')) return '/review';
  return '/speaker';
}
