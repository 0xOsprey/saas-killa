/**
 * The merge-field vocabulary and the pre-built bodies that use it.
 *
 * Deliberately free of any `@/lib/env` or `@/db` import, because the compose
 * form is a client component and needs the same template list the server
 * renders with. A module that reached for the environment here would either
 * leak configuration into the browser bundle or force the form to hold its own
 * second copy of the bodies, and two copies of a template is how the token a
 * preview resolves stops matching the token a send resolves.
 */

/**
 * Double braces rather than `%name%` or `{name}`.
 *
 * A single brace collides with the JSON and code snippets organizers paste into
 * a body, and a bare `%` collides with nothing but reads as a printf escape to
 * anyone who has met one. Double braces are what mail-merge tools already use,
 * so an organizer who has sent a mailshot before guesses right first time.
 */
export const TOKENS = [
  'name',
  'first_name',
  'session',
  'portal_link',
  'event',
  'email',
  'title',
  'company',
] as const;

export type TokenName = (typeof TOKENS)[number];

/**
 * What each token stands for, printed beside the body so the syntax is
 * documented where it is typed.
 *
 * `title` and `company` are the two that can come back empty, and they say so
 * rather than substituting a stand-in. Inventing a job title for somebody who
 * never gave one is worse than a gap, and a gap is exactly what the preview
 * exists to show before a send rather than after one.
 */
export const TOKEN_HELP: Record<TokenName, string> = {
  name: 'the speaker\'s name in full, or "there" if we do not hold one',
  first_name: 'the first word of their name, for a greeting',
  session: 'the title of their accepted talk, or "your session" if they have none yet',
  portal_link: 'the address of their own speaker portal',
  event: 'the name of this conference',
  email: 'the address this copy is going to',
  title: 'their job title, blank if we do not hold one',
  company: 'where they work, blank if we do not hold it',
};

export type MergeContext = Record<TokenName, string>;

/**
 * Both spellings, `{{name}}` and `{{ name }}`, because an organizer copying a
 * token out of the legend and one typing it from memory should not get
 * different results, and a stray space is invisible in a textarea.
 */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

function isToken(value: string): value is TokenName {
  return (TOKENS as readonly string[]).includes(value);
}

/**
 * Every `{{...}}` in the text that this app cannot fill in, deduplicated.
 *
 * The send path refuses on a non-empty result rather than substituting a blank.
 * A typo like `{{firstname}}` is otherwise invisible until it has gone out to
 * the whole roster with the braces still in it, and there is no un-send: the
 * only moment this is cheap to catch is before the loop starts.
 */
export function unknownTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1] ?? '';
    if (!isToken(name)) found.add(name);
  }
  return [...found];
}

/**
 * Fill in the known tokens and leave anything else exactly as typed.
 *
 * Leaving unknowns alone is what lets the preview show an organizer their own
 * typo as a typo. Blanking them would render a body that looks finished and is
 * missing a sentence.
 */
export function renderTokens(text: string, context: MergeContext): string {
  return text.replace(TOKEN_PATTERN, (whole, rawName: string) =>
    isToken(rawName) ? context[rawName] : whole,
  );
}

export type AnnouncementTemplate = {
  id: string;
  label: string;
  subject: string;
  body: string;
};

/**
 * The saved bodies. Prose rather than placeholders: the three announcements a
 * conference actually sends between acceptance and the doors opening are a
 * welcome, a run sheet and a chase, and an organizer who has to write those
 * from scratch writes them at midnight and forgets the portal link.
 *
 * Every one of them carries `{{first_name}}`, `{{session}}` and
 * `{{portal_link}}`, so the personalization is visible in the textarea the
 * moment the screen loads rather than being something a reader has to go
 * looking for.
 *
 * The blank one is last and deliberate. Its counterpart is an organizer who
 * wants none of this and would otherwise have to select-all and delete a
 * template to type their own subject.
 */
export const ANNOUNCEMENT_TEMPLATES: AnnouncementTemplate[] = [
  {
    id: 'welcome',
    label: 'Welcome to the programme',
    subject: 'Welcome to {{event}} speakers',
    body: [
      'Hi {{first_name}},',
      '',
      'Welcome to {{event}}. We are delighted to have you and "{{session}}" on the',
      'programme this year.',
      '',
      'Everything we need from you lives in your speaker portal: your bio, your',
      'headshot, your slides, and anything else we have asked for. It is here:',
      '',
      '{{portal_link}}',
      '',
      'If any of that is wrong, reply to this email and we will put it right.',
      '',
      'Thank you,',
      'the programme team',
    ].join('\n'),
  },
  {
    id: 'logistics',
    label: 'Week-of logistics',
    subject: 'Your run sheet for {{event}}',
    body: [
      'Hi {{first_name}},',
      '',
      '{{event}} is nearly here, so a few practical things before you travel.',
      '',
      'You are down for "{{session}}". Your time and room are on the public agenda,',
      'and your portal carries the same details alongside anything still outstanding:',
      '',
      '{{portal_link}}',
      '',
      'Please come to your room ten minutes before your start time so we can fit',
      'your microphone and test your laptop. Bring your own adapter if your machine',
      'is not HDMI.',
      '',
      'Thank you,',
      'the programme team',
    ].join('\n'),
  },
  {
    id: 'deadline',
    label: 'Chase slides and headshots',
    subject: 'Still needed for {{event}}',
    body: [
      'Hi {{first_name}},',
      '',
      'We are assembling the programme for {{event}} and are still short one or two',
      'things for "{{session}}".',
      '',
      'Your portal lists exactly what is outstanding and takes the upload directly:',
      '',
      '{{portal_link}}',
      '',
      'If you have already sent it to one of us by email, ignore this and we will',
      'match it up at our end.',
      '',
      'Thank you,',
      'the programme team',
    ].join('\n'),
  },
  {
    id: 'blank',
    label: 'Start from nothing',
    subject: '',
    body: '',
  },
];
