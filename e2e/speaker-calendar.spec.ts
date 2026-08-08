import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail, type CapturedMail } from './mailbox';

/**
 * The mails a speaker gets about their own talk, and the calendar invitations
 * attached to them.
 *
 * Runs after `schedule.spec.ts` and `smoke.spec.ts`, before `uploads.spec.ts`.
 * `pipeline.spec.ts` has already accepted one talk and placed it, so there is a
 * real placement waiting for its first invitation when this file starts.
 *
 * The property worth an end-to-end test is that a change reaches the calendar
 * entry the speaker already has. That needs three things to line up across two
 * separate emails: the same UID, a higher SEQUENCE, and a METHOD the client
 * will act on. Any one of them wrong and the speaker quietly keeps the old
 * time, which is the failure a schedule-change email exists to prevent.
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

/**
 * The attachment out of a development mail receipt. `sendMail` writes the body
 * in full between named fences precisely so a test can read what a real client
 * would be handed, rather than trusting that something was attached.
 */
function attachment(mail: CapturedMail, filename: string): string {
  const fence = new RegExp(
    `--- attachment: ${filename} \\(([^)]+)\\) ---\\n([\\s\\S]*?)\\n--- end attachment: ${filename} ---`,
  );
  const found = fence.exec(mail.body);
  if (!found) throw new Error(`no ${filename} attached to "${mail.subject}":\n${mail.body}`);
  return found[2]!;
}

function contentType(mail: CapturedMail, filename: string): string {
  const found = new RegExp(`--- attachment: ${filename} \\(([^)]+)\\) ---`).exec(mail.body);
  if (!found) throw new Error(`no ${filename} attached to "${mail.subject}"`);
  return found[1]!;
}

/**
 * One property out of a calendar body.
 *
 * Unfolds first. RFC 5545 breaks any line over 75 octets and continues it after
 * a space, so an ATTENDEE with a long name arrives in two pieces and a naive
 * read returns half an address. Parameters are skipped too: the line is
 * `ORGANIZER;CN=Name:mailto:…`, and the value starts at the first colon that is
 * not inside them.
 */
function field(ics: string, name: string): string {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const found = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'm').exec(unfolded);
  if (!found) throw new Error(`no ${name} in calendar:\n${unfolded}`);
  return found[1]!.trim();
}

/** Press the send button and wait for the row it names to land. */
async function sendNotices(page: Page): Promise<void> {
  await page.goto('/organizer/schedule');
  const button = page.getByTestId('notify-schedule');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('notify-schedule')).toBeDisabled();
}

test('a schedule change updates the invitation the speaker already has', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  // 1. The first invitation -------------------------------------------------
  await sendNotices(page);
  const scheduled = await waitForMail((m) => m.subject.startsWith('You are scheduled:'));
  const first = attachment(scheduled, 'invite.ics');

  expect(contentType(scheduled, 'invite.ics')).toContain('method=REQUEST');
  expect(field(first, 'METHOD')).toBe('REQUEST');
  expect(field(first, 'ORGANIZER')).toContain('mailto:');
  expect(field(first, 'ATTENDEE')).toContain(`mailto:${scheduled.to}`);
  // A calendar entry with no start is a file, not an appointment.
  expect(field(first, 'DTSTART')).toMatch(/^\d{8}T\d{6}Z$/);

  const uid = field(first, 'UID');
  const firstSequence = Number(field(first, 'SEQUENCE'));
  // Sent once already means the second notice has somewhere to count up from.
  expect(firstSequence).toBeGreaterThanOrEqual(1);

  // Nothing has changed since, so there is nothing to send. Without this the
  // button would mail every scheduled speaker on every press.
  await page.goto('/organizer/schedule');
  await expect(page.getByTestId('notify-schedule')).toBeDisabled();

  // 2. Move it --------------------------------------------------------------
  const placed = page.locator('[data-testid^="slot-"]').filter({ hasText: 'remove' }).first();
  const title = (await placed.innerText()).split('\n')[0]!.trim();
  const target = page.locator('[data-testid^="slot-"]').filter({ hasText: 'empty' }).first();
  const targetId = await target.getAttribute('data-testid');
  await placed.dragTo(target);
  await expect(page.locator(`[data-testid="${targetId}"]`)).toContainText(title);

  await sendNotices(page);
  const moved = await waitForMail((m) => m.subject.startsWith('Time change:'));
  const second = attachment(moved, 'invite.ics');

  // The whole mechanism, in three assertions. Same UID, so the client finds the
  // entry it already holds; higher SEQUENCE, so it accepts the revision rather
  // than discarding it as a duplicate; a different DTSTART or LOCATION, so
  // there was something to revise.
  expect(field(second, 'UID')).toBe(uid);
  expect(Number(field(second, 'SEQUENCE'))).toBeGreaterThan(firstSequence);
  expect(field(second, 'DTSTART') + field(second, 'LOCATION')).not.toBe(
    field(first, 'DTSTART') + field(first, 'LOCATION'),
  );
  // The mail says what it was as well as what it is. A speaker reading only the
  // new time cannot tell a change from a duplicate of the mail they have.
  expect(moved.body).toContain('It was previously');

  // 3. Take it off the grid -------------------------------------------------
  await page.goto('/organizer/schedule');
  await page.locator(`[data-testid="${targetId}"]`).getByText('remove').click();
  await expect(page.locator(`[data-testid="${targetId}"]`)).toContainText('empty');

  await sendNotices(page);
  const cancelled = await waitForMail((m) => m.subject.includes('has come off the'));
  const third = attachment(cancelled, 'cancelled.ics');

  expect(contentType(cancelled, 'cancelled.ics')).toContain('method=CANCEL');
  expect(field(third, 'METHOD')).toBe('CANCEL');
  // Both are needed. The METHOD tells the client this is a withdrawal and the
  // STATUS is what several of them actually read before removing the entry.
  expect(third).toContain('STATUS:CANCELLED');
  expect(field(third, 'UID')).toBe(uid);
  // Cancelling something the speaker was never told about would be worse than
  // saying nothing, so the cancellation carries the time they were last given.
  expect(field(third, 'DTSTART')).toBe(field(second, 'DTSTART'));
});

test('a first-time submitter gets a receipt, and the organizers get a heads-up', async ({
  page,
}) => {
  const run = Date.now();
  const email = `e2e-receipt-${run}@example.com`;
  const name = `Marguerite Newcomer ${run}`;
  const title = `The pager rotation nobody volunteered for ${run}`;

  await page.goto('/cfp');
  await page.getByTestId('cfp-email').fill(email);
  await page.getByTestId('cfp-name').fill(name);
  await page.getByTestId('cfp-title').fill(title);
  await page
    .getByTestId('cfp-abstract')
    .fill(
      'Our on-call rotation was assembled by three people leaving in the same quarter and ' +
        'never revisited. This talk is the audit we ran on it, what we found about who was ' +
        'actually carrying the load, and the rota we replaced it with.',
    );
  await page.getByTestId('cfp-format').selectOption('talk_45');
  await page
    .getByTestId('custom-questions')
    .getByLabel('What will the audience be able to do afterwards? *')
    .fill(`Audit their own rotation ${run}`);
  await page.getByTestId('cfp-submit').click();

  // The redirect and the success message, both of which the brief calls out.
  await expect(page).toHaveURL(/\/speaker\?submitted=1/);
  await expect(page.getByTestId('submitted-confirmation')).toBeVisible();

  // Two different mails, and the distinction is the point. The sign-in link is
  // about the account; the receipt is about the proposal. A first-time
  // submitter used to get only the first and had nothing saying the form had
  // taken anything.
  await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  const receipt = await waitForMail((m) => m.to === email && m.subject.startsWith('Received:'));
  expect(receipt.body).toContain(title);

  const alert = await waitForMail(
    (m) => m.to === ORGANIZER && m.subject.startsWith('New submission:'),
  );
  // The one mail in this system that is not blind, because it goes to the
  // person running the event rather than to anyone grading.
  expect(alert.body).toContain(name);
  expect(alert.body).toContain(title);
});
