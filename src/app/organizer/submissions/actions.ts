'use server';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { submissionStatusEnum, submissions, users } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { acceptanceMail, rejectionMail, sendMail } from '@/lib/email';
import { evaluatePending, evaluatorConfigured } from '@/lib/ai-evaluator';
import { getEvent } from '@/lib/queries';

const decisionSchema = z.object({
  submissionId: z.string().uuid(),
  status: z.enum(submissionStatusEnum.enumValues),
});

/**
 * Set a decision. Deliberately does not email: an organizer works through the
 * list flipping statuses and changing their mind, and nothing leaves the
 * building until they press send in `notifyDecided`.
 */
export async function setDecision(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = decisionSchema.parse({
    submissionId: formData.get('submissionId'),
    status: formData.get('status'),
  });

  await db
    .update(submissions)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(submissions.id, input.submissionId));

  revalidatePath('/organizer/submissions');
  revalidatePath('/organizer/schedule');
}

/**
 * Send the accept or reject email for every decided submission that has not had
 * one. `decisionEmailedAt` is the idempotency key, so a second press finds
 * nothing to send rather than mailing every speaker twice.
 *
 * The timestamp is written per row immediately after that row's send, not in
 * one update at the end: a failure halfway through then leaves the already-sent
 * speakers marked, and a retry resumes rather than restarting.
 */
export async function notifyDecided(): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const rows = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      email: users.email,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .where(
      and(
        inArray(submissions.status, ['accepted', 'rejected']),
        isNull(submissions.decisionEmailedAt),
      ),
    );

  for (const row of rows) {
    const mail =
      row.status === 'accepted'
        ? acceptanceMail(row.email, row.title, event.name)
        : rejectionMail(row.email, row.title, event.name);
    await sendMail(mail);
    await db
      .update(submissions)
      .set({ decisionEmailedAt: new Date() })
      .where(eq(submissions.id, row.id));
  }

  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker');
}

/** Run the AI evaluator over everything it has not already graded. */
export async function runEvaluator(): Promise<void> {
  await requireRole('organizer');
  if (!evaluatorConfigured()) return;
  const event = await getEvent();
  await evaluatePending(event.name);
  revalidatePath('/organizer/submissions');
  revalidatePath('/review');
}
