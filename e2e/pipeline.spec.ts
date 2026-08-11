import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * One pass down the whole pipeline: submit, grade, accept, notify, schedule,
 * publish, read the public agenda. It is deliberately a single test rather than
 * seven, because each stage's precondition is the previous stage's output and
 * splitting them would only mean re-driving the earlier stages seven times.
 */

const RUN = Date.now();
const SPEAKER_EMAIL = `e2e-speaker-${RUN}@example.com`;
const SPEAKER_NAME = `Bernice Testcase ${RUN}`;
const TITLE = `Retiring the batch job that outlived its author ${RUN}`;
const ABSTRACT =
  'We ran a nightly reconciliation job for eleven years after the person who wrote it left. ' +
  'This talk covers how we worked out what it actually did, the two downstream systems that ' +
  'turned out to depend on a side effect nobody documented, and the four-month path to deleting it. ' +
  'You will leave with a method for auditing a job you are afraid to turn off.';

const TAKEAWAY = `Audit one job they are afraid of and delete a consumer of it ${RUN}`;

const ORGANIZER_EMAIL = 'organizer@example.com';

async function signOut(page: Page) {
  // Click the real control rather than hitting the route directly: sign-out is
  // POST-only, and driving it through the nav is what proves that still works.
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('current-user')).toHaveCount(0);
}

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

test('a proposal travels from the CFP to the published agenda', async ({ page }) => {
  // 1. Submit ---------------------------------------------------------------
  await page.goto('/cfp');
  await page.getByTestId('cfp-email').fill(SPEAKER_EMAIL);
  await page.getByTestId('cfp-name').fill(SPEAKER_NAME);
  await page.getByTestId('cfp-title').fill(TITLE);
  await page.getByTestId('cfp-abstract').fill(ABSTRACT);
  await page.getByTestId('cfp-format').selectOption('talk_45');
  // The form carries the organizer's own questions now, and one of them is
  // required. A submission that skips it never reaches the queue.
  await page
    .getByTestId('custom-questions')
    .getByLabel('What will the audience be able to do afterwards? *')
    .fill(TAKEAWAY);
  await page.getByTestId('cfp-submit').click();

  await expect(page.getByTestId('submitted-confirmation')).toBeVisible();
  await expect(page.getByText(TITLE)).toBeVisible();

  // A first-time submitter gets a sign-in link so the submission is not
  // stranded behind an account they never knowingly created.
  await waitForMail((m) => m.to === SPEAKER_EMAIL && m.subject.includes('sign-in link'));

  // 2. Grade, as the organizer (who also holds the reviewer role) ------------
  await signOut(page);
  await signInVia(page, ORGANIZER_EMAIL);

  await page.goto('/review');
  const card = page.locator('[data-testid^="review-card-"]').filter({ hasText: TITLE });
  await expect(card).toHaveCount(1);

  // Blind review is the property under test here, not the wording on the page:
  // the reviewer screen must not carry the speaker's name at all.
  await expect(page.locator('body')).not.toContainText(SPEAKER_NAME);

  // The answers travel with the proposal. A committee that grades on a question
  // the organizer added has to be able to read what was answered.
  await expect(card.getByTestId('answers')).toContainText(TAKEAWAY);

  // A grade is now four criterion scores, not one. The stored `reviews.score` is
  // their weighted mean, so every criterion has to be 5 for the card to report 5.
  for (const criterion of ['clarity', 'originality', 'relevance', 'credibility']) {
    await card.locator(`[data-testid^="score-${criterion}-"]`).selectOption('5');
  }
  await card.locator('[data-testid^="grade-"]').click();
  await expect(card.locator('[data-testid^="my-score-"]')).toContainText('you scored 5');

  // 3. Accept ---------------------------------------------------------------
  // Searched for rather than scrolled to. The board pages at 25 and sorts by
  // average grade, so a proposal filed a minute ago carrying one review is not
  // on the first page of a call for papers of any size.
  await page.goto(`/organizer/submissions?q=${encodeURIComponent(TITLE)}`);
  const row = page.locator('[data-testid^="submission-"]').filter({ hasText: TITLE });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(SPEAKER_EMAIL);
  await row.locator('[data-testid^="accept-"]').click();
  await expect(row).toContainText('Accepted');

  // 4. Notify ---------------------------------------------------------------
  await page.getByTestId('notify-decided').click();
  const acceptance = await waitForMail(
    (m) => m.to === SPEAKER_EMAIL && m.subject.startsWith('Accepted:'),
  );
  expect(acceptance.body).toContain(TITLE);
  await expect(
    page.locator('[data-testid^="submission-"]').filter({ hasText: TITLE }),
  ).toContainText('speaker notified');

  // Pressing send again must not mail anybody twice.
  await expect(page.getByTestId('notify-decided')).toBeDisabled();

  // 4b. Read the receipt ----------------------------------------------------
  // "Did that go out" used to be answerable only in psql: every send wrote an
  // `email_log` row and no screen read the table. The acceptance was not even
  // in it, because the decision mail alone went through `sendMail`.
  await page.goto('/organizer/email');
  // Matched on the subject of the mail this test actually read out of `.mail/`,
  // so the row is the receipt for that send and not for the "received" mail the
  // same submission produced an hour of test-time earlier.
  const receipt = page
    .locator('[data-testid^="email-row-"]')
    .filter({ hasText: acceptance.subject });
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toContainText('decision_accepted');
  await expect(receipt).toContainText(SPEAKER_EMAIL);
  await expect(receipt).toContainText('not sent'); // RESEND_API_KEY is unset under test.
  // Which reason, not just that there is one. The notice has two branches now
  // and the other one names MAIL_NOTIFICATIONS, so a screen that reported the
  // wrong cause would send its reader to edit a variable that is already right.
  await expect(page.getByTestId('mail-not-live')).toContainText('RESEND_API_KEY');

  // 5. Schedule -------------------------------------------------------------
  await page.goto('/organizer/schedule');
  await page.getByTestId('add-band').click();

  const poolItem = page.locator('[data-testid^="pool-"]').filter({ hasText: TITLE });
  await expect(poolItem).toHaveCount(1);
  await poolItem.click();

  // Click-to-place rather than drag. Both call the same server action, and this
  // file is about the pipeline; the drag itself is driven in `schedule.spec.ts`.
  const emptySlot = page.locator('[data-testid^="slot-"]').filter({ hasText: 'empty' }).first();
  await emptySlot.click();

  await expect(
    page.locator('[data-testid^="slot-"]').filter({ hasText: TITLE }),
  ).toHaveCount(1);
  await expect(page.locator('[data-testid^="pool-"]').filter({ hasText: TITLE })).toHaveCount(0);

  // 6. Publish --------------------------------------------------------------
  await page.getByTestId('toggle-publish').click();
  await expect(page.getByTestId('toggle-publish')).toHaveText('Unpublish agenda');

  // 7. Read it as the public ------------------------------------------------
  await signOut(page);
  await page.goto('/agenda');
  const agendaLink = page.getByRole('link', { name: TITLE });
  await expect(agendaLink).toBeVisible();

  await agendaLink.click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(page.getByText(SPEAKER_NAME)).toBeVisible();
  await expect(page.getByText(ABSTRACT.slice(0, 60))).toBeVisible();
});

test('an undecided proposal is not reachable from the public agenda', async ({ page }) => {
  // A signed-out visitor must not be able to read an undecided proposal by
  // guessing its detail URL, because that would leak a decision the committee
  // has not made.
  //
  // The proposal is filed here rather than picked off the organizer's dashboard.
  // Taking the first row assumed the fixture decided nothing, which stopped
  // being true once the seed started accepting work, and the test then passed
  // an accepted talk to a published agenda and read a legitimate 200. Filing one
  // makes the precondition the test's own rather than the fixture's.
  const title = `Instrumenting a job nobody owns ${Date.now()}`;
  await page.goto('/cfp');
  await page.getByTestId('cfp-email').fill(`e2e-undecided-${Date.now()}@example.com`);
  await page.getByTestId('cfp-name').fill('Undecided Testcase');
  await page.getByTestId('cfp-title').fill(title);
  await page.getByTestId('cfp-abstract').fill(ABSTRACT);
  await page.getByTestId('cfp-format').selectOption('talk_25');
  await page
    .getByTestId('custom-questions')
    .getByLabel('What will the audience be able to do afterwards? *')
    .fill('Name the consumers of a job they cannot switch off.');
  await page.getByTestId('cfp-submit').click();
  await expect(page.getByTestId('submitted-confirmation')).toBeVisible();

  await signInVia(page, ORGANIZER_EMAIL);
  await page.goto(`/organizer/submissions?q=${encodeURIComponent(title)}`);
  const row = page.locator('[data-testid^="submission-"]').filter({ hasText: title });
  const testId = await row.getAttribute('data-testid');
  const submissionId = testId!.replace('submission-', '');

  await signOut(page);
  const response = await page.goto(`/agenda/${submissionId}`);
  expect(response?.status()).toBe(404);
});

test('the review queue refuses a signed-out visitor', async ({ page }) => {
  await page.goto('/review');
  await expect(page).toHaveURL(/\/login/);
});

/**
 * The back button, filed twice.
 *
 * Verified end to end with scripting off before the fix: file a proposal from
 * /cfp, press browser back, find the form still populated, press submit again,
 * and /organizer/abstracts showed two submissions with one title from one
 * speaker. Reviewers then graded the same talk twice with no sign the two rows
 * were one.
 *
 * Driven with `javaScriptEnabled: false` deliberately. It is the configuration
 * the defect was found in — a scripted form disables its own button on submit,
 * so the client hides the case the server has to handle anyway — and this app
 * supports the whole CFP without script.
 *
 * The failure has to reach `CfpState.error` rather than throwing, because that
 * is what CfpForm renders.
 */
test('filing the same title twice is refused in the form, not filed twice', async ({ browser }) => {
  const title = `Pressing back and submitting again ${RUN}`;
  const email = `e2e-doubler-${RUN}@example.com`;
  const abstract =
    'The browser back button restores a submitted form intact when scripting is off, so the ' +
    'second press of Submit posts exactly the payload the first one did. A conference gets ' +
    'this from real people on bad hotel wifi more often than anyone expects, and the answer ' +
    'has to be a sentence in the form rather than a second row in the database.';

  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  async function fileIt() {
    await page.getByTestId('cfp-email').fill(email);
    await page.getByTestId('cfp-name').fill(`Back Button ${RUN}`);
    await page.getByTestId('cfp-title').fill(title);
    await page.getByTestId('cfp-abstract').fill(abstract);
    await page
      .getByTestId('custom-questions')
      .getByLabel('What will the audience be able to do afterwards? *')
      .fill(`Dedupe their own CFP ${RUN}`);
    await page.getByTestId('cfp-submit').click();
    await page.waitForLoadState('domcontentloaded');
  }

  await page.goto('/cfp');
  await fileIt();
  await expect(page.getByTestId('submitted-confirmation')).toBeVisible();

  // Back, and the form is still holding everything it just sent.
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('cfp-title')).toHaveValue(title);

  await page.getByTestId('cfp-submit').click();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText('is already filed under this speaker')).toBeVisible();
  await context.close();

  // One row, not two. Read from the organizer's own list rather than from the
  // speaker's, because the list the reviewers work off is the one that mattered.
  const organizer = await browser.newContext();
  const check = await organizer.newPage();
  await signInVia(check, ORGANIZER_EMAIL);
  await check.goto(`/organizer/abstracts?q=${encodeURIComponent(title)}`);
  await expect(check.getByText(title, { exact: false })).toHaveCount(1);
  await organizer.close();
});
