'use server';

import { z } from 'zod';
import { issueMagicLink, upsertUserByEmail } from '@/lib/auth';
import { magicLinkMail, sendMail } from '@/lib/email';
import { getEvent } from '@/lib/queries';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
});

export type LoginState = { error?: string; sent?: string };

/**
 * Always reports success for a well-formed address, whether or not the account
 * existed. Reporting "no such user" would turn the login form into an oracle
 * for who has submitted to this conference.
 */
export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid email' };
  }

  const event = await getEvent();
  const user = await upsertUserByEmail(parsed.data.email);
  const token = await issueMagicLink(user.id);
  await sendMail(magicLinkMail(user.email, token, event.name));

  return { sent: parsed.data.email };
}
