import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * Every route, once, under the role that is meant to reach it.
 *
 * `pipeline.spec.ts` proves one path works end to end. This proves the other
 * forty render at all, which is a different and much weaker claim — but it is
 * the claim that was missing, because a page that throws on its first query is
 * indistinguishable from a page nobody has opened until somebody opens it.
 *
 * Assertions are deliberately shallow: an HTTP status and the absence of an
 * error boundary. Anything deeper belongs in a test named after the feature.
 */

const ORGANIZER = 'organizer@example.com';
const SPEAKER = 'speaker1@example.com';
const REVIEWER = 'reviewer1@example.com';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

/** Open a path and fail with the path in the message, not just a bare status. */
async function visit(page: Page, path: string) {
  const response = await page.goto(path);
  const status = response?.status() ?? 0;
  expect(status, `GET ${path}`).toBeLessThan(400);
  // A server component that throws after streaming has begun returns 200 and
  // then swaps in the error boundary, so status alone does not cover it.
  //
  // Both checks, and the testid is the load-bearing one. Since src/app/error.tsx
  // exists our own boundary renders instead of Next's, so the literal string
  // stopped appearing and a check for it alone would pass on every broken page.
  // The string still catches a failure early enough that no boundary renders.
  await expect(page.getByTestId('error-boundary'), `error boundary on ${path}`).toHaveCount(0);
  await expect(page.locator('body'), `error boundary on ${path}`).not.toContainText(
    'Application error',
  );
}

/**
 * First href on the current page matching a route shape, e.g. /posters/<uuid>.
 *
 * The tail must be a uuid rather than any segment: `/organizer/abstracts` also
 * carries links to `/organizer/abstracts/book` and `/organizer/abstracts/export`,
 * and a looser pattern picked up the literal ones and then asked for
 * `/organizer/abstracts/book/history`, which is nothing.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

async function firstHref(page: Page, pattern: RegExp): Promise<string> {
  const hrefs = await page.locator('a[href]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('href') ?? ''),
  );
  const hit = hrefs.find((href) => pattern.test(href));
  expect(hit, `no link matching ${pattern} on ${page.url()}`).toBeTruthy();
  return hit!;
}

type FetchedFile = { status: number; contentType: string; body: string };

/**
 * Fetch a file from inside the page rather than through `page.request`.
 *
 * The session cookie is `Secure`, and Chromium sends a Secure cookie to
 * `http://127.0.0.1` because it treats loopback as a trustworthy origin.
 * Playwright's `APIRequestContext` is a separate client that does not, so
 * `page.request.get` on a signed-in route came back 401 while the same URL in
 * the browser was fine. `page.goto` is not the alternative: these responses
 * carry `content-disposition: attachment`, which aborts a navigation.
 */
async function fetchInPage(page: Page, path: string): Promise<FetchedFile> {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'include' });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  }, path);
}

test('the public pages render for a signed-out visitor', async ({ page }) => {
  for (const path of [
    '/',
    '/login',
    '/cfp',
    '/agenda',
    '/posters',
    '/speakers',
    '/awards',
    // The embed surfaces are documents in their own right rather than pages
    // under the app's layout, so nothing else here would open them.
    '/embed/demo',
    '/embed/speakers',
    '/embed/agenda',
  ]) {
    await visit(page, path);
  }

  await visit(page, '/posters');
  await visit(page, await firstHref(page, new RegExp(`^/posters/${UUID}$`)));

  await visit(page, '/speakers');
  await visit(page, await firstHref(page, new RegExp(`^/speakers/${UUID}$`)));
});

test('the organizer console renders every tab', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  // The tab list is read off the nav rather than typed out here. A hand-kept
  // copy is a list that goes stale silently: four tabs were added over one week
  // and this test went on passing under a name that had stopped being true.
  await page.goto('/organizer');
  const tabs = await page
    .locator('nav a[href^="/organizer"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''));

  expect(tabs.length, 'tabs found in the organizer nav').toBeGreaterThan(10);
  expect(tabs, 'the nav still leads to the schedule').toContain('/organizer/schedule');

  // Sub-pages the nav does not link to, which are still part of the console.
  for (const path of [...tabs, '/organizer/cfp/questions', '/organizer/abstracts/book', '/organizer/evaluators/audit']) {
    await visit(page, path);
  }

  await visit(page, '/organizer/abstracts');
  const abstractHref = await firstHref(page, new RegExp(`^/organizer/abstracts/${UUID}$`));
  await visit(page, abstractHref);
  await visit(page, `${abstractHref}/history`);

  await visit(page, '/organizer/speakers');
  await visit(page, await firstHref(page, new RegExp(`^/organizer/speakers/${UUID}$`)));
});

test('the CSV exports come back as CSV, not as a page', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  for (const path of ['/organizer/abstracts/export', '/organizer/speakers/export']) {
    const file = await fetchInPage(page, path);
    expect(file.status, `GET ${path}`).toBe(200);
    expect(file.contentType, `content-type of ${path}`).toContain('text/csv');
    expect(file.body.trim().split('\n').length, `rows in ${path}`).toBeGreaterThan(1);
  }
});

test('the calendar feeds resolve as handlers, not as an agenda detail page', async ({ page }) => {
  // `/agenda/calendar.ics` sits beside `/agenda/[id]`, and a dynamic segment
  // that swallowed the literal one would 404 on a submission id of
  // "calendar.ics" — which looks exactly like an unpublished agenda. Signing in
  // as the organizer separates them: the handler answers, the detail page does
  // not.
  await signInVia(page, ORGANIZER);

  for (const path of ['/agenda/calendar.ics', '/agenda/my.ics', '/agenda/filtered.ics?day=1']) {
    const file = await fetchInPage(page, path);
    expect(file.status, `GET ${path}`).toBe(200);
    expect(file.contentType, `content-type of ${path}`).toContain('text/calendar');
    expect(file.body, `body of ${path}`).toContain('BEGIN:VCALENDAR');
  }
});

test('a speaker reaches their own hub and edit form', async ({ page }) => {
  await signInVia(page, SPEAKER);

  for (const path of ['/speaker', '/speaker/profile', '/speaker/posters', '/speaker/content']) {
    await visit(page, path);
  }

  await visit(page, '/speaker');
  await visit(page, await firstHref(page, new RegExp(`^/speaker/submissions/${UUID}/edit$`)));
});

test('a reviewer reaches the queue and the award ballot', async ({ page }) => {
  await signInVia(page, REVIEWER);
  await visit(page, '/review');
  await visit(page, '/awards/judge');
});

test('the health check answers for a signed-out probe and names what it checked', async ({
  page,
}) => {
  // A load balancer is not signed in, so this route is deliberately open. It
  // may therefore name only which check failed and never a host, a connection
  // string or a stack.
  const response = await page.goto('/healthz');
  expect(response?.status()).toBe(200);

  const body = JSON.parse(await page.locator('body').innerText());
  expect(body.status).toBe('ok');
  expect(body.checks.map((check: { name: string }) => check.name)).toEqual(['env', 'database']);
});

test('an id that is not a uuid gets a 404, not a database error', async ({ page }) => {
  // Each of these handed the raw segment to a `where id = $1` on a uuid column,
  // so Postgres raised 22P02 and the route 500'd with the query in the server
  // log. The `notFound()` below the query never ran: nothing reached it. The
  // guard belongs above the query, which is where the pages under
  // /organizer/abstracts already put it.
  for (const path of ['/agenda/nope', '/speakers/nope', '/posters/nope']) {
    const response = await page.goto(path);
    expect(response?.status(), `GET ${path}`).toBe(404);
    await expect(page.getByTestId('not-found'), `not-found page on ${path}`).toBeVisible();
  }
});

test('an address that is not a page gets our 404, not the framework default', async ({ page }) => {
  const response = await page.goto('/not-a-real-page');

  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
  // The nav is in the root layout, so a not-found.tsx that renders inside it
  // leaves the reader somewhere to go. Next's own 404 does not.
  await expect(page.getByRole('link', { name: 'Agenda' }).first()).toBeVisible();
});
