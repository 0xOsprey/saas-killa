import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * `/awards` is public, and its nominee list is restricted to accepted
 * submissions with each one rendered next to its speaker's name. Ungated, that
 * page is the acceptance list, published before the organizers chose to
 * announce it: with `agenda_published` false, `/agenda` said "not published"
 * while `/awards` listed eight accepted titles and their speakers.
 *
 * This file sorts first in the alphabetical order the suite runs in, which is
 * the one point where the seed's unpublished agenda is still intact for a whole
 * file. It signs in but writes no row, so it leaves the fixture as it found it.
 */

const ORGANIZER = 'organizer@example.com';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

test('an unpublished agenda hides the nominees from everyone but an organizer', async ({
  page,
}) => {
  // The neighbouring gate, as the baseline the awards page has to match.
  await page.goto('/agenda');
  await expect(page.locator('body')).toContainText('not published yet');

  await page.goto('/awards');
  await expect(page.getByTestId(/^award-/)).toHaveCount(0);
  const signedOutBody = (await page.locator('body').innerText()).toLowerCase();

  // Same page as the organizer: the gate lets them through, exactly as
  // `/agenda` and `/speakers` do, so the console still works before announcing.
  await signInVia(page, ORGANIZER);
  await page.goto('/awards');
  const cards = page.getByTestId(/^award-/);
  await expect(cards.first()).toBeVisible();

  const titles = await page
    .locator('[data-testid^="award-"] a[href^="/agenda/"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));
  expect(titles.length, 'nominated titles visible to the organizer').toBeGreaterThan(0);

  // The assertion the leak failed: not one of those titles reached the public
  // page. Counting cards alone would pass on a page that dropped the wrapper
  // and kept the list.
  for (const title of titles) {
    expect(signedOutBody, `"${title}" leaked to a signed-out visitor`).not.toContain(
      title.toLowerCase(),
    );
  }
});
