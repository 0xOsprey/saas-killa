import { expect, test, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * The speaker wiki: pages an organizer writes, and what survives the sanitiser.
 *
 * Sorts between `pipeline.spec.ts` and `schedule.spec.ts`, and touches nothing
 * either of them reads. Every page it creates it deletes.
 *
 * The second test is the one that matters. A sanitiser is only worth anything
 * if it is exercised against the payloads it exists to stop, and asserting on
 * its return value in isolation would not catch the failure that actually hurts
 * here, which is a screen rendering the raw body instead of the sanitised one.
 * So the check is made in the browser, on the page a speaker sees.
 */

const ORGANIZER = 'organizer@example.com';
const SPEAKER = 'speaker11@example.com';

async function signInVia(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();

  const mail = await waitForMail((m) => m.to === email && m.subject.includes('sign-in link'));
  await page.goto(extractMagicLink(mail));
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

async function signOut(page: Page) {
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('current-user')).toHaveCount(0);
}

async function writePage(
  page: Page,
  fields: { title: string; slug: string; body: string; summary?: string },
) {
  await page.goto('/organizer/pages');
  await page.getByTestId('page-title').fill(fields.title);
  await page.getByTestId('page-slug').fill(fields.slug);
  if (fields.summary) await page.getByTestId('page-summary').fill(fields.summary);
  await page.getByTestId('page-body').fill(fields.body);
  await page.getByTestId('page-save').click();
  await expect(page.getByTestId('page-saved')).toBeVisible();
}

async function publish(page: Page, slug: string) {
  await page.goto('/organizer/pages');
  await page.getByTestId(`page-publish-${slug}`).click();
  await expect(page.getByTestId(`page-publish-${slug}`)).toHaveText('Unpublish');
}

async function removePage(page: Page, slug: string) {
  await page.goto('/organizer/pages');
  await page.getByTestId(`page-delete-${slug}`).click();
  await expect(page.getByTestId(`page-delete-${slug}`)).toHaveCount(0);
}

test('an organizer writes a page and a speaker reads it', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  await writePage(page, {
    title: 'Expenses and travel',
    slug: 'expenses',
    summary: 'What we cover and how to claim it.',
    body: [
      '<h2>What we cover</h2>',
      '<ul><li>A standard-class return</li><li>Two nights at the conference hotel</li></ul>',
      '<p>Claims go to <a href="https://example.com/claims">the claims form</a>, and the',
      'lectern details are on the <a href="/speaker/pages/venue-and-av">venue page</a>.</p>',
      '<iframe src="https://player.vimeo.com/video/12345" width="480" height="270" title="How to claim"></iframe>',
    ].join('\n'),
  });
  await publish(page, 'expenses');

  await signOut(page);
  await signInVia(page, SPEAKER);

  // The index, then the page. A wiki nobody can find their way into is a set of
  // URLs, so the index is part of the feature rather than decoration.
  await page.goto('/speaker/pages');
  await page.getByTestId('portal-page-link-expenses').click();

  const body = page.getByTestId('portal-page-body');
  await expect(body.getByRole('heading', { name: 'What we cover' })).toBeVisible();
  await expect(body.getByRole('listitem')).toHaveCount(2);

  // An embed from an allowed host survives, sandboxed. The sandbox is the point:
  // it is what stops framed content reaching the session around it.
  const frame = body.locator('iframe');
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute('src', 'https://player.vimeo.com/video/12345');
  await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);

  // An outbound link cannot reach back through `window.opener`; a wiki link to
  // another page in this portal stays in the tab, because it is not outbound.
  const outbound = body.getByRole('link', { name: 'the claims form' });
  await expect(outbound).toHaveAttribute('rel', /noopener/);
  await expect(outbound).toHaveAttribute('target', '_blank');
  const internal = body.getByRole('link', { name: 'venue page' });
  await expect(internal).toHaveAttribute('href', '/speaker/pages/venue-and-av');
  await expect(internal).not.toHaveAttribute('target', '_blank');

  // And the wiki link works, which is the whole reason slugs are the address.
  await internal.click();
  await expect(page.getByRole('heading', { name: 'Venue and AV' })).toBeVisible();

  await signOut(page);
  await signInVia(page, ORGANIZER);
  await removePage(page, 'expenses');
});

test('script, handlers and unlisted embeds do not survive the page', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  const marker = `sentinel-${Date.now()}`;
  await writePage(page, {
    title: 'Hostile paste',
    slug: 'hostile',
    body: [
      `<p>${marker} opening</p>`,
      '<script>window.__owned = true;</script>',
      '<img src="https://example.com/a.png" alt="pixel" onerror="window.__owned = true">',
      '<a href="javascript:window.__owned = true">looks like a link</a>',
      '<iframe src="https://evil.test/frame"></iframe>',
      '<iframe src="https://evil-youtube.com/frame"></iframe>',
      '<style>body { display: none }</style>',
      '<form action="/organizer/pages"><button>Delete everything</button></form>',
      `<p>${marker} closing</p>`,
    ].join('\n'),
  });
  await publish(page, 'hostile');

  await signOut(page);
  await signInVia(page, SPEAKER);
  await page.goto('/speaker/pages/hostile');

  const body = page.getByTestId('portal-page-body');

  // The organizer's actual writing is still there. A sanitiser that ate the
  // page along with the payload would pass every negative check below and be
  // useless.
  await expect(body).toContainText(`${marker} opening`);
  await expect(body).toContainText(`${marker} closing`);

  // Nothing ran. This is the assertion the whole file exists for: not that the
  // string was removed, but that no script executed in a signed-in session.
  expect(await page.evaluate(() => (window as { __owned?: boolean }).__owned)).toBeUndefined();

  // The script's source text is not printed onto the page either, which is what
  // "drop the contents too" means for a `<script>` tag.
  await expect(body).not.toContainText('__owned');
  await expect(body.locator('script')).toHaveCount(0);
  await expect(body.locator('style')).toHaveCount(0);
  await expect(body.locator('form')).toHaveCount(0);
  await expect(body.locator('button')).toHaveCount(0);

  // The image kept its src and lost its handler; the tag survives because an
  // image is legitimate and the attribute is not.
  const image = body.locator('img');
  await expect(image).toHaveCount(1);
  expect(await image.getAttribute('onerror')).toBeNull();

  // A `javascript:` href takes its whole tag with it. The text stays, so the
  // organizer can see what they wrote and fix it.
  await expect(body.getByRole('link', { name: 'looks like a link' })).toHaveCount(0);
  await expect(body).toContainText('looks like a link');

  // Neither an unlisted host nor a lookalike of a listed one gets to frame.
  await expect(body.locator('iframe')).toHaveCount(0);

  await signOut(page);
  await signInVia(page, ORGANIZER);
  await removePage(page, 'hostile');
});

test('a draft is invisible to speakers and readable by its author', async ({ page }) => {
  await signInVia(page, ORGANIZER);

  // The seeded draft, not one this test makes: a page left unpublished by
  // somebody else is the case that actually happens.
  await page.goto('/speaker/pages/before-you-arrive');
  await expect(page.getByRole('heading', { name: 'Before you arrive' })).toBeVisible();
  await expect(page.getByTestId('portal-page-draft')).toBeVisible();

  await signOut(page);
  await signInVia(page, SPEAKER);

  // 404 rather than a refusal notice. A draft a speaker may not read is a page
  // that does not exist, and a "not allowed" screen carrying its title tells
  // them about work in progress they were not meant to see.
  const response = await page.goto('/speaker/pages/before-you-arrive');
  expect(response?.status()).toBe(404);

  await page.goto('/speaker/pages');
  await expect(page.getByTestId('portal-page-link-venue-and-av')).toBeVisible();
  await expect(page.getByTestId('portal-page-link-before-you-arrive')).toHaveCount(0);

  // A signed-out visitor gets neither: this is the speaker portal, not a public
  // site, and the redirect is what says so.
  await signOut(page);
  await page.goto('/speaker/pages');
  await expect(page).toHaveURL(/\/login/);
});
