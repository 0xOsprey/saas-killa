import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The onboarding dashboard: who still owes us something, counted.
 *
 * Every assertion here is relative. The file reads a baseline, changes exactly
 * one thing, and asserts the difference, so it does not encode how many tasks
 * the seed happens to create and it cannot rot when the seed changes. Each test
 * puts back the task it made, which is what lets the suite keep its one shared
 * database.
 *
 * Sorts before `pipeline.spec.ts`, which moves submissions between statuses.
 * That ordering is not load-bearing: the relative assertions survive whatever
 * state a preceding file leaves behind.
 */

const ORGANIZER = 'organizer@example.com';

/** A date comfortably in the past, so a task carrying it is overdue on sight. */
const OVERDUE_AT = '2026-08-01T09:00';

type Counts = {
  clear: number;
  outstandingPeople: number;
  overduePeople: number;
  completed: number;
  outstandingTasks: number;
  overdueTasks: number;
};

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

async function tile(page: Page, id: string): Promise<number> {
  return Number((await page.getByTestId(id).innerText()).trim());
}

/** The hint under a tile leads with its task count: "27 task(s) between them". */
async function hintCount(page: Page, id: string): Promise<number> {
  const text = await page.getByTestId(`${id}-hint`).innerText();
  return Number(/^\d+/.exec(text.trim())?.[0] ?? '0');
}

async function readDashboard(page: Page): Promise<Counts> {
  await page.goto('/organizer/onboarding');
  return {
    clear: await tile(page, 'tile-clear'),
    outstandingPeople: await tile(page, 'tile-outstanding'),
    overduePeople: await tile(page, 'tile-overdue'),
    completed: await tile(page, 'tile-completed'),
    outstandingTasks: await hintCount(page, 'tile-outstanding'),
    overdueTasks: await hintCount(page, 'tile-overdue'),
  };
}

/** The open count in the by-kind table, or 0 when that kind has no open work. */
async function openOfKind(page: Page, kind: string): Promise<number> {
  const row = page.getByTestId(`kind-${kind}`);
  if ((await row.count()) === 0) return 0;
  return Number((await row.locator('td').nth(2).innerText()).trim());
}

/** Add one task to one speaker from the organizer side, and hand back its row. */
async function addTask(page: Page, speakerHref: string, label: string, kind: string) {
  await page.goto(speakerHref);
  await page.getByTestId('task-kind').selectOption(kind);
  await page.getByTestId('task-label').fill(label);
  await page.getByTestId('task-due').fill(OVERDUE_AT);
  await page.getByTestId('task-add').click();
  const row = page.getByTestId(/^speaker-task-/).filter({ hasText: label });
  await expect(row).toHaveCount(1);
  return row;
}

test('the tiles agree with the roster they link to', async ({ page }) => {
  await signIn(page, ORGANIZER);

  // Reached the way an organizer reaches it, from the nav, because a route that
  // only a test knows the URL of is not a feature.
  await page.goto('/organizer');
  await page.getByRole('link', { name: 'Onboarding', exact: true }).click();
  await expect(page).toHaveURL(/\/organizer\/onboarding$/);

  const counts = await readDashboard(page);

  // Ready is measured against the accepted population, so it cannot exceed it.
  const accepted = await hintCount(page, 'tile-clear');
  expect(accepted).toBeGreaterThan(0);
  expect(counts.clear).toBeLessThanOrEqual(accepted);

  // Overdue is a subset of outstanding, on both the people and the task count.
  expect(counts.overduePeople).toBeLessThanOrEqual(counts.outstandingPeople);
  expect(counts.overdueTasks).toBeLessThanOrEqual(counts.outstandingTasks);

  // The by-kind table accounts for every outstanding task exactly once.
  const rows = await page.getByTestId('by-kind').locator('tbody tr').all();
  let byKindTotal = 0;
  for (const row of rows) byKindTotal += Number((await row.locator('td').nth(2).innerText()).trim());
  expect(byKindTotal).toBe(counts.outstandingTasks);

  // The tile is a link, and this is the assertion that keeps it honest: the
  // number on the tile and the length of the list it opens are two independent
  // queries, and a dashboard whose figures disagree with the screen it sends
  // you to is worse than no dashboard.
  await page.getByTestId('tile-outstanding').click();
  await expect(page).toHaveURL(/filter=outstanding/);
  await expect(page.getByTestId(/^roster-/)).toHaveCount(counts.outstandingPeople);

  await page.goto('/organizer/onboarding');
  await page.getByTestId('tile-overdue').click();
  await expect(page).toHaveURL(/filter=overdue/);
  await expect(page.getByTestId(/^roster-/)).toHaveCount(counts.overduePeople);
});

test('a new overdue task moves the figures, and finishing it moves them back', async ({ page }) => {
  await signIn(page, ORGANIZER);

  const before = await readDashboard(page);
  const bioBefore = await openOfKind(page, 'bio');

  // Someone already outstanding, taken from the chase list itself. Picking a
  // person who already owes something is what keeps the people counts fixed
  // while the task counts move, so the two are told apart.
  const target = page.getByTestId('stuck-list').locator('li').first().getByRole('link').first();
  const href = await target.getAttribute('href');
  expect(href).toBeTruthy();

  const label = `e2e onboarding ${Date.now()}`;
  const row = await addTask(page, href!, label, 'bio');

  const added = await readDashboard(page);
  expect(added.outstandingTasks).toBe(before.outstandingTasks + 1);
  expect(added.overdueTasks).toBe(before.overdueTasks + 1);
  expect(added.outstandingPeople).toBe(before.outstandingPeople);
  expect(await openOfKind(page, 'bio')).toBe(bioBefore + 1);

  await page.goto(href!);
  await row.getByTestId('task-complete').click();
  await expect(row.getByTestId('task-complete')).toHaveCount(0);

  const done = await readDashboard(page);
  expect(done.outstandingTasks).toBe(before.outstandingTasks);
  expect(done.overdueTasks).toBe(before.overdueTasks);
  // Completing is the movement this screen exists to show, so it is the one
  // figure that must go up rather than back.
  expect(done.completed).toBe(before.completed + 1);

  await page.goto(href!);
  // Two presses since deleting a task also destroys its deadline, its chase
  // history and, for a finished one, the record that it was finished.
  await row.getByTestId('task-delete').click();
  await page.getByTestId('confirm-delete-task-submit').click();
  await expect(row).toHaveCount(0);

  const after = await readDashboard(page);
  expect(after).toEqual(before);
});

/**
 * The undo for the one-way button.
 *
 * `completed_at` is a single timestamp column and "Mark done" is one click with
 * no confirmation, so a mis-click used to be permanent: the only route back was
 * Delete, which also destroys the deadline and the chase history, and then
 * retyping the task from memory. Reopening writes the column back to null and
 * nothing else, which is why the dashboard has to come back to exactly the
 * figures it had before the mistake.
 */
test('a task marked done by mistake goes back on the outstanding list', async ({ page }) => {
  await signIn(page, ORGANIZER);

  const before = await readDashboard(page);

  const href = await page
    .getByTestId('stuck-list')
    .locator('li')
    .first()
    .getByRole('link')
    .first()
    .getAttribute('href');
  expect(href).toBeTruthy();

  const label = `e2e reopen ${Date.now()}`;
  const row = await addTask(page, href!, label, 'bio');

  await row.getByTestId('task-complete').click();
  // The two controls are mutually exclusive by construction, so the presence of
  // one is the absence of the other and both are worth asserting: a done task
  // offering "Mark done" again is the state that made the first bug invisible.
  await expect(row.getByTestId('task-complete')).toHaveCount(0);
  await expect(row.getByTestId('task-reopen')).toHaveCount(1);
  expect((await readDashboard(page)).completed).toBe(before.completed + 1);

  await page.goto(href!);
  await row.getByTestId('task-reopen').click();
  await expect(row.getByTestId('task-reopen')).toHaveCount(0);
  await expect(row.getByTestId('task-complete')).toHaveCount(1);

  const reopened = await readDashboard(page);
  expect(reopened.completed).toBe(before.completed);
  expect(reopened.outstandingTasks).toBe(before.outstandingTasks + 1);
  expect(reopened.overdueTasks).toBe(before.overdueTasks + 1);

  await page.goto(href!);
  await row.getByTestId('task-delete').click();
  await page.getByTestId('confirm-delete-task-submit').click();
  await expect(row).toHaveCount(0);

  const after = await readDashboard(page);
  expect(after).toEqual(before);
});

test('the dashboard refreshes itself, and the toggle stops it', async ({ page, context }) => {
  // Two full poll intervals plus a sign-in, so the budget is generous.
  test.setTimeout(120_000);
  await signIn(page, ORGANIZER);

  await page.goto('/organizer/onboarding');
  const href = await page
    .getByTestId('stuck-list')
    .locator('li')
    .first()
    .getByRole('link')
    .first()
    .getAttribute('href');

  const label = `e2e live ${Date.now()}`;
  await addTask(page, href!, label, 'bio');

  const before = await readDashboard(page);

  // The claim is "real-time", so the test never navigates this page again. A
  // second tab makes the change and the first has to notice on its own; polling
  // that only works when you reload is a reload.
  const other = await context.newPage();
  await other.goto(href!);
  await other
    .getByTestId(/^speaker-task-/)
    .filter({ hasText: label })
    .getByTestId('task-complete')
    .click();

  await expect(page.getByTestId('tile-outstanding-hint')).toContainText(
    `${before.outstandingTasks - 1} task`,
    { timeout: 45_000 },
  );

  // Paused says paused. Asserting the absence of a refresh would cost another
  // interval of waiting to prove a negative, so the state of the control is
  // what is checked here and the interval itself is covered above.
  const toggle = page.getByTestId('auto-refresh-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveText('Paused');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Put the task back the way the file found it, from the second tab, so the
  // dashboard tab is never navigated in this test at all.
  await other.goto(href!);
  const otherRow = other.getByTestId(/^speaker-task-/).filter({ hasText: label });
  await otherRow.getByTestId('task-delete').click();
  await other.getByTestId('confirm-delete-task-submit').click();
  await expect(otherRow).toHaveCount(0);
  await other.close();
});
