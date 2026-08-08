import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAIL_DIR = join(process.cwd(), '.mail');

export type CapturedMail = { to: string; subject: string; body: string; path: string };

function readAll(): CapturedMail[] {
  if (!existsSync(MAIL_DIR)) return [];
  return readdirSync(MAIL_DIR)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => {
      const path = join(MAIL_DIR, name);
      const raw = readFileSync(path, 'utf8');
      const to = /^To: (.*)$/m.exec(raw)?.[1]?.trim() ?? '';
      const subject = /^Subject: (.*)$/m.exec(raw)?.[1]?.trim() ?? '';
      return { to, subject, body: raw, path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function clearMailbox(): void {
  if (existsSync(MAIL_DIR)) rmSync(MAIL_DIR, { recursive: true, force: true });
  claimed.clear();
}

/**
 * Messages this run has already handed out. Without it, a second sign-in as the
 * same address matches the *first* run's mail before the new one has hit disk,
 * and that link has already been redeemed — magic links are single use, so the
 * test silently signs in as nobody.
 */
const claimed = new Set<string>();

/**
 * Wait for a message not yet returned to any caller. The app writes the file
 * inside the server action, but the browser's navigation resolves independently
 * of the write landing on disk, so a bare read races. Polling closes that gap
 * without a fixed sleep.
 */
export async function waitForMail(
  predicate: (mail: CapturedMail) => boolean,
  timeoutMs = 15_000,
): Promise<CapturedMail> {
  const deadline = Date.now() + timeoutMs;
  let seen: CapturedMail[] = [];
  while (Date.now() < deadline) {
    seen = readAll();
    const hit = seen.find((mail) => !claimed.has(mail.path) && predicate(mail));
    if (hit) {
      claimed.add(hit.path);
      return hit;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `no matching mail within ${timeoutMs}ms. Mailbox held: ${
      seen.map((m) => `${m.to} / ${m.subject}`).join(' | ') || '(empty)'
    }`,
  );
}

export function extractMagicLink(mail: CapturedMail): string {
  const url = /(https?:\/\/\S*\/auth\/verify\?token=\S+)/.exec(mail.body)?.[1];
  if (!url) throw new Error(`no magic link in mail to ${mail.to}:\n${mail.body}`);
  return url;
}
