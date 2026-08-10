import { NextResponse, type NextRequest } from 'next/server';

/**
 * Turn away an unauthenticated request before anything renders.
 *
 * The layout guards were doing the authentication and they still are, but they
 * do it too late. `redirect()` inside `organizer/layout.tsx` aborts the layout;
 * it does not stop the page beneath it, because the App Router renders a layout
 * and its page concurrently and serializes whatever the page produced into the
 * flight payload. The browser follows the 307 and shows nothing, so the hole is
 * invisible in a browser. `curl` sees the whole page. Measured on the deployed
 * clone before this file existed: a signed-out GET of /organizer/speakers came
 * back 307 with 145KB of body carrying 95 distinct email addresses, and
 * /organizer/abstracts, /organizer/submissions and /organizer/email all leaked
 * the same way.
 *
 * Middleware runs before any of that, so a redirect here renders nothing at
 * all. It replaces no existing check: the layouts keep deciding *which* role
 * may see a screen, which needs the database and cannot happen out here.
 */

/** Mirrors `SESSION_COOKIE` in `lib/auth.ts`. Duplicated because that module pulls in the database driver. */
const SESSION_COOKIE = 'sb_session';

const encoder = new TextEncoder();

/**
 * The same HMAC `lib/auth.ts` signs with, recomputed through Web Crypto.
 *
 * Web Crypto rather than `node:crypto` so this keeps working on the edge
 * runtime, and a fresh key per call because a module-level `importKey` would
 * have to be awaited at import time.
 */
async function signatureMatches(sessionId: string, signature: string): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Length-invariant compare. A signature is public once it has been sent, but
  // this one is a bearer token and the cost of not leaking its bytes by timing
  // is four lines.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function middleware(request: NextRequest) {
  const raw = request.cookies.get(SESSION_COOKIE)?.value;

  let signed = false;
  if (raw) {
    // `lastIndexOf` because the id is a hex string and the signature is hex, so
    // the separator is the only dot, but splitting on the first one would break
    // the moment either half gains a dot.
    const dot = raw.lastIndexOf('.');
    if (dot > 0) signed = await signatureMatches(raw.slice(0, dot), raw.slice(dot + 1));
  }
  if (signed) return NextResponse.next();

  // A well-formed cookie whose session has expired or been deleted still gets
  // through here and is turned away by the layout, which is the case that needs
  // the database. That path leaks the same way this one used to, but reaching
  // it means holding a signature only this server's secret can produce.
  const login = new URL('/login', request.url);
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (next !== '/') login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

/**
 * Only the trees that hold somebody's data. The public agenda, the speaker
 * directory, the CFP form and every `/embed` surface are meant to answer a
 * request with no cookie at all, and putting them behind this would break the
 * thing the product is for.
 */
export const config = {
  matcher: ['/organizer/:path*', '/speaker/:path*', '/review/:path*'],
};
