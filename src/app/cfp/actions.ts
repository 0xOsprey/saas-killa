'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { audienceLevelEnum, submissionFormatEnum, submissions, users } from '@/db/schema';
import { currentUser, issueMagicLink, startSession, upsertUserByEmail } from '@/lib/auth';
import { magicLinkMail, sendMail } from '@/lib/email';
import { cfpIsOpen, getEvent } from '@/lib/queries';
import { eq } from 'drizzle-orm';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().min(1, 'Tell us your name').max(120),
  bio: z.string().max(2000).optional(),
  title: z.string().min(6, 'Give the talk a title').max(200),
  abstract: z.string().min(120, 'Abstracts under 120 characters are too thin to review').max(5000),
  format: z.enum(submissionFormatEnum.enumValues),
  audienceLevel: z.enum(audienceLevelEnum.enumValues),
  trackId: z.string().uuid().nullable(),
  posterUrl: z.string().url().nullable(),
});

export type CfpState = { error?: string };

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

export async function submitProposal(_prev: CfpState, formData: FormData): Promise<CfpState> {
  const event = await getEvent();
  if (!cfpIsOpen(event)) {
    return { error: 'The call for papers is closed.' };
  }

  const signedIn = await currentUser();

  const parsed = schema.safeParse({
    // A signed-in speaker cannot submit under someone else's address; the form
    // field is ignored in that case rather than trusted.
    email: signedIn?.email ?? optional(formData.get('email')),
    name: optional(formData.get('name')) ?? signedIn?.name,
    bio: optional(formData.get('bio')) ?? undefined,
    title: optional(formData.get('title')),
    abstract: optional(formData.get('abstract')),
    format: formData.get('format'),
    audienceLevel: formData.get('audienceLevel'),
    trackId: optional(formData.get('trackId')),
    posterUrl: optional(formData.get('posterUrl')),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;

  if (input.format === 'poster' && !input.posterUrl) {
    return { error: 'A poster submission needs a link to the poster artwork.' };
  }

  const speaker = signedIn ?? (await upsertUserByEmail(input.email, input.name));

  // Keep the speaker profile current from the newest submission. This is the
  // whole of "speaker management" on the speaker's side: one profile, reused.
  await db
    .update(users)
    .set({ name: input.name, bio: input.bio ?? speaker.bio })
    .where(eq(users.id, speaker.id));

  await db.insert(submissions).values({
    speakerId: speaker.id,
    trackId: input.trackId,
    title: input.title,
    abstract: input.abstract,
    format: input.format,
    audienceLevel: input.audienceLevel,
    posterUrl: input.posterUrl,
  });

  // A first-time submitter has no session. Email them a link so the submission
  // is not stranded behind an account they never created.
  if (!signedIn) {
    const token = await issueMagicLink(speaker.id);
    await sendMail(magicLinkMail(speaker.email, token, event.name));
    await startSession(speaker.id);
  }

  redirect('/speaker?submitted=1');
}
