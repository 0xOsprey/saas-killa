import type { Mail } from '@/lib/email';
import { mergeContext, type Recipient } from './recipients';
import { renderTokens } from './templates';

/**
 * The one message this feature sends, beside its action the way
 * `speakers/mail.ts` sits beside its own.
 *
 * The difference from every other template in this app is that the words are
 * not in here. The bodies live in `./templates.ts`, which the compose form also
 * imports, because an organizer typed them into a textarea and this function's
 * job is only to fill in the tokens and hand the result to `sendAndLog`. Two
 * copies of a template would mean the preview and the send could resolve
 * differently, which is exactly the bug a preview exists to rule out.
 *
 * Subject and body are both rendered. A subject like "Your run sheet for
 * {{event}}" is the normal case, and one that carries no token at all, such as
 * the literal string an organizer typed, comes back unchanged.
 */
export function announcementMail(input: {
  recipient: Recipient;
  eventName: string;
  subject: string;
  body: string;
}): Mail {
  const context = mergeContext(input.recipient, input.eventName);
  return {
    to: input.recipient.email,
    subject: renderTokens(input.subject, context),
    text: renderTokens(input.body, context),
  };
}
