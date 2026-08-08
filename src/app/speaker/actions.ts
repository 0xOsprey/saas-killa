'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { submissions } from '@/db/schema';
import { requireUser } from '@/lib/auth';

/**
 * Every action here scopes its WHERE clause to the caller's own speaker id.
 * Ownership is a query condition, not a check before the query, so a forged
 * submission id updates zero rows instead of someone else's talk.
 */

export async function confirmAttendance(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));

  await db
    .update(submissions)
    .set({ speakerConfirmedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(submissions.id, id),
        eq(submissions.speakerId, user.id),
        eq(submissions.status, 'accepted'),
      ),
    );

  revalidatePath('/speaker');
}

export async function withdrawSubmission(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));

  await db
    .update(submissions)
    .set({ status: 'withdrawn', updatedAt: new Date() })
    .where(and(eq(submissions.id, id), eq(submissions.speakerId, user.id)));

  revalidatePath('/speaker');
  revalidatePath('/agenda');
}

const contentSchema = z.object({
  submissionId: z.string().uuid(),
  slidesUrl: z.string().url().or(z.literal('')).nullable(),
  recordingUrl: z.string().url().or(z.literal('')).nullable(),
  resourcesNote: z.string().max(4000).nullable(),
});

/** Post-event content: slides, a recording link and a short note of resources. */
export async function saveContent(formData: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = contentSchema.parse({
    submissionId: formData.get('submissionId'),
    slidesUrl: (formData.get('slidesUrl') as string | null)?.trim() || null,
    recordingUrl: (formData.get('recordingUrl') as string | null)?.trim() || null,
    resourcesNote: (formData.get('resourcesNote') as string | null)?.trim() || null,
  });

  await db
    .update(submissions)
    .set({
      slidesUrl: parsed.slidesUrl || null,
      recordingUrl: parsed.recordingUrl || null,
      resourcesNote: parsed.resourcesNote,
      updatedAt: new Date(),
    })
    .where(and(eq(submissions.id, parsed.submissionId), eq(submissions.speakerId, user.id)));

  revalidatePath('/speaker');
  revalidatePath(`/agenda/${parsed.submissionId}`);
}
