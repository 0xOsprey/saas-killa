import { z } from 'zod';

/**
 * Fail at boot on a missing secret rather than at the first request that needs
 * it. SESSION_SECRET has no default on purpose: a fallback value would silently
 * ship a forgeable cookie key to production.
 */
const schema = z.object({
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z
    .string({ required_error: 'SESSION_SECRET is required' })
    .min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().default('http://127.0.0.1:9140'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Saas Killa <cfp@example.com>'),
  BOOTSTRAP_ORGANIZER_EMAIL: z.string().email().optional(),

  // The kill switch for notification mail on a box that does have a key. `off`
  // routes every notification to `.mail/` instead of Resend, which is how the
  // organizer screens get clicked through without buying a send per press. A
  // typo must not read as `off`, so this is an enum rather than a truthy
  // string: `MAIL_NOTIFICATIONS=false` is a boot failure, not silent sending.
  MAIL_NOTIFICATIONS: z.enum(['on', 'off']).default('on'),

  // Rate limit knobs, primarily so the Playwright suite can sign the same test
  // users in dozens of times in a few minutes without tripping the gate.
  MAGIC_LINK_LIMIT: z.coerce.number().int().nonnegative().default(3),
  MAGIC_LINK_WINDOW_MS: z.coerce.number().int().nonnegative().default(600000),

  // The Accelevents push. All three unset means dry run, which is the mode this
  // app reaches unless someone deliberately configures otherwise, and the only
  // mode any test has ever run in. See `src/lib/accelevents.ts`.
  ACCELEVENTS_BASE_URL: z.string().url().optional(),
  ACCELEVENTS_API_KEY: z.string().optional(),
  ACCELEVENTS_EVENT_ID: z.string().optional(),

  // Demo / admin mode. `off` hides the demo page and role switcher.
  // `open` shows one-click role buttons (local/dev only).
  // `secret` requires DEMO_SECRET and shows a password field on /demo.
  DEMO_MODE: z.enum(['off', 'open', 'secret']).default('off'),
  DEMO_SECRET: z.string().min(32).optional(),

  // Sign-up control. `open` lets anyone create an account by logging in or
  // submitting to the CFP. `closed` blocks new accounts; only existing users
  // and demo logins can sign in. Keeps a public demo from burning Resend.
  PUBLIC_SIGNUPS: z.enum(['open', 'closed']).default('open'),
}).refine(
  (data) => data.DEMO_MODE !== 'secret' || !!data.DEMO_SECRET,
  {
    message: 'DEMO_SECRET is required when DEMO_MODE=secret',
    path: ['DEMO_SECRET'],
  },
);

/**
 * An empty assignment means unset. `.env.example` ships every optional variable
 * as a bare `NAME=`, and a dotenv loader delivers that as `''` rather than as
 * absent, so `.optional()` and `.default()` never see the `undefined` they are
 * written for: `ACCELEVENTS_BASE_URL=` reached `z.string().url()` as an empty
 * string and failed, and the app refused to boot from its own example file with
 * an error telling you to copy the example file.
 */
export function withoutBlanks(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

export function parseEnv(source: Record<string, string | undefined>): z.infer<typeof schema> {
  const parsed = schema.safeParse(withoutBlanks(source));
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${detail}. Copy .env.example to .env.local.`);
  }
  return parsed.data;
}

let cached: z.infer<typeof schema> | null = null;

export function env(): z.infer<typeof schema> {
  if (cached) return cached;
  cached = parseEnv(process.env);
  return cached;
}

/**
 * Where a notification actually goes, and why. Three states rather than a
 * boolean, because the two ways mail does not leave the box are not the same
 * fact and a screen that reports one while the other is true sends its reader
 * to edit the wrong variable.
 *
 * This is about notifications only. The sign-in link is exempt by design and
 * goes out whenever there is a key, so `notifications-off` is a live instance
 * people can still sign in to: see `sendSignInMail` in `lib/email.ts`.
 *
 * It lives here rather than beside the sender because `lib/email.ts` imports
 * the database and the Playwright specs cannot: `tsconfig.json` excludes `e2e`,
 * so a spec has no `@/` alias and importing the sender would drag `@/db` in.
 * Configuration is the whole input to this decision, so it is testable here.
 */
export type MailMode = 'live' | 'no-key' | 'notifications-off';

export function mailMode(
  config: Pick<z.infer<typeof schema>, 'RESEND_API_KEY' | 'MAIL_NOTIFICATIONS'> = env(),
): MailMode {
  if (!config.RESEND_API_KEY) return 'no-key';
  return config.MAIL_NOTIFICATIONS === 'off' ? 'notifications-off' : 'live';
}
