// A browser window onto the development mailbox.
//
// With RESEND_API_KEY unset the app writes every message it would have sent to
// .mail/ on this host. That is fine when you are sitting at the host and
// useless from anywhere else, and magic-link sign-in needs the message. So:
// serve the same directory over HTTP, newest first, with the sign-in link in
// each message turned into something clickable.
//
// Loopback only. Reach it from another machine over `tailscale serve`, never by
// binding wider.
//
//   node scripts/dev-inbox.mjs        # http://127.0.0.1:9141
//   PORT=9151 node scripts/dev-inbox.mjs
import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.mail');
const PORT = Number(process.env.PORT ?? 9141);

const escape = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function messages() {
  let names = [];
  try {
    names = readdirSync(MAIL).filter((n) => n.endsWith('.txt'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const raw = readFileSync(join(MAIL, name), 'utf8');
      return {
        name,
        raw,
        at: statSync(join(MAIL, name)).mtime,
        to: /^To: (.*)$/m.exec(raw)?.[1]?.trim() ?? '',
        subject: /^Subject: (.*)$/m.exec(raw)?.[1]?.trim() ?? '',
        link: /(https?:\/\/\S*\/auth\/verify\?token=\S+)/.exec(raw)?.[1] ?? null,
      };
    })
    .sort((a, b) => b.at - a.at);
}

const PAGE = (body) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sessionboard dev inbox</title>
<style>
 body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
 header{padding:1rem 1.25rem;background:#fff;border-bottom:1px solid #e2e8f0}
 h1{font-size:1rem;margin:0}
 p.hint{margin:.25rem 0 0;font-size:.8rem;color:#64748b}
 ul{list-style:none;margin:0;padding:0}
 li{padding:.85rem 1.25rem;border-bottom:1px solid #e2e8f0;background:#fff}
 .to{font-size:.78rem;color:#64748b}
 .subject{font-weight:600}
 a.btn{display:inline-block;margin-top:.4rem;padding:.3rem .7rem;border-radius:.4rem;
   background:#0ea5e9;color:#fff;text-decoration:none;font-size:.8rem}
 a.raw{font-size:.75rem;color:#64748b;margin-left:.6rem}
 pre{white-space:pre-wrap;padding:1.25rem;margin:0}
 .empty{padding:1.25rem;color:#64748b}
</style>
${body}`;

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/m/')) {
    const name = basename(url.pathname.slice(3));
    try {
      const raw = readFileSync(join(MAIL, name), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE(`<header><a href="/">&larr; inbox</a></header><pre>${escape(raw)}</pre>`));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('no such message');
    }
  }

  const list = messages();
  const body =
    list.length === 0
      ? '<p class="empty">Nothing yet. Ask for a sign-in link and reload.</p>'
      : `<ul>${list
          .map(
            (m) => `<li>
    <div class="to">${escape(m.to)} &middot; ${m.at.toLocaleString('en-GB')}</div>
    <div class="subject">${escape(m.subject)}</div>
    ${m.link ? `<a class="btn" href="${escape(m.link)}">Sign in</a>` : ''}
    <a class="raw" href="/m/${encodeURIComponent(m.name)}">read</a>
  </li>`,
          )
          .join('')}</ul>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    PAGE(
      `<header><h1>Sessionboard dev inbox</h1>
       <p class="hint">Every message the app would have sent. Links expire 15 minutes after they are asked for.</p></header>${body}`,
    ),
  );
}).listen(PORT, '127.0.0.1', () => console.log(`dev inbox on http://127.0.0.1:${PORT}`));
