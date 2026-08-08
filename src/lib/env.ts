import { z } from 'zod';

/**
 * Fail at boot on a missing secret rather than at the first request that needs
 * it. SESSION_SECRET has no default on purpose: a fallback value would silently
 * ship a forgeable cookie key to production.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().default('http://127.0.0.1:9140'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Sessionboard <cfp@example.com>'),
  BOOTSTRAP_ORGANIZER_EMAIL: z.string().email().optional(),
});

let cached: z.infer<typeof schema> | null = null;

export function env(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${detail}. Copy .env.example to .env.local.`);
  }
  cached = parsed.data;
  return cached;
}
