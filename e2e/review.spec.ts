import { expect, test, type Browser, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The two defects that compound: the fallback queue offered a reviewer their own
 * proposal, and every refusal in `submitReview` was a bare `return`. Together
 * that is a reviewer pressing Grade on their own abstract and the page coming
 * back identical, with no score recorded and nothing said.
 *
 * State this file changes and restores: `speaker9` is granted the reviewer role
 * and it is revoked again, and one submission is accepted and then undecided.
 * `setDecision` writes only `status` and `updatedAt` and mails nobody, so the
 * undecide is a real restore rather than an approximation of one.
 */

const ORGANIZER = 'organizer@example.com';
const REVIEWER = 'reviewer1@example.com';
/** A speaker with an open proposal, promoted to the committee inside this file. */
const SUBMITTER = 'speaker9@example.com';
const THEIR_TALK = 'Scaling a database under real load (33)';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

/**
 * A second signed-in browser, so one person can act while another holds a page
 * open. The refusal below is only reachable that way: the state has to change
 * under a form that has already rendered.
 */
async function asOrganizer(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInVia(page, ORGANIZER);
  return { context, page };
}

test('the fallback queue does not offer a reviewer their own proposal', async ({
  page,
  browser,
  baseURL,
}) => {
  const organizer = await asOrganizer(browser, baseURL);
  await organizer.page.goto('/organizer/speakers');
  await organizer.page.getByTestId(`grant-reviewer-${SUBMITTER}`).click();
  await expect(organizer.page.getByTestId(`grant-reviewer-${SUBMITTER}`)).toBeHidden();

  // No assignments exist for this person, so `/review` takes the
  // `openSubmissionQueue` fallback, which is the path that had no exclusion.
  await signInVia(page, SUBMITTER);
  await page.goto('/review');
  const cards = page.getByTestId(/^review-card-/);
  expect(await cards.count(), 'other proposals are still offered').toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText(THEIR_TALK);

  // Put the roster back. The revoke chip carries no testid of its own, so it is
  // reached through the roster card that names this person.
  await organizer.page.goto('/organizer/speakers');
  await organizer.page
    .getByTestId(/^roster-/)
    .filter({ hasText: SUBMITTER })
    .getByRole('button', { name: 'reviewer ✕' })
    .click();
  await expect(organizer.page.getByTestId(`grant-reviewer-${SUBMITTER}`)).toBeVisible();
  await organizer.context.close();
});

test('a grade that cannot be recorded says why instead of vanishing', async ({
  page,
  browser,
  baseURL,
}) => {
  await signInVia(page, REVIEWER);
  await page.goto('/review');
  const card = page.getByTestId(/^review-card-/).first();
  const id = (await card.getAttribute('data-testid'))!.replace('review-card-', '');

  // Decide it out from under the rendered form. A reviewer with the queue open
  // in a tab is the ordinary way this happens.
  const organizer = await asOrganizer(browser, baseURL);
  await organizer.page.goto('/organizer/submissions');
  const row = organizer.page.getByTestId(`submission-${id}`);
  await organizer.page.getByTestId(`accept-${id}`).click();
  // Accept stays on screen and only changes style once it is the live decision,
  // so the signal that the write landed is Undecide appearing beside it.
  await expect(row.getByRole('button', { name: 'Undecide' })).toBeVisible();

  // The press that used to do nothing at all: no message, no redirect, no
  // revalidate, and four criteria and a comment gone.
  await card.getByTestId(`grade-${id}`).click();
  await expect(page.getByTestId('grade-refusal')).toContainText('already been decided');

  await organizer.page.goto('/organizer/submissions');
  await row.getByRole('button', { name: 'Undecide' }).click();
  await expect(row.getByRole('button', { name: 'Undecide' })).toBeHidden();
  await organizer.context.close();
});
