'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { users } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { deleteUpload, linkField, replaceHeadshot, saveUpload } from '@/lib/uploads';

export type ProfileState = { error?: string; saved?: boolean };

const schema = z.object({
  name: z.string().min(1, 'Tell us your name').max(120),
  bio: z.string().max(2000, 'Keep the bio under 2000 characters').nullable(),
  // A headshot goes straight into an `img` src, so the scheme is restricted:
  // `linkField` takes an http(s) URL or one of this app's own `/files/` paths
  // and nothing else, which keeps `data:` and `javascript:` out of the page.
  //
  // The relative arm is not decoration. An uploaded headshot writes its own
  // `/files/…` path into this column, and a validator that only accepted
  // absolute URLs would refuse the speaker's next profile save on a value the
  // upload had just written.
  headshotUrl: linkField,
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
    headshotUrl: String(formData.get('headshotUrl') ?? ''),
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

function refreshProfileViews(): void {
  revalidatePath('/speaker');
  revalidatePath('/speaker/profile');
  revalidatePath('/agenda');
  revalidatePath('/speakers');
}

/**
 * Upload a headshot instead of pointing at one.
 *
 * Its own form and its own action rather than a file input bolted onto the
 * profile form: this one redirects, so the page reloads and the preview beside
 * the field shows the file that was actually stored. Reusing the profile form
 * would mean the client component holding a URL the server had since replaced.
 */
export async function uploadHeadshot(formData: FormData): Promise<void> {
  const user = await requireUser();

  const result = await saveUpload({
    file: formData.get('headshotFile'),
    kind: 'headshot',
    ownerId: user.id,
  });
  if (!result.ok) {
    redirect(`/speaker/profile?error=${encodeURIComponent(result.reason)}`);
  }

  await replaceHeadshot(user.id, result.upload);
  refreshProfileViews();
  redirect('/speaker/profile?uploaded=1');
}

/**
 * Take the uploaded headshot down. Clearing the column is not enough on its
 * own: the file would stay readable at its old `/files/` path, and "remove my
 * photo" that leaves the photo up is a promise the app did not keep.
 */
export async function removeHeadshot(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().safeParse(formData.get('uploadId'));
  if (!id.success) redirect('/speaker/profile');

  const removed = await deleteUpload(id.data, user.id);
  if (removed) {
    await db.update(users).set({ headshotUrl: null }).where(eq(users.id, user.id));
  }

  refreshProfileViews();
  redirect('/speaker/profile?removed=1');
}
