import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { env } from '@/lib/env';

const MAGIC_LINK_IP_WINDOW_MS = 60 * 1000;
const MAGIC_LINK_IP_LIMIT = 10;

const ipAttempts = new Map<string, { count: number; resetAt: number }>();

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function publicSignups(): 'open' | 'closed' {
  return env().PUBLIC_SIGNUPS ?? 'open';
}

export class SignupsClosedError extends Error {
  constructor() {
    super('Sign-ups are closed. Use the demo or ask an organizer for access.');
    this.name = 'SignupsClosedError';
  }
}

export class MagicLinkIpRateLimitError extends Error {
  constructor() {
    super('Too many sign-in attempts from this network. Try again in a minute.');
    this.name = 'MagicLinkIpRateLimitError';
  }
}

export async function findUserByEmail(rawEmail: string) {
  const email = normaliseEmail(rawEmail);
  return db.query.users.findFirst({ where: eq(users.email, email) });
}

export async function checkPublicSignups(rawEmail: string): Promise<void> {
  const existing = await findUserByEmail(rawEmail);
  if (existing) return;
  if (publicSignups() === 'closed') {
    throw new SignupsClosedError();
  }
}

async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return h.get('x-real-ip') ?? 'unknown';
}

export async function checkMagicLinkIpRateLimit(): Promise<void> {
  const ip = await getClientIp();
  const now = Date.now();
  const entry = ipAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    ipAttempts.set(ip, { count: 1, resetAt: now + MAGIC_LINK_IP_WINDOW_MS });
    return;
  }
  if (entry.count >= MAGIC_LINK_IP_LIMIT) {
    throw new MagicLinkIpRateLimitError();
  }
  entry.count += 1;
}
