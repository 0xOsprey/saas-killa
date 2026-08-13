'use server';

import { z } from 'zod';
import { issueMagicLink, MagicLinkRateLimitError, upsertUserByEmail } from '@/lib/auth';
import { magicLinkMail, sendSignInMail } from '@/lib/email';
import {
  checkMagicLinkIpRateLimit,
  checkPublicSignups,
  findUserByEmail,
  MagicLinkIpRateLimitError,
  SignupsClosedError,
} from '@/lib/signups';
import { getEvent } from '@/lib/queries';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
});

export type LoginState = { error?: string; sent?: string };

/**
 * Reports success for a well-formed, allowed address. Existing users can always
 * request a link; new users are blocked when public sign-ups are closed, and
 * all requests are gated by an IP rate limit so a public demo cannot burn
 * Resend.
 */
export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid email' };
  }

  try {
    await checkMagicLinkIpRateLimit();
  } catch (err) {
    if (err instanceof MagicLinkIpRateLimitError) return { error: err.message };
    throw err;
  }

  try {
    await checkPublicSignups(parsed.data.email);
  } catch (err) {
    if (err instanceof SignupsClosedError) return { error: err.message };
    throw err;
  }

  const existing = await findUserByEmail(parsed.data.email);
  const user = existing ?? (await upsertUserByEmail(parsed.data.email));

  const event = await getEvent();
  try {
    const token = await issueMagicLink(user.id);
    await sendSignInMail(magicLinkMail(user.email, token, event.name));
  } catch (err) {
    if (err instanceof MagicLinkRateLimitError) return { error: err.message };
    throw err;
  }

  return { sent: parsed.data.email };
}
