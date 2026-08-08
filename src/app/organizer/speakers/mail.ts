import type { Mail } from '@/lib/email';
import { env } from '@/lib/env';
import { dayLabel } from '@/lib/format';

/**
 * The two templates this feature sends. They live here rather than in
 * `src/lib/email.ts` so the transport stays one file with one job; the bodies
 * are the organizer's copy and change on their own schedule.
 *
 * Both fill themselves in from the row the caller already has, which is the
 * whole point of a template here: an organizer chasing forty headshots should
 * never be retyping a name and a date.
 */

export function taskReminderMail(input: {
  to: string;
  speakerName: string | null;
  taskLabel: string;
  dueAt: Date | null;
  eventName: string;
  timezone: string;
}): Mail {
  const deadline = input.dueAt
    ? `It is due on ${dayLabel(input.dueAt, input.timezone)}.`
    : 'There is no deadline on it yet, but we would like it soon.';

  return {
    to: input.to,
    subject: `Still outstanding for ${input.eventName}: ${input.taskLabel}`,
    text: [
      `Hi ${input.speakerName ?? 'there'},`,
      '',
      `One thing is still outstanding for ${input.eventName}: ${input.taskLabel}.`,
      deadline,
      '',
      `You can take care of it here: ${env().APP_URL}/speaker`,
      '',
      'Thank you — the programme team.',
    ].join('\n'),
  };
}

export function speakerInviteMail(input: {
  to: string;
  speakerName: string | null;
  title: string;
  token: string;
  eventName: string;
}): Mail {
  const url = `${env().APP_URL}/auth/verify?token=${encodeURIComponent(input.token)}`;
  return {
    to: input.to,
    subject: `We have you down to speak at ${input.eventName}`,
    text: [
      `Hi ${input.speakerName ?? 'there'},`,
      '',
      `We have put "${input.title}" into the programme for ${input.eventName} on your`,
      'behalf. Everything about it is yours to edit — open the link below and it is',
      'in your account:',
      '',
      url,
      '',
      'This link works once and expires in 15 minutes. Ask for another at',
      `${env().APP_URL}/login if it lapses.`,
      '',
      'Thank you — the programme team.',
    ].join('\n'),
  };
}
