'use server';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import {
  audienceLevelEnum,
  roleEnum,
  speakerAvailability,
  speakerTaskKindEnum,
  speakerTasks,
  submissionFormatEnum,
  submissions,
  userRoles,
  users,
} from '@/db/schema';
import { grantRole, issueMagicLink, MagicLinkRateLimitError, requireRole, upsertUserByEmail } from '@/lib/auth';
import { sendAndLog } from '@/lib/email';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { hasSubmissions, isRosterFilter, speakerRoster } from '@/lib/speakers';
import { linkField, replaceHeadshot, saveUpload, uploadHref } from '@/lib/uploads';
import { speakerInviteMail, taskReminderMail } from './mail';

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

function refreshSpeakerScreens(userId?: string): void {
  revalidatePath('/organizer/speakers');
  if (userId) revalidatePath(`/organizer/speakers/${userId}`);
  revalidatePath('/speakers');
  // The public profile prints the name, the byline and the bio, so an organizer
  // correcting any of them has to reach it too. `/speakers` on its own is the
  // directory page and nothing else.
  if (userId) revalidatePath(`/speakers/${userId}`);
}

const roleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(roleEnum.enumValues),
});

/** Grant a role. Reviewer and organizer are given here and never self-assigned. */
export async function grantRoleAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = roleSchema.parse({
    userId: formData.get('userId'),
    role: formData.get('role'),
  });
  // Organizers grade as much as reviewers do, and the completion dashboard and
  // auto-distributor both query `role = 'reviewer'`. An organizer without that
  // role would be able to grade but never appear in those surfaces.
  const extras = input.role === 'organizer' ? ([{ userId: input.userId, role: 'reviewer' as const }] as const) : [];
  await db
    .insert(userRoles)
    .values([input, ...extras])
    .onConflictDoNothing();
  revalidatePath('/organizer/speakers');
}

export async function revokeRoleAction(formData: FormData): Promise<void> {
  const actor = await requireRole('organizer');
  const input = roleSchema.parse({
    userId: formData.get('userId'),
    role: formData.get('role'),
  });

  // Refuse to let an organizer drop their own organizer role. Doing so is
  // always a mistake and it can lock the last organizer out of the admin
  // screens with no way back in short of a database edit.
  if (input.userId === actor.id && input.role === 'organizer') return;

  // Refuse to strip `speaker` from someone who has submissions. Their own
  // portal at /speaker is speaker-gated, so revoking it does not tidy an
  // account up, it locks the author out of confirming, withdrawing and
  // uploading slides for talks that stay in the programme regardless.
  if (input.role === 'speaker' && (await hasSubmissions(input.userId))) return;

  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, input.userId), eq(userRoles.role, input.role)));
  revalidatePath('/organizer/speakers');
}

export type ProfileState = {
  error?: string;
  saved?: boolean;
  /** The stored name of a headshot this save uploaded, for the confirmation line. */
  uploaded?: string;
};

const profileSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().max(120).nullable(),
  title: z.string().max(120, 'Job titles over 120 characters are too long').nullable(),
  company: z.string().max(120, 'Company names over 120 characters are too long').nullable(),
  bio: z.string().max(4000, 'Bios over 4000 characters are too long').nullable(),
  // Organizer-only, and not on the speaker's own copy of this form. It holds
  // what staff were told rather than what the speaker published: an arrival
  // date, a dietary requirement, who is paying for the flight. None of it
  // belongs on a public profile and none of it is a field a speaker fills in
  // about themselves.
  travelNotes: z.string().max(2000, 'Travel notes over 2000 characters are too long').nullable(),
  // Same field, same rule, as the speaker's own copy of this form: an uploaded
  // headshot writes an app-relative `/files/…` path, and `.url()` rejected the
  // value the upload itself had just written, so an organizer who uploaded a
  // photo could never save the profile again.
  headshotUrl: linkField,
});

/**
 * Organizer editing of a speaker profile. Conference staff routinely hold the
 * headshot and the corrected job title before the speaker gets round to logging
 * in, and until now nothing in the app could write any of the three.
 *
 * The photo arrives two ways and both end in the same column. A pasted URL is
 * the text field; a file goes through `saveUpload`, the same disk, the same
 * magic-byte sniffing and the same `/files/<id>` address the speaker's own
 * upload uses, and then `replaceHeadshot` points the profile at it. There is
 * deliberately no second storage path for organizer-supplied photos: a headshot
 * uploaded here has to be the same object the public directory, the agenda and
 * the file-meta line already know how to read.
 *
 * The upload is part of this form rather than a form of its own, which is where
 * it differs from `/speaker/profile`. That page keeps them apart because its
 * client component holds a live preview that a redirect would leave stale; this
 * one previews straight off the server prop, and an organizer correcting a bio
 * and attaching a photo in one sitting should not lose the typing they have not
 * saved yet to a redirect fired by the other control.
 *
 * `ownerId` is the speaker, not the organizer pressing the button. The row is
 * that person's headshot: it is what `headshotUpload` looks up when the record
 * renders the file, what `replaceHeadshot` scopes its cleanup to, and what lets
 * the speaker take their own photo down from their own profile later.
 */
export async function updateSpeakerProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  await requireRole('organizer');

  const parsed = profileSchema.safeParse({
    userId: formData.get('userId'),
    name: optional(formData.get('name')),
    title: optional(formData.get('title')),
    company: optional(formData.get('company')),
    bio: optional(formData.get('bio')),
    travelNotes: optional(formData.get('travelNotes')),
    headshotUrl: String(formData.get('headshotUrl') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;

  // An empty file input still posts, as a zero-byte File with no name. That is
  // "no photo attached this time", not a failed upload, and it must not blank
  // the column or refuse the rest of the form.
  const file = formData.get('headshotFile');
  const attached = file instanceof File && file.size > 0;

  let headshotUrl = input.headshotUrl;
  let uploaded: string | undefined;

  if (attached) {
    const result = await saveUpload({ file, kind: 'headshot', ownerId: input.userId });
    // The refusal is the speaker-facing sentence `saveUpload` composed — which
    // rule was hit and what the file actually is — not a generic failure. The
    // rest of the form is not written: an organizer who picked the wrong file
    // gets one message and one press to fix, with their typing still on screen.
    if (!result.ok) return { error: result.reason };

    await replaceHeadshot(input.userId, result.upload);
    // Overrides whatever the URL field posted. The field is showing the path of
    // the photo this upload just replaced, and letting it win would point the
    // profile at bytes `replaceHeadshot` has already deleted.
    headshotUrl = uploadHref(result.upload);
    uploaded = result.upload.filename;
  }

  await db
    .update(users)
    .set({
      name: input.name,
      title: input.title,
      company: input.company,
      bio: input.bio,
      travelNotes: input.travelNotes,
      headshotUrl,
    })
    .where(eq(users.id, input.userId));

  refreshSpeakerScreens(input.userId);
  revalidatePath('/agenda');
  // The speaker's own copy of this profile prints the same photo and bio.
  revalidatePath('/speaker');
  revalidatePath('/speaker/profile');
  return { saved: true, ...(uploaded ? { uploaded } : {}) };
}

const attendanceSchema = z.object({
  submissionId: z.string().uuid(),
  userId: z.string().uuid(),
  state: z.enum(['confirmed', 'declined', 'pending']),
});

/**
 * Record whether a speaker is presenting, from the organizer's side.
 *
 * `confirmAttendance` and `declineAttendance` in `/app/speaker/actions.ts` write
 * the same two columns and are scoped `speakerId = <caller>`, which is right for
 * them and is left alone: a speaker must never be able to answer for anybody
 * else. But most of these answers do not arrive through the portal at all. They
 * arrive by email, on a call, or in a corridor at last year's event, and until
 * now the only record of one was a badge the organizer could read and not
 * write. This is that write, and it is a separate action rather than a widened
 * predicate so the speaker-side rule stays a rule.
 *
 * Three states, not a toggle. `pending` clears both columns, which is the undo
 * for a misclick and the only way back to "we have not heard" once something has
 * been recorded. Setting either one clears the other, the same invariant the
 * speaker-side pair holds, so no reader has to decide which timestamp wins.
 *
 * `speakerId = userId` is in the WHERE clause even though an organizer may act
 * on anyone: it ties the row to the record the button was pressed on, so a
 * mismatched pair updates nothing instead of moving a stranger's talk.
 *
 * Nothing is emailed. The organizer pressing this already knows, and the mail in
 * `declineAttendance` exists to tell organizers something a speaker did.
 */
export async function setAttendanceAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = attendanceSchema.parse({
    submissionId: formData.get('submissionId'),
    userId: formData.get('userId'),
    state: formData.get('state'),
  });

  const now = new Date();
  const stamps = {
    confirmed: { speakerConfirmedAt: now, speakerDeclinedAt: null },
    declined: { speakerConfirmedAt: null, speakerDeclinedAt: now },
    pending: { speakerConfirmedAt: null, speakerDeclinedAt: null },
  }[input.state];

  await db
    .update(submissions)
    .set({ ...stamps, updatedAt: now })
    .where(
      and(
        eq(submissions.id, input.submissionId),
        eq(submissions.speakerId, input.userId),
        eq(submissions.status, 'accepted'),
      ),
    );

  refreshSpeakerScreens(input.userId);
  revalidatePath('/speaker');
  revalidatePath('/organizer/schedule');
}

const taskSchema = z.object({
  userId: z.string().uuid(),
  kind: z.enum(speakerTaskKindEnum.enumValues),
  label: z.string().min(1, 'Give the task a label').max(200),
  instructions: z.string().max(2000).nullable(),
  dueAt: z.string().nullable(),
  submissionId: z.string().uuid().nullable(),
});

/** Add one task to one speaker. */
export async function createSpeakerTaskAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();
  const input = taskSchema.parse({
    userId: formData.get('userId'),
    kind: formData.get('kind'),
    label: optional(formData.get('label')),
    instructions: optional(formData.get('instructions')),
    dueAt: optional(formData.get('dueAt')),
    submissionId: optional(formData.get('submissionId')),
  });

  await db.insert(speakerTasks).values({
    userId: input.userId,
    kind: input.kind,
    label: input.label,
    instructions: input.instructions,
    submissionId: input.submissionId,
    dueAt: input.dueAt ? wallClockToInstant(input.dueAt, event.timezone) : null,
  });

  refreshSpeakerScreens(input.userId);
  revalidatePath('/speaker');
}

const taskIdSchema = z.object({ taskId: z.string().uuid(), userId: z.string().uuid() });

/**
 * Mark a task done from the organizer side. Speakers hand things over by email
 * and in corridors; without this the dashboard stays wrong until the speaker
 * logs in and ticks a box they never knew about.
 */
export async function completeSpeakerTaskAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = taskIdSchema.parse({
    taskId: formData.get('taskId'),
    userId: formData.get('userId'),
  });

  await db
    .update(speakerTasks)
    .set({ completedAt: new Date() })
    .where(and(eq(speakerTasks.id, input.taskId), isNull(speakerTasks.completedAt)));

  refreshSpeakerScreens(input.userId);
  revalidatePath('/speaker');
}

/**
 * Put a finished task back to outstanding.
 *
 * "Mark done" is one press in a list that runs to a dozen rows, and it was
 * one-way: the column was only ever written forward and the button only ever
 * rendered while the task was open. The only route back was Delete, which
 * throws away the label, the deadline and the chase history to undo a misclick,
 * and which is why that one asks first.
 *
 * No confirmation here, matching `completeSpeakerTaskAction`. This is the undo,
 * and a confirmation on an undo is how a list teaches an organizer to click
 * through confirmations.
 */
export async function reopenSpeakerTaskAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = taskIdSchema.parse({
    taskId: formData.get('taskId'),
    userId: formData.get('userId'),
  });

  await db
    .update(speakerTasks)
    .set({ completedAt: null })
    .where(and(eq(speakerTasks.id, input.taskId), isNotNull(speakerTasks.completedAt)));

  refreshSpeakerScreens(input.userId);
  revalidatePath('/speaker');
}

/**
 * Delete a task, on the second press.
 *
 * The row carries its label, its deadline, when it was last chased and, for a
 * finished one, the fact that the speaker did it. None of that is anywhere
 * else, and the button sits inches from "Mark done" in a list that can run to
 * a dozen rows, so the accident this guards against is a real one rather than
 * a theoretical one. `?confirmTask=<id>` and a second press carrying
 * `confirm=yes`, the shape `deleteAward` and `deletePage` use.
 */
export async function deleteSpeakerTaskAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = taskIdSchema.parse({
    taskId: formData.get('taskId'),
    userId: formData.get('userId'),
  });

  if (formData.get('confirm') !== 'yes') {
    redirect(`/organizer/speakers/${input.userId}?confirmTask=${input.taskId}`);
  }

  await db.delete(speakerTasks).where(eq(speakerTasks.id, input.taskId));

  refreshSpeakerScreens(input.userId);
  revalidatePath('/speaker');
  redirect(`/organizer/speakers/${input.userId}`);
}

export type BulkTaskState = { error?: string; created?: number; skipped?: number };

const bulkTaskSchema = z.object({
  filter: z.string(),
  q: z.string().nullable(),
  kind: z.enum(speakerTaskKindEnum.enumValues),
  label: z.string().min(1, 'Give the task a label').max(200),
  instructions: z.string().max(2000).nullable(),
  dueAt: z.string().nullable(),
});

/**
 * "Headshot due Friday for every accepted speaker."
 *
 * The target set is resolved here by re-running the roster filter, not read
 * from a list of ids the page posted: what the organizer saw and what this
 * writes are then the same query. A speaker who already owes an open task of
 * this kind is skipped, so pressing the button twice does not hand everyone two
 * identical deadlines.
 */
export async function bulkCreateTasksAction(
  _prev: BulkTaskState,
  formData: FormData,
): Promise<BulkTaskState> {
  await requireRole('organizer');

  const parsed = bulkTaskSchema.safeParse({
    filter: formData.get('filter') ?? 'all',
    q: optional(formData.get('q')),
    kind: formData.get('kind'),
    label: optional(formData.get('label')),
    instructions: optional(formData.get('instructions')),
    dueAt: optional(formData.get('dueAt')),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;
  if (!isRosterFilter(input.filter)) return { error: 'Unknown filter.' };

  const event = await getEvent();
  const dueAt = input.dueAt ? wallClockToInstant(input.dueAt, event.timezone) : null;

  // Bots hold a users row so their grades attribute, but nobody is behind the
  // address; a deadline against one would never be met or read.
  const targets = (
    await speakerRoster({ q: input.q ?? undefined, filter: input.filter })
  ).filter((row) => !row.isBot);

  let created = 0;
  let skipped = 0;
  for (const target of targets) {
    if (target.openTasks.some((task) => task.kind === input.kind)) {
      skipped += 1;
      continue;
    }
    await db.insert(speakerTasks).values({
      userId: target.id,
      kind: input.kind,
      label: input.label,
      instructions: input.instructions,
      dueAt,
    });
    created += 1;
  }

  refreshSpeakerScreens();
  revalidatePath('/speaker');
  return { created, skipped };
}

export type ReminderState = { error?: string; sent?: number; skipped?: number };

const reminderSchema = z.object({
  scope: z.enum(['all', 'user', 'task']),
  filter: z.string(),
  q: z.string().nullable(),
  userId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
});

/**
 * Chase outstanding tasks by email.
 *
 * A task reminded inside the last day is skipped rather than resent, and the
 * count of both is reported: an organizer pressing this twice in a morning
 * needs to see "0 sent, 31 skipped" and not wonder. `lastRemindedAt` is written
 * per row straight after that row's send, so a failure part-way through resumes
 * instead of re-mailing everyone already reached.
 */
export async function sendTaskRemindersAction(
  _prev: ReminderState,
  formData: FormData,
): Promise<ReminderState> {
  await requireRole('organizer');

  const parsed = reminderSchema.safeParse({
    scope: formData.get('scope') ?? 'all',
    filter: formData.get('filter') ?? 'all',
    q: optional(formData.get('q')),
    userId: optional(formData.get('userId')),
    taskId: optional(formData.get('taskId')),
  });
  if (!parsed.success) return { error: 'Could not work out who to remind.' };
  const input = parsed.data;
  if (!isRosterFilter(input.filter)) return { error: 'Unknown filter.' };

  const event = await getEvent();

  const roster = (await speakerRoster({ q: input.q ?? undefined, filter: input.filter })).filter(
    (row) => !row.isBot,
  );
  const scoped =
    input.scope === 'all' ? roster : roster.filter((row) => row.id === input.userId);

  const cutoff = Date.now() - REMINDER_COOLDOWN_MS;
  let sent = 0;
  let skipped = 0;

  for (const person of scoped) {
    for (const task of person.openTasks) {
      if (input.scope === 'task' && task.id !== input.taskId) continue;
      if (task.lastRemindedAt && task.lastRemindedAt.getTime() > cutoff) {
        skipped += 1;
        continue;
      }

      await sendAndLog(
        taskReminderMail({
          to: person.email,
          speakerName: person.name,
          taskLabel: task.label,
          dueAt: task.dueAt,
          eventName: event.name,
          timezone: event.timezone,
        }),
        { userId: person.id, kind: 'task_reminder', submissionId: task.submissionId ?? undefined },
      );
      await db
        .update(speakerTasks)
        .set({ lastRemindedAt: new Date() })
        .where(eq(speakerTasks.id, task.id));
      sent += 1;
    }
  }

  refreshSpeakerScreens(input.userId ?? undefined);
  revalidatePath('/organizer/onboarding');
  return { sent, skipped };
}

export type InviteState = { error?: string; message?: string };

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().min(1, 'Tell us their name').max(120),
  // `speakerTitle`, not `title`, and the one place in this app where the byline
  // field is not called `title`. This form carries the talk's title as well,
  // under the name the column has, and two inputs called `title` in one
  // `FormData` is a bug that reads as a typo.
  speakerTitle: z.string().max(120).nullable(),
  company: z.string().max(120).nullable(),
  bio: z.string().max(4000, 'Bios over 4000 characters are too long').nullable(),
  title: z.string().min(6, 'Give the talk a title').max(200),
  abstract: z.string().min(120, 'Abstracts under 120 characters are too thin to review').max(5000),
  format: z.enum(submissionFormatEnum.enumValues),
  audienceLevel: z.enum(audienceLevelEnum.enumValues),
  trackId: z.string().uuid().nullable(),
  keywords: z.string().nullable(),
  acceptNow: z.boolean(),
});

/**
 * File a submission on a speaker's behalf and hand them the account.
 *
 * Deliberately does not consult `cfpIsOpen`. A keynote is booked by an invitation
 * months after the call closed, and the CFP window governs what the public may
 * post, not what the programme committee may enter.
 *
 * `decisionEmailedAt` is left null even when accepted on the spot, so the
 * acceptance mail still belongs to the send button on /organizer/submissions
 * and this action sends exactly one thing: the sign-in link.
 */
export async function inviteSpeakerAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  await requireRole('organizer');

  const parsed = inviteSchema.safeParse({
    email: optional(formData.get('email')),
    name: optional(formData.get('name')),
    speakerTitle: optional(formData.get('speakerTitle')),
    company: optional(formData.get('company')),
    bio: optional(formData.get('bio')),
    title: optional(formData.get('title')),
    abstract: optional(formData.get('abstract')),
    format: formData.get('format'),
    audienceLevel: formData.get('audienceLevel'),
    trackId: optional(formData.get('trackId')),
    keywords: optional(formData.get('keywords')),
    acceptNow: formData.get('acceptNow') === 'on',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;

  const event = await getEvent();
  const speaker = await upsertUserByEmail(input.email, input.name);
  await grantRole(speaker.id, 'speaker');

  // A blank field is no opinion, not an instruction to clear the column. The
  // committee books a keynote knowing where they work; they may also be
  // re-inviting somebody already on the roster, and a form submitted with the
  // profile left empty must not wipe what that speaker filled in themselves.
  if (input.speakerTitle !== null || input.company !== null || input.bio !== null) {
    await db
      .update(users)
      .set({
        title: input.speakerTitle ?? speaker.title,
        company: input.company ?? speaker.company,
        bio: input.bio ?? speaker.bio,
      })
      .where(eq(users.id, speaker.id));
  }

  const [created] = await db
    .insert(submissions)
    .values({
      speakerId: speaker.id,
      trackId: input.trackId,
      title: input.title,
      abstract: input.abstract,
      format: input.format,
      audienceLevel: input.audienceLevel,
      status: input.acceptNow ? 'accepted' : 'submitted',
      keywords: input.keywords
        ? input.keywords
            .split(',')
            .map((k) => k.trim())
            .filter((k) => k.length > 0)
        : [],
    })
    .returning({ id: submissions.id });
  if (!created) return { error: 'The submission could not be created.' };

  try {
    const token = await issueMagicLink(speaker.id);
    await sendAndLog(
      speakerInviteMail({
        to: speaker.email,
        speakerName: speaker.name ?? input.name,
        title: input.title,
        token,
        eventName: event.name,
      }),
      { userId: speaker.id, kind: 'speaker_invite', submissionId: created.id },
    );
  } catch (err) {
    if (err instanceof MagicLinkRateLimitError) return { error: err.message };
    throw err;
  }

  refreshSpeakerScreens(speaker.id);
  revalidatePath('/organizer/submissions');
  revalidatePath('/speaker');
  return { message: `Invited ${speaker.email} and sent them a sign-in link.` };
}

export type AvailabilityState = { error?: string; saved?: boolean };

const availabilitySchema = z.object({
  userId: z.string().uuid(),
  startsAt: z.string().min(1, 'Give the block a start'),
  endsAt: z.string().min(1, 'Give the block an end'),
  note: z.string().max(200).nullable(),
});

/**
 * Record when a speaker cannot be scheduled. The scheduling conflict checker
 * reads these rows; this is the only place they are written.
 */
export async function createAvailabilityAction(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  await requireRole('organizer');

  const parsed = availabilitySchema.safeParse({
    userId: formData.get('userId'),
    startsAt: optional(formData.get('startsAt')),
    endsAt: optional(formData.get('endsAt')),
    note: optional(formData.get('note')),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;

  const event = await getEvent();
  const startsAt = wallClockToInstant(input.startsAt, event.timezone);
  const endsAt = wallClockToInstant(input.endsAt, event.timezone);
  if (endsAt <= startsAt) return { error: 'The block has to end after it starts.' };

  await db.insert(speakerAvailability).values({
    userId: input.userId,
    startsAt,
    endsAt,
    note: input.note,
  });

  refreshSpeakerScreens(input.userId);
  revalidatePath('/organizer/schedule');
  return { saved: true };
}

const availabilityIdSchema = z.object({
  availabilityId: z.string().uuid(),
  userId: z.string().uuid(),
});

export async function deleteAvailabilityAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = availabilityIdSchema.parse({
    availabilityId: formData.get('availabilityId'),
    userId: formData.get('userId'),
  });

  await db.delete(speakerAvailability).where(eq(speakerAvailability.id, input.availabilityId));

  refreshSpeakerScreens(input.userId);
  revalidatePath('/organizer/schedule');
}
