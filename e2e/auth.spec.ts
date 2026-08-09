import { expect, test, type Page } from '@playwright/test';
import { withDb } from './db';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * A sign-in link that does not work has to say so.
 *
 * `/auth/verify` is a route handler, so its only way to talk to the user is a
 * redirect carrying a code. The login page has to read that code back. These
 * tests exist because it did not: both codes were sent and both were dropped,
 * and an expired link put you on a login form that looked untouched.
 *
 * Nothing here changes seeded state. The third test redeems one throwaway link
 * for a seeded speaker, which the suite's other files do for themselves anyway.
 */

const SPEAKER = 'speaker9@example.com';

test('a link with no token says the link was incomplete', async ({ page }) => {
  await page.goto('/auth/verify');

  await expect(page).toHaveURL(/\/login\?error=missing$/);
  await expect(page.getByTestId('login-error')).toContainText('without its token');
});

test('a link whose token means nothing says the link expired', async ({ page }) => {
  await page.goto('/auth/verify?token=not-a-real-token');

  await expect(page).toHaveURL(/\/login\?error=expired$/);
  await expect(page.getByTestId('login-error')).toContainText('expired or has already been used');
});

test('a second press of the same link says the link was already used', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(SPEAKER);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === SPEAKER && m.subject.includes('sign-in link'));
  const link = extractMagicLink(mail);

  await page.goto(link);
  await expect(page.getByTestId('current-user')).toHaveText(SPEAKER);

  // Magic links are single use. The second press is the common real case: the
  // mail client prefetched the link, or the speaker went back and clicked again.
  await page.goto(link);
  await expect(page).toHaveURL(/\/login\?error=expired$/);
  await expect(page.getByTestId('login-error')).toContainText('expired or has already been used');
});

/**
 * The organizer-only route handlers, on the codes they answer with.
 *
 * A route handler runs no layout, so the gate wrapping the rest of /organizer
 * does not stand in front of these three. They each used to answer for
 * themselves and had drifted: two returned 403 to a signed-out caller and one
 * returned 401. `guardRoute` holds the split now, so this asserts the split
 * rather than any one handler's copy of it.
 *
 * Driven through `page.goto` on purpose. `page.request` does not carry the
 * Secure session cookie, so a signed-in check made that way looks signed out
 * and passes for the wrong reason.
 */
const GUARDED = [
  '/organizer/abstracts/export',
  '/organizer/speakers/export',
  // The guard runs before the run is looked up, so a made-up id still reaches
  // it. That is the point: no fixture needed to test the door.
  '/organizer/integrations/00000000-0000-0000-0000-000000000000/bundle',
];

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

test('a signed-out caller gets 401 from every organizer route handler', async ({ page }) => {
  for (const path of GUARDED) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(401);
  }
});

test('a signed-in speaker gets 403 from every organizer route handler', async ({ page }) => {
  await signIn(page, 'speaker1@example.com');

  for (const path of GUARDED) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(403);
  }
});

/**
 * Dead rows are actually removed, and an ordinary sign-in is what removes them.
 *
 * `currentUser` refuses an expired session but cannot delete it: it runs during
 * render, and Next forbids writes from a render pass. Nothing else ever touched
 * either table, so `auth_sessions` and `magic_link_tokens` grew for the life of
 * the deployment. That is invisible from every screen, which is why this is the
 * one spec in the suite that opens the database directly: the subject is a row
 * that has already stopped being usable, so no cookie and no link can reach it.
 *
 * The live row is the other half and the one that would matter if the predicate
 * were wrong by an inequality: a sweep that took `expires_at > now()` as well
 * would sign out everybody who is currently using the app.
 */
test('signing in sweeps expired sessions and expired links, and spares live ones', async ({
  page,
}) => {
  const marker = `e2e-sweep-${Date.now()}`;
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  const live = new Date(Date.now() + 60 * 60 * 1000);

  const { staleSession, liveSession } = await withDb(async (sql) => {
    const [user] = await sql`select id from users where email = ${SPEAKER}`;
    expect(user, `no ${SPEAKER} in the fixture`).toBeTruthy();
    const [dead] = await sql`
      insert into auth_sessions (user_id, expires_at) values (${user!.id}, ${stale}) returning id`;
    const [alive] = await sql`
      insert into auth_sessions (user_id, expires_at) values (${user!.id}, ${live}) returning id`;
    await sql`
      insert into magic_link_tokens (user_id, token_hash, expires_at)
      values (${user!.id}, ${marker}, ${stale})`;
    return { staleSession: dead!.id as string, liveSession: alive!.id as string };
  });

  try {
    // Any sign-in at all. The sweep is hung off `startSession`, so it is the act
    // of opening a session that pays for the cleanup, not a cron nobody runs.
    await signIn(page, 'speaker2@example.com');

    await withDb(async (sql) => {
      const dead = await sql`select id from auth_sessions where id = ${staleSession}`;
      expect(dead.length, 'expired session survived the sweep').toBe(0);

      const token = await sql`select id from magic_link_tokens where token_hash = ${marker}`;
      expect(token.length, 'expired magic link survived the sweep').toBe(0);

      const alive = await sql`select id from auth_sessions where id = ${liveSession}`;
      expect(alive.length, 'live session was swept away').toBe(1);
    });

    // And the browser that just signed in is still signed in, which is the same
    // claim from the outside: the sweep runs after its own row is written.
    await page.goto('/speaker');
    await expect(page.getByTestId('current-user')).toHaveText('speaker2@example.com');
  } finally {
    await withDb(async (sql) => {
      await sql`delete from auth_sessions where id = ${liveSession}`;
      await sql`delete from magic_link_tokens where token_hash = ${marker}`;
    });
  }
});
