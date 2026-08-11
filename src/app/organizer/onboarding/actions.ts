'use server';

import { and, eq, gt, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { emailLog, submissions, users } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { sendAndLog } from '@/lib/email';
import { getEvent } from '@/lib/queries';
import { confirmationReminderMail } from './mail';

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type ConfirmationReminderState = { error?: string; sent?: number; skipped?: number };

/**
 * Chase every accepted speaker who has not confirmed or declined.
 *
 * This is not a task, so it cannot use `sendTaskRemindersAction`. One mail per
 * speaker, listing their unconfirmed accepted talks, with a 24-hour cooldown
 * read from `email_log` so pressing the button twice does not spam anyone.
 */
export async function sendConfirmationRemindersAction(
  _prev: ConfirmationReminderState,
  formData: FormData,
): Promise<ConfirmationReminderState> {
  await requireRole('organizer');

  // This button has no form fields to parse, but it keeps the same shape as the
  // other bulk actions so the page can render it with `useActionState`.
  void formData;

  const event = await getEvent();

  const unconfirmed = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      title: submissions.title,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .where(
      and(
        eq(submissions.status, 'accepted'),
        isNull(submissions.speakerConfirmedAt),
        isNull(submissions.speakerDeclinedAt),
        eq(users.isBot, false),
      ),
    )
    .orderBy(users.id);

  const cutoff = new Date(Date.now() - REMINDER_COOLDOWN_MS);
  const recent = await db
    .select({ userId: emailLog.userId })
    .from(emailLog)
    .where(and(eq(emailLog.kind, 'confirmation_reminder'), gt(emailLog.sentAt, cutoff)));
  const recentSet = new Set(recent.map((r) => r.userId));

  const byUser = new Map<string, { name: string | null; email: string; titles: string[] }>();
  const skippedUsers = new Set<string>();

  for (const row of unconfirmed) {
    if (recentSet.has(row.userId)) {
      skippedUsers.add(row.userId);
      continue;
    }
    const existing = byUser.get(row.userId);
    if (existing) {
      existing.titles.push(row.title);
    } else {
      byUser.set(row.userId, { name: row.name, email: row.email, titles: [row.title] });
    }
  }

  let sent = 0;
  for (const [userId, person] of byUser) {
    await sendAndLog(
      confirmationReminderMail({
        to: person.email,
        speakerName: person.name,
        eventName: event.name,
        titles: person.titles,
      }),
      { userId, kind: 'confirmation_reminder' },
    );
    sent += 1;
  }

  // A user on the cooldown list is one skip, no matter how many unconfirmed
  // talks they still have.
  const skipped = skippedUsers.size;

  revalidatePath('/organizer/onboarding');
  revalidatePath('/organizer/speakers');
  return { sent, skipped };
}
