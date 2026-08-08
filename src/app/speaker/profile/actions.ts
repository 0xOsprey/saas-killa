'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { users } from '@/db/schema';
import { requireUser } from '@/lib/auth';

export type ProfileState = { error?: string; saved?: boolean };

const schema = z.object({
  name: z.string().min(1, 'Tell us your name').max(120),
  bio: z.string().max(2000, 'Keep the bio under 2000 characters').nullable(),
  headshotUrl: z
    .string()
    .url('The headshot needs to be a full URL, starting http:// or https://')
    // A headshot is rendered straight into an `img` src. Restricting the scheme
    // here keeps `data:` and other exotic URLs out of the page entirely.
    .refine((value) => /^https?:\/\//i.test(value), {
      message: 'The headshot URL must start http:// or https://',
    })
    .nullable(),
});

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

/**
 * A speaker maintaining their own profile. Ownership is the WHERE clause: the
 * id comes from the session and is never read off the form, so there is no id
 * to forge.
 */
export async function saveProfile(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const user = await requireUser();

  const parsed = schema.safeParse({
    name: optional(formData.get('name')),
    bio: optional(formData.get('bio')),
    headshotUrl: optional(formData.get('headshotUrl')),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  await db
    .update(users)
    .set({
      name: parsed.data.name,
      bio: parsed.data.bio,
      headshotUrl: parsed.data.headshotUrl,
    })
    .where(eq(users.id, user.id));

  revalidatePath('/speaker');
  revalidatePath('/speaker/profile');
  // The bio and name are printed beside every talk on the public agenda.
  revalidatePath('/agenda');

  return { saved: true };
}
