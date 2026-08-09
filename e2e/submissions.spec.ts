import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The decision board, on the size of the page it renders.
 *
 * It used to read the whole call for papers and narrow it in JavaScript: 40
 * seeded submissions came out as 17,093 pixels of page and 2,522 DOM nodes, with
 * one filter on it — content status — and no way at all to find a row by its
 * title or its speaker. An organizer looking for one proposal scrolled for it,
 * and a real event's several hundred would have scaled linearly.
 *
 * Everything here is read-only. The filters are a GET form and the pager is a
 * set of links, so this file changes nothing and puts nothing back.
 */

const ORGANIZER = 'organizer@example.com';

/** Rows on the board, which is deliberately not `[data-testid^="submission-"]`
 *  in this file: that prefix is what the filter controls were named until they
 *  collided with it. Matching the uuid is what tells the two apart. */
const ROWS = /^submission-[0-9a-f]{8}-/;

const PAGE_SIZE = 25;

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

/** The ids on screen, in the order the board put them. */
async function rowIds(page: Page): Promise<string[]> {
  return page
    .getByTestId(ROWS)
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute('data-testid') ?? '').replace('submission-', '')),
    );
}

test('the board renders a page of rows, not the whole call for papers', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/submissions');

  await expect(page.getByTestId(ROWS)).toHaveCount(PAGE_SIZE);

  // The symptom, measured. 10,845px and 1,572 nodes against 17,093 and 2,522,
  // on the same 40 submissions. The bound is loose on purpose: a card gaining a
  // line is not this test's business, and the whole board coming back is.
  const shape = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    nodes: document.getElementsByTagName('*').length,
  }));
  expect(shape.height, 'page height').toBeLessThan(14_000);
  expect(shape.nodes, 'DOM nodes').toBeLessThan(2_000);

  // The header counts the whole event, not the page. A "12 undecided" that fell
  // to 8 on turning to page 2 would be counting the wrong thing, and the send
  // button beside it acts on every decided row in the database.
  const total = Number(
    /Showing 1–\d+ of (\d+)/.exec((await page.getByTestId('pager-range').textContent()) ?? '')?.[1],
  );
  expect(total, 'submissions in the event').toBeGreaterThan(PAGE_SIZE);
  await expect(page.getByTestId('filter-all')).toContainText(`(${total})`);
});

test('page two holds the rest and shares no row with page one', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/submissions');
  const first = await rowIds(page);

  await page.getByTestId('page-next').click();
  await expect(page.getByTestId('page-of')).toContainText('Page 2');
  const second = await rowIds(page);

  // A sort without a total order lets Postgres return tied rows in any order it
  // likes per query, which shows up exactly here: a row on both pages, and one
  // on neither. Every sort therefore ends on the id.
  expect(second.filter((id) => first.includes(id)), 'rows on both pages').toEqual([]);
  expect(first.length + second.length, 'rows across both pages').toBe(
    Number(
      /of (\d+)/.exec((await page.getByTestId('pager-range').textContent()) ?? '')?.[1] ?? '0',
    ),
  );

  // A page number past the end is the last page, not an empty screen with the
  // pager scrolled off it.
  await page.goto('/organizer/submissions?page=99');
  await expect(page.getByTestId('pager-range')).toHaveText(/Showing \d+–\d+ of \d+/);
  expect(await rowIds(page)).toEqual(second);
});

test('the search box finds a row by title, by speaker and by id', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/submissions');

  const id = (await rowIds(page))[0];
  const row = page.getByTestId(`submission-${id}`);
  const title = (await row.locator('h2').first().textContent()) ?? '';
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(await row.innerText())?.[0] ?? '';
  expect(title, 'a title to search for').not.toBe('');
  expect(email, 'a speaker address to search for').not.toBe('');

  // Through the form, because the form is what an organizer actually uses.
  await page.getByTestId('board-search').fill(title);
  await page.getByTestId('board-apply').click();
  await expect(page.getByTestId(`submission-${id}`)).toBeVisible();
  await expect(page.getByTestId('board-search')).toHaveValue(title);

  await page.goto(`/organizer/submissions?q=${encodeURIComponent(email)}`);
  await expect(page.getByTestId(`submission-${id}`)).toBeVisible();

  // A uuid matches the row it names rather than being looked for inside a
  // title. Ids are the first column of the CSV export and the tail of every
  // organizer URL, so pasting one in is the ordinary way back to a known row.
  await page.goto(`/organizer/submissions?q=${id}`);
  await expect(page.getByTestId(ROWS)).toHaveCount(1);
  await expect(page.getByTestId(`submission-${id}`)).toBeVisible();

  await page.goto('/organizer/submissions?q=zzz-nothing-matches-this');
  await expect(page.getByTestId(ROWS)).toHaveCount(0);
  await expect(page.getByTestId('pager-range')).toContainText('No submissions match');
});

test('the decision filter and the sort control both change what is on the page', async ({
  page,
}) => {
  await signInVia(page, ORGANIZER);

  await page.goto('/organizer/submissions?status=accepted');
  const accepted = page.getByTestId(ROWS);
  await expect(accepted).not.toHaveCount(0);
  for (const text of await accepted.allInnerTexts()) {
    expect(text, 'a row under the accepted filter').toContain('Accepted');
  }

  // Three sorts, three different orderings of the same page. Compared as whole
  // ordered lists rather than by their first row: a proposal an earlier file
  // graded 5 is both the newest and the best, so the top row alone is a
  // coincidence waiting to happen, while a full page agreeing is not.
  const orders: Record<string, string[]> = {};
  for (const sort of ['grade', 'newest', 'title']) {
    await page.goto(`/organizer/submissions?sort=${sort}`);
    orders[sort] = await rowIds(page);
  }
  expect(orders.grade, 'grade against newest').not.toEqual(orders.newest);
  expect(orders.grade, 'grade against title').not.toEqual(orders.title);
  expect(orders.newest, 'newest against title').not.toEqual(orders.title);

  // A sort the app does not have is the default, not a 500: this reaches the
  // ORDER BY, and an unchecked one would be a query built from the query string.
  await page.goto('/organizer/submissions?sort=; drop table submissions');
  await expect(page.getByTestId('board-sort')).toHaveValue('grade');
  await expect(page.getByTestId(ROWS)).toHaveCount(PAGE_SIZE);
});

test('a content chip keeps the search it was pressed from', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  // The chips were bare `?content=` links, so pressing one from a searched board
  // silently dropped the search, the sort and the decision filter.
  await page.goto('/organizer/submissions?sort=title&page=2');
  await expect(page.getByTestId('filter-approved')).toHaveAttribute(
    'href',
    '/organizer/submissions?content=approved&sort=title',
  );

  await page.goto('/organizer/submissions?q=review');
  const searched = await page.getByTestId(ROWS).count();
  await page.getByTestId('filter-draft').click();

  await expect(page).toHaveURL(/content=draft/);
  await expect(page).toHaveURL(/q=review/);
  await expect(page.getByTestId('board-search')).toHaveValue('review');
  // Both filters, not the last one pressed: the chip narrows the search rather
  // than replacing it.
  expect(await page.getByTestId(ROWS).count(), 'draft rows within the search').toBeLessThanOrEqual(
    searched,
  );
  for (const text of await page.getByTestId(ROWS).allInnerTexts()) {
    expect(text, 'a row under the draft content chip').toContain('Content: Draft');
  }
});

test('show all is still there for the organizer who wants the whole board', async ({ page }) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/submissions');

  const total = Number(
    /of (\d+)/.exec((await page.getByTestId('pager-range').textContent()) ?? '')?.[1] ?? '0',
  );
  await page.getByTestId('page-all').click();

  await expect(page.getByTestId('pager-range')).toHaveText(`Showing all ${total}`);
  await expect(page.getByTestId(ROWS)).toHaveCount(total);
  // And a way back, because the whole point is that this is the exception.
  await expect(page.getByTestId('page-paged')).toBeVisible();
});
