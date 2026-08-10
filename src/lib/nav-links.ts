export type NavUser = { email: string; name: string | null; roles: string[] };

export type NavLink = { href: string; label: string };

export type NavSection = {
  title: string;
  links: NavLink[];
};

export const PUBLIC_LINKS: NavLink[] = [
  { href: '/agenda', label: 'Agenda' },
  { href: '/posters', label: 'Posters' },
  { href: '/speakers', label: 'Speakers' },
  { href: '/awards', label: 'Awards' },
];

/**
 * The organization's own people, not this event's. Split out of the event tabs
 * and rendered above them because a contact directory nested inside one event's
 * menu reads as that event's roster, which is the thing it is not: these rows
 * outlive any single conference and carry the history across all of them.
 */
export const ORGANIZATION_SECTION: NavSection = {
  title: 'Organization',
  links: [
    { href: '/organizer/contacts', label: 'Contacts' },
    { href: '/organizer/contacts/pipeline', label: 'Pipeline' },
    { href: '/organizer/contacts/import', label: 'Import' },
  ],
};

/**
 * Ordered by the shape of the job rather than alphabetically: open the call,
 * decide on what came in, build the programme, then run the event's people and
 * prizes. Settings sits last because it is the tab you visit once.
 */
export const EVENT_SECTION: NavSection = {
  title: 'This event',
  links: [
    { href: '/organizer', label: 'Overview' },
    { href: '/organizer/cfp', label: 'Call for papers' },
    { href: '/organizer/rounds', label: 'Review rounds' },
    { href: '/organizer/submissions', label: 'Submissions' },
    { href: '/organizer/abstracts', label: 'Abstracts' },
    { href: '/organizer/files', label: 'Files' },
    { href: '/organizer/evaluators', label: 'Evaluators' },
    { href: '/organizer/schedule', label: 'Schedule' },
    { href: '/organizer/rooms', label: 'Rooms & tracks' },
    { href: '/organizer/posters', label: 'Posters' },
    { href: '/organizer/speakers', label: 'Speakers' },
    { href: '/organizer/onboarding', label: 'Onboarding' },
    { href: '/organizer/awards', label: 'Awards' },
    { href: '/organizer/pages', label: 'Speaker info' },
    { href: '/organizer/email', label: 'Email log' },
    { href: '/organizer/embed', label: 'Embed' },
    { href: '/organizer/integrations', label: 'Accelevents' },
    { href: '/organizer/settings', label: 'Settings' },
  ],
};

export const SPEAKER_SECTION: NavSection = {
  title: 'Speaker portal',
  links: [
    { href: '/speaker', label: 'My submissions' },
    { href: '/speaker/pages', label: 'Speaker info' },
    { href: '/speaker/availability', label: 'Availability' },
    { href: '/speaker/profile', label: 'Profile' },
  ],
};

export const REVIEWER_SECTION: NavSection = {
  title: 'Committee',
  links: [
    { href: '/review', label: 'Review queue' },
    { href: '/review?tab=done', label: 'My reviews' },
    { href: '/awards/judge', label: 'Judge awards' },
  ],
};
