import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseEnv, withoutBlanks } from '../src/lib/env';

/**
 * The first thing anyone who clones this repository does is what `README.md`
 * says: copy `.env.example` to `.env.local` and fill `SESSION_SECRET`. That has
 * to produce an app that boots, and once it did not. `.env.example` ships the
 * optional variables as bare `NAME=`, a dotenv loader hands those over as `''`
 * rather than as absent, and `ACCELEVENTS_BASE_URL: z.string().url().optional()`
 * rejected the empty string, so a fresh clone died at `pnpm db:seed` with an
 * error instructing the reader to copy the example file they had just copied.
 *
 * No browser here. This is the boot path, and it fails before a server exists.
 */

/** What a dotenv loader makes of the file: `KEY=value`, surrounding quotes off. */
function loadExample(): Record<string, string> {
  // `import.meta.url`, not `__dirname`: the specs are ESM, the same reason
  // `db.ts` reaches for `.env.local` this way.
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}

test('.env.example plus a SESSION_SECRET is a bootable environment', () => {
  const example = loadExample();
  // `openssl rand -hex 32`, the command README.md prints on the line above.
  example.SESSION_SECRET = 'a'.repeat(64);

  const parsed = parseEnv(example);

  expect(parsed.DATABASE_URL).toContain('127.0.0.1:5433');
  expect(parsed.APP_URL).toBe('http://127.0.0.1:9140');
  expect(parsed.BOOTSTRAP_ORGANIZER_EMAIL).toBe('organizer@example.com');
});

test('the example file leaves the Accelevents push a dry run and mail unsent', () => {
  const example = loadExample();
  example.SESSION_SECRET = 'a'.repeat(64);

  const parsed = parseEnv(example);

  // All three undefined rather than '' is what `accelevents.ts` reads as a dry
  // run, and an unset RESEND_API_KEY is what routes mail to `.mail/`.
  expect(parsed.ACCELEVENTS_BASE_URL).toBeUndefined();
  expect(parsed.ACCELEVENTS_API_KEY).toBeUndefined();
  expect(parsed.ACCELEVENTS_EVENT_ID).toBeUndefined();
  expect(parsed.RESEND_API_KEY).toBeUndefined();
});

test('a required variable set to empty is still a boot failure', () => {
  const example = loadExample();
  example.SESSION_SECRET = '';

  // Blank means unset, and unset here means refuse to start rather than ship a
  // forgeable cookie key. The empty case must not slip through as a short one.
  expect(() => parseEnv(example)).toThrow(/SESSION_SECRET is required/);
  expect(withoutBlanks({ A: '', B: 'set', C: undefined })).toEqual({ B: 'set' });
});
