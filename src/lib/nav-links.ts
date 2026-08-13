import type { IconName } from './icons';

export type NavUser = {
  email: string;
  name: string | null;
  roles: string[];
  headshotUrl?: string | null;
};

export type NavLink = { href: string; label: string; icon?: IconName };

export type NavSection = {
  title: string;
  links: NavLink[];
};

export const PUBLIC_LINKS: NavLink[] = [
  { href: '/agenda', label: 'Agenda', icon: 'Calendar' },
  { href: '/posters', label: 'Posters', icon: 'Image' },
  { href: '/speakers', label: 'Speakers', icon: 'Users' },
  { href: '/awards', label: 'Awards', icon: 'Award' },
];

export const DASHBOARD_SECTION: NavSection = {
  title: 'Dashboard',
  links: [{ href: '/organizer', label: 'Overview', icon: 'LayoutDashboard' }],
};

export const PROGRAM_SECTION: NavSection = {
  title: 'Program',
  links: [
    { href: '/organizer/cfp', label: 'Call for papers', icon: 'FileText' },
    { href: '/organizer/rounds', label: 'Review rounds', icon: 'ListChecks' },
    { href: '/organizer/submissions', label: 'Submissions', icon: 'Inbox' },
    { href: '/organizer/abstracts', label: 'Abstracts', icon: 'FileText' },
    { href: '/organizer/files', label: 'Files', icon: 'Folder' },
    { href: '/organizer/schedule', label: 'Schedule', icon: 'Calendar' },
    { href: '/organizer/rooms', label: 'Rooms & tracks', icon: 'MapPin' },
    { href: '/organizer/posters', label: 'Posters', icon: 'Image' },
  ],
};

export const COLLECT_AND_REVIEW_SECTION: NavSection = {
  title: 'Collect & review',
  links: [
    { href: '/organizer/evaluators', label: 'Evaluators', icon: 'Users' },
    { href: '/organizer/email', label: 'Email log', icon: 'Mail' },
    { href: '/organizer/embed', label: 'Embed', icon: 'Code' },
  ],
};

export const PORTALS_SECTION: NavSection = {
  title: 'Portals',
  links: [
    { href: '/organizer/speakers', label: 'Speakers', icon: 'Users' },
    { href: '/organizer/onboarding', label: 'Onboarding', icon: 'CheckSquare' },
    { href: '/organizer/pages', label: 'Pages', icon: 'FileText' },
    { href: '/organizer/awards', label: 'Awards', icon: 'Award' },
  ],
};

export const CONFIGURE_SECTION: NavSection = {
  title: 'Configure',
  links: [
    { href: '/organizer/settings', label: 'Settings', icon: 'Settings' },
    { href: '/organizer/integrations', label: 'Accelevents', icon: 'Plug' },
    { href: '/organizer/switch', label: 'Role preview', icon: 'User' },
  ],
};

export const CRM_SECTION: NavSection = {
  title: 'CRM',
  links: [
    { href: '/organizer/contacts', label: 'Contacts', icon: 'Users' },
    { href: '/organizer/contacts/pipeline', label: 'Pipeline', icon: 'GitCommit' },
    { href: '/organizer/contacts/import', label: 'Import', icon: 'Upload' },
  ],
};

export const SPEAKER_PORTAL_SECTION: NavSection = {
  title: 'Speaker portal',
  links: [
    { href: '/speaker', label: 'My submissions', icon: 'FileText' },
    { href: '/speaker/content', label: 'Content', icon: 'FileCheck' },
    { href: '/speaker/pages', label: 'Speaker info', icon: 'Info' },
    { href: '/speaker/availability', label: 'Availability', icon: 'Clock' },
    { href: '/speaker/profile', label: 'Profile', icon: 'User' },
  ],
};

export const REVIEWER_SECTION: NavSection = {
  title: 'Collect & review',
  links: [
    { href: '/review', label: 'Review queue', icon: 'ListChecks' },
    { href: '/review?tab=done', label: 'My reviews', icon: 'CheckCircle' },
    { href: '/awards/judge', label: 'Judge awards', icon: 'Award' },
  ],
};

export function roleSections(roles: string[]): NavSection[] {
  if (roles.includes('organizer')) {
    return [
      DASHBOARD_SECTION,
      PROGRAM_SECTION,
      COLLECT_AND_REVIEW_SECTION,
      PORTALS_SECTION,
      CONFIGURE_SECTION,
      CRM_SECTION,
    ];
  }
  if (roles.includes('reviewer')) return [REVIEWER_SECTION];
  if (roles.includes('speaker')) return [SPEAKER_PORTAL_SECTION];
  return [];
}
