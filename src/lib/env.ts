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
  MAIL_FROM: z.string().default('Sessionboard <cfp@example.com>'),
  BOOTSTRAP_ORGANIZER_EMAIL: z.string().email().optional(),

  // The Accelevents push. All three unset means dry run, which is the mode this
  // app reaches unless someone deliberately configures otherwise, and the only
  // mode any test has ever run in. See `src/lib/accelevents.ts`.
  ACCELEVENTS_BASE_URL: z.string().url().optional(),
  ACCELEVENTS_API_KEY: z.string().optional(),
  ACCELEVENTS_EVENT_ID: z.string().optional(),
});

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
