import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The one-way push to Accelevents.
 *
 * Nothing in this file reaches the network. The suite never sets
 * ACCELEVENTS_BASE_URL, so every run here goes through the fixture transport,
 * and the first test asserts that rather than assuming it. A test that quietly
 * started hitting a real endpoint would be hitting somebody's live event.
 *
 * Sorts before `schedule.spec.ts`, so it places its own talk rather than
 * relying on one being on the grid, and clears it again.
 */

const ORGANIZER = 'organizer@example.com';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

/** Put the first unplaced talk into the first empty box. Returns its title. */
async function placeFirstFromPool(page: Page): Promise<string> {
  await page.goto('/organizer/schedule');
  await page.getByTestId('add-band').click();
  const item = page.locator('[data-testid^="pool-"]').first();
  const title = (await item.locator('span').first().innerText()).trim();
  await item.click();
  await page.locator('[data-testid^="slot-"]').filter({ hasText: 'empty' }).first().click();
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(1);
  return title;
}

async function unplace(page: Page, title: string) {
  await page.goto('/organizer/schedule');
  await page.locator('[data-testid^="slot-"]').filter({ hasText: title }).getByText('remove').click();
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(0);
}

async function runExport(page: Page) {
  await page.goto('/organizer/integrations');
  await page.getByTestId('run-export').click();
  await expect(page.getByTestId('run-detail')).toBeVisible();
}

/**
 * Fetch from inside the page rather than through `page.request`.
 *
 * The session cookie is `Secure` and Chromium sends it to `http://127.0.0.1`
 * because loopback counts as a trustworthy origin. Playwright's own HTTP client
 * is a separate client that applies the rule strictly, so `page.request.get`
 * arrives signed out and the bundle comes back 403 for the wrong reason.
 * `page.goto` is not the alternative either: the response carries
 * `content-disposition: attachment`, which aborts a navigation.
 */
async function fetchInPage(page: Page, path: string) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'include' });
    return {
      status: response.status,
      disposition: response.headers.get('content-disposition') ?? '',
      body: await response.text(),
    };
  }, path);
}

test('a dry run rehearses the whole programme without leaving the machine', async ({ page }) => {
  await signIn(page, ORGANIZER);

  const title = await placeFirstFromPool(page);

  // Reached from the nav, like an organizer would.
  await page.goto('/organizer');
  await page.getByRole('link', { name: 'Accelevents', exact: true }).click();
  await expect(page).toHaveURL(/\/organizer\/integrations$/);

  // Dry run is not a claim the test takes on trust: it is the state of the
  // screen, and it names what would have to be set for the button to reach a
  // real endpoint.
  await expect(page.getByTestId('integration-mode')).toHaveText('Dry run');
  await expect(page.getByTestId('integration-target')).toHaveText('no endpoint configured');
  await expect(page.getByTestId('dry-run-explainer')).toContainText('ACCELEVENTS_BASE_URL');
  await expect(page.getByTestId('dry-run-explainer')).toContainText('ACCELEVENTS_API_KEY');

  await runExport(page);
  await expect(page.getByTestId('run-status')).toHaveText('ok');

  // Tracks, speakers and the session just placed. Every request came back 200
  // from the fixture, which is what makes the rehearsal worth running: the
  // responses were parsed and the remote ids recorded, not skipped.
  const requests = page.getByTestId('run-requests').locator('li');
  const count = await requests.count();
  expect(count).toBeGreaterThan(3);
  await expect(page.getByTestId('run-request-count')).toHaveText(String(count));
  await expect(page.getByTestId('run-requests')).toContainText(title);
  await expect(page.getByTestId('run-requests')).toContainText('/sessions/external/');
  await expect(page.getByTestId('run-requests')).toContainText('/speakers/external/');
  await expect(page.getByTestId('run-requests')).toContainText('/tracks/external/');
  await expect(page.getByTestId('run-requests').getByText('→ ae_')).not.toHaveCount(0);

  await unplace(page, title);
});

test('the bundle is downloadable and carries no credential', async ({ page }) => {
  await signIn(page, ORGANIZER);

  const title = await placeFirstFromPool(page);
  await runExport(page);

  const href = await page.getByTestId('run-bundle-link').getAttribute('href');
  const response = await fetchInPage(page, href!);
  expect(response.status).toBe(200);
  expect(response.disposition).toContain('attachment');

  const raw = response.body;
  const bundle = JSON.parse(raw) as {
    mode: string;
    baseUrl: string | null;
    requests: { path: string; body: Record<string, unknown>; remoteId: string | null }[];
  };

  expect(bundle.mode).toBe('dry_run');
  expect(bundle.baseUrl).toBeNull();

  // The key is never written to a run, so there is nothing to redact. This
  // asserts the property rather than the redaction, because a redactor is one
  // more thing that can be forgotten on a field added later.
  expect(raw.toLowerCase()).not.toContain('authorization');
  expect(raw.toLowerCase()).not.toContain('api_key');
  expect(raw.toLowerCase()).not.toContain('bearer');

  // Times go out as instants, not wall clocks. A naive string would be read in
  // whatever timezone the far end thinks the event is in.
  const session = bundle.requests.find((r) => r.path.includes('/sessions/external/'));
  expect(session, 'a session request').toBeTruthy();
  expect(String(session!.body.startTime)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  expect(session!.body.title).toBe(title);
  expect(session!.remoteId).toMatch(/^ae_session_/);

  // Only what is on the schedule goes. An accepted talk still sitting in the
  // pool has no time to send, and this export is of the programme rather than
  // of the submission pile.
  await page.goto('/organizer/schedule');
  const stillPooled = (
    await page.locator('[data-testid^="pool-"]').first().locator('span').first().innerText()
  ).trim();
  expect(stillPooled).not.toBe(title);
  expect(raw).not.toContain(stillPooled);

  await unplace(page, title);
});

test('a speaker with no name fails the dry run instead of the live one', async ({ page }) => {
  await signIn(page, ORGANIZER);

  // The chase list is the quickest route to a speaker with an accepted talk.
  await page.goto('/organizer/speakers?filter=accepted');
  const speaker = page.getByTestId(/^roster-/).first().getByRole('link').first();
  const href = await speaker.getAttribute('href');
  await page.goto(href!);

  const nameField = page.getByTestId('profile-name');
  const original = await nameField.inputValue();
  expect(original).not.toBe('');

  await nameField.fill('');
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-saved')).toBeVisible();

  await runExport(page);
  await expect(page.getByTestId('run-status')).toHaveText('failed');
  await expect(page.getByTestId('run-requests')).toContainText('requires firstName on a speaker');

  // This is what the rehearsal is for. Billing that person as their email
  // address would have been the alternative, and nobody would have noticed
  // until the public programme was already published on the other side.
  await page.goto(href!);
  await nameField.fill(original);
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-saved')).toBeVisible();

  await runExport(page);
  await expect(page.getByTestId('run-status')).toHaveText('ok');

  // Two dry runs and a failure are all still on the list. A run is never
  // deleted, because "what did we send them" is the first question asked when
  // two systems disagree.
  await expect(page.getByTestId('run-list').locator('li')).not.toHaveCount(0);
});
