'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import {
  events,
  reviewAssignments,
  reviewRounds,
  submissions,
  userRoles,
  users,
} from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { sendAndLog, type Mail } from '@/lib/email';
import { env } from '@/lib/env';
import { wallClockToInstant } from '@/lib/format';
import {
  distributionInputs,
  planAssignments,
  recentlyRemindedIds,
  reviewersWithOutstanding,
  REVIEWER_REMINDER_KIND,
  type ReminderTarget,
} from '@/lib/grading';
import { getEvent } from '@/lib/queries';
import { activeRound, allRounds, carryForward, previousRound } from '@/lib/rounds';

function revalidateCfp(): void {
  revalidatePath('/organizer/cfp');
  revalidatePath('/review');
  revalidatePath('/cfp');
}

/** Every outcome this page reports comes back as a query string, so the page stays a server component. */
function back(params: Record<string, string | number>): never {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  redirect(`/organizer/cfp?${query.toString()}`);
}

const wallClock = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Pick a date and time');

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

/**
 * Move the call-for-papers window. Only these two columns: the event's name,
 * tagline and dates belong to the settings screen, and two screens writing the
 * same row is how one of them starts silently clobbering the other.
 */
export async function updateCfpWindow(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const parsed = z
    .object({ opensAt: wallClock, closesAt: wallClock })
    .safeParse({ opensAt: formData.get('opensAt'), closesAt: formData.get('closesAt') });
  if (!parsed.success) back({ error: 'window' });

  const opensAt = wallClockToInstant(parsed.data.opensAt, event.timezone);
  const closesAt = wallClockToInstant(parsed.data.closesAt, event.timezone);
  if (closesAt <= opensAt) back({ error: 'order' });

  await db
    .update(events)
    .set({ cfpOpensAt: opensAt, cfpClosesAt: closesAt })
    .where(eq(events.id, event.id));
  revalidateCfp();
  back({ saved: 'window' });
}

/** Push the deadline out without retyping it, which is what an extension always is. */
export async function extendCfp(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const days = z.coerce.number().int().min(1).max(90).parse(formData.get('days'));
  const event = await getEvent();

  const closesAt = new Date(event.cfpClosesAt.getTime() + days * 24 * 60 * 60 * 1000);
  await db.update(events).set({ cfpClosesAt: closesAt }).where(eq(events.id, event.id));
  revalidateCfp();
  back({ saved: 'extended', days });
}

/**
 * Close the call now. The window is a pair of instants rather than a flag, so
 * closing means moving the end to this moment; `cfpIsOpen` needs nothing new.
 */
export async function closeCfpNow(): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();
  await db.update(events).set({ cfpClosesAt: new Date() }).where(eq(events.id, event.id));
  revalidateCfp();
  back({ saved: 'closed' });
}

const distributeSchema = z.object({
  reviewsPerSubmission: z.coerce.number().int().min(1).max(10),
  maxPerReviewer: z.coerce.number().int().min(1).max(500),
  matchTrack: z.boolean(),
  dueAt: wallClock.nullable(),
});

/**
 * Spread the open submissions across the committee, inside the round that is
 * open now. Inserts are `onConflictDoNothing` on the (round, submission,
 * reviewer) primary key, so running it twice tops the coverage up instead of
 * erroring, and an existing pair keeps the deadline it was given rather than
 * silently inheriting this batch's.
 */
export async function autoDistribute(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const parsed = distributeSchema.safeParse({
    reviewsPerSubmission: formData.get('reviewsPerSubmission'),
    maxPerReviewer: formData.get('maxPerReviewer'),
    matchTrack: formData.get('matchTrack') === 'on',
    dueAt: optional(formData.get('dueAt')),
  });
  if (!parsed.success) back({ error: 'distribute' });

  const round = await activeRound();
  if (!round) back({ error: 'no-round' });

  const dueAt = parsed.data.dueAt ? wallClockToInstant(parsed.data.dueAt, event.timezone) : null;
  const inputs = await distributionInputs(round.id);
  if (inputs.reviewers.length === 0) back({ error: 'no-reviewers' });

  const { planned, short } = planAssignments({
    submissions: inputs.submissions,
    reviewers: inputs.reviewers,
    reviewsPerSubmission: parsed.data.reviewsPerSubmission,
    maxPerReviewer: parsed.data.maxPerReviewer,
    matchTrack: parsed.data.matchTrack,
  });

  if (planned.length > 0) {
    await db
      .insert(reviewAssignments)
      .values(planned.map((row) => ({ ...row, roundId: round.id, dueAt })))
      .onConflictDoNothing();
  }

  revalidateCfp();
  back({ assigned: planned.length, short });
}

const pairSchema = z.object({
  submissionId: z.string().uuid(),
  reviewerId: z.string().uuid(),
});

/** Assign one reviewer to one submission by hand, for the case the distributor cannot know about. */
export async function addAssignment(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const parsed = pairSchema
    .extend({ dueAt: wallClock.nullable() })
    .safeParse({
      submissionId: formData.get('submissionId'),
      reviewerId: formData.get('reviewerId'),
      dueAt: optional(formData.get('dueAt')),
    });
  if (!parsed.success) back({ error: 'assign' });

  // The target has to actually be a reviewer. Without this an organizer can
  // hand work to a speaker account, and the queue would then show them
  // proposals they were never cleared to read.
  const holdsRole = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(userRoles.userId, parsed.data.reviewerId),
        eq(userRoles.role, 'reviewer'),
        eq(users.isBot, false),
      ),
    );
  if (holdsRole.length === 0) back({ error: 'not-reviewer' });

  // An assignment on a decided submission can never be completed: `submitReview`
  // refuses to grade anything that is no longer 'submitted'.
  const target = await db.query.submissions.findFirst({
    where: eq(submissions.id, parsed.data.submissionId),
  });
  if (!target || target.status !== 'submitted') back({ error: 'decided' });
  if (target.speakerId === parsed.data.reviewerId) back({ error: 'self-review' });

  const round = await activeRound();
  if (!round) back({ error: 'no-round' });

  await db
    .insert(reviewAssignments)
    .values({
      roundId: round.id,
      submissionId: parsed.data.submissionId,
      reviewerId: parsed.data.reviewerId,
      dueAt: parsed.data.dueAt ? wallClockToInstant(parsed.data.dueAt, event.timezone) : null,
    })
    .onConflictDoNothing();

  revalidateCfp();
  back({ assigned: 1, short: 0 });
}

export async function removeAssignment(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = pairSchema.parse({
    submissionId: formData.get('submissionId'),
    reviewerId: formData.get('reviewerId'),
  });

  // Scoped to the open round. Unassigning somebody now must not erase the fact
  // that they were assigned in round one, which is part of how that round's
  // completion rate was calculated.
  const round = await activeRound();
  if (!round) back({ error: 'no-round' });

  await db
    .delete(reviewAssignments)
    .where(
      and(
        eq(reviewAssignments.roundId, round.id),
        eq(reviewAssignments.submissionId, input.submissionId),
        eq(reviewAssignments.reviewerId, input.reviewerId),
      ),
    );

  revalidateCfp();
  back({ removed: 1 });
}

const roundSchema = z.object({
  name: z.string().trim().min(1).max(80),
  dueAt: wallClock.nullable(),
});

/**
 * Open the next pass of review. The new round always sorts after every existing
 * one, so "the active round" stays unambiguous without asking the organizer to
 * pick a number.
 */
export async function openRound(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const parsed = roundSchema.safeParse({
    name: formData.get('name'),
    dueAt: optional(formData.get('dueAt')),
  });
  if (!parsed.success) back({ error: 'round-name' });

  const existing = await allRounds();
  const position = existing.reduce((max, round) => Math.max(max, round.position), -1) + 1;

  await db.insert(reviewRounds).values({
    name: parsed.data.name,
    position,
    opensAt: new Date(),
    dueAt: parsed.data.dueAt ? wallClockToInstant(parsed.data.dueAt, event.timezone) : null,
  });

  revalidateCfp();
  back({ saved: 'round-opened' });
}

/** Stop new grades landing in a round. Never deletes it; the scores are the record. */
export async function closeRound(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('roundId'));

  await db
    .update(reviewRounds)
    .set({ closedAt: new Date() })
    .where(and(eq(reviewRounds.id, id), isNull(reviewRounds.closedAt)));

  revalidateCfp();
  back({ saved: 'round-closed' });
}

/**
 * Shortlist into the open round: carry the named submissions, and the reviewers
 * who already read them, forward from the round before it.
 */
export async function shortlistIntoRound(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const round = await activeRound();
  if (!round) back({ error: 'no-round' });

  const previous = await previousRound(round.id);
  if (!previous) back({ error: 'no-previous-round' });

  const submissionIds = formData
    .getAll('submissionId')
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => z.string().uuid().safeParse(value).success);
  if (submissionIds.length === 0) back({ error: 'nothing-shortlisted' });

  const dueAtRaw = optional(formData.get('dueAt'));
  const carried = await carryForward({
    fromRoundId: previous.id,
    toRoundId: round.id,
    submissionIds,
    dueAt: dueAtRaw ? wallClockToInstant(dueAtRaw, event.timezone) : null,
  });

  revalidateCfp();
  back({ assigned: carried, short: 0 });
}

function reminderMail(target: ReminderTarget, eventName: string): Mail {
  const overdue =
    target.overdue > 0
      ? `${target.overdue} of them ${target.overdue === 1 ? 'is' : 'are'} past its deadline.`
      : 'None of them is past its deadline yet.';
  return {
    to: target.email,
    subject: `${target.outstanding} proposal(s) still awaiting your review for ${eventName}`,
    text: [
      `${target.name ?? 'Hello'} —`,
      '',
      `The programme committee is waiting on ${target.outstanding} review(s) from you. ${overdue}`,
      '',
      `Your queue: ${env().APP_URL}/review`,
      '',
      'Reviews are blind; grade the abstract on the four criteria and leave a note',
      'for the rest of the committee if you have one.',
    ].join('\n'),
  };
}

/**
 * Chase every reviewer still holding work. The cooldown is read from
 * `email_log` rather than kept in memory, so a double-clicked button, a second
 * organizer pressing it a minute later and a redeploy all see the same answer.
 */
export async function remindReviewers(): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  const round = await activeRound();
  if (!round) back({ error: 'no-round' });

  const targets = await reviewersWithOutstanding(round.id);
  const recentlyReminded = await recentlyRemindedIds();

  let sent = 0;
  let skipped = 0;
  for (const target of targets) {
    if (recentlyReminded.has(target.reviewerId)) {
      skipped += 1;
      continue;
    }
    await sendAndLog(reminderMail(target, event.name), {
      userId: target.reviewerId,
      kind: REVIEWER_REMINDER_KIND,
    });
    sent += 1;
  }

  revalidateCfp();
  back({ sent, skipped });
}
