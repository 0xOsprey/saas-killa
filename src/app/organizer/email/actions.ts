'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { parseContactFilters } from '@/lib/contacts';
import { db } from '@/db';
import { emailLog } from '@/db/schema';
import { sendAndLog, sendMail, type Mail } from '@/lib/email';
import { getEvent } from '@/lib/queries';
import { isRosterFilter } from '@/lib/speakers';
import { announcementMail } from './mail';
import { announcementAudience, mergeContext, type Recipient } from './recipients';
import { renderTokens, unknownTokens } from './templates';

/** The `email_log.kind` slug a bulk announcement writes. Glossed on the log below the form. */
const ANNOUNCEMENT_KIND = 'bulk_announcement';

/** How many rendered copies the preview shows at once. Enough to see the tokens vary, few enough to read. */
const PREVIEW_LIMIT = 3;

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

const composeSchema = z.object({
  filter: z.string(),
  q: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  tag: z.string().nullable(),
  subject: z.string().min(1, 'Give the message a subject').max(200),
  body: z.string().min(1, 'Write something to send').max(20000),
});

/**
 * Everything both actions need: the audience, and a subject and body with no
 * token this app cannot fill in.
 *
 * The token check runs before either action does its own work, so a typo is
 * caught by the preview as well as by the send. Catching it only on the send
 * would mean the one screen built to show an organizer what their message looks
 * like is also the one screen that would happily show them `{{firstname}}`.
 */
async function resolveCompose(
  formData: FormData,
): Promise<{ error: string } | { audience: Recipient[]; subject: string; body: string; eventName: string }> {
  const parsed = composeSchema.safeParse({
    filter: formData.get('filter') ?? 'all',
    q: optional(formData.get('q')),
    company: optional(formData.get('company')),
    title: optional(formData.get('title')),
    tag: optional(formData.get('tag')),
    subject: optional(formData.get('subject')) ?? '',
    body: optional(formData.get('body')) ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const input = parsed.data;
  if (!isRosterFilter(input.filter)) return { error: 'Unknown filter.' };

  const unknown = unknownTokens(`${input.subject}\n${input.body}`);
  if (unknown.length > 0) {
    return {
      error: `Nothing fills in {{${unknown[0]}}}. Use one of the merge fields listed under the body, or take the braces out.`,
    };
  }

  // Through the shared parser rather than by hand, so the normalising the
  // directory does happens here too. A tag arrives lowercased and space-collapsed
  // either way, and a hand-built object would match "AI" against nothing.
  const filters = parseContactFilters({
    q: input.q ?? undefined,
    filter: input.filter,
    company: input.company ?? undefined,
    title: input.title ?? undefined,
    tag: input.tag ?? undefined,
  });

  const [event, audience] = await Promise.all([getEvent(), announcementAudience(filters)]);

  return { audience, subject: input.subject, body: input.body, eventName: event.name };
}

export type PreviewRender = {
  name: string;
  email: string;
  subject: string;
  body: string;
};

export type PreviewState = {
  error?: string;
  rendered?: PreviewRender[];
  audienceSize?: number;
  /** How many of the audience have no accepted talk, and so fall back on `{{session}}`. */
  withoutSession?: number;
};

/**
 * Fill the message in against real people and show it, without sending
 * anything.
 *
 * Reads the whole audience rather than the ticked subset, on purpose. The
 * question this button answers is "what does this template say once it is
 * filled in", which is about the template and the person, not about who is
 * getting a copy, and an organizer who unticked somebody to exclude them should
 * still be able to look at how their own copy would have read.
 *
 * The chosen speaker is rendered first and the next two follow, because one
 * rendering proves a token resolved and three prove it resolved differently per
 * person.
 */
export async function previewAnnouncementAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  await requireRole('organizer');

  const resolved = await resolveCompose(formData);
  if ('error' in resolved) return { error: resolved.error };
  const { audience, subject, body, eventName } = resolved;

  if (audience.length === 0) return { error: 'Nobody matches that filter, so there is nothing to preview.' };

  const wanted = optional(formData.get('previewUserId'));
  const first = audience.findIndex((person) => person.id === wanted);
  const ordered =
    first > 0 ? [audience[first]!, ...audience.filter((_, i) => i !== first)] : audience;

  const rendered = ordered.slice(0, PREVIEW_LIMIT).map((recipient) => {
    const context = mergeContext(recipient, eventName);
    return {
      name: recipient.name ?? recipient.email,
      email: recipient.email,
      subject: renderTokens(subject, context),
      body: renderTokens(body, context),
    };
  });

  return {
    rendered,
    audienceSize: audience.length,
    withoutSession: audience.filter((person) => person.sessionTitle === null).length,
  };
}

export type SendState = {
  error?: string;
  sent?: number;
  skipped?: number;
};

/**
 * Send the composed message, one personalized copy per speaker.
 *
 * The set is resolved by re-running the roster query and the ticked boxes can
 * only narrow it. That ordering is the point: an id posted by a page that has
 * since gone stale, or by anyone hand-editing the form, is dropped rather than
 * mailed, so the worst a forged id achieves is a message that does not go out.
 * Ticking is still a real control, because "everyone accepted except these two"
 * is a normal thing to want and no saved view expresses it.
 *
 * One `email_log` row per recipient, through `sendAndLog` like everything else,
 * which is what puts the recipient and the timestamp in the history below. A
 * failure part-way through therefore leaves rows for the copies that did go,
 * rather than losing the record of them.
 */
export async function sendAnnouncementAction(
  _prev: SendState,
  formData: FormData,
): Promise<SendState> {
  await requireRole('organizer');

  const resolved = await resolveCompose(formData);
  if ('error' in resolved) return { error: resolved.error };
  const { audience, subject, body, eventName } = resolved;

  const ticked = new Set(formData.getAll('recipient').map(String));
  const chosen = audience.filter((person) => ticked.has(person.id));
  if (chosen.length === 0) {
    return { error: 'Tick at least one speaker to send to.' };
  }

  let sent = 0;
  for (const recipient of chosen) {
    await sendAndLog(announcementMail({ recipient, eventName, subject, body }), {
      userId: recipient.id,
      kind: ANNOUNCEMENT_KIND,
    });
    sent += 1;
  }

  revalidatePath('/organizer/email');
  return { sent, skipped: audience.length - sent };
}

export type RetryState = { error?: string; delivered?: boolean };

const retrySchema = z.object({ id: z.string().uuid() });

/**
 * Resend a single failed email, using the rendered body stored on the log row.
 *
 * The row is updated in place so the log reflects the latest attempt: a
 * successful retry flips the badge to "delivered", a failed one leaves it as
 * "not sent" with an updated timestamp. Old rows that pre-date this feature have
 * no stored body, so they cannot be retried exactly; the action explains that.
 */
export async function retryEmailAction(
  _prev: RetryState,
  formData: FormData,
): Promise<RetryState> {
  await requireRole('organizer');

  const parsed = retrySchema.safeParse({
    id: formData.get('id'),
  });
  if (!parsed.success) return { error: 'Could not work out which email to retry.' };

  const [row] = await db
    .select({
      id: emailLog.id,
      userId: emailLog.userId,
      submissionId: emailLog.submissionId,
      kind: emailLog.kind,
      delivered: emailLog.delivered,
      mailJson: emailLog.mailJson,
    })
    .from(emailLog)
    .where(and(eq(emailLog.id, parsed.data.id), eq(emailLog.delivered, false)));

  if (!row) return { error: 'That email has already been delivered or removed.' };
  if (!row.mailJson) return { error: 'This email was sent before retry was available.' };

  let mail: Mail;
  try {
    mail = JSON.parse(row.mailJson) as Mail;
  } catch {
    return { error: 'Stored email is unreadable.' };
  }

  const result = await sendMail(mail);
  await db
    .update(emailLog)
    .set({ delivered: result.delivered, sentAt: new Date() })
    .where(eq(emailLog.id, row.id));

  revalidatePath('/organizer/email');
  return { delivered: result.delivered };
}
