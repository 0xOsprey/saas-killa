import type { Mail } from '@/lib/email';
import { env } from '@/lib/env';

/**
 * Content sent back for changes. The organizer's reason is quoted verbatim
 * rather than summarised — a speaker who cannot see what was wrong will resubmit
 * the same thing — and the link goes to the content screen, not the portal root,
 * so the fix is one click from the mail.
 */
export function contentReturnedMail(opts: {
  to: string;
  title: string;
  eventName: string;
  reason: string;
}): Mail {
  return {
    to: opts.to,
    subject: `Changes needed: content for "${opts.title}"`,
    text: [
      `An organizer has sent back the slides, recording and resources for "${opts.title}" at ${opts.eventName}.`,
      '',
      'What they asked for:',
      '',
      opts.reason,
      '',
      `Update it and resubmit for review: ${env().APP_URL}/speaker/content`,
    ].join('\n'),
  };
}
