import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * `/speaker/content`, on the two things it said it did and did not.
 *
 * Both defects were silent. A co-author's Save reported success and wrote
 * nothing, and editing approved content rewrote a live URL without ever asking
 * an organizer to look at it again. Neither shows up as an error anywhere: the
 * only way to see either is to write the value, come back, and read it.
 *
 * The talk under test is `speaker1`'s, with `speaker6` credited on it holding
 * `can_edit`. Every test here puts the content columns back to empty and the
 * status back to draft, which is where the seed leaves them.
 */

const FILER = 'speaker1@example.com';
const COAUTHOR = 'speaker6@example.com';
const ORGANIZER = 'organizer@example.com';
const TALK = 'Rebuilding our review pipeline (1)';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

/** The content card for the talk under test, and the submission id off it. */
async function contentCard(page: Page) {
  const card = page.getByTestId(/^content-[0-9a-f]{8}-/).filter({ hasText: TALK });
  await expect(card).toHaveCount(1);
  const id = (await card.getAttribute('data-testid'))!.replace('content-', '');
  return { card, id };
}

/**
 * Approve the content on one submission from the organizer board.
 *
 * The button lives inside the row's "Content and locks" `<details>`, so it is
 * in the DOM but not visible until the disclosure is opened. It unmounts once
 * the content is approved, which is the signal that the action landed.
 */
async function approveContent(page: Page, id: string) {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/submissions');
  const row = page.getByTestId(`submission-${id}`);
  await row.getByText('Content and locks').click();
  await row.getByTestId(`content-approve-${id}`).click();
  await expect(row.getByTestId(`content-approve-${id}`)).toBeHidden();
}

async function clearContent(page: Page) {
  await page.goto('/speaker/content');
  const { card } = await contentCard(page);
  await card.getByLabel('Slides URL').fill('');
  await card.getByLabel('Recording URL').fill('');
  await card.getByLabel('Resources').fill('');
  await card.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('content-flash')).toBeVisible();
}

test('a co-author holding can_edit actually writes, rather than being told they did', async ({
  page,
}) => {
  const note = 'Co-author wrote this.';
  await signInVia(page, COAUTHOR);
  await page.goto('/speaker/content');

  // The co-author reaches the screen at all, which is what made the bug so
  // quiet: every gate on this page admitted them except the UPDATE.
  const { card } = await contentCard(page);
  await card.getByLabel('Resources').fill(note);
  await card.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('content-flash')).toContainText('Saved.');

  // The assertion the old scope failed. `?saved=1` was reported either way;
  // only a re-read tells you whether the row moved.
  await page.goto('/speaker/content');
  const { card: reloaded } = await contentCard(page);
  await expect(reloaded.getByLabel('Resources')).toHaveValue(note);

  // And the filer sees the same row, because it is one row.
  await signInVia(page, FILER);
  await page.goto('/speaker/content');
  const { card: asFiler } = await contentCard(page);
  await expect(asFiler.getByLabel('Resources')).toHaveValue(note);

  await clearContent(page);
});

test('editing approved content sends it back to draft, as the screen promises', async ({
  page,
}) => {
  const first = 'https://example.com/recording-one';
  const second = 'https://example.com/recording-two';

  await signInVia(page, FILER);
  await page.goto('/speaker/content');
  const { card, id } = await contentCard(page);
  await card.getByLabel('Recording URL').fill(first);
  await card.getByTestId(`submit-review-${id}`).click();
  await expect(page.getByTestId(`content-status-${id}`)).toHaveText(/review/i);

  await approveContent(page, id);

  await signInVia(page, FILER);
  await page.goto('/speaker/content');
  const { card: approved } = await contentCard(page);
  await expect(approved).toContainText('Approved and live on the agenda');

  // The promise in that sentence, kept. Before this, `saveContentDraft` never
  // called `setContentStatus`, so the URL changed under a status that still
  // said approved and the new recording published with no organizer pass.
  await approved.getByLabel('Recording URL').fill(second);
  await approved.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('content-flash')).toContainText('taken off the public agenda');
  await expect(page.getByTestId(`content-status-${id}`)).toHaveText(/draft/i);

  const { card: afterEdit } = await contentCard(page);
  await expect(afterEdit.getByLabel('Recording URL')).toHaveValue(second);

  // Saving an untouched form is not an edit and must not unpublish anything.
  // Re-approve, press Save with nothing changed, and the status has to hold.
  await approved.getByTestId(`submit-review-${id}`).click();
  await expect(page.getByTestId(`content-status-${id}`)).toHaveText(/review/i);
  await approveContent(page, id);

  await signInVia(page, FILER);
  await page.goto('/speaker/content');
  const { card: stillApproved } = await contentCard(page);
  await stillApproved.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('content-flash')).toContainText('Saved.');
  await expect(page.getByTestId(`content-status-${id}`)).toHaveText(/approved/i);

  await clearContent(page);
  await expect(page.getByTestId(`content-status-${id}`)).toHaveText(/draft/i);
});
