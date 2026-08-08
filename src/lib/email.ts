import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resend } from 'resend';
import { db } from '@/db';
import { emailLog } from '@/db/schema';
import { env } from './env';

export type Mail = {
  to: string;
  subject: string;
  text: string;
};

/**
 * Send, or in development record. With RESEND_API_KEY unset every message is
 * printed and written to .mail/ instead of leaving the box, so the magic-link
 * flow and the accept/reject flow are both exercisable offline and by the
 * Playwright suite. A missing key is never a silent no-op: the file is the
 * receipt.
 */
export async function sendMail(mail: Mail): Promise<{ delivered: boolean; path?: string }> {
  const { RESEND_API_KEY, MAIL_FROM } = env();

  if (!RESEND_API_KEY) {
    const dir = join(process.cwd(), '.mail');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${mail.to.replace(/[^a-z0-9]/gi, '_')}.txt`);
    writeFileSync(path, `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`, 'utf8');
    console.log(`[mail:dev] ${mail.to} — ${mail.subject}\n${mail.text}\n`);
    return { delivered: false, path };
  }

  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
  if (error) throw new Error(`resend failed: ${error.message}`);
  return { delivered: true };
}

/**
 * Send, then write the receipt. Every caller outside the sign-in path should
 * use this rather than `sendMail`, because an organizer asking "did that go
 * out" is asking about `email_log`, and a row only exists if a send happened.
 * `kind` is a stable slug the reminder actions dedupe on, e.g. 'task_reminder'.
 */
export async function sendAndLog(
  mail: Mail,
  meta: { userId: string; kind: string; submissionId?: string },
): Promise<{ delivered: boolean; path?: string }> {
  const result = await sendMail(mail);
  await db.insert(emailLog).values({
    userId: meta.userId,
    submissionId: meta.submissionId ?? null,
    kind: meta.kind,
    subject: mail.subject,
    delivered: result.delivered,
  });
  return result;
}

export function magicLinkMail(to: string, token: string, eventName: string): Mail {
  const url = `${env().APP_URL}/auth/verify?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: `Your sign-in link for ${eventName}`,
    text: [
      `Sign in to ${eventName}:`,
      '',
      url,
      '',
      'This link works once and expires in 15 minutes.',
      'If you did not ask for it, ignore this email.',
    ].join('\n'),
  };
}

export function acceptanceMail(to: string, title: string, eventName: string): Mail {
  return {
    to,
    subject: `Accepted: "${title}" at ${eventName}`,
    text: [
      `Good news — "${title}" has been accepted for ${eventName}.`,
      '',
      `Your talk's time and room appear on the agenda once scheduling is done: ${env().APP_URL}/agenda`,
      '',
      `Manage your submission: ${env().APP_URL}/speaker`,
    ].join('\n'),
  };
}

export function rejectionMail(to: string, title: string, eventName: string): Mail {
  return {
    to,
    subject: `Update on "${title}" for ${eventName}`,
    text: [
      `Thank you for submitting "${title}" to ${eventName}.`,
      '',
      'We had more strong proposals than slots this year and were not able to',
      'include it in the programme. We hope you will submit again.',
      '',
      `The full agenda will be published at ${env().APP_URL}/agenda`,
    ].join('\n'),
  };
}

/**
 * The receipt for a proposal that has landed.
 *
 * A first-time submitter gets a sign-in link instead, because their more urgent
 * problem is reaching an account they did not knowingly create. A speaker who is
 * already signed in has no such problem and used to receive nothing at all,
 * which reads as a form that swallowed the submission.
 */
export function submissionReceivedMail(to: string, title: string, eventName: string): Mail {
  return {
    to,
    subject: `Received: "${title}" for ${eventName}`,
    text: [
      `We have "${title}" down for ${eventName}. Nothing else is needed from you yet.`,
      '',
      'The programme committee reads proposals blind, so nobody grading it will',
      'see your name beside it. You will hear from us once the decisions are made.',
      '',
      `Your submissions: ${env().APP_URL}/speaker`,
    ].join('\n'),
  };
}
