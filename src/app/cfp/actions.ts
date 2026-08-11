'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { audienceLevelEnum, submissionFormatEnum, submissions, users } from '@/db/schema';
import {
  duplicateTitleMessage,
  isDuplicateTitleError,
  titleAlreadyFiled,
} from '@/lib/abstracts';
import { currentUser, grantRole, issueMagicLink, MagicLinkRateLimitError, startSession, upsertUserByEmail } from '@/lib/auth';
import {
  alertOrganizers,
  magicLinkMail,
  sendAndLog,
  sendSignInMail,
  submissionAlertMail,
  submissionReceivedMail,
} from '@/lib/email';
import { FORMAT_LABELS } from '@/lib/format';
import { activeQuestions, saveAnswers } from '@/lib/question-queries';
import { questionIdFromField, validateAnswers, type AnswerMap } from '@/lib/questions';
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

const MAX_KEYWORDS = 12;

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

/**
 * Split the comma-separated keyword field. Deduped case-insensitively but
 * stored as typed, because "Postgres" is what the speaker wrote and the
 * gallery filter is what wants it lowercased, not the record.
 */
function parseKeywords(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const keyword = raw.trim().slice(0, 40);
    if (keyword === '') continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * Tell the organizers a proposal has landed.
 *
 * The recipient lookup and the swallowed failure both moved to
 * `alertOrganizers` in `lib/email.ts` once a second caller needed them: a
 * speaker declining an accepted talk is the other thing the organizers have to
 * hear about without the speaker's own action failing over it.
 */
async function announceSubmission(opts: {
  title: string;
  speakerName: string;
  format: string;
  eventName: string;
  submissionId: string;
}): Promise<void> {
  await alertOrganizers((to) => submissionAlertMail({ ...opts, to }), {
    kind: 'submission_alert',
    submissionId: opts.submissionId,
  });
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

  // The organizer's questions are checked before anything is written. Answers
  // to hidden questions are dropped by `validateAnswers` rather than rejected,
  // so a speaker who opens a branch, fills it in and closes it again is not
  // held to an answer the form is no longer asking for.
  const questions = await activeQuestions();
  const posted: AnswerMap = {};
  for (const [field, value] of formData.entries()) {
    const questionId = questionIdFromField(field);
    if (questionId && typeof value === 'string') posted[questionId] = value;
  }

  const checked = validateAnswers(
    questions,
    { format: input.format, trackId: input.trackId },
    posted,
  );
  if (!checked.ok) {
    return { error: checked.errors[0]!.message };
  }

  const speaker = signedIn ?? (await upsertUserByEmail(input.email, input.name));

  // Filing a proposal is what makes a user a speaker. `upsertUserByEmail` only
  // grants the role on a newly created account, so a signed-in user whose role
  // was revoked (or who never had one) still regains it here.
  await grantRole(speaker.id, 'speaker');

  // The back button, not a race. With scripting off, filing a proposal and
  // pressing back leaves the form populated, and pressing submit again filed a
  // second identical proposal with nothing said. The reviewers then graded the
  // same talk twice.
  //
  // Checked before the profile update below, so a resubmission does not rewrite
  // the speaker's bio on its way to being refused.
  if (await titleAlreadyFiled(speaker.id, input.title)) {
    return { error: duplicateTitleMessage(input.title) };
  }

  // Keep the speaker profile current from the newest submission. This is the
  // whole of "speaker management" on the speaker's side: one profile, reused.
  await db
    .update(users)
    .set({ name: input.name, bio: input.bio ?? speaker.bio })
    .where(eq(users.id, speaker.id));

  let created: { id: string } | undefined;
  try {
    [created] = await db
      .insert(submissions)
      .values({
        speakerId: speaker.id,
        trackId: input.trackId,
        title: input.title,
        abstract: input.abstract,
        format: input.format,
        audienceLevel: input.audienceLevel,
        posterUrl: input.posterUrl,
        keywords: parseKeywords(formData.get('keywords')),
      })
      .returning({ id: submissions.id });
  } catch (error) {
    // Two tabs, submitted close enough together that both passed the check
    // above. The index caught it; this turns that into the same sentence rather
    // than a 500.
    if (isDuplicateTitleError(error)) return { error: duplicateTitleMessage(input.title) };
    throw error;
  }
  if (created) await saveAnswers(created.id, checked.answers);

  // A first-time submitter has no session. Email them a link so the submission
  // is not stranded behind an account they never created.
  if (!signedIn) {
    try {
      const token = await issueMagicLink(speaker.id);
      await sendSignInMail(magicLinkMail(speaker.email, token, event.name));
      await startSession(speaker.id);
    } catch (err) {
      if (err instanceof MagicLinkRateLimitError) return { error: err.message };
      throw err;
    }
  }

  // Every submitter gets a receipt, first-timer included. The sign-in link
  // above is not one: it says "here is your account" and never mentions the
  // proposal, so a first-time speaker used to be the only person who could not
  // prove the form had taken anything.
  if (created) {
    await sendAndLog(submissionReceivedMail(speaker.email, input.title, event.name), {
      userId: speaker.id,
      kind: 'submission_received',
      submissionId: created.id,
    });
    await announceSubmission({
      title: input.title,
      speakerName: input.name,
      format: FORMAT_LABELS[input.format],
      eventName: event.name,
      submissionId: created.id,
    });
  }

  redirect('/speaker?submitted=1');
}
