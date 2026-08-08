import { env } from '@/lib/env';
import { esc } from '@/lib/embed';
import { getEvent } from '@/lib/queries';

/**
 * A pretend conference website that embeds our two widgets.
 *
 * Deliberately not a page under the app's layout: it is a hand-written document
 * with its own font and its own colours, because "renders on somebody else's
 * site" is the claim and a React page inside our own tree would not test it.
 * The organizer opens it to see what the snippet on `/organizer/embed` will do
 * before they paste it into their CMS, and `e2e/embed.spec.ts` drives it.
 */
export async function GET(): Promise<Response> {
  const event = await getEvent();
  const base = env().APP_URL;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Embed preview · ${esc(event.name)}</title>
<style>
  body{margin:0;background:#faf7f2;color:#2b2118;font-family:Georgia,"Times New Roman",serif}
  main{max-width:820px;margin:0 auto;padding:32px 20px 60px}
  h1{font-size:28px;margin:0 0 4px}
  p.lede{margin:0 0 28px;color:#7a6a58}
  h2{font-size:18px;margin:36px 0 12px;border-bottom:2px solid #e6dccd;padding-bottom:6px}
</style>
</head><body>
<main>
  <h1>${esc(event.name)}</h1>
  <p class="lede">A stand-in for an organizer's own website. Everything below the
  headings is drawn by the Sessionboard embed script.</p>

  <h2>Our speakers</h2>
  <div data-sessionboard="speakers"></div>

  <h2>The schedule</h2>
  <div data-sessionboard="agenda"></div>
</main>
<script src="${esc(base)}/embed/embed.js" async></script>
</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
