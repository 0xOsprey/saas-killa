import { expect, test } from '@playwright/test';
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
