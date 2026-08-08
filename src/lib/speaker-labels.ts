import type { SpeakerTaskKind } from '@/db/schema';

/**
 * Split out of `speakers.ts` rather than living beside the queries: that module
 * imports the database client, and pulling it into a client component would
 * drag the Postgres driver into the browser bundle. This file imports a type
 * and nothing else, so both sides can use it.
 */
export const TASK_KIND_LABELS: Record<SpeakerTaskKind, string> = {
  headshot: 'Headshot',
  bio: 'Bio',
  slides: 'Slides',
  poster: 'Poster artwork',
  confirm: 'Confirm attendance',
  other: 'Other',
};
