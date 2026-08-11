import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mailMode, parseEnv, withoutBlanks } from '../src/lib/env';

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

  // Notifications are on out of the box. The switch is for an instance that has
  // a key, and defaulting it off would make a fresh deploy quietly stop mailing
  // the speakers it just accepted.
  expect(parsed.MAIL_NOTIFICATIONS).toBe('on');
  expect(mailMode(parsed)).toBe('no-key');
});

test('MAIL_NOTIFICATIONS=off suppresses on a box that does have a key', () => {
  const key = { RESEND_API_KEY: 're_live_key' } as const;

  expect(mailMode({ ...key, MAIL_NOTIFICATIONS: 'on' })).toBe('live');
  expect(mailMode({ ...key, MAIL_NOTIFICATIONS: 'off' })).toBe('notifications-off');

  // The two ways mail does not leave the box stay distinguishable, because the
  // fix is a different line of `.env.local` for each and the organizer screen
  // names the one that is actually true.
  expect(mailMode({ RESEND_API_KEY: undefined, MAIL_NOTIFICATIONS: 'off' })).toBe('no-key');
});

test('a MAIL_NOTIFICATIONS typo is a boot failure rather than silent sending', () => {
  const example = loadExample();
  example.SESSION_SECRET = 'a'.repeat(64);

  // The dangerous shape: somebody writes the switch the way every other config
  // format spells it, gets a value that is not `off`, and pays for a bulk send
  // they believed they had disabled. An enum refuses at boot instead.
  example.MAIL_NOTIFICATIONS = 'false';
  expect(() => parseEnv(example)).toThrow(/MAIL_NOTIFICATIONS/);

  // Blank is the one exception, and only because `withoutBlanks` makes it mean
  // unset, which is the default: on.
  example.MAIL_NOTIFICATIONS = '';
  expect(parseEnv(example).MAIL_NOTIFICATIONS).toBe('on');
});

test('a required variable set to empty is still a boot failure', () => {
  const example = loadExample();
  example.SESSION_SECRET = '';

  // Blank means unset, and unset here means refuse to start rather than ship a
  // forgeable cookie key. The empty case must not slip through as a short one.
  expect(() => parseEnv(example)).toThrow(/SESSION_SECRET is required/);
  expect(withoutBlanks({ A: '', B: 'set', C: undefined })).toEqual({ B: 'set' });
});
