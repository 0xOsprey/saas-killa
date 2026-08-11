import { NextResponse } from 'next/server';
import { endSession } from '@/lib/auth';
import { env } from '@/lib/env';

/**
 * POST only, deliberately.
 *
 * As a GET this was a live bug rather than a style point: `next/link`
 * prefetches every link in the viewport, so the "Sign out" link in the nav
 * fired this handler seconds after each sign-in and deleted the session the
 * user had just opened. The same shape is also the classic CSRF hole, where any
 * third-party page can log a visitor out with an <img> tag.
 */
export async function POST() {
  await endSession();
  return NextResponse.redirect(new URL('/', env().APP_URL), { status: 303 });
}
