'use server';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { contentStatusEnum, submissionStatusEnum, submissions, users } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import {
  acceptanceMail,
  calendarAttachment,
  mailFromParty,
  rejectionMail,
  sendAndLog,
  sendMail,
} from '@/lib/email';
import { dayLabel, timeOfDay } from '@/lib/format';
import { sendScheduleNotices } from '@/lib/schedule-notices';
import { inviteFor, placements } from '@/lib/speaker-calendar';
import { evaluatePending, evaluatorConfigured } from '@/lib/ai-evaluator';
import {
  LOCKABLE_FIELDS,
  applyTextEdit,
  contentRecipient,
  currentStatuses,
  isLocked,
  logRevisions,
  withLock,
} from '@/lib/content';
import { getEvent } from '@/lib/queries';
import { activeRound } from '@/lib/rounds';
import { contentReturnedMail } from './mail';

const decisionSchema = z.object({
  submissionId: z.string().uuid(),
  status: z.enum(submissionStatusEnum.enumValues),
});

function revalidateDashboard(): void {
  revalidatePath('/organizer/submissions');
  revalidatePath('/organizer/schedule');
}

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

  revalidateDashboard();
}

/**
 * Send the accept or reject email for every decided submission that has not had
 * one. `decisionEmailedAt` is the idempotency key, so a second press finds
 * nothing to send rather than mailing every speaker twice.
 *
 * The timestamp is written per row immediately after that row's send, not in
 * one update at the end: a failure halfway through then leaves the already-sent
 * speakers marked, and a retry resumes rather than restarting.
 *
 * An acceptance for a talk that already has a slot carries the calendar
 * invitation, and records the placement in `scheduleNoticeKey` as it goes.
 * Without that write, `notifySchedule` would read the talk as newly placed and
 * send a second invitation minutes later for a time nothing had changed about.
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

  const accepted = rows.filter((row) => row.status === 'accepted').map((row) => row.id);
  const placed = new Map(
    (accepted.length > 0 ? await placements(accepted) : []).map((row) => [row.submissionId, row]),
  );
  const organizer = mailFromParty();

  for (const row of rows) {
    const placement = placed.get(row.id);
    const slot = row.status === 'accepted' ? (placement?.slot ?? null) : null;
    const sequence = (placement?.noticeSeq ?? 0) + 1;

    let mail;
    if (row.status !== 'accepted') {
      mail = rejectionMail(row.email, row.title, event.name);
    } else if (slot && placement) {
      const ics = inviteFor(placement, { eventName: event.name, organizer, sequence });
      mail = {
        ...acceptanceMail(row.email, row.title, event.name, {
          when: `${dayLabel(slot.startsAt, event.timezone)}, ${timeOfDay(slot.startsAt, event.timezone)}–${timeOfDay(slot.endsAt, event.timezone)}`,
          room: slot.roomName,
        }),
        ...(ics ? { attachments: [calendarAttachment(ics)] } : {}),
      };
    } else {
      mail = acceptanceMail(row.email, row.title, event.name);
    }

    await sendMail(mail);
    await db
      .update(submissions)
      .set({
        decisionEmailedAt: new Date(),
        ...(placement && slot
          ? { scheduleNoticeKey: placement.key, scheduleNoticeSeq: sequence }
          : {}),
      })
      .where(eq(submissions.id, row.id));
  }

  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker');
}

/**
 * Mail every speaker whose time or room has changed since they were last told,
 * with an updated calendar invitation. The button lives on the schedule screen,
 * which is where an organizer has just finished moving things.
 */
export async function notifySchedule(): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();
  await sendScheduleNotices({
    eventName: event.name,
    timezone: event.timezone,
    organizer: mailFromParty(),
  });
  revalidatePath('/organizer/schedule');
  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker');
}

/**
 * Grade everything the evaluator has not already seen, with the default persona
 * and no options. This is the one-button version on the decision dashboard. The
 * button on /organizer/evaluators is `runPersonaEvaluation`, which picks a
 * persona, takes a limit and hands back a report. Both were called
 * `runEvaluator` until the two pages were read side by side.
 */
export async function gradePending(): Promise<void> {
  await requireRole('organizer');
  if (!evaluatorConfigured()) return;
  const round = await activeRound();
  if (!round) return;
  const event = await getEvent();
  await evaluatePending(event.name, round.id);
  revalidatePath('/organizer/submissions');
  revalidatePath('/review');
}

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

const inlineEditSchema = z.object({
  submissionId: z.string().uuid(),
  title: z.string().trim().min(4).max(200),
  abstract: z.string().trim().min(20).max(8000),
});

/**
 * Edit a title or abstract from the dashboard. An organizer edits through the
 * lock rather than around it: `lockedFields` freezes the speaker, never the
 * committee, so nothing here consults it.
 */
export async function editSubmissionText(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const input = inlineEditSchema.parse({
    submissionId: formData.get('submissionId'),
    title: formData.get('title'),
    abstract: formData.get('abstract'),
  });

  await applyTextEdit({
    submissionId: input.submissionId,
    editorId: editor.id,
    next: { title: input.title, abstract: input.abstract },
  });

  revalidateDashboard();
  revalidatePath(`/agenda/${input.submissionId}`);
}

// ---------------------------------------------------------------------------
// Content moderation
// ---------------------------------------------------------------------------

const idsSchema = z.array(z.string().uuid()).min(1).max(500);

function readIds(formData: FormData): string[] {
  return idsSchema.parse(formData.getAll('ids').map(String));
}

/**
 * Move content to a new status and log the move. Approval and send-back are the
 * two ends of the same transition, so they share one writer and differ only in
 * the mail that follows.
 *
 * Every move clears `contentReturnReason`, `returnContent` included: it writes
 * its own reason immediately afterwards. The rule is "any status move clears
 * it", applied at both of the two writers that move the column — this one and
 * `setContentStatus` on the speaker's side. Clearing only on the transitions
 * that are not returns is the version that misses one, and the miss shows a
 * speaker a note about a draft they have since resubmitted.
 */
async function moveContent(
  ids: string[],
  next: (typeof contentStatusEnum.enumValues)[number],
  editorId: string,
): Promise<void> {
  const before = await db
    .select({ id: submissions.id, contentStatus: submissions.contentStatus })
    .from(submissions)
    .where(inArray(submissions.id, ids));

  await db
    .update(submissions)
    .set({ contentStatus: next, contentReturnReason: null, updatedAt: new Date() })
    .where(inArray(submissions.id, ids));

  await logRevisions(
    before.map((row) => ({
      submissionId: row.id,
      editorId,
      field: 'contentStatus',
      oldValue: row.contentStatus,
      newValue: next,
    })),
  );
}

function revalidateContent(ids: string[]): void {
  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker/content');
  revalidatePath('/posters');
  for (const id of ids) revalidatePath(`/agenda/${id}`);
}

/** Approve one submission's content. Publishing follows from the status alone. */
export async function approveContent(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('submissionId'));
  await moveContent([id], 'approved', editor.id);
  revalidateContent([id]);
}

const returnSchema = z.object({
  submissionId: z.string().uuid(),
  reason: z.string().trim().min(4).max(2000),
});

/**
 * Send content back for changes. The status drops to 'draft' before the mail is
 * built, so a send that fails leaves the speaker able to edit rather than stuck
 * in a review queue nobody is looking at.
 *
 * The reason is stored as well as mailed, in the same write order and for the
 * same reason: it used to exist only in the email, so a speaker opened
 * `/speaker/content`, found a draft they thought they had submitted, and had to
 * go and find the message to learn what to change.
 */
export async function returnContent(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const input = returnSchema.parse({
    submissionId: formData.get('submissionId'),
    reason: formData.get('reason'),
  });

  const recipient = await contentRecipient(input.submissionId);
  if (!recipient) return;

  await moveContent([input.submissionId], 'draft', editor.id);
  // After the move, which clears the column. The speaker's screen reads this
  // and the mail below carries the same words, so the two cannot disagree.
  await db
    .update(submissions)
    .set({ contentReturnReason: input.reason })
    .where(eq(submissions.id, input.submissionId));

  const event = await getEvent();
  await sendAndLog(
    contentReturnedMail({
      to: recipient.speakerEmail,
      title: recipient.title,
      eventName: event.name,
      reason: input.reason,
    }),
    { userId: recipient.speakerId, kind: 'content_returned', submissionId: recipient.submissionId },
  );

  revalidateContent([input.submissionId]);
}

// ---------------------------------------------------------------------------
// Field locks
// ---------------------------------------------------------------------------

const lockSchema = z.object({
  submissionId: z.string().uuid(),
  field: z.enum(LOCKABLE_FIELDS),
  locked: z.enum(['true', 'false']),
});

/**
 * Freeze or release one field on one submission. Read-modify-write on a jsonb
 * array, so it runs in a transaction with the row held: two organizers toggling
 * two different fields at once would otherwise each write an array missing the
 * other's lock.
 */
export async function setFieldLock(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = lockSchema.parse({
    submissionId: formData.get('submissionId'),
    field: formData.get('field'),
    locked: formData.get('locked'),
  });

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ lockedFields: submissions.lockedFields })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .limit(1)
      .for('update');
    if (!current) return;

    await tx
      .update(submissions)
      .set({
        lockedFields: withLock(current.lockedFields, input.field, input.locked === 'true'),
        updatedAt: new Date(),
      })
      .where(eq(submissions.id, input.submissionId));
  });

  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker');
  revalidatePath('/speaker/content');
}

// ---------------------------------------------------------------------------
// Bulk editing
// ---------------------------------------------------------------------------

/**
 * Set the status on a selection. Bulk deciding still does not mail anybody:
 * `notifyDecided` remains the only thing that sends, so a hundred rows flipped
 * by mistake cost an undo rather than a hundred apologies.
 */
export async function bulkSetStatus(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const ids = readIds(formData);
  const status = z.enum(submissionStatusEnum.enumValues).parse(formData.get('status'));

  const before = await currentStatuses(ids);
  await db
    .update(submissions)
    .set({ status, updatedAt: new Date() })
    .where(inArray(submissions.id, ids));

  await logRevisions(
    ids.map((id) => ({
      submissionId: id,
      editorId: editor.id,
      field: 'status',
      oldValue: before.get(id)?.status ?? null,
      newValue: status,
    })),
  );

  revalidateDashboard();
}

/** Move a selection into a track, or out of every track when `trackId` is blank. */
export async function bulkSetTrack(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const ids = readIds(formData);
  const raw = String(formData.get('trackId') ?? '');
  const trackId = raw === '' ? null : z.string().uuid().parse(raw);

  const before = await currentStatuses(ids);
  await db
    .update(submissions)
    .set({ trackId, updatedAt: new Date() })
    .where(inArray(submissions.id, ids));

  await logRevisions(
    ids.map((id) => ({
      submissionId: id,
      editorId: editor.id,
      field: 'trackId',
      oldValue: before.get(id)?.trackId ?? null,
      newValue: trackId,
    })),
  );

  revalidateDashboard();
}

export async function bulkApproveContent(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const ids = readIds(formData);
  await moveContent(ids, 'approved', editor.id);
  revalidateContent(ids);
}

const bulkLockSchema = z.object({
  field: z.enum(LOCKABLE_FIELDS),
  locked: z.enum(['true', 'false']),
});

/**
 * Freeze or release one field across a selection. Each row is read and written
 * inside the same transaction so a bulk lock cannot drop a lock another
 * organizer set on a different field a moment earlier.
 */
export async function bulkSetLock(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const ids = readIds(formData);
  const input = bulkLockSchema.parse({
    field: formData.get('field'),
    locked: formData.get('locked'),
  });
  const locked = input.locked === 'true';

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: submissions.id, lockedFields: submissions.lockedFields })
      .from(submissions)
      .where(inArray(submissions.id, ids))
      .for('update');

    for (const row of rows) {
      // A lock already in the wanted state is left alone rather than rewritten,
      // so `updatedAt` still means "this submission changed".
      if (isLocked(row.lockedFields, input.field) === locked) continue;
      await tx
        .update(submissions)
        .set({
          lockedFields: withLock(row.lockedFields, input.field, locked),
          updatedAt: new Date(),
        })
        .where(eq(submissions.id, row.id));
    }
  });

  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker');
  revalidatePath('/speaker/content');
}
