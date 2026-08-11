import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resend } from 'resend';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { emailLog, submissions, userRoles, users } from '@/db/schema';
import { env, mailMode } from './env';

/**
 * A file that rides along with the message. Text only, because the one thing
 * this app attaches is an iCalendar body, and keeping `content` a string means
 * the development receipt in `.mail/` is readable rather than a base64 wall.
 */
export type Attachment = {
  filename: string;
  contentType: string;
  content: string;
};

export type Mail = {
  to: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
};

/**
 * Send, or record. With RESEND_API_KEY unset every message is printed and
 * written to .mail/ instead of leaving the box, so the magic-link flow and the
 * accept/reject flow are both exercisable offline and by the Playwright suite.
 * A missing key is never a silent no-op: the file is the receipt.
 *
 * `MAIL_NOTIFICATIONS=off` takes the same door on a box that does have a key.
 * That is a cost control for testing: pressing "notify" against a seeded board
 * is one send per speaker, and against a fixture full of `@example.com`
 * addresses it is also one bounce per speaker, on a domain whose reputation is
 * worth more than the test.
 *
 * What it does not do is change the app around the send. The receipt is still
 * written, `email_log` still gets its row reading `not sent`, and
 * `decisionEmailedAt` is still stamped. An organizer's board says "speaker
 * notified" either way, so this is a switch about egress, not an undo.
 */
export async function sendMail(mail: Mail): Promise<{ delivered: boolean; path?: string }> {
  return deliver(mail, mailMode() === 'notifications-off');
}

/**
 * The sign-in link, and the one message `MAIL_NOTIFICATIONS=off` does not
 * touch.
 *
 * A magic link is authentication rather than correspondence, which is already
 * why it is the one send that writes no `email_log` row. It is also why it is
 * exempt here: an instance with a real key and notifications off has to stay an
 * instance somebody can log in to, and a cost control that locks the organizer
 * out of the box it is set on is a lock, not a control.
 */
export async function sendSignInMail(mail: Mail): Promise<{ delivered: boolean; path?: string }> {
  return deliver(mail, false);
}

async function deliver(
  mail: Mail,
  suppressed: boolean,
): Promise<{ delivered: boolean; path?: string }> {
  const { RESEND_API_KEY, MAIL_FROM } = env();

  // Two ways to take the disk door: no key at all, or a key this message is not
  // allowed to spend. The second test also narrows `RESEND_API_KEY` for the
  // send below, which is why it is here and not only at the call sites.
  if (suppressed || !RESEND_API_KEY) {
    const dir = join(process.cwd(), '.mail');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${mail.to.replace(/[^a-z0-9]/gi, '_')}.txt`);
    // Attachments are written into the receipt in full rather than named. An
    // .ics whose DTSTART is wrong is a wrong invitation, and a receipt that only
    // said "1 attachment" would let that ship.
    const parts = [`To: ${mail.to}`, `Subject: ${mail.subject}`, '', mail.text, ''];
    for (const file of mail.attachments ?? []) {
      parts.push(
        `--- attachment: ${file.filename} (${file.contentType}) ---`,
        file.content,
        `--- end attachment: ${file.filename} ---`,
        '',
      );
    }
    writeFileSync(path, parts.join('\n'), 'utf8');
    console.log(`[mail:dev] ${mail.to} — ${mail.subject}\n${mail.text}\n`);
    return { delivered: false, path };
  }

  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    // Resend takes attachment bytes as a Buffer or a base64 string; a plain
    // string would be read as a URL to fetch from.
    attachments: mail.attachments?.map((file) => ({
      filename: file.filename,
      content: Buffer.from(file.content, 'utf8'),
      contentType: file.contentType,
    })),
  });
  if (error) throw new Error(`resend failed: ${error.message}`);
  return { delivered: true };
}

/**
 * An iCalendar body as a mail attachment.
 *
 * The `method=` parameter is read back out of the body rather than passed in.
 * A client trusts the header over the payload, so the two disagreeing means a
 * cancellation delivered as an invitation, and deriving it is the only way the
 * two cannot drift.
 */
export function calendarAttachment(ics: string, filename = 'invite.ics'): Attachment {
  const method = /^METHOD:(\w+)/m.exec(ics)?.[1] ?? 'PUBLISH';
  return {
    filename,
    contentType: `text/calendar; charset=utf-8; method=${method}`,
    content: ics,
  };
}

/**
 * Write the receipt for a message that has already gone out.
 *
 * Separate from `sendAndLog` for the one caller that cannot use it: the
 * decision mail marks `decisionEmailedAt` between the send and the receipt,
 * because that column is its idempotency key and a receipt failing must not
 * cost a speaker a second acceptance mail on the retry.
 */
export async function logEmail(meta: {
  userId: string;
  kind: string;
  subject: string;
  delivered: boolean;
  mailJson?: string;
  submissionId?: string;
}): Promise<void> {
  await db.insert(emailLog).values({
    userId: meta.userId,
    submissionId: meta.submissionId ?? null,
    kind: meta.kind,
    subject: meta.subject,
    delivered: meta.delivered,
    mailJson: meta.mailJson ?? null,
  });
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
  await logEmail({
    ...meta,
    subject: mail.subject,
    delivered: result.delivered,
    mailJson: JSON.stringify(mail),
  });
  return result;
}

export type EmailLogEntry = {
  id: string;
  kind: string;
  subject: string;
  delivered: boolean;
  mailJson: string | null;
  sentAt: Date;
  recipientName: string | null;
  recipientEmail: string;
  submissionId: string | null;
  submissionTitle: string | null;
};

/**
 * The correspondence log, newest first.
 *
 * Every send but one is here: the sign-in link goes out through
 * `sendSignInMail` alone, because a magic link is authentication rather than
 * correspondence and an organizer reading a list of who was mailed what does
 * not want it padded with one row per page load.
 *
 * Capped rather than paginated. The screen answers "did that go out", which is
 * always a question about a recent send, and an uncapped select on a table that
 * grows with every reminder is a page that gets slower every week.
 */
export async function recentEmails(limit = 200): Promise<EmailLogEntry[]> {
  return db
    .select({
      id: emailLog.id,
      kind: emailLog.kind,
      subject: emailLog.subject,
      delivered: emailLog.delivered,
      mailJson: emailLog.mailJson,
      sentAt: emailLog.sentAt,
      recipientName: users.name,
      recipientEmail: users.email,
      submissionId: emailLog.submissionId,
      submissionTitle: submissions.title,
    })
    .from(emailLog)
    .innerJoin(users, eq(users.id, emailLog.userId))
    .leftJoin(submissions, eq(submissions.id, emailLog.submissionId))
    .orderBy(desc(emailLog.sentAt))
    .limit(limit);
}

/**
 * Send one mail per organizer, and never fail the caller over it.
 *
 * Per organizer rather than to a shared address, because there is no shared
 * address in this app: the recipient list is whoever holds the organizer role,
 * which lives in `user_roles` and not on `users`, since one person can hold both
 * organizer and reviewer.
 *
 * Failures are swallowed on purpose. Every caller has already committed the
 * thing being announced, and a mail server refusing the organizer's copy is not
 * a reason to show a speaker an error about an action that did in fact happen.
 */
export async function alertOrganizers(
  build: (to: string) => Mail,
  meta: { kind: string; submissionId?: string },
): Promise<void> {
  try {
    const organizers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(eq(userRoles.role, 'organizer'));

    for (const organizer of organizers) {
      await sendAndLog(build(organizer.email), {
        userId: organizer.id,
        kind: meta.kind,
        submissionId: meta.submissionId,
      });
    }
  } catch (error) {
    console.error(`[${meta.kind}] organizer alert failed`, error);
  }
}

/**
 * `MAIL_FROM` split into the name and address an ORGANIZER line needs.
 *
 * The env value is one RFC 5322 string, `Name <addr>` or a bare address, and a
 * calendar invitation wants the two apart. Parsed here so the calendar code
 * never has to know the env layout, and so the address a speaker's client shows
 * as the organizer is the same one the mail actually came from.
 */
export function mailFromParty(): { name: string | null; email: string } {
  const raw = env().MAIL_FROM.trim();
  const match = /^(.*?)\s*<([^>]+)>$/.exec(raw);
  if (!match) return { name: null, email: raw };
  const name = match[1]!.replace(/^"|"$/g, '').trim();
  return { name: name === '' ? null : name, email: match[2]!.trim() };
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

/** A placement in words: what the speaker reads when a calendar file is not enough. */
export type MailPlacement = { when: string; room: string };

/**
 * The acceptance.
 *
 * A talk already placed on the grid at decision time carries its invitation
 * here, so an accepted speaker does not have to wait for a second email to know
 * when they are on. A talk not yet scheduled gets the same prose it always did,
 * and the invitation follows from `notifySchedule` once there is a time to send.
 */
export function acceptanceMail(
  to: string,
  title: string,
  eventName: string,
  placement?: MailPlacement,
): Mail {
  const text = placement
    ? [
        `Good news — "${title}" has been accepted for ${eventName}.`,
        '',
        `You are on at ${placement.when}, in ${placement.room}.`,
        'The attached calendar invitation has the same details; adding it means a',
        'later change to your time or room updates the entry you already have.',
        '',
        `Manage your submission: ${env().APP_URL}/speaker`,
      ]
    : [
        `Good news — "${title}" has been accepted for ${eventName}.`,
        '',
        `Your talk's time and room appear on the agenda once scheduling is done: ${env().APP_URL}/agenda`,
        'We will email you a calendar invitation as soon as it has a slot.',
        '',
        `Manage your submission: ${env().APP_URL}/speaker`,
      ];
  return { to, subject: `Accepted: "${title}" at ${eventName}`, text: text.join('\n') };
}

/**
 * The first "you are on at" mail, the "your time has changed" mail, and the
 * "you are off the grid" mail.
 *
 * One template with three openings rather than three templates, because the
 * body below the first line is the same information every time and the three
 * drifted apart the moment they were separate. `previous` is stated in full on
 * a move: a speaker who only reads the new time cannot tell whether the mail is
 * about a change or a duplicate of the one they already have.
 */
export function scheduleNoticeMail(opts: {
  to: string;
  title: string;
  eventName: string;
  placement: MailPlacement | null;
  previous: MailPlacement | null;
}): Mail {
  const { title, eventName, placement, previous } = opts;

  if (!placement) {
    return {
      to: opts.to,
      subject: `"${title}" has come off the ${eventName} schedule`,
      text: [
        `"${title}" no longer has a time at ${eventName}.`,
        previous ? `It was down for ${previous.when}, in ${previous.room}.` : '',
        '',
        'Your acceptance stands. This is a scheduling change, not a decision, and',
        'we will email a new invitation once it is back on the grid.',
        '',
        'The attached file cancels the calendar entry we sent you.',
        '',
        `Your submissions: ${env().APP_URL}/speaker`,
      ]
        .filter((line, index, all) => line !== '' || all[index - 1] !== '')
        .join('\n'),
    };
  }

  const moved = previous !== null;
  return {
    to: opts.to,
    subject: moved
      ? `Time change: "${title}" at ${eventName}`
      : `You are scheduled: "${title}" at ${eventName}`,
    text: [
      moved
        ? `"${title}" has moved. It is now at ${placement.when}, in ${placement.room}.`
        : `"${title}" is on the ${eventName} schedule at ${placement.when}, in ${placement.room}.`,
      moved ? `It was previously ${previous.when}, in ${previous.room}.` : '',
      '',
      'The attached calendar invitation carries the new details. Adding it replaces',
      'the entry you already have rather than making a second one.',
      '',
      `The full agenda: ${env().APP_URL}/agenda`,
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n'),
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

/**
 * The organizer's heads-up that a proposal has landed.
 *
 * Sent per organizer rather than to a shared address, because there is no
 * shared address in this app — the recipient list is whoever holds the
 * organizer role. The speaker's name is in it: this is the one mail in the
 * system that is not blind, and it is not, because it goes to the person
 * running the event rather than to anyone grading.
 */
export function submissionAlertMail(opts: {
  to: string;
  title: string;
  speakerName: string;
  format: string;
  eventName: string;
}): Mail {
  return {
    to: opts.to,
    subject: `New submission: "${opts.title}"`,
    text: [
      `${opts.speakerName} has submitted "${opts.title}" (${opts.format}) to ${opts.eventName}.`,
      '',
      `Review queue: ${env().APP_URL}/organizer/submissions`,
    ].join('\n'),
  };
}

/**
 * The organizer's heads-up that an accepted speaker has dropped out.
 *
 * Says plainly what has not happened as well as what has. The talk is still
 * accepted and still on the grid, and an organizer who reads this as a
 * withdrawal will go looking for a hole in the programme that is not there.
 */
export function attendanceDeclinedMail(opts: {
  to: string;
  title: string;
  speakerName: string;
  eventName: string;
  placement: MailPlacement | null;
}): Mail {
  return {
    to: opts.to,
    subject: `Cannot present: "${opts.title}"`,
    text: [
      `${opts.speakerName} can no longer present "${opts.title}" at ${opts.eventName}.`,
      '',
      opts.placement
        ? `It is still on the schedule: ${opts.placement.when}, ${opts.placement.room}.`
        : 'It is not on the schedule.',
      '',
      'The proposal is still accepted and has not been withdrawn. Declining is',
      'about the speaker, not the talk, so nothing has left the programme.',
      '',
      `Schedule: ${env().APP_URL}/organizer/schedule`,
    ].join('\n'),
  };
}

/**
 * The organizer's heads-up that a speaker has taken their talk off the
 * programme outright. The counterpart to `attendanceDeclinedMail` and the
 * stronger of the two: this one leaves a hole.
 *
 * Withdrawing used to send nothing, which made it the only speaker action that
 * changed the public agenda in silence. It reports the placement as something
 * that still stands, because clearing a slot is the organizer's decision and
 * nothing here makes it for them.
 */
export function submissionWithdrawnMail(opts: {
  to: string;
  title: string;
  speakerName: string;
  eventName: string;
  placement: MailPlacement | null;
}): Mail {
  return {
    to: opts.to,
    subject: `Withdrawn: "${opts.title}"`,
    text: [
      `${opts.speakerName} has withdrawn "${opts.title}" from ${opts.eventName}.`,
      '',
      opts.placement
        ? `It is scheduled for ${opts.placement.when}, ${opts.placement.room}, and still holds` +
          ' that box. Nothing clears a slot on your behalf.'
        : 'It is not on the schedule.',
      '',
      'It has already left the public agenda and the calendar feeds. Withdrawing',
      'is reversible from the submissions board if this was a mistake.',
      '',
      `Schedule: ${env().APP_URL}/organizer/schedule`,
    ].join('\n'),
  };
}
