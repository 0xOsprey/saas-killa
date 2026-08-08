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

/**
 * An award card, and not the "New award category" name input, which also has a
 * testid beginning `award-`. The uuid head is what tells the two apart.
 */
const AWARD_CARD = /^award-[0-9a-f]{8}-/;

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

/**
 * A ballot-free category can still be destroyed, and it takes two presses.
 *
 * The first press carries no `confirm=yes`, so the action bounces to
 * `?confirmAward=` and the page states what the delete costs, the same shape
 * `deleteRoom` and `deleteTrack` use.
 */
test('deleting a ballot-free category round-trips through a confirmation', async ({ page }) => {
  const name = 'Throwaway, deletable';
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/awards');

  await page.getByTestId('award-name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const card = page.getByTestId(AWARD_CARD).filter({ hasText: name });
  await expect(card).toHaveCount(1);

  await card.getByText('Retire this category').click();
  await card.getByTestId('delete-award-start').click();

  // Bounced to the confirmation rather than deleted, and the confirmation is
  // about this category.
  await expect(page).toHaveURL(/confirmAward=/);
  const confirm = page.getByTestId('confirm-delete-award');
  await expect(confirm).toContainText(name);
  await expect(confirm).toContainText('No ballots have been cast in it');

  await page.getByTestId('confirm-delete-award-submit').click();
  await expect(page.getByTestId(AWARD_CARD).filter({ hasText: name })).toHaveCount(0);
});

/**
 * The principle the repository already holds for `form_questions.archived_at`
 * and `evaluator_personas.active`: work the committee did survives the
 * organizer changing their mind about the container it was done in.
 *
 * `award_votes.award_id` cascades, so before this the delete button destroyed
 * every ballot in a category with no archive and no undo.
 *
 * State this file leaves behind: one archived category holding one nominee and
 * one ballot. That is the feature rather than an untidy test. A category with a
 * ballot in it is precisely what cannot be removed, and archived means invisible
 * to `awardDetails()` everywhere except this console.
 */
test('a category with a ballot in it refuses to delete, archives, and restores intact', async ({
  page,
}) => {
  const name = 'Throwaway, judged';
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/awards');

  await page.getByTestId('award-name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const card = page.getByTestId(AWARD_CARD).filter({ hasText: name });
  const awardId = (await card.getAttribute('data-testid'))!.replace('award-', '');

  // One nominee, then one committee ballot cast against it. No criteria on this
  // category, so the ballot is the unweighted single pick. The select is picked
  // by its label because the override-winner form on the same card carries a
  // second `submissionId`.
  await card.getByLabel(/^Nominate/).selectOption({ index: 1 });
  await card.getByRole('button', { name: 'Add' }).click();
  // Wait for the nomination to land before navigating. `page.goto` during an
  // in-flight server action aborts the POST, and the judge page then shows
  // "Nothing nominated yet" for a reason that has nothing to do with the code
  // under test.
  await expect(card).not.toContainText('Nothing nominated yet.');

  await page.goto('/awards/judge');
  const judge = page.getByTestId(`judge-award-${awardId}`);
  await judge.getByRole('button', { name: 'vote' }).first().click();
  await expect(judge).toContainText('Your ballot:');

  // The delete path, reached the only way it can be with a ballot present: by
  // typing the confirmation URL. The button that leads here is gone from the
  // card, and the refusal below is the server-side half of that.
  await page.goto(`/organizer/awards?confirmAward=${awardId}`);
  await expect(page.getByTestId('confirm-delete-award')).toContainText('this will be refused');
  await page.getByTestId('confirm-delete-award-submit').click();

  await expect(page.getByTestId('award-has-ballots')).toBeVisible();
  await page.goto('/organizer/awards');
  await expect(page.getByTestId(AWARD_CARD).filter({ hasText: name })).toHaveCount(1);

  // Archive is what the organizer gets instead, and the ballot goes with it.
  await card.getByText('Retire this category').click();
  await card.getByTestId('archive-award-submit').click();
  await expect(page.getByTestId(AWARD_CARD).filter({ hasText: name })).toHaveCount(0);

  const archivedRow = page.getByTestId('archived-awards').locator('li').filter({ hasText: name });
  await expect(archivedRow).toContainText('1 nominee');
  await expect(archivedRow).toContainText('1 ballot kept');

  // Off the committee ballot too, not merely off this list.
  await page.goto('/awards/judge');
  await expect(page.getByTestId(`judge-award-${awardId}`)).toHaveCount(0);

  // Restoring puts the tally back, which is the whole claim: the ballot was
  // never destroyed, only hidden.
  await page.goto('/organizer/awards');
  await archivedRow.getByTestId('restore-award-submit').click();
  await expect(page.getByTestId(AWARD_CARD).filter({ hasText: name })).toHaveCount(1);
  await page.goto('/awards/judge');
  await expect(page.getByTestId(`judge-award-${awardId}`)).toContainText('Your ballot:');

  // Put it back out of the way for the nine files that run after this one.
  await page.goto('/organizer/awards');
  await card.getByText('Retire this category').click();
  await card.getByTestId('archive-award-submit').click();
  await expect(page.getByTestId(AWARD_CARD).filter({ hasText: name })).toHaveCount(0);
});
