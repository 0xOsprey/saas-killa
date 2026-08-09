'use server';

import { and, eq, isNull } from 'drizzle-orm';
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
import { grantRole, issueMagicLink, requireRole, upsertUserByEmail } from '@/lib/auth';
import { sendAndLog } from '@/lib/email';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { hasSubmissions, isRosterFilter, speakerRoster } from '@/lib/speakers';
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
  await db.insert(userRoles).values(input).onConflictDoNothing();
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

export type ProfileState = { error?: string; saved?: boolean };

const profileSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().max(120).nullable(),
  bio: z.string().max(4000, 'Bios over 4000 characters are too long').nullable(),
  headshotUrl: z.string().url('A headshot needs a full URL, including https://').nullable(),
});

/**
 * Organizer editing of a speaker profile. Conference staff routinely hold the
 * headshot and the corrected job title before the speaker gets round to logging
 * in, and until now nothing in the app could write any of the three.
 */
export async function updateSpeakerProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  await requireRole('organizer');

  const parsed = profileSchema.safeParse({
    userId: formData.get('userId'),
    name: optional(formData.get('name')),
    bio: optional(formData.get('bio')),
    headshotUrl: optional(formData.get('headshotUrl')),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;

  await db
    .update(users)
    .set({ name: input.name, bio: input.bio, headshotUrl: input.headshotUrl })
    .where(eq(users.id, input.userId));

  refreshSpeakerScreens(input.userId);
  revalidatePath('/agenda');
  return { saved: true };
}

const taskSchema = z.object({
  userId: z.string().uuid(),
  kind: z.enum(speakerTaskKindEnum.enumValues),
  label: z.string().min(1, 'Give the task a label').max(200),
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
    dueAt: optional(formData.get('dueAt')),
    submissionId: optional(formData.get('submissionId')),
  });

  await db.insert(speakerTasks).values({
    userId: input.userId,
    kind: input.kind,
    label: input.label,
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
  return { sent, skipped };
}

export type InviteState = { error?: string; message?: string };

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().min(1, 'Tell us their name').max(120),
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
