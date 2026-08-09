import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The embeddable speaker gallery and schedule itinerary, driven the way an
 * organizer's own website drives them: a document on a different origin with a
 * script tag in it.
 *
 * The host page comes from a real one-file server on an ephemeral loopback
 * port, not from `page.route`. Two reasons, and the second is the load-bearing
 * one:
 *
 *   - The fetch is then genuinely cross-origin, so the CORS headers on the feed
 *     are under test rather than assumed.
 *   - Chrome blocks a request to a *more private* address space, and a response
 *     synthesised by `page.route` has no address at all, so a fulfilled host
 *     page cannot load anything from 127.0.0.1. The failure is
 *     "Permission was denied for this request to access the `loopback` address
 *     space", it is the browser's policy rather than ours, and no response
 *     header fixes it. A real loopback server is in the same address space and
 *     the question never arises.
 *
 * Nothing signs in on that origin, which is also the point: the widget must
 * never depend on a session cookie.
 *
 * This file sorts first, ahead of `features.spec.ts`, and shares its database
 * with everything after it. The only thing it changes is the published flag,
 * and it puts that back. It used to add a break band and then delete one, which
 * was safe only while the fixture seeded no schedule; the fixture now seeds two
 * days of it, the deletion took a seeded band with it, and four later files
 * failed for a reason none of them could see.
 */

const ORGANIZER = 'organizer@example.com';
/** A break the fixture seeds, so this file no longer has to write one. */
const BREAK_LABEL = 'Lunch';
const BOTH_WIDGETS =
  '<div data-sessionboard="speakers"></div><div data-sessionboard="agenda"></div>';

/** A pretend customer website. It renders whatever the query string asks for. */
let host: Server;
let hostOrigin: string;

test.beforeAll(async () => {
  host = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://placeholder');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      [
        '<!doctype html><html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Our conference</title></head><body><h1>Our conference</h1>',
        url.searchParams.get('w') ?? '',
        `<script src="${url.searchParams.get('app')}/embed/embed.js"></script>`,
        '</body></html>',
      ].join(''),
    );
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  hostOrigin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => host.close(() => resolve()));
});

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

async function openHostPage(page: Page, appUrl: string, widgets: string) {
  const query = `app=${encodeURIComponent(appUrl)}&w=${encodeURIComponent(widgets)}`;
  await page.goto(`${hostOrigin}/?${query}`);
}

test('the widgets say the programme is closed rather than rendering nothing', async ({
  page,
  baseURL,
}) => {
  // The fixture starts unpublished. A widget already pasted into a host page
  // has to say something honest on the morning before the line-up goes out.
  await openHostPage(page, baseURL!, BOTH_WIDGETS);

  const gallery = page.locator('[data-sessionboard="speakers"]');
  const itinerary = page.locator('[data-sessionboard="agenda"]');

  await expect(gallery).toHaveAttribute('data-sessionboard-state', 'closed');
  await expect(itinerary).toHaveAttribute('data-sessionboard-state', 'closed');
  await expect(gallery).toContainText('is not published yet');
  await expect(itinerary).toContainText('is not published yet');

  // Closed means closed: who got in is the committee's decision to announce.
  await expect(page.locator('body')).not.toContainText('Speaker 1');

  const feed = await (await page.request.get(`${baseURL}/embed/speakers.json`)).json();
  expect(feed.published).toBe(false);
  expect(feed.speakers).toEqual([]);
});

test('a host page on another origin renders the gallery and the itinerary', async ({
  page,
  baseURL,
}) => {
  await signInVia(page, ORGANIZER);
  await page.goto('/organizer/schedule');

  // The fixture's own break is the entry under test. It exercises the collapse
  // — a break is one slot per room, so it arrives as three rows and must render
  // as one line — and using the seeded one rather than writing a fresh band
  // keeps this file's only edit to the published flag.
  await page.getByTestId('toggle-publish').click();
  await expect(page.getByTestId('toggle-publish')).toHaveText('Unpublish agenda');

  await openHostPage(page, baseURL!, BOTH_WIDGETS);

  const gallery = page.locator('[data-sessionboard="speakers"]');
  const itinerary = page.locator('[data-sessionboard="agenda"]');

  await expect(gallery).toHaveAttribute('data-sessionboard-state', 'ready');
  await expect(itinerary).toHaveAttribute('data-sessionboard-state', 'ready');

  await expect(gallery.locator('.sb-card').first()).toBeVisible();
  await expect(itinerary.locator('.sb-title', { hasText: BREAK_LABEL })).toHaveCount(1);

  // Every link points back at the app rather than at the host page, which is
  // the whole reason a gallery is worth embedding.
  await expect(gallery.locator('.sb-name').first()).toHaveAttribute(
    'href',
    new RegExp(`^${baseURL}/speakers/`),
  );

  // Mobile-friendly is a measurable claim, so measure it: the gallery is one
  // column on a phone and more than one on a desktop.
  const columns = () =>
    gallery
      .locator('.sb-grid')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);

  await page.setViewportSize({ width: 390, height: 780 });
  expect(await columns(), 'columns at 390px').toBe(1);

  await page.setViewportSize({ width: 1100, height: 780 });
  expect(await columns(), 'columns at 1100px').toBeGreaterThan(1);

  // The iframe fallback is the same widget without the script, for a CMS that
  // allows one and not the other, so it has to stand up on its own markup.
  await page.goto(`${baseURL}/embed/agenda`);
  await expect(page.locator('.sb-title', { hasText: BREAK_LABEL })).toHaveCount(1);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /width=device-width/,
  );
  await page.goto(`${baseURL}/embed/speakers`);
  await expect(page.locator('.sb-card').first()).toBeVisible();

  // Put the fixture back for the files that run after this one. Unpublishing is
  // the whole of it: nothing here wrote a row.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/organizer/schedule');
  await page.getByTestId('toggle-publish').click();
  await expect(page.getByTestId('toggle-publish')).toHaveText('Publish agenda');
});

test('an unknown widget name and a malformed filter both fail soft', async ({ page, baseURL }) => {
  await openHostPage(
    page,
    baseURL!,
    '<div data-sessionboard="sponsors"></div><div data-sessionboard="agenda" data-track="banana"></div>',
  );

  const unknown = page.locator('[data-sessionboard="sponsors"]');
  await expect(unknown).toHaveAttribute('data-sessionboard-state', 'error');
  await expect(unknown).toContainText('Unknown Saas Killa widget "sponsors"');

  // One bad div does not take the rest of the host page's widgets with it.
  await expect(page.locator('[data-sessionboard="agenda"]')).toHaveAttribute(
    'data-sessionboard-state',
    /ready|closed/,
  );

  // A hand-edited filter reaches a uuid column if nothing discards it first, and
  // a 500 on somebody else's website reads as our outage.
  const response = await page.request.get(`${baseURL}/embed/agenda.json?track=banana&day=tuesday`);
  expect(response.status()).toBe(200);
  expect((await response.json()).event.name).toBeTruthy();
});
