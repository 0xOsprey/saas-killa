import { expect, test, type Browser, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * What the speaker portal says the speaker has been *told*, as against what the
 * organizers have *decided*.
 *
 * The two are separate columns on purpose — an organizer flips a status while
 * deciding and moves a talk four times while building the grid, and nothing
 * leaves the building until they press send — so the portal has to be able to
 * say which of the two it is showing. Every assertion below is about that
 * distinction rather than about the decision or the placement, both of which
 * already have their own tests.
 *
 * Runs after `speaker-calendar.spec.ts` and before `uploads.spec.ts` on the
 * shared database. The talk it files is its own, and it hands back the box it
 * borrows and settles the notice before it finishes, so the next file finds the
 * grid and the send button as it left them.
 */

const ORGANIZER = 'organizer@example.com';

/**
 * Seeded with an accepted talk that is on the grid and already confirmed, which
 * is the exact state the portal had no way out of. Not used by any other file:
 * `speaker9` and `speaker11` are spoken for by auth, review, portal-pages and
 * uploads.
 */
const DECLINER = 'speaker3@example.com';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

/** A second signed-in browser, so the organizer can act without displacing the speaker. */
async function asOrganizer(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInVia(page, ORGANIZER);
  return { context, page };
}

/**
 * Place a talk through the no-script form rather than by dragging.
 *
 * `schedule.spec.ts` owns the gesture. What this file needs is a placement that
 * lands in a box of its own choosing, and a box it can name again later to hand
 * back. `avoid` is how the move gets a genuinely different slot: re-placing a
 * talk into the box it already occupies changes no key and would report as
 * "unchanged" for the right reason and the wrong one at once.
 */
async function placeViaFallback(page: Page, title: string, avoid?: string): Promise<string> {
  await page.goto('/organizer/schedule');
  const fallback = page.getByTestId('schedule-fallback');
  await fallback.locator('summary').click();

  const talkId = await fallback
    .getByTestId('fallback-talk')
    .locator('option')
    .filter({ hasText: title })
    .first()
    .getAttribute('value');
  expect(talkId, `"${title}" is offered by the fallback form`).toBeTruthy();

  // Every occupied box carries its occupant after an em dash, so the options
  // without one are the free boxes. The first is the empty placeholder.
  const free = await fallback
    .getByTestId('fallback-slot')
    .locator('option')
    .filter({ hasNotText: '—' })
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  const slotId = free.find((value) => value !== '' && value !== avoid);
  expect(slotId, 'a free slot to place into').toBeTruthy();

  await fallback.getByTestId('fallback-talk').selectOption(talkId!);
  await fallback.getByTestId('fallback-slot').selectOption(slotId!);
  await fallback.getByTestId('fallback-place').click();
  await expect(page.locator(`[data-testid="slot-${slotId}"]`)).toContainText(title);

  return slotId!;
}

/** The room a slot's own option label names, for checking against what the notice says. */
async function roomOf(page: Page, slotId: string): Promise<string> {
  await page.goto('/organizer/schedule');
  const fallback = page.getByTestId('schedule-fallback');
  await fallback.locator('summary').click();
  const label = await fallback
    .getByTestId('fallback-slot')
    .locator(`option[value="${slotId}"]`)
    .textContent();
  const room = /·\s*([^—]+?)\s*(?:—|$)/.exec(label ?? '');
  expect(room, `a room name in "${label}"`).toBeTruthy();
  return room![1]!;
}

/** Press the send button and wait for the state it names to settle. */
async function sendNotices(page: Page): Promise<void> {
  await page.goto('/organizer/schedule');
  const button = page.getByTestId('notify-schedule');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('notify-schedule')).toBeDisabled();
}

test('the portal separates what the organizers decided from what the speaker was told', async ({
  page,
  browser,
  baseURL,
}) => {
  const run = Date.now();
  const email = `e2e-told-${run}@example.com`;
  const title = `The runbook nobody opened until 3am ${run}`;

  // 1. File one, which signs the submitter in ------------------------------
  await page.goto('/cfp');
  await page.getByTestId('cfp-email').fill(email);
  await page.getByTestId('cfp-name').fill(`Ines Told ${run}`);
  await page.getByTestId('cfp-title').fill(title);
  await page
    .getByTestId('cfp-abstract')
    .fill(
      'We had a runbook for the database failover and nobody had opened it in two years. ' +
        'This is what happened when we finally ran it end to end, what it got wrong, and ' +
        'the three habits that keep ours current now.',
    );
  await page.getByTestId('cfp-format').selectOption('talk_45');
  await page
    .getByTestId('custom-questions')
    .getByLabel('What will the audience be able to do afterwards? *')
    .fill(`Run their own failover drill ${run}`);
  await page.getByTestId('cfp-submit').click();
  await expect(page.getByTestId('submitted-confirmation')).toBeVisible();

  const card = page.locator('[data-testid^="submission-card-"]').filter({ hasText: title });
  await expect(card).toHaveCount(1);

  // Nothing placed and nothing said is not news. Warning every accepted speaker
  // about an email that was correct not to have been sent would bury the cases
  // below in noise.
  await expect(card.getByTestId(/^schedule-notice-/)).toHaveCount(0);

  const organizer = await asOrganizer(browser, baseURL);

  // 2. Decided, not yet sent ----------------------------------------------
  await organizer.page.goto('/organizer/submissions');
  const row = organizer.page.locator('[data-testid^="submission-"]').filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.locator('[data-testid^="accept-"]').click();
  await expect(row).toContainText('Accepted');

  await page.reload();
  await expect(card.getByTestId(/^decision-unsent-/)).toBeVisible();
  await expect(card.getByTestId(/^decision-sent-/)).toHaveCount(0);

  // 3. Sent ----------------------------------------------------------------
  await organizer.page.getByTestId('notify-decided').click();
  await waitForMail((m) => m.to === email && m.subject.startsWith('Accepted:'));

  await page.reload();
  await expect(card.getByTestId(/^decision-sent-/)).toBeVisible();
  await expect(card.getByTestId(/^decision-unsent-/)).toHaveCount(0);

  // An acceptance for a talk with no slot carries no placement, so the schedule
  // half starts from nothing said rather than inheriting the decision's mail.
  await expect(card.getByTestId(/^schedule-notice-/)).toHaveCount(0);

  // 4. On the grid, but nobody has been told -------------------------------
  const first = await placeViaFallback(organizer.page, title);
  const firstRoom = await roomOf(organizer.page, first);

  await page.reload();
  await expect(card.getByTestId(/^schedule-notice-/)).toContainText('has not been emailed to you');

  // 5. Told ----------------------------------------------------------------
  await sendNotices(organizer.page);

  await page.reload();
  await expect(card.getByTestId(/^schedule-notice-/)).toContainText(
    'This is the time and room your last email described',
  );

  // 6. Moved after being told ----------------------------------------------
  const second = await placeViaFallback(organizer.page, title, first);
  expect(second, 'the move landed in a different box').not.toBe(first);

  await page.reload();
  const moved = card.getByTestId(/^schedule-notice-/);
  await expect(moved).toContainText('Moved since your last email');
  // The old placement, not the new one. A speaker who is only shown the current
  // time cannot tell which of the two the email in their inbox describes.
  await expect(moved).toContainText(firstRoom);

  // 7. Hand the box back, and settle the notice ----------------------------
  await organizer.page.goto('/organizer/schedule');
  const fallback = organizer.page.getByTestId('schedule-fallback');
  await fallback.locator('summary').click();
  await fallback.getByTestId('fallback-clear-slot').selectOption(second);
  await fallback.getByTestId('fallback-clear').click();
  await expect(organizer.page.locator(`[data-testid="slot-${second}"]`)).toContainText('empty');

  await sendNotices(organizer.page);

  // Agreeing on "not scheduled" is still agreement, and it is the one case where
  // the reassuring wording would describe a time that is not on the card.
  await page.reload();
  await expect(card.getByTestId(/^schedule-notice-/)).toContainText(
    'Not on the schedule, which is what your last email about it said',
  );

  await organizer.context.close();
});

test('a speaker who cannot come says so without withdrawing the talk', async ({
  page,
  browser,
  baseURL,
}) => {
  await signInVia(page, DECLINER);
  await page.goto('/speaker');

  // On the grid as well as accepted. This speaker has two accepted talks and
  // only one of them is placed, and both halves of the organizer's side of this
  // — the mail's "it is still on the schedule" line and the warning on the
  // schedule screen — are about a talk that occupies a slot.
  const offered = page
    .locator('[data-testid^="submission-card-"]')
    .filter({ has: page.locator('[data-testid^="decline-"]') })
    .filter({ has: page.locator('[data-testid^="placement-"]') });
  expect(await offered.count(), 'an accepted, placed talk to decline').toBeGreaterThan(0);

  const card = offered.first();
  const title = ((await card.locator('h2').first().textContent()) ?? '').trim();
  expect(title).not.toBe('');

  // Already confirmed, which is the state the portal could not reverse:
  // `confirmAttendance` set a timestamp and nothing anywhere reset it.
  await expect(card.getByText('Attendance confirmed')).toBeVisible();

  const organizer = await asOrganizer(browser, baseURL);
  await organizer.page.goto('/organizer/schedule');
  await expect(organizer.page.getByTestId('declined-warning')).toHaveCount(0);

  await card.locator('[data-testid^="decline-"]').click();

  const declined = page.locator('[data-testid^="submission-card-"]').filter({ hasText: title });
  await expect(declined.getByTestId(/^declined-/)).toBeVisible();
  await expect(declined.locator('[data-testid^="decline-"]')).toHaveCount(0);

  // The whole point of the smaller move. Withdrawing is still on the card and
  // still a different button, and the proposal has not gone anywhere.
  await expect(declined.getByTestId(/^status-/)).toHaveText('Accepted');
  await expect(declined.getByRole('button', { name: 'Withdraw' })).toBeVisible();

  // The organizers are told, rather than left to notice a column. The mail says
  // where the talk still is, which is the placement lookup working.
  const alert = await waitForMail(
    (m) => m.to === ORGANIZER && m.subject.startsWith('Cannot present:'),
  );
  expect(alert.body).toContain(title);
  expect(alert.body).toContain('It is still on the schedule');
  expect(alert.body).toContain('has not been withdrawn');

  // And the screen where the slot has to change says so too.
  await organizer.page.goto('/organizer/schedule');
  await expect(organizer.page.getByTestId('declined-warning')).toContainText(title);

  // Undoing it is a press of the opposite button, which is why neither asks
  // twice. This also puts the fixture back for the files that run after.
  await declined.getByTestId(/^reconfirm-/).click();
  await expect(
    page.locator('[data-testid^="submission-card-"]').filter({ hasText: title }),
  ).toContainText('Attendance confirmed');

  await organizer.page.goto('/organizer/schedule');
  await expect(organizer.page.getByTestId('declined-warning')).toHaveCount(0);

  await organizer.context.close();
});
