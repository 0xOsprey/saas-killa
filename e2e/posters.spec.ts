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
const CO_AUTHOR = 'poster-co-author@example.com';

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

/**
 * Who may upload the artwork.
 *
 * `/speaker` lists a co-author's poster, because `mySubmissions` asks
 * `writableBy`, and the link beside it led to a page that asked
 * `speakerId = me` and answered "you have no poster submissions". Admitted at
 * every gate but one, and the one refused without saying why.
 *
 * The grant is made in two steps on purpose. Being credited is not being given
 * access, so the same account is checked before and after `can_edit` is set and
 * only the second visit may see the poster.
 */
test('a co-author with can_edit reaches the poster page, and a credited one does not', async ({
  page,
}) => {
  await signInVia(page, ORGANIZER);

  // Whichever poster the fixture puts first, found the way the organizer would.
  await page.goto('/organizer/posters');
  const posterId = (await page
    .locator('[data-testid^="board-form-"]')
    .first()
    .getAttribute('data-testid'))!.replace('board-form-', '');
  expect(posterId, 'a poster in the fixture').toMatch(/^[0-9a-f]{8}-/);

  // The board row carries "Name · email", which is the only screen that names
  // the filer's address. Deriving it from the seed instead would tie this test
  // to which speaker the fixture's PRNG happens to hand the first poster.
  await page.goto(`/organizer/submissions?q=${posterId}`);
  const row = await page.getByTestId(`submission-${posterId}`).innerText();
  const filer = /[\w.+-]+@example\.com/.exec(row)?.[0];
  expect(filer, `no speaker email on the board row for ${posterId}`).toBeTruthy();

  const editUrl = `/speaker/submissions/${posterId}/edit`;
  await signInVia(page, filer!);
  await page.goto(editUrl);
  await page.getByLabel('Co-author email').fill(CO_AUTHOR);
  await page.getByLabel('Name', { exact: true }).fill('Robin Poster');
  await page.getByRole('button', { name: 'Add co-author' }).click();
  await expect(page.getByText(`${CO_AUTHOR} is credited on this submission.`)).toBeVisible();

  // Credited only. The poster is not theirs to change and the page says so by
  // not offering it at all.
  await signInVia(page, CO_AUTHOR);
  await page.goto('/speaker/posters');
  await expect(page.getByTestId(`poster-url-${posterId}`)).toHaveCount(0);
  await expect(page.getByText('You have no poster submissions.')).toBeVisible();

  await signInVia(page, filer!);
  await page.goto(editUrl);
  await page
    .locator('li', { hasText: CO_AUTHOR })
    .getByRole('button', { name: 'Let them edit' })
    .click();
  await expect(page.locator('li', { hasText: CO_AUTHOR })).toContainText('can edit');

  await signInVia(page, CO_AUTHOR);
  await page.goto('/speaker/posters');
  const field = page.getByTestId(`poster-url-${posterId}`);
  await expect(field).toBeVisible();

  // The write, not only the read. A refusal here is a redirect to
  // `?error=refused`, so asserting the saved notice and the absence of the error
  // is asserting that the UPDATE matched a row rather than none.
  const original = await field.inputValue();
  const replacement = 'https://example.org/e2e-co-author-poster.pdf';
  await field.fill(replacement);
  await page.getByRole('button', { name: 'Save poster' }).click();
  await expect(page.getByTestId('poster-error')).toHaveCount(0);
  await expect(page.getByText('Poster saved.')).toBeVisible();
  await page.goto('/speaker/posters');
  await expect(page.getByTestId(`poster-url-${posterId}`)).toHaveValue(replacement);

  // Put the artwork back: the gallery renders it and smoke.spec.ts runs later.
  await page.getByTestId(`poster-url-${posterId}`).fill(original);
  await page.getByRole('button', { name: 'Save poster' }).click();
  await page.goto('/speaker/posters');
  await expect(page.getByTestId(`poster-url-${posterId}`)).toHaveValue(original);

  // Revoked, it leaves their page again, which is the same predicate read the
  // other way round.
  await signInVia(page, filer!);
  await page.goto(editUrl);
  await page
    .locator('li', { hasText: CO_AUTHOR })
    .getByRole('button', { name: 'Revoke editing' })
    .click();
  await expect(page.getByText('can no longer edit this proposal.')).toBeVisible();
  await page.locator('li', { hasText: CO_AUTHOR }).getByRole('button', { name: 'Remove' }).click();

  await signInVia(page, CO_AUTHOR);
  await page.goto('/speaker/posters');
  await expect(page.getByTestId(`poster-url-${posterId}`)).toHaveCount(0);
});
