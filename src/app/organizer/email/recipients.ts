import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { slots, submissions } from '@/db/schema';
import { contactDirectory, type ContactFilters } from '@/lib/contacts';
import { env } from '@/lib/env';
import type { MergeContext } from './templates';

export type Recipient = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  company: string | null;
  /** Their accepted talk, or null when they hold none. What `{{session}}` resolves against. */
  sessionTitle: string | null;
};

/**
 * Who a compose gets sent to, resolved from the filters rather than from a list
 * of ids, matching `bulkCreateTasksAction` and `sendTaskRemindersAction`. Both
 * the count on the button and the set the send loops over come out of this one
 * call, so the number an organizer read before pressing and the number of
 * messages that leave cannot drift apart.
 *
 * It resolves them through `contactDirectory`, the same function the contact
 * directory screen renders from, because "Email these people" is a link off
 * that screen and the two have to agree about who "these people" are. The
 * composer used to take only `q` and a preset while the directory link carried
 * `company`, `title` and `tag` as well, so narrowing the directory to one tag
 * and pressing the link resolved an audience *wider* than the list the
 * organizer had just read. Sharing the query is what stops that recurring:
 * a filter added to `ContactFilters` reaches both screens or neither.
 *
 * Bots are dropped by `contactDirectory` itself. They hold a `users` row so
 * their grades attribute, but nobody is behind the address, and a welcome mail
 * to one is a bounce against a domain this app has to keep clean.
 */
export async function announcementAudience(filters: ContactFilters): Promise<Recipient[]> {
  const contacts = await contactDirectory(filters);
  const titles = await acceptedTitles(contacts.map((row) => row.id));

  return contacts.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    company: row.company,
    sessionTitle: titles.get(row.id) ?? null,
  }));
}

/**
 * One accepted talk per speaker, the scheduled one first.
 *
 * A speaker with two accepted talks has no single "your session", and the
 * choice has to be made somewhere. Earliest placement wins because a run-sheet
 * mail is about the next thing they are due on stage for; an unplaced talk
 * sorts last, since ASC puts NULLs at the end in Postgres, and ties break on
 * title so the same speaker gets the same talk on every send rather than
 * whichever row Postgres returned first that day.
 */
async function acceptedTitles(userIds: string[]): Promise<Map<string, string>> {
  const chosen = new Map<string, string>();
  if (userIds.length === 0) return chosen;

  const rows = await db
    .select({ speakerId: submissions.speakerId, title: submissions.title })
    .from(submissions)
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .where(and(inArray(submissions.speakerId, userIds), eq(submissions.status, 'accepted')))
    .orderBy(asc(slots.startsAt), asc(submissions.title));

  for (const row of rows) {
    if (!chosen.has(row.speakerId)) chosen.set(row.speakerId, row.title);
  }
  return chosen;
}

/**
 * What one recipient's tokens resolve to.
 *
 * Both fallbacks read as ordinary English inside a sentence, because that is
 * the only place they are ever seen. "Hi there" and "your session" are what the
 * hand-written templates in `speakers/mail.ts` already say when a name is
 * missing, and a body that degraded to "Hi ," would be worse than one that was
 * never personalized at all.
 */
export function mergeContext(recipient: Recipient, eventName: string): MergeContext {
  return {
    name: recipient.name ?? 'there',
    first_name: firstName(recipient.name),
    session: recipient.sessionTitle ?? 'your session',
    portal_link: `${env().APP_URL}/speaker`,
    event: eventName,
    email: recipient.email,
    // Empty rather than a stand-in, and empty rather than `billing()`'s joined
    // form: a body that says "{{title}} at {{company}}" has written the joining
    // word itself and would get a second one. Whoever types these two is
    // choosing the sentence around them, so this hands over the columns.
    title: recipient.title ?? '',
    company: recipient.company ?? '',
  };
}

/**
 * The first whitespace-separated word of a name, for a greeting.
 *
 * This app holds one `name` field on purpose, and `SURNAME_KEY` in
 * `lib/speakers.ts` carries the note about why splitting one is a guess. The
 * guess is made here anyway because "Hi Priya Raman," is not how anybody
 * addresses a colleague, and it is the safe half of that guess: taking the
 * first word is wrong for far fewer names than taking the last, and a mononym
 * comes back as itself rather than as a fragment. An organizer who disagrees
 * for a particular send has `{{name}}` sitting next to it in the legend.
 */
function firstName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first && first !== '' ? first : 'there';
}
