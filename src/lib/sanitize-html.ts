/**
 * HTML sanitisation for organizer-authored portal pages.
 *
 * Written here rather than pulled in, like `ics.ts`, but for a different reason
 * and with a different risk. Serialising a VEVENT wrong produces a bad calendar
 * file; sanitising HTML wrong produces script execution on this origin, in a
 * signed-in speaker's session. So the design is the conservative one:
 *
 *   NOTHING FROM THE INPUT IS PASSED THROUGH.
 *
 * The input is tokenised and the output is rebuilt from an allowlist, tag by
 * tag and attribute by attribute, with every text node escaped. A construct
 * this file does not understand cannot survive by accident, because surviving
 * requires being written out again, and only known tags and known attributes
 * are ever written. That is the opposite of a filter that removes the bad
 * things it can think of, which is the design that keeps failing.
 *
 * What an organizer gets is a wiki page: headings, lists, tables, links,
 * images, and an embed from a host on the list below. What they cannot get is
 * script, style, event handlers, `javascript:` URLs, form controls, or an
 * iframe pointing anywhere else.
 */

/** Tags kept, with the attributes each may carry. Everything else is dropped. */
const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  br: [],
  hr: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  code: [],
  pre: [],
  blockquote: [],
  h2: ['id'],
  h3: ['id'],
  h4: ['id'],
  ul: [],
  ol: [],
  li: [],
  dl: [],
  dt: [],
  dd: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height'],
  figure: [],
  figcaption: [],
  iframe: ['src', 'width', 'height', 'title'],
};

/** Tags with no closing tag. Written self-closed and never pushed on the stack. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * Tags whose *contents* go too, not just the tag.
 *
 * For an unknown tag like `<div>` the text inside is the organizer's writing
 * and is kept. For these, the contents are the payload: dropping `<script>` and
 * keeping what was between the tags would print the program on the page and, in
 * the case of `<style>`, a dropped `<style>` tag leaves CSS that a browser in
 * quirks mode may still apply.
 */
const DROP_CONTENTS = new Set([
  'script',
  'style',
  'svg',
  'math',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'select',
  'option',
  'textarea',
  'button',
  'head',
]);

/**
 * Hosts an `<iframe>` may point at.
 *
 * An allowlist rather than a blocklist, and hosts rather than a scheme check,
 * because an iframe is the one allowed tag that runs someone else's code. A
 * page that frames an arbitrary URL is a page that can frame this app's own
 * origin and phish a speaker's session inside a screen they trust.
 *
 * Subdomains match: `www.youtube.com` is on the list because
 * `evil-youtube.com` must not be, and a suffix test alone gives you the second
 * for free.
 */
const EMBED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'docs.google.com',
  'drive.google.com',
  'calendar.google.com',
  'www.google.com',
  'open.spotify.com',
  'w.soundcloud.com',
  'codesandbox.io',
  'codepen.io',
]);

/** `&` first, or the entities the later replacements add get double-escaped. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL an `href` or `src` may hold.
 *
 * Site-relative paths pass, which is what makes these pages a wiki: one page
 * links to another as `/speaker/pages/<slug>`. Everything else has to parse as
 * an absolute http(s) URL. Anything that does not parse is refused rather than
 * guessed at, so `javascript:`, `data:`, `vbscript:` and the whitespace and
 * entity tricks that hide them all fail the same way.
 */
function safeUrl(raw: string, options: { hosts?: Set<string> } = {}): string | null {
  const value = raw.trim();
  if (value === '') return null;

  if (!options.hosts && (value.startsWith('/') || value.startsWith('#'))) {
    // `//evil.com` is protocol-relative and absolute, not a path.
    if (value.startsWith('//')) return null;
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (options.hosts && !options.hosts.has(url.hostname.toLowerCase())) return null;
  return url.toString();
}

/**
 * The `>` that ends a tag, skipping any inside a quoted attribute value.
 *
 * A plain `indexOf('>')` ends the tag early on `srcdoc="<script>…</script>"`,
 * and the remainder of the attribute then reappears as text. Escaped text, so
 * never a script, but a page showing half an attribute reads as corruption. It
 * also means the parser and a browser disagree about where the tag ends, and
 * that disagreement is where sanitiser bypasses live.
 */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return i;
  }
  return -1;
}

type Attr = { name: string; value: string };

/**
 * Read a tag's attributes.
 *
 * Handles double-quoted, single-quoted and bare values, because an author
 * pasting an embed snippet from anywhere has met all three. Names are
 * lowercased so `OnError` and `onerror` are the same attribute to the
 * allowlist, which is one of the ways a case-sensitive filter gets walked past.
 */
function parseAttrs(source: string): Attr[] {
  const attrs: Attr[] = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attrs.push({
      name: match[1]!.toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? '',
    });
  }
  return attrs;
}

function renderAttrs(tag: string, attrs: Attr[]): string | null {
  const allowed = ALLOWED[tag]!;
  const out: string[] = [];

  for (const attr of attrs) {
    if (!allowed.includes(attr.name)) continue;

    if (attr.name === 'href' || attr.name === 'src') {
      const url = safeUrl(attr.value, tag === 'iframe' ? { hosts: EMBED_HOSTS } : {});
      // A refused URL takes its tag with it rather than leaving the tag with
      // the attribute stripped. `<a>` with no href is dead text pretending to
      // be a link, and an `<iframe>` with no src is an empty box: both read as
      // a rendering bug rather than as "that was not allowed here".
      if (url === null) return null;
      out.push(`${attr.name}="${escapeText(url)}"`);
      continue;
    }

    if (['width', 'height', 'colspan', 'rowspan'].includes(attr.name)) {
      if (!/^\d{1,4}$/.test(attr.value.trim())) continue;
      out.push(`${attr.name}="${attr.value.trim()}"`);
      continue;
    }

    out.push(`${attr.name}="${escapeText(attr.value)}"`);
  }

  // A link out of this app opens in a new tab and cannot reach back through
  // `window.opener`. Forced here rather than asked of the author, because the
  // author is writing prose and this is not a thing prose should have to say.
  if (tag === 'a') {
    if (!out.some((piece) => piece.startsWith('href='))) return null;
    out.push('rel="noopener noreferrer nofollow"');
    const href = out.find((piece) => piece.startsWith('href='))!;
    if (!href.startsWith('href="/') && !href.startsWith('href="#')) out.push('target="_blank"');
  }

  if (tag === 'iframe') {
    if (!out.some((piece) => piece.startsWith('src='))) return null;
    // `allow-scripts` with `allow-same-origin` is normally an escape hatch,
    // because together they let framed content reach out and remove its own
    // sandbox. It is safe here only because EMBED_HOSTS never contains this
    // app's own origin, so "same origin" means the video host's, not ours.
    // Adding this app's hostname to that list would break this reasoning.
    out.push('sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"');
    out.push('loading="lazy"');
    out.push('referrerpolicy="strict-origin-when-cross-origin"');
  }

  return out.length > 0 ? ` ${out.join(' ')}` : '';
}

/**
 * Rebuild `html` from the allowlist.
 *
 * The stack closes what the author left open and drops close tags for things
 * never opened, so an unbalanced paste cannot leak its shape into the rest of
 * the page.
 */
export function sanitizeHtml(html: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let index = 0;
  /** Set while inside a DROP_CONTENTS element; nothing is emitted until it closes. */
  let dropping: string | null = null;

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      if (!dropping) out.push(escapeText(html.slice(index)));
      break;
    }
    if (next > index && !dropping) out.push(escapeText(html.slice(index, next)));

    // A comment can hide a tag from a naive parser, so it is skipped whole
    // rather than escaped and shown.
    if (html.startsWith('<!--', next)) {
      const close = html.indexOf('-->', next + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', next) || html.startsWith('<?', next)) {
      const close = html.indexOf('>', next);
      index = close === -1 ? html.length : close + 1;
      continue;
    }

    const close = findTagEnd(html, next + 1);
    if (close === -1) {
      // An unterminated `<` is text, not a tag. Escaped, so it shows as typed.
      if (!dropping) out.push(escapeText(html.slice(next)));
      break;
    }

    const inner = html.slice(next + 1, close);
    index = close + 1;

    const isClosing = inner.startsWith('/');
    const body = isClosing ? inner.slice(1) : inner;
    const nameMatch = /^([A-Za-z][A-Za-z0-9-]*)/.exec(body.trim());
    if (!nameMatch) continue;
    const tag = nameMatch[1]!.toLowerCase();

    if (dropping) {
      if (isClosing && tag === dropping) dropping = null;
      continue;
    }

    if (isClosing) {
      const at = stack.lastIndexOf(tag);
      if (at === -1) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }

    if (DROP_CONTENTS.has(tag) && tag !== 'iframe') {
      dropping = tag;
      continue;
    }

    if (!(tag in ALLOWED)) continue;

    const attrs = renderAttrs(tag, parseAttrs(body.slice(nameMatch[1]!.length)));
    // Null means the tag failed its own rule: a link with no usable href, an
    // iframe pointing off the allowlist. The tag goes; any text inside it stays.
    if (attrs === null) {
      if (tag === 'iframe') dropping = 'iframe';
      continue;
    }

    if (VOID_TAGS.has(tag)) {
      out.push(`<${tag}${attrs} />`);
      continue;
    }
    out.push(`<${tag}${attrs}>`);
    stack.push(tag);
  }

  while (stack.length > 0) out.push(`</${stack.pop()}>`);
  return out.join('');
}

/** Plain text of a page body, for a search index or a summary line. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
