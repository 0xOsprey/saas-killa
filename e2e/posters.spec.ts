import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * Auto-numbering the poster boards.
 *
 * The sweep is total by design: numbering only the blanks would leave two
 * posters sharing a board, which is worse than a number somebody has to type
 * back in. So the guard is a confirmation rather than a skip, and it only
 * appears once there is a number to lose. This file proves both halves, in
 * that order, because the fixture starts with every board blank.
 *
 * It clears the numbers again on the way out. Board numbers show on the public
 * gallery, and `posters` runs before `review`, `schedule` and `smoke`.
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

const boardInputs = (page: Page) => page.locator('input[name="boardNumber"]');

test('auto-numbering runs on a blank hall and asks before overwriting one', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/posters');

  const count = await boardInputs(page).count();
  expect(count, 'accepted posters in the fixture').toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    await expect(boardInputs(page).nth(i), `board ${i} starts blank`).toHaveValue('');
  }

  // Nothing is numbered, so there is nothing to lose and no reason to ask.
  await page.getByTestId('auto-number-boards').click();
  await expect(page.getByTestId('confirm-renumber')).toHaveCount(0);
  await expect(boardInputs(page).first()).toHaveValue('1');

  // Now a hand-set number, the case the venue creates: the board already has
  // "P7" printed on it and the organizer types that in.
  await boardInputs(page).first().fill('P7');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(boardInputs(page).first()).toHaveValue('P7');

  // The second sweep asks, and asking is not doing.
  await page.getByTestId('auto-number-boards').click();
  await expect(page.getByTestId('confirm-renumber')).toBeVisible();
  await expect(boardInputs(page).first()).toHaveValue('P7');

  await page.getByTestId('confirm-renumber-submit').click();
  await expect(page.getByTestId('confirm-renumber')).toHaveCount(0);
  // Reload before reading the field. The board inputs are uncontrolled, so a
  // value typed by hand survives a client-side re-render even after the server
  // has changed the row underneath it; the database is right and the box on
  // screen is stale until the page is fetched again.
  await page.reload();
  await expect(boardInputs(page).first()).toHaveValue('1');

  // Blank again for the files that run after this one.
  for (let i = 0; i < count; i += 1) {
    await boardInputs(page).nth(i).fill('');
    await page.getByRole('button', { name: 'Save' }).nth(i).click();
  }
  for (let i = 0; i < count; i += 1) {
    await expect(boardInputs(page).nth(i), `board ${i} left blank`).toHaveValue('');
  }
});
