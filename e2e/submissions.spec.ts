import { expect, test, type Page } from '@playwright/test';
import { withDb } from './db';
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
 * Every test but the last is read-only: the filters are a GET form and the pager
 * is a set of links. The last one drives the bulk bar, which writes, and it puts
 * the rows it touched back exactly.
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
  expect(shape.nodes, 'DOM nodes').toBeLessThan(2_500);

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

/** Tick the checkbox on each row and wait for the bar that only a selection shows. */
async function select(page: Page, ids: string[]) {
  for (const id of ids) await page.getByTestId(`select-${id}`).check();
  await expect(page.getByTestId('bulk-bar')).toContainText(`${ids.length} selected`);
}

/**
 * The four bulk actions, which had no coverage at all: deciding, tracking,
 * approving content and freezing a field across a selection.
 *
 * Each one is the same shape — a selection, a control, one write per row — and
 * each clears the selection afterwards, so the rows are ticked again between
 * actions. The fourth row is the control: it sits in the same filter and is
 * never selected, so an action that quietly widened to the whole filter would
 * show up as the row that should not have moved.
 *
 * The restore is a database write and is the only one in the suite. Three of the
 * four have a way back on screen and `bulkApproveContent` does not: content goes
 * draft to pending to approved, an organizer can send it back but only to draft
 * with a reason attached, and a row returning to 'pending' is not a state this
 * app offers. The choice was a restore that lands where the seed was, or three
 * actions instead of four.
 */
test('the bulk bar acts on the selection, and leaves the rest of the filter alone', async ({
  page,
}) => {
  await signInVia(page, ORGANIZER);

  // Undecided rows: the least entangled slice of the board. They are not on the
  // agenda, not in the calendar feeds and not scheduled.
  await page.goto('/organizer/submissions?status=submitted&sort=title');
  const onScreen = await rowIds(page);
  expect(onScreen.length, 'undecided rows to act on').toBeGreaterThan(3);
  const ids = onScreen.slice(0, 3);
  const untouched = onScreen[3]!;

  const before = await withDb(
    async (sql) =>
      await sql`
        select id, status, track_id, content_status, locked_fields
        from submissions
        where id = any(${[...ids, untouched]}::uuid[])`,
  );
  expect(before.length, 'rows read back for the restore').toBe(4);

  try {
    await select(page, ids);
    await page.getByTestId('bulk-status').selectOption('rejected');
    await page.getByTestId('bulk-status-apply').click();
    // The filter is `status=submitted`, so the three rejected rows leave the
    // page and the fourth stays. That is the strongest form of the assertion:
    // the selection moved and its neighbour did not.
    for (const id of ids) await expect(page.getByTestId(`submission-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`submission-${untouched}`)).toContainText('Under review');

    await page.goto('/organizer/submissions?status=rejected&sort=title');
    for (const id of ids) {
      await expect(page.getByTestId(`submission-${id}`)).toContainText('Not accepted');
    }

    // A track none of them is in already, so the assertion cannot pass by
    // accident on a row that was there to begin with.
    await select(page, ids);
    const options = await page
      .getByTestId('bulk-track')
      .locator('option')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute('value') ?? '',
          label: (node.textContent ?? '').trim(),
        })),
      );
    const rowsNow = await page.getByTestId(ROWS).allInnerTexts();
    const track = options.find(
      (option) => option.value !== '' && !rowsNow.some((text) => text.includes(option.label)),
    );
    expect(track, 'a track none of the selected rows is in').toBeTruthy();
    await page.getByTestId('bulk-track').selectOption(track!.value);
    await page.getByTestId('bulk-track-apply').click();
    for (const id of ids) {
      await expect(page.getByTestId(`submission-${id}`)).toContainText(track!.label);
    }

    await select(page, ids);
    await page.getByTestId('bulk-approve-content').click();
    for (const id of ids) {
      await expect(page.getByTestId(`submission-${id}`)).toContainText('Content: Approved');
    }

    // Locking is the one that reads back on the speaker's own screen, so the
    // badge is the organizer's half of it. Unlock is asserted too: a lock with
    // no way off is a support ticket.
    await select(page, ids);
    const field = await page.getByTestId('bulk-lock-field').inputValue();
    const fieldLabel = (
      await page
        .getByTestId('bulk-lock-field')
        .locator(`option[value="${field}"]`)
        .innerText()
    ).trim();
    await page.getByTestId('bulk-lock').click();
    for (const id of ids) {
      // Scoped to the line rather than the card. The field name also appears in
      // the lock controls further down every row, so a card-wide match would
      // pass on a row nothing had been locked on.
      const line = page
        .getByTestId(`submission-${id}`)
        .locator('p', { hasText: 'Locked to the speaker' });
      await expect(line).toContainText(fieldLabel);
    }

    await select(page, ids);
    await page.getByTestId('bulk-unlock').click();
    for (const id of ids) {
      await expect(page.getByTestId(`submission-${id}`)).not.toContainText('Locked to the speaker');
    }
  } finally {
    await withDb(async (sql) => {
      for (const row of before) {
        // Both status columns are Postgres enums, and a bare parameter arrives
        // as text, so each one is cast by name rather than left to inference.
        await sql`
          update submissions
          set status = ${row.status}::submission_status,
              track_id = ${row.track_id},
              content_status = ${row.content_status}::content_status,
              locked_fields = ${sql.json(row.locked_fields)}
          where id = ${row.id}`;
      }
    });
  }
});
