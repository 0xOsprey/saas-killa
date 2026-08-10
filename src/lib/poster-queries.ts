import { type SQL, and, asc, count, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { bookmarks, submissionAuthors, submissions, tracks, users } from '@/db/schema';
import type { ContentStatus, SubmissionStatus } from '@/db/schema';
import { writableBy } from './abstracts';

/**
 * Every read the poster hall makes. Kept out of `src/lib/poster.ts` so that
 * module stays pure and testable without a database; kept out of
 * `src/lib/queries.ts` because that file is shared with eight other surfaces.
 */

export const POSTERS_PER_PAGE = 12;

export type GalleryFilters = {
  q: string;
  trackId: string | null;
  mineOnly: boolean;
  page: number;
};

export type PosterCard = {
  id: string;
  title: string;
  abstract: string;
  posterUrl: string | null;
  boardNumber: string | null;
  keywords: string[];
  speakerName: string | null;
  /** The presenter's byline, in the two halves `billing` joins. */
  speakerTitle: string | null;
  speakerCompany: string | null;
  trackName: string | null;
  trackColour: string | null;
  bookmarked: boolean;
};

/**
 * What the public hall is allowed to show.
 *
 * Cross-agent contract with the content-moderation work on
 * `submissions.contentStatus`: 'approved' is public, and a 'draft' row that
 * already carries artwork stays public — every seeded poster is 'draft', and
 * hiding them would empty the hall the moment moderation shipped. 'pending',
 * meaning submitted for moderation and not yet cleared, is the one state that
 * hides a poster from this page. An organizer sees a hidden poster on
 * /organizer/posters, which does not use this predicate.
 */
function visibilityConditions(): SQL[] {
  const conditions: SQL[] = [
    eq(submissions.status, 'accepted'),
    eq(submissions.format, 'poster'),
    isNotNull(submissions.posterUrl),
  ];
  const moderation = or(
    eq(submissions.contentStatus, 'approved'),
    and(eq(submissions.contentStatus, 'draft'), isNotNull(submissions.posterUrl)),
  );
  if (moderation) conditions.push(moderation);
  return conditions;
}

/**
 * An EXISTS rather than a join: the gallery needs the flag and the "my
 * bookmarks" filter from the same expression, and a join would have to be
 * un-joined again for the count query.
 */
function bookmarkedBy(userId: string): SQL {
  return sql`exists (
    select 1 from ${bookmarks} b
    where b.submission_id = ${submissions.id} and b.user_id = ${userId}
  )`;
}

function filterConditions(filters: GalleryFilters, userId: string | null): SQL[] {
  const conditions = visibilityConditions();

  const q = filters.q.trim();
  if (q) {
    const pattern = `%${q}%`;
    const freeText = or(
      ilike(submissions.title, pattern),
      ilike(submissions.abstract, pattern),
      // keywords is text[]; flattening it to a string is what lets one search
      // box cover all three fields in a single pass.
      sql`array_to_string(${submissions.keywords}, ' ') ilike ${pattern}`,
    );
    if (freeText) conditions.push(freeText);
  }

  if (filters.trackId) conditions.push(eq(submissions.trackId, filters.trackId));
  if (filters.mineOnly && userId) conditions.push(bookmarkedBy(userId));

  return conditions;
}

/**
 * Board numbers are text, so a plain sort files board 10 before board 2.
 * Ordering on the digits keeps the gallery in the order an attendee walks the
 * hall; posters with no board yet fall to the end, alphabetically.
 */
const BOARD_ORDER = sql`nullif(regexp_replace(coalesce(${submissions.boardNumber}, ''), '\\D', '', 'g'), '')::int asc nulls last`;

export async function posterGallery(
  filters: GalleryFilters,
  userId: string | null,
): Promise<{ rows: PosterCard[]; total: number }> {
  const where = and(...filterConditions(filters, userId));
  const bookmarked = userId ? bookmarkedBy(userId) : sql`false`;

  const [totals] = await db
    .select({ total: count() })
    .from(submissions)
    .where(where);

  const rows = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      posterUrl: submissions.posterUrl,
      boardNumber: submissions.boardNumber,
      keywords: submissions.keywords,
      speakerName: users.name,
      speakerTitle: users.title,
      speakerCompany: users.company,
      trackName: tracks.name,
      trackColour: tracks.colour,
      bookmarked: sql<boolean>`${bookmarked}`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(where)
    .orderBy(BOARD_ORDER, asc(submissions.title))
    .limit(POSTERS_PER_PAGE)
    .offset((filters.page - 1) * POSTERS_PER_PAGE);

  return { rows, total: totals?.total ?? 0 };
}

export type PosterAuthor = {
  name: string | null;
  affiliation: string | null;
  isPresenter: boolean;
};

export type PosterDetail = PosterCard & {
  abstract: string;
  authors: PosterAuthor[];
};

/**
 * One poster at full size. `includeHidden` is the organizer's proof-reading
 * path: it drops the public predicate so an embargoed or unmoderated poster is
 * still reachable by URL for the person who has to check it.
 */
export async function posterById(
  id: string,
  opts: { userId: string | null; includeHidden: boolean },
): Promise<PosterDetail | null> {
  const conditions = opts.includeHidden
    ? [eq(submissions.format, 'poster'), isNotNull(submissions.posterUrl)]
    : visibilityConditions();
  const bookmarked = opts.userId ? bookmarkedBy(opts.userId) : sql`false`;

  const [row] = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      posterUrl: submissions.posterUrl,
      boardNumber: submissions.boardNumber,
      keywords: submissions.keywords,
      speakerName: users.name,
      speakerTitle: users.title,
      speakerCompany: users.company,
      trackName: tracks.name,
      trackColour: tracks.colour,
      bookmarked: sql<boolean>`${bookmarked}`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(and(...conditions, eq(submissions.id, id)))
    .limit(1);

  if (!row) return null;

  const credited = await db
    .select({
      name: users.name,
      affiliation: submissionAuthors.affiliation,
      isPresenter: submissionAuthors.isPresenter,
    })
    .from(submissionAuthors)
    .innerJoin(users, eq(users.id, submissionAuthors.userId))
    .where(eq(submissionAuthors.submissionId, id))
    .orderBy(asc(submissionAuthors.position));

  // The filer is author 0 by convention, but a submission filed through the CFP
  // has no author rows at all, so the owning speaker is the byline in that case
  // rather than an empty credit line.
  const authors: PosterAuthor[] = credited.length
    ? credited
    : [{ name: row.speakerName, affiliation: null, isPresenter: true }];

  return { ...row, authors };
}

export type OrganizerPosterRow = {
  id: string;
  title: string;
  status: SubmissionStatus;
  contentStatus: ContentStatus;
  posterUrl: string | null;
  boardNumber: string | null;
  speakerName: string | null;
  trackName: string | null;
  trackColour: string | null;
  bookmarkCount: number;
};

/**
 * Every accepted poster, moderated or not, in the order the hall is numbered:
 * track first, then title. Bookmarks are counted here rather than in a second
 * query because the same row carries both the number to edit and the only
 * engagement figure this app can honestly report — there is no view counter and
 * no table to put one in.
 */
export async function organizerPosters(): Promise<OrganizerPosterRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      contentStatus: submissions.contentStatus,
      posterUrl: submissions.posterUrl,
      boardNumber: submissions.boardNumber,
      speakerName: users.name,
      trackName: tracks.name,
      trackColour: tracks.colour,
      bookmarkCount: sql<number>`count(${bookmarks.userId})::int`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(bookmarks, eq(bookmarks.submissionId, submissions.id))
    .where(and(eq(submissions.status, 'accepted'), eq(submissions.format, 'poster')))
    .groupBy(submissions.id, users.name, tracks.id, tracks.name, tracks.colour)
    .orderBy(sql`${tracks.name} asc nulls last`, asc(submissions.title));
}

/** The numbering order itself, isolated so the bulk action and the page agree. */
export async function acceptedPosterIdsInTrackOrder(): Promise<string[]> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(and(eq(submissions.status, 'accepted'), eq(submissions.format, 'poster')))
    .orderBy(sql`${tracks.name} asc nulls last`, asc(submissions.title));
  return rows.map((row) => row.id);
}

export type SpeakerPosterRow = {
  id: string;
  title: string;
  status: SubmissionStatus;
  contentStatus: ContentStatus;
  posterUrl: string | null;
  boardNumber: string | null;
  trackName: string | null;
  lockedFields: string[];
};

/**
 * The posters this person may act on, at any status: their own, plus any a filer
 * granted them `can_edit` on.
 *
 * `writableBy`, not an equality on `speakerId`. `/speaker` builds its poster
 * link out of `mySubmissions`, which is already `writableBy`, so a co-author on
 * a poster was offered the link and then told on arrival that they had no
 * posters at all. Scoped in the WHERE either way, so nothing widens beyond the
 * predicate the rest of the app writes with.
 */
export async function myPosters(userId: string): Promise<SpeakerPosterRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      contentStatus: submissions.contentStatus,
      posterUrl: submissions.posterUrl,
      boardNumber: submissions.boardNumber,
      trackName: tracks.name,
      lockedFields: submissions.lockedFields,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(and(writableBy(userId), eq(submissions.format, 'poster')))
    .orderBy(asc(submissions.title));
}
