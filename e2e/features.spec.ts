import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The three features that needed schema changes: a configurable submission
 * form, review in rounds, and co-authors who can edit rather than only be
 * credited.
 *
 * This file runs before `pipeline.spec.ts` and `smoke.spec.ts`, which share the
 * same database, so anything it changes it changes back. The rounds test in
 * particular opens a round and closes it again: leaving a different round
 * active would move the queue the pipeline test grades in.
 */

const ORGANIZER = 'organizer@example.com';
const SPEAKER = 'speaker1@example.com';
const REVIEWER = 'reviewer1@example.com';
const CO_AUTHOR = 'co-author-under-test@example.com';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

// ---------------------------------------------------------------------------
// Configurable submission form
// ---------------------------------------------------------------------------

test('an organizer adds, retires and restores a form question', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/cfp/questions');

  const prompt = 'Do you need a microphone?';
  const questions = page.locator('ol > li');
  const before = await questions.count();

  // Every existing question carries the same form behind a disclosure, so the
  // add form has to be addressed through its own card rather than by label.
  const addForm = page.locator('div', { has: page.getByRole('button', { name: 'Add question' }) }).last();
  await addForm.getByLabel('Question', { exact: true }).fill(prompt);
  await addForm.getByLabel('Answer type').selectOption('checkbox');
  await addForm.getByRole('button', { name: 'Add question' }).click();

  await expect(page.getByText('Question added to the end of the form.')).toBeVisible();
  await expect(questions).toHaveCount(before + 1);
  // Added at the end, never in the middle: a question's position is what decides
  // whether an existing branch can still point at its parent.
  await expect(questions.last()).toContainText(prompt);

  // Retiring keeps the answers, so the question moves to the retired list rather
  // than leaving the page.
  await questions.last().getByRole('button', { name: 'Retire' }).click();
  await expect(page.getByText('Answers already given are kept.')).toBeVisible();
  await expect(questions).toHaveCount(before);
  await expect(page.getByText('Retired', { exact: true })).toBeVisible();

  await page
    .locator('li', { hasText: prompt })
    .getByRole('button', { name: 'Restore' })
    .click();
  await expect(questions).toHaveCount(before + 1);

  // Put the form back the way the other files expect to find it.
  await questions.last().getByRole('button', { name: 'Retire' }).click();
  await expect(questions).toHaveCount(before);
});

test('the submission form shows and hides questions as the speaker answers', async ({ page }) => {
  await page.goto('/cfp');

  const custom = page.getByTestId('custom-questions');
  const branch = custom.getByLabel('Where, and roughly when? *');
  const workshopOnly = custom.getByLabel('How much of the room needs to be at a keyboard? *');

  // Asked of everyone, whatever else is filled in.
  await expect(custom.getByLabel('What will the audience be able to do afterwards? *')).toBeVisible();

  // A branch is not merely disabled, it is not rendered: a hidden answer that
  // still posted could be revived by the branch reopening later.
  await expect(branch).toHaveCount(0);
  await custom.getByText('Have you given this talk before?').click();
  await expect(branch).toBeVisible();
  await custom.getByText('Have you given this talk before?').click();
  await expect(branch).toHaveCount(0);

  // The other narrowing rule is the format, and it applies independently.
  await expect(workshopOnly).toHaveCount(0);
  await page.getByTestId('cfp-format').selectOption('workshop_90');
  await expect(workshopOnly).toBeVisible();
  await page.getByTestId('cfp-format').selectOption('talk_25');
  await expect(workshopOnly).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Review rounds
// ---------------------------------------------------------------------------

test('a round opened by an organizer becomes the queue a reviewer grades in', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/cfp');

  // The fixture has a closed first pass and an open shortlist, so both states
  // are on screen before anything is pressed.
  const rounds = page.locator('li[data-testid^="round-"]');
  await expect(rounds).toHaveCount(2);
  await expect(rounds.first()).toContainText('closed');
  await expect(rounds.last()).toContainText('open');

  await page.getByTestId('round-name').fill('Round 3 (final)');
  await page.getByTestId('open-round').click();
  await expect(page.getByText('New grades land in it from now on.')).toBeVisible();
  await expect(rounds).toHaveCount(3);

  // The furthest-along open round is the one grading happens in, so the queue
  // follows without a reviewer being told anything.
  await signInVia(page, REVIEWER);
  await page.goto('/review');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Round 3 (final)');

  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/cfp');
  await page
    .locator('li[data-testid^="round-"]', { hasText: 'Round 3 (final)' })
    .getByRole('button', { name: 'Close round' })
    .click();
  await expect(page.getByText('Its scores are kept.')).toBeVisible();

  // Closing hands the queue back to the shortlist rather than to nothing, and
  // the closed round keeps its row: the scores are the record.
  await expect(page.locator('li[data-testid^="round-"]')).toHaveCount(3);
  await signInVia(page, REVIEWER);
  await page.goto('/review');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Round 2 (shortlist)');
});

// ---------------------------------------------------------------------------
// Co-author access
// ---------------------------------------------------------------------------

test('a co-author granted access can edit the proposal but not withdraw it', async ({ page }) => {
  await signInVia(page, SPEAKER);
  await page.goto('/speaker');

  const card = page.locator('[data-testid^="submission-card-"]').first();
  const title = (await card.locator('h2').first().innerText()).trim();

  const editUrl = await card.locator('[data-testid^="edit-"]').first().getAttribute('href');
  expect(editUrl, 'no edit link on the speaker hub').toBeTruthy();
  await page.goto(editUrl!);
  await expect(page.getByRole('heading', { name: 'Edit submission' })).toBeVisible();

  await page.getByLabel('Co-author email').fill(CO_AUTHOR);
  await page.getByLabel('Name', { exact: true }).fill('Casey Co-author');
  await page.getByTestId('grant-edit').check();
  await page.getByRole('button', { name: 'Add co-author' }).click();

  await expect(page.getByText(`${CO_AUTHOR} is credited on this submission.`)).toBeVisible();
  const row = page.locator('li', { hasText: CO_AUTHOR });
  await expect(row).toContainText('can edit');

  // The co-author now reaches the proposal from their own hub, which is the
  // whole point: crediting is a name, access is a second decision.
  await signInVia(page, CO_AUTHOR);
  await page.goto('/speaker');
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.locator('[data-testid^="coauthor-"]').first()).toBeVisible();

  // Withdrawing and confirming attendance stay with the filer, so the button is
  // absent rather than present and refused.
  await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);

  const response = await page.goto(editUrl!);
  expect(response?.status(), editUrl!).toBeLessThan(400);
  await expect(page.getByRole('heading', { name: 'Edit submission' })).toBeVisible();
  // Access is the filer's to hand out, so a co-author is not offered the toggle.
  await expect(page.getByTestId('grant-edit')).toHaveCount(0);

  // Revoked, the proposal disappears from their hub entirely.
  await signInVia(page, SPEAKER);
  await page.goto(editUrl!);
  await page.locator('li', { hasText: CO_AUTHOR }).getByRole('button', { name: 'Revoke editing' }).click();
  await expect(page.getByText('can no longer edit this proposal.')).toBeVisible();

  await signInVia(page, CO_AUTHOR);
  const denied = await page.goto(editUrl!);
  expect(denied?.status(), editUrl!).toBe(404);
});
