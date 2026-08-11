import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { rooms, slots, submissionRevisions, submissions, tracks, users } from '@/db/schema';
import type { ContentStatus, SubmissionFormat, SubmissionStatus } from '@/db/schema';
import { writableBy } from './abstracts';

/**
 * Content Management: the moderation gate over speaker-supplied content, the
 * field-lock list, and the append-only edit log the organizer dashboard reads.
 *
 * Everything here is server-only — it opens the database. Client components get
 * plain data as props rather than importing this module.
 */

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * CROSS-AGENT CONTRACT. The public agenda detail page and the poster gallery
 * both gate speaker-supplied content on exactly this rule:
 *
 *     contentStatus === 'approved'
 *       OR (contentStatus === 'draft' AND the field is already populated)
 *
 * The second clause is the migration, not a loophole: every seeded row is
 * 'draft', so without it the entire back catalogue of slides, recordings and
 * poster artwork would vanish from the public site the hour moderation shipped.
 *
 * 'pending' is deliberately absent from both clauses. Submitting for review
 * takes content off the public page until an organizer approves it, which is
 * what "submitted for review" has to mean if approval is to mean anything.
 */
export function contentIsPublic(
  status: ContentStatus,
  value: string | null | undefined,
): boolean {
  if (status === 'approved') return true;
  return status === 'draft' && Boolean(value && value.trim());
}

export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  draft: 'Draft',
  pending: 'Awaiting review',
  approved: 'Approved',
};

// ---------------------------------------------------------------------------
// Field locks
// ---------------------------------------------------------------------------

/**
 * The columns an organizer may freeze against speaker edits. These are the
 * schema's own property names, which is what `submissions.lockedFields` stores.
 *
 * CROSS-AGENT CONTRACT. This module writes the array; the speaker-side edit
 * actions read it and refuse the listed fields. An organizer is never blocked
 * by a lock — freezing a field stops the speaker changing it, it does not
 * freeze the field itself.
 */
export const LOCKABLE_FIELDS = [
  'title',
  'abstract',
  'keywords',
  'format',
  'audienceLevel',
  'slidesUrl',
  'recordingUrl',
  'resourcesNote',
  // `posterUrl` was read before it could be written. /speaker/posters has
  // always refused an edit while the lock is present, and both halves of the
  // organizer's lock form validate against this list, so there was no way to
  // set the lock that page was already checking for. Freezing the artwork is
  // the case the feature is most obviously for: once the boards are at the
  // printer, a replacement file is a poster nobody will ever see.
  'posterUrl',
] as const;

export type LockableField = (typeof LOCKABLE_FIELDS)[number];

/** `submission_revisions.field` is free text, so display names live here. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  abstract: 'Abstract',
  keywords: 'Keywords',
  format: 'Format',
  audienceLevel: 'Audience level',
  authors: 'Authors',
  slidesUrl: 'Slides URL',
  recordingUrl: 'Recording URL',
  resourcesNote: 'Resources',
  posterUrl: 'Poster artwork',
  contentStatus: 'Content status',
  trackId: 'Track',
  status: 'Status',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * Locks are compared on a flattened key because `audienceLevel` and
 * `audience_level` name the same column and a lock stored under one spelling
 * must still hold when read under the other. A lock that silently does not hold
 * is worse than no lock at all.
 */
function lockKey(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

export function isLocked(lockedFields: string[] | null, field: string): boolean {
  if (!lockedFields || lockedFields.length === 0) return false;
  const wanted = lockKey(field);
  return lockedFields.some((entry) => lockKey(entry) === wanted);
}

/**
 * Add or drop one field, returning the array to store. Writing back the
 * canonical spelling on every toggle is what stops a row accumulating
 * `audience_level` and `audienceLevel` as two entries meaning one lock.
 */
export function withLock(
  lockedFields: string[] | null,
  field: LockableField,
  locked: boolean,
): string[] {
  const others = (lockedFields ?? []).filter((entry) => lockKey(entry) !== lockKey(field));
  return locked ? [...others, field] : others;
}

/** Only the locks this build understands, in a stable order for display. */
export function knownLocks(lockedFields: string[] | null): LockableField[] {
  return LOCKABLE_FIELDS.filter((field) => isLocked(lockedFields, field));
}

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

/**
 * The IANA zones this runtime knows. A zone outside the list is rejected rather
 * than stored: `Intl.DateTimeFormat` throws on an unknown one, and every
 * timestamp in the app renders through it, so one bad value would take out the
 * agenda, the schedule grid and the speaker portal together.
 */
export const SUPPORTED_TIMEZONES: readonly string[] = Intl.supportedValuesOf('timeZone');

export function isSupportedTimezone(value: string): boolean {
  return SUPPORTED_TIMEZONES.includes(value);
}

// ---------------------------------------------------------------------------
// The edit log
// ---------------------------------------------------------------------------

/**
 * Text columns whose edits are logged. Title and abstract are the proposal
 * itself; the other three are the post-event content a speaker supplies. Every
 * change to one of these appends a `submission_revisions` row per field.
 */
export const REVISABLE_FIELDS = [
  'title',
  'abstract',
  'slidesUrl',
  'recordingUrl',
  'resourcesNote',
] as const;

export type RevisableField = (typeof REVISABLE_FIELDS)[number];

/** Only the fields present in the object are considered; absent means untouched. */
export type TextEdit = Partial<Record<RevisableField, string | null>>;

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

/**
 * Turn the changed fields into a drizzle `set` clause. Written out field by
 * field rather than spread from a loop because `title` and `abstract` are NOT
 * NULL and the other three are nullable, and the type system is the thing that
 * should be enforcing that difference.
 */
function updateClause(changed: RevisableField[], next: TextEdit) {
  const set: {
    title?: string;
    abstract?: string;
    slidesUrl?: string | null;
    recordingUrl?: string | null;
    resourcesNote?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  for (const field of changed) {
    const value = next[field] ?? null;
    switch (field) {
      // Blank is rejected by the caller's schema, so an empty string reaching
      // here would be a bug rather than an instruction to clear the column.
      case 'title':
        if (value) set.title = value;
        break;
      case 'abstract':
        if (value) set.abstract = value;
        break;
      case 'slidesUrl':
        set.slidesUrl = value;
        break;
      case 'recordingUrl':
        set.recordingUrl = value;
        break;
      case 'resourcesNote':
        set.resourcesNote = value;
        break;
    }
  }
  return set;
}

/**
 * Write the edit and log it in one transaction, with the row held for the
 * duration. The revision's `oldValue` is only true if nothing wrote between the
 * read and the update — an audit trail that can disagree with the row it
 * describes is not one.
 *
 * `ownerId`, when given, goes into the WHERE clause rather than a check before
 * it, so a forged submission id updates zero rows instead of someone else's.
 * The predicate is `writableBy`, matching `applyAbstractEdit` and every other
 * writer on this screen. It used to be a bare `submissions.speakerId`, one file
 * apart from its sibling, and the difference was invisible: `/speaker/content`
 * admits a co-author at `myContent`, `loadOwned` and `setContentStatus`, so the
 * co-author reached the form, pressed Save, matched zero rows and was redirected
 * to `?saved=1`.
 *
 * Returns the fields that actually changed, so a caller can say "nothing to
 * save" instead of logging a revision for a form that was submitted untouched.
 */
export async function applyTextEdit(opts: {
  submissionId: string;
  editorId: string;
  ownerId?: string;
  next: TextEdit;
}): Promise<RevisableField[]> {
  const scope = opts.ownerId
    ? and(eq(submissions.id, opts.submissionId), writableBy(opts.ownerId))
    : eq(submissions.id, opts.submissionId);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        title: submissions.title,
        abstract: submissions.abstract,
        slidesUrl: submissions.slidesUrl,
        recordingUrl: submissions.recordingUrl,
        resourcesNote: submissions.resourcesNote,
      })
      .from(submissions)
      .where(scope)
      .limit(1)
      .for('update');
    if (!current) return [];

    const changed = REVISABLE_FIELDS.filter(
      (field) => field in opts.next && !sameText(current[field], opts.next[field]),
    );
    if (changed.length === 0) return [];

    await tx.update(submissions).set(updateClause(changed, opts.next)).where(scope);

    await tx.insert(submissionRevisions).values(
      changed.map((field) => ({
        submissionId: opts.submissionId,
        editorId: opts.editorId,
        field,
        oldValue: current[field] ?? null,
        newValue: opts.next[field] ?? null,
      })),
    );

    return changed;
  });
}

/**
 * Log a change the caller has already written. Used for the non-text edits —
 * status and track — where the value is an enum or a foreign key and the update
 * is a plain one-liner, but the change still belongs in the history.
 */
export async function logRevisions(
  entries: {
    submissionId: string;
    editorId: string;
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }[],
): Promise<void> {
  const real = entries.filter((entry) => entry.oldValue !== entry.newValue);
  if (real.length === 0) return;
  await db.insert(submissionRevisions).values(real);
}

export type RevisionRow = {
  submissionId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  editorName: string | null;
  editorEmail: string;
};

const REVISION_FIELDS = {
  submissionId: submissionRevisions.submissionId,
  field: submissionRevisions.field,
  oldValue: submissionRevisions.oldValue,
  newValue: submissionRevisions.newValue,
  createdAt: submissionRevisions.createdAt,
  editorName: users.name,
  editorEmail: users.email,
} as const;

/**
 * The single most recent revision of every submission, in one query.
 *
 * `distinct on` is what keeps this exact: one row per submission whatever the
 * log holds, so the "last edited by" line on a dashboard row is right for a
 * submission edited once in March and for one edited forty times this morning.
 *
 * `ids` narrows it to the rows a caller is about to render. Omitting it reads
 * the whole log, which is only ever what a caller rendering the whole log wants.
 */
export async function lastEditBySubmission(ids?: string[]): Promise<Map<string, RevisionRow>> {
  if (ids && ids.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([submissionRevisions.submissionId], REVISION_FIELDS)
    .from(submissionRevisions)
    .innerJoin(users, eq(users.id, submissionRevisions.editorId))
    .where(ids ? inArray(submissionRevisions.submissionId, ids) : undefined)
    .orderBy(asc(submissionRevisions.submissionId), desc(submissionRevisions.createdAt));

  return new Map(rows.map((row) => [row.submissionId, row]));
}

/**
 * Recent revisions grouped by submission, for the expandable history on each
 * row. Bounded by a flat cap on the newest rows rather than per submission,
 * which is the compromise a plain query can make: on a log longer than `limit`
 * the quietest submissions lose their panel entries, but never their last-edit
 * line, because that comes from `lastEditBySubmission` instead.
 *
 * Passing `ids` is what keeps that compromise cheap. Scoped to the 25 rows on
 * one page of the board, the cap is reached only if those same 25 carry more
 * than `limit` revisions between them, rather than by any busy submission
 * anywhere in the event.
 */
export async function recentRevisions(
  ids?: string[],
  limit = 500,
  perSubmission = 5,
): Promise<Map<string, RevisionRow[]>> {
  if (ids && ids.length === 0) return new Map();

  const rows = await db
    .select(REVISION_FIELDS)
    .from(submissionRevisions)
    .innerJoin(users, eq(users.id, submissionRevisions.editorId))
    .where(ids ? inArray(submissionRevisions.submissionId, ids) : undefined)
    .orderBy(desc(submissionRevisions.createdAt))
    .limit(limit);

  const byId = new Map<string, RevisionRow[]>();
  for (const row of rows) {
    const list = byId.get(row.submissionId) ?? [];
    if (list.length >= perSubmission) continue;
    list.push(row);
    byId.set(row.submissionId, list);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Dashboard reads
// ---------------------------------------------------------------------------

export type ContentRow = {
  id: string;
  contentStatus: ContentStatus;
  lockedFields: string[];
  trackId: string | null;
  slidesUrl: string | null;
  recordingUrl: string | null;
  resourcesNote: string | null;
  posterUrl: string | null;
  revisionCount: number;
};

/**
 * The content-management columns for every submission, keyed by id. Kept
 * separate from `organizerSubmissions()` so the decision dashboard's existing
 * query — and its sort by average grade — is untouched by this feature.
 *
 * The revision count is a correlated subquery rather than a join: joining
 * `submission_revisions` would multiply the rows and quietly corrupt any count
 * computed alongside it.
 *
 * It is built with the query builder rather than written into the `sql` template
 * by hand, because a column interpolated into a template renders *unqualified*.
 * `where ${submissionRevisions.submissionId} = ${submissions.id}` came out as
 * `where "submission_id" = "id"`, and inside the subquery `"id"` binds to
 * `submission_revisions.id`, not to the outer submission. The predicate was a
 * row comparing itself, so the count was 0 for every submission ever filed and
 * the board said "0 change(s) logged" beside a last-edit line it had just
 * rendered from the same table. The builder emits both sides qualified.
 */
export async function contentRowsById(ids?: string[]): Promise<Map<string, ContentRow>> {
  if (ids && ids.length === 0) return new Map();

  const revisionCount = db
    .select({ n: sql<number>`count(*)::int` })
    .from(submissionRevisions)
    .where(eq(submissionRevisions.submissionId, submissions.id));

  const rows = await db
    .select({
      id: submissions.id,
      contentStatus: submissions.contentStatus,
      lockedFields: submissions.lockedFields,
      trackId: submissions.trackId,
      slidesUrl: submissions.slidesUrl,
      recordingUrl: submissions.recordingUrl,
      resourcesNote: submissions.resourcesNote,
      posterUrl: submissions.posterUrl,
      revisionCount: sql<number>`(${revisionCount})`,
    })
    .from(submissions)
    .where(ids ? inArray(submissions.id, ids) : undefined);

  return new Map(rows.map((row) => [row.id, row]));
}

export type ContentRecipient = {
  submissionId: string;
  title: string;
  speakerId: string;
  speakerEmail: string;
};

/** Who to write to when content is sent back, and about what. */
export async function contentRecipient(submissionId: string): Promise<ContentRecipient | null> {
  const [row] = await db
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      speakerId: submissions.speakerId,
      speakerEmail: users.email,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return row ?? null;
}

/** The current status of a set of submissions, for logging what a bulk edit changed. */
export async function currentStatuses(
  ids: string[],
): Promise<Map<string, { status: SubmissionStatus; trackId: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: submissions.id, status: submissions.status, trackId: submissions.trackId })
    .from(submissions)
    .where(inArray(submissions.id, ids));
  return new Map(rows.map((row) => [row.id, { status: row.status, trackId: row.trackId }]));
}

// ---------------------------------------------------------------------------
// Speaker reads
// ---------------------------------------------------------------------------

export type SpeakerContentRow = {
  id: string;
  title: string;
  status: SubmissionStatus;
  format: SubmissionFormat;
  contentStatus: ContentStatus;
  lockedFields: string[];
  /** What an organizer said when they sent it back. Null unless it is a returned draft. */
  contentReturnReason: string | null;
  slidesUrl: string | null;
  recordingUrl: string | null;
  resourcesNote: string | null;
  posterUrl: string | null;
  trackName: string | null;
  slotStartsAt: Date | null;
  roomName: string | null;
};

/**
 * One speaker's accepted submissions and the content attached to each.
 * Restricted to accepted work: slides and a recording for a proposal that was
 * not on the programme have nowhere to appear, and offering the form anyway
 * would invite an organizer to moderate content that can never publish.
 */
export async function myContent(speakerId: string): Promise<SpeakerContentRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      contentStatus: submissions.contentStatus,
      lockedFields: submissions.lockedFields,
      contentReturnReason: submissions.contentReturnReason,
      slidesUrl: submissions.slidesUrl,
      recordingUrl: submissions.recordingUrl,
      resourcesNote: submissions.resourcesNote,
      posterUrl: submissions.posterUrl,
      trackName: tracks.name,
      slotStartsAt: slots.startsAt,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(and(writableBy(speakerId), eq(submissions.status, 'accepted')))
    .orderBy(asc(submissions.title));
}
