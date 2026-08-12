import { expect, test, type Locator, type Page } from '@playwright/test';
import { extractMagicLink, waitForMail } from './mailbox';

/**
 * Real files on this server's disk: a headshot, a slide deck and a supporting
 * document, uploaded through the speaker portal and read back through
 * `/files/<id>`.
 *
 * Two properties are worth an e2e test rather than a unit test, because both
 * only exist end to end:
 *
 *   - the type is decided by the file's own first bytes, so an HTML page named
 *     `me.png` is refused however the browser labels it;
 *   - who may read a file back depends on its kind, so a supporting document is
 *     private on the same disk from which a headshot is public.
 *
 * This file sorts last and the suite resets the fixture before each run, but it
 * still puts back what it uploads: a stray headshot on a seeded speaker would
 * show up in a screenshot of the gallery long after anyone remembered why.
 */

const SPEAKER = 'speaker11@example.com';
const OTHER_SPEAKER = 'speaker12@example.com';
const ORGANIZER = 'organizer@example.com';

/** A real 1x1 PNG. The magic bytes are the point; the pixel is incidental. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Enough of a PDF to be one: nothing in this app parses past the header. */
const PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n'),
);

/** An HTML page wearing a PNG's name and a PNG's declared type. */
const IMPOSTOR = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

const FILES = /^\/files\/[0-9a-f-]{36}\//;

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
  if ((await page.getByTestId('current-user').count()) === 0) return;
  await page.getByTestId('user-menu').click();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('current-user')).toHaveCount(0);
}

/**
 * Read a file back the way the app does: `fetch` from inside the page, on the
 * app's own origin.
 *
 * Not `page.request`. `next start` runs in production mode, so the session
 * cookie carries `Secure`, and the suite runs over plain http on loopback.
 * Chrome makes the loopback exception and sends it; Playwright's own HTTP
 * client applies the rule strictly and does not. Every authenticated read
 * through `page.request` therefore arrives signed out, and every access rule
 * this file exists to check would read as "denied" for the wrong reason.
 */
async function fetchFile(
  page: Page,
  url: string,
): Promise<{ status: number; contentType: string | null; nosniff: string | null }> {
  return page.evaluate(async (target) => {
    // `no-store`, because a headshot is served cacheable and the claim under
    // test is what the server does now, not what this browser was told a minute
    // ago. Without it, a file deleted a moment earlier still reads 200.
    const response = await fetch(target, { cache: 'no-store' });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      nosniff: response.headers.get('x-content-type-options'),
    };
  }, url);
}

/** Upload a headshot and hand back the path it was stored at. */
async function uploadHeadshot(page: Page, file: Buffer, name = 'me.png'): Promise<string> {
  await page.goto('/speaker/profile');
  await page.getByTestId('headshot-file').setInputFiles({ name, mimeType: 'image/png', buffer: file });
  await page.getByTestId('headshot-upload').click();
  await expect(page.getByTestId('headshot-uploaded')).toBeVisible();

  const src = await page.getByTestId('headshot-image').first().getAttribute('src');
  expect(src).toMatch(FILES);
  return src!;
}

/** The first accepted talk on the content screen, and its submission id. */
async function firstContentCard(page: Page): Promise<{ id: string; documents: Locator }> {
  await page.goto('/speaker/content');
  const documents = page.locator('[data-testid^="documents-"]').first();
  await expect(documents).toBeVisible();
  const id = (await documents.getAttribute('data-testid'))!.replace('documents-', '');
  return { id, documents };
}

async function attachDocument(page: Page, id: string, name: string): Promise<string> {
  await page.getByTestId(`document-file-${id}`).setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await page.getByTestId(`document-upload-${id}`).click();
  await expect(page.getByTestId('content-flash')).toContainText('Document attached');

  const link = page.getByTestId(`documents-${id}`).getByRole('link', { name });
  await expect(link).toHaveCount(1);
  return (await link.getAttribute('href'))!;
}

test('a speaker uploads a headshot, a deck and a supporting document', async ({ page }) => {
  await signInVia(page, SPEAKER);

  const headshot = await uploadHeadshot(page, PNG);

  // Served back as the type it actually is, not the type the form declared, and
  // with `nosniff` so the browser does not get a second opinion.
  const image = await fetchFile(page, headshot);
  expect(image.status).toBe(200);
  expect(image.contentType).toBe('image/png');
  expect(image.nosniff).toBe('nosniff');

  const { id } = await firstContentCard(page);

  // A deck attached as a file, on the same form that takes a URL. The file
  // wins, and what lands in the column is this app's own path.
  await page.getByTestId(`slides-file-${id}`).setInputFiles({
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await page.getByRole('button', { name: 'Save draft' }).first().click();
  await expect(page.getByTestId('content-flash')).toContainText('Saved');
  await expect(page.getByTestId(`slides-${id}`)).toHaveValue(FILES);

  const documentHref = await attachDocument(page, id, 'handout.pdf');
  const document = await fetchFile(page, documentHref);
  expect(document.status).toBe(200);
  expect(document.contentType).toBe('application/pdf');

  // Removing a file takes the bytes down, not just the link to them. Clearing
  // the column alone would leave the photo readable at its old path, which is
  // not what "remove" means to the person pressing it.
  await page.goto('/speaker/profile');
  await page.getByTestId('headshot-remove').click();
  await expect(page.getByTestId('headshot-file-meta')).toContainText('Upload an image');
  expect((await fetchFile(page, headshot)).status).toBe(404);

  await page.goto('/speaker/content');
  await page.getByTestId(`document-remove-${documentHref.split('/')[2]}`).click();
  await expect(page.getByTestId('content-flash')).toContainText('Document removed');
});

test('an uploaded headshot replaces the URL field instead of sitting beside it', async ({
  page,
}) => {
  await signInVia(page, SPEAKER);

  // The URL field is the door for a speaker who has not uploaded anything, so
  // it is on screen before one exists.
  await page.goto('/speaker/profile');
  await expect(page.getByTestId('profile-headshot-url')).toBeVisible();

  const headshot = await uploadHeadshot(page, PNG, 'one-door.png');
  await expect(page.getByTestId('profile-headshot-url')).toHaveCount(0);

  // Saving the rest of the profile must not blank the column the upload wrote.
  // This form is `headshotUrl`'s only writer on save, so a field that were
  // simply deleted would post nothing and take the photo down with it.
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-saved')).toBeVisible();
  await page.goto('/speaker/profile');
  await expect(page.getByTestId('headshot-image').first()).toHaveAttribute('src', headshot);
  expect((await fetchFile(page, headshot)).status).toBe(200);

  // Removing the upload hands the fallback door back, empty.
  await page.getByTestId('headshot-remove').click();
  await expect(page.getByTestId('headshot-file-meta')).toContainText('Upload an image');
  await expect(page.getByTestId('profile-headshot-url')).toHaveValue('');
});

test('a file that is not what it says it is gets refused', async ({ page }) => {
  await signInVia(page, SPEAKER);
  await page.goto('/speaker/profile');
  // Snapshotted rather than assumed empty: what matters is that a refused
  // upload changes nothing, whatever this speaker's profile held when we
  // arrived.
  const before = (await page.getByTestId('headshot-file-meta').textContent())!;

  // The browser is telling the truth about what it was handed and the file is
  // lying about what it is. Trusting the declared type here would put an
  // attacker's HTML on this origin, served to whoever opened the headshot.
  await page.getByTestId('headshot-file').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: IMPOSTOR,
  });
  await page.getByTestId('headshot-upload').click();

  await expect(page.getByTestId('headshot-error')).toContainText('whatever it is named');
  await expect(page.getByTestId('headshot-file-meta')).toHaveText(before);

  // A real PDF is a real file and still not a headshot. The refusal is the
  // kind's rule rather than the sniffer's, and it says so.
  await page.getByTestId('headshot-file').setInputFiles({
    name: 'me.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await page.getByTestId('headshot-upload').click();
  await expect(page.getByTestId('headshot-error')).toContainText('A headshot has to be an image');
});

test('a supporting document is private and a headshot is not', async ({ page }) => {
  await signInVia(page, SPEAKER);

  const headshot = await uploadHeadshot(page, PNG, 'portrait.png');
  const { id } = await firstContentCard(page);
  const documentHref = await attachDocument(page, id, 'salary-appendix.pdf');

  // Two files on the same disk, uploaded a minute apart by the same person.
  // The kind is the whole difference: a headshot is already on the public
  // speaker gallery, and a supporting document is material for the committee.
  await signOut(page);
  expect((await fetchFile(page, headshot)).status, 'headshot, signed out').toBe(200);
  expect((await fetchFile(page, documentHref)).status, 'document, signed out').toBe(404);

  // 404 rather than 403, for a stranger and for a signed-in stranger alike:
  // a 403 would confirm to anyone walking the id space which documents exist.
  await signInVia(page, OTHER_SPEAKER);
  expect((await fetchFile(page, documentHref)).status, 'document, other speaker').toBe(404);
  await signOut(page);

  // The organizers are who it was sent to, and the board is where they find it.
  await signInVia(page, ORGANIZER);
  expect((await fetchFile(page, documentHref)).status, 'document, organizer').toBe(200);
  // Searched by id: the board pages at 25 and this row is wherever its grade
  // puts it.
  await page.goto(`/organizer/submissions?q=${id}`);
  const panel = page.getByTestId(`organizer-documents-${id}`);
  // The list lives in the row's collapsed "Content and locks" panel, and a
  // closed `details` is out of the accessibility tree, so the link genuinely is
  // not reachable until an organizer opens it. Opening it is the assertion.
  await page.locator('details', { has: panel }).locator('summary').first().click();
  await expect(panel.getByRole('link', { name: 'salary-appendix.pdf' })).toBeVisible();
  await signOut(page);

  await signInVia(page, SPEAKER);
  await page.goto('/speaker/profile');
  await page.getByTestId('headshot-remove').click();
  // Same wait the first removal above makes. Navigating straight off the click
  // races the server action, and losing it leaves this speaker's headshot on the
  // public gallery for every file that runs after this one, with nothing red.
  await expect(page.getByTestId('headshot-file-meta')).toContainText('Upload an image');
  await page.goto('/speaker/content');
  await page.getByTestId(`document-remove-${documentHref.split('/')[2]}`).click();
  await expect(page.getByTestId('content-flash')).toContainText('Document removed');
});

/**
 * A deck on a draft card is readable by the public, because the agenda page
 * links to it.
 *
 * Two gates decide this and they had drifted. `/agenda/<id>` publishes a
 * material when the content is 'approved' or 'draft'-with-a-value, the second
 * leg being deliberate so the seeded back catalogue did not vanish the day
 * moderation shipped. `readableUpload` demanded 'approved' outright, so the
 * button rendered and the file behind it answered 404. Both now go through
 * `contentIsPublic`.
 */
test('slides on a draft card are public, matching the link the agenda renders', async ({
  page,
}) => {
  await signInVia(page, SPEAKER);
  const { id } = await firstContentCard(page);

  await page.getByTestId(`slides-file-${id}`).setInputFiles({
    name: 'draft-deck.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await page.getByRole('button', { name: 'Save draft' }).first().click();
  await expect(page.getByTestId('content-flash')).toContainText('Saved');

  // Saving a draft leaves the card at contentStatus 'draft', which is the whole
  // point: this is the state the agenda page publishes and the file server used
  // to refuse.
  const href = await page.getByTestId(`slides-${id}`).inputValue();
  expect(href).toMatch(FILES);

  await signOut(page);
  const deck = await fetchFile(page, href);
  expect(deck.status, 'a signed-out visitor following the agenda link').toBe(200);
  expect(deck.contentType).toBe('application/pdf');
});
