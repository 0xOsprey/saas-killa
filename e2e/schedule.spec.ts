import { expect, test, type Locator, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * Building the schedule and reading it back.
 *
 * Runs after `pipeline.spec.ts`, which leaves one band and one placed talk
 * behind, and before `smoke.spec.ts`, which only opens routes. Anything this
 * file places it clears again.
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

/** Take the first unplaced talk and drop it in the first empty box. */
async function placeFirstFromPool(page: Page): Promise<string> {
  const item = page.locator('[data-testid^="pool-"]').first();
  const title = (await item.locator('span').first().innerText()).trim();
  await item.click();
  await page.locator('[data-testid^="slot-"]').filter({ hasText: 'empty' }).first().click();
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(1);
  return title;
}

/**
 * Drag one cell onto another, by hand.
 *
 * Not `locator.dragTo`, which scrolls the target into view *after* pressing the
 * mouse button and before Chromium has decided a drag is starting. On a grid
 * taller than the viewport that scroll moves the layout under a stationary
 * cursor, so `dragstart` fires on whichever cell has slid into the point:
 * measured on this fixture as mousedown landing on the right cell at scrollY
 * 670 and dragstart firing on its neighbour at scrollY 626, which moved a talk
 * the test had never named. A viewport tall enough to hold both cells means
 * nothing scrolls once the button is down.
 */
async function dragSlot(page: Page, source: Locator, target: Locator) {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const at = (box: { x: number; y: number; width: number; height: number }) =>
    [box.x + box.width / 2, box.y + box.height / 2] as const;

  await page.mouse.move(...at(from));
  await page.mouse.down();
  // Two moves, not one. The first is what Chromium treats as the gesture
  // beginning and the second is the one the drop target sees.
  await page.mouse.move(...at(to), { steps: 12 });
  await page.mouse.move(...at(to));
  await page.mouse.up();
}

test('an organizer drags a placed talk into another box', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/schedule');
  await page.getByTestId('add-band').click();

  const title = await placeFirstFromPool(page);

  const source = page.locator('[data-testid^="slot-"]').filter({ hasText: title });
  const sourceId = await source.getAttribute('data-testid');
  const target = page.locator('[data-testid^="slot-"]').filter({ hasText: 'empty' }).first();
  const targetId = await target.getAttribute('data-testid');
  expect(sourceId).not.toBe(targetId);

  // The gesture under test is moving a talk that is already placed, which is
  // what rearranging a schedule mostly is. Dragging out of the pool was already
  // possible; dragging out of a box was not.
  await dragSlot(page, source, target);

  await expect(page.locator(`[data-testid="${targetId}"]`)).toContainText(title);
  await expect(page.locator(`[data-testid="${sourceId}"]`)).toContainText('empty');

  // A talk occupies one box, so the move emptied the one it came from rather
  // than leaving a copy: `slots_submission_idx` is unique and the action clears
  // the old row inside the same transaction.
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(1);

  await page.locator(`[data-testid="${targetId}"]`).getByText('remove').click();
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(0);
});

test('the same schedule reads five ways', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/schedule');
  const title = await placeFirstFromPool(page);

  // Every reading view is the same rows arranged differently, so the talk that
  // is on the grid has to be in all of them.
  for (const view of ['list', 'week', 'track', 'room'] as const) {
    await page.goto(`/organizer/schedule?view=${view}`);
    await expect(page.getByTestId(`schedule-${view}`), `view=${view}`).toBeVisible();
    await expect(page.locator('body'), `view=${view}`).toContainText(title);
  }

  // The day view narrows the grid to one day and offers the days as tabs.
  await page.goto('/organizer/schedule?view=day');
  const dayTab = page.getByTestId('schedule-day-tabs').getByRole('link').first();
  await expect(dayTab).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(1);

  // And the public agenda's own day filter narrows for real. It used to offer
  // days formatted `06/11/2026` and then discard every one of them on arrival.
  const dayKey = (await dayTab.getAttribute('href'))!.split('day=')[1]!;
  expect(dayKey, 'day key in the tab link').toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await page.goto(`/agenda?day=${dayKey}`);
  await expect(page.locator('body')).toContainText(title);
  await page.goto('/agenda?day=2020-01-01');
  await expect(page.locator('body')).not.toContainText(title);

  await page.goto('/organizer/schedule');
  await page
    .locator('[data-testid^="slot-"]')
    .filter({ hasText: title })
    .getByText('remove')
    .click();
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: title })).toHaveCount(0);
});

test('the schedule places and clears with scripting off', async ({ page, browser, baseURL }) => {
  // Signing in needs JavaScript — the login form is a client component — so the
  // session is minted in the ordinary context and carried into one without
  // scripting. The claim under test is that placing and clearing survive, not
  // that signing in does.
  await signInVia(page, ORGANIZER);
  const storageState = await page.context().storageState();

  const context = await browser.newContext({ baseURL, storageState, javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto('/organizer/schedule');

  const fallback = plain.getByTestId('schedule-fallback');
  await expect(fallback).toBeVisible();
  // `<details>` opens on its own; that is the element, not a script.
  await fallback.locator('summary').click();

  const talk = fallback.getByTestId('fallback-talk');
  // Option 0 is the placeholder and the unplaced pool comes first, so option 1
  // is a talk with no box yet.
  const title = ((await talk.locator('option').nth(1).textContent()) ?? '').split(' — ')[0]!;
  await talk.selectOption({ index: 1 });

  // The first slot the form offers with nothing already in it. An occupied one
  // carries its occupant after an em dash.
  const slotValue = (await fallback
    .getByTestId('fallback-slot')
    .locator('option')
    .filter({ hasNotText: '—' })
    .nth(1)
    .getAttribute('value'))!;
  await fallback.getByTestId('fallback-slot').selectOption(slotValue);
  await fallback.getByTestId('fallback-place').click();

  await expect(plain.locator(`[data-testid="slot-${slotValue}"]`)).toContainText(title);

  const reopened = plain.getByTestId('schedule-fallback');
  await reopened.locator('summary').click();
  await reopened.getByTestId('fallback-clear-slot').selectOption(slotValue);
  await reopened.getByTestId('fallback-clear').click();
  await expect(plain.locator(`[data-testid="slot-${slotValue}"]`)).toContainText('empty');

  await context.close();
});

test('a view name and a day the schedule does not have fall back rather than error', async ({
  page,
}) => {
  await signInVia(page, ORGANIZER);

  // A hand-edited or stale query string reaches this page as often as a click
  // does, and the grid is the safe thing to show.
  const response = await page.goto('/organizer/schedule?view=gantt&day=tuesday');
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('view-grid')).toHaveAttribute('aria-current', 'page');
  // The testid, not just the string: src/app/error.tsx means our own boundary
  // renders in place of Next's default and the literal text never appears.
  await expect(page.getByTestId('error-boundary')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Application error');

  // `view=day` with a day nothing is scheduled on falls back to the first day
  // the schedule actually has, rather than an empty grid with no way out.
  await page.goto('/organizer/schedule?view=day&day=2020-01-01');
  await expect(page.getByTestId('view-day')).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByTestId('schedule-day-tabs').getByRole('link').first(),
  ).toHaveAttribute('aria-current', 'page');
});

/**
 * The star on the agenda, against the star on the talk's own page.
 *
 * Both counts come from the same bookmarks table by two different routes, and
 * the agenda's route was a correlated subquery written into an `sql` template.
 * A drizzle column interpolated into a template renders *unqualified*, so
 * `where ${bookmarks.submissionId} = ${slots.submissionId}` came out as
 * `where "submission_id" = "submission_id"` and both sides bound to the
 * subquery's own table. The predicate was always true: every talk on the agenda
 * reported the site-wide bookmark total, and the `exists` beside it made every
 * talk look starred to anyone who had starred anything at all.
 *
 * The detail page escaped only because `bookmarks` has no `id` column for its
 * bare `"id"` to bind to, which makes it the honest number to compare against.
 */
test('a talk on the agenda carries its own star count, not the whole site', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/agenda');

  const stars = await page
    .locator('[data-testid^="star-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: (node.getAttribute('data-testid') ?? '').replace('star-', ''),
        count: (node.textContent ?? '').replace(/\D/g, ''),
        pressed: node.getAttribute('aria-pressed') === 'true',
      })),
    );

  expect(stars.length, 'starred talks on the agenda').toBeGreaterThan(1);

  for (const star of stars) {
    await page.goto(`/agenda/${star.id}`);
    const own = await page.getByTestId(`star-${star.id}`).textContent();
    expect(star.count, `star count for ${star.id}`).toBe((own ?? '').replace(/\D/g, ''));
  }

  // `bookmarkedByMe` had the same defect and shows as `aria-pressed`. Starring
  // one talk has to leave the others alone, which is the assertion the broken
  // `exists` failed: it pressed every star on the page at once.
  await page.goto('/agenda');
  const target = stars[0].id;
  const wasPressed = stars[0].pressed;
  await page.getByTestId(`star-${target}`).click();
  await expect(page.getByTestId(`star-${target}`)).toHaveAttribute(
    'aria-pressed',
    String(!wasPressed),
  );

  const pressedNow = await page
    .locator('[data-testid^="star-"][aria-pressed="true"]')
    .evaluateAll((nodes) => nodes.length);
  const expected = stars.filter((s) => s.pressed).length + (wasPressed ? -1 : 1);
  expect(pressedNow, 'stars pressed after toggling exactly one').toBe(expected);

  // Put it back: this file runs before smoke.spec.ts on the same database.
  await page.getByTestId(`star-${target}`).click();
  await expect(page.getByTestId(`star-${target}`)).toHaveAttribute(
    'aria-pressed',
    String(wasPressed),
  );
});

/**
 * The morning the clocks go forward.
 *
 * `wallClockToInstant` measured the zone's offset once, at the wall clock read
 * as UTC, which is by construction the wrong instant. When that instant sits on
 * the far side of a DST transition from the real one the offset is an hour out:
 * 03:00 on 2026-03-08 in New York stored as 08:00Z, which reads back as 04:00.
 * London hides it, because its transitions happen at 01:00 UTC and the guess
 * lands on the same side; this test therefore moves the event to New York and
 * puts it back.
 */
test('a wall clock on the morning the clocks go forward stores the time it says', async ({
  page,
}) => {
  const WALL = '2026-03-08T03:00';
  const RIGHT = '2026-03-08T07:00:00.000Z';
  const SINGLE_PASS = '2026-03-08T08:00:00.000Z';

  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/settings');
  const timezone = await page.getByTestId('event-timezone').inputValue();
  await page.getByTestId('event-timezone').selectOption('America/New_York');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('event-timezone')).toHaveValue('America/New_York');

  await page.goto('/organizer/schedule');
  await page.getByTestId('band-start').fill(WALL);
  await page.getByTestId('add-band').click();

  // The band remover carries each band's stored instant verbatim, which is the
  // value under test; the button beside it carries what the organizer reads.
  await expect(page.locator(`input[name="startsAt"][value="${RIGHT}"]`)).toHaveCount(1);
  await expect(page.locator(`input[name="startsAt"][value="${SINGLE_PASS}"]`)).toHaveCount(0);

  const remove = page.locator(`form:has(input[name="startsAt"][value="${RIGHT}"])`);
  await page.getByText('Remove a time band or break').click();
  await expect(remove.getByRole('button')).toContainText('8 March 03:00');

  await remove.getByRole('button').click();
  await page.getByTestId('confirm-delete-band-submit').click();
  await expect(page.locator(`input[name="startsAt"][value="${RIGHT}"]`)).toHaveCount(0);

  await page.goto('/organizer/settings');
  await page.getByTestId('event-timezone').selectOption(timezone);
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('event-timezone')).toHaveValue(timezone);
});

/**
 * Placing onto an occupied box is allowed and always was. What it did was
 * happen in silence: the talk that had been sitting there went back to the
 * unscheduled pool with nothing on screen to say so, and on a grid taller than
 * the viewport the pool is not where an organizer is looking.
 */
test('placing onto an occupied box says which talk it displaced', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/schedule');

  const sitting = await placeFirstFromPool(page);
  const box = page.locator('[data-testid^="slot-"]').filter({ hasText: sitting });
  const boxId = (await box.getAttribute('data-testid'))!;

  const moving = await page
    .locator('[data-testid^="pool-"]')
    .first()
    .locator('span')
    .first()
    .innerText();
  await page.locator('[data-testid^="pool-"]').first().click();
  await page.locator(`[data-testid="${boxId}"]`).click();

  await expect(page.getByTestId('eviction-notice')).toContainText(sitting);
  await expect(page.locator(`[data-testid="${boxId}"]`)).toContainText(moving);
  await expect(page.locator('[data-testid^="pool-"]').filter({ hasText: sitting })).toHaveCount(1);

  // Put both back in the pool, which is where this file found them.
  await page.locator(`[data-testid="${boxId}"]`).getByText('remove').click();
  await expect(page.locator('[data-testid^="slot-"]').filter({ hasText: moving })).toHaveCount(0);
});
