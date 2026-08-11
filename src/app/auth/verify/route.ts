import { type NextRequest, NextResponse } from 'next/server';
import { consumeMagicLink, homeForRoles, rolesFor, startSession } from '@/lib/auth';
import { env } from '@/lib/env';

/**
 * Redeem a magic link. A GET is correct here despite being a state change: the
 * link arrives by email and email clients only issue GETs. The token is single
 * use, so a scanner that prefetches the link burns it and the user simply asks
 * for another rather than gaining access.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const base = env().APP_URL;

  if (!token) {
    return NextResponse.redirect(new URL('/login?error=missing', base));
  }

  const user = await consumeMagicLink(token);
  if (!user) {
    return NextResponse.redirect(new URL('/login?error=expired', base));
  }

  await startSession(user.id);
  return NextResponse.redirect(new URL(homeForRoles(await rolesFor(user.id)), base));
}
