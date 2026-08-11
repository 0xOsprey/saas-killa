import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';

/**
 * Theme controller. Sets a `theme` cookie to `ai-engineer` or `light` and
 * redirects back to the referring page (or `/` if none is given).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const set = url.searchParams.get('set');
  const redirectTo = url.searchParams.get('redirect') ?? '/';

  if (set === 'ai-engineer' || set === 'light') {
    const cookieStore = await cookies();
    cookieStore.set('theme', set, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
    });
  }

  return Response.redirect(new URL(redirectTo, env().APP_URL).toString(), 302);
}
