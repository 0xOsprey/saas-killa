import { and, asc, desc, eq, exists, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import {
  reviews,
  submissionAuthors,
  submissionRevisions,
  submissions,
  tracks,
  users,
} from '@/db/schema';
import type { AudienceLevel, SubmissionFormat, SubmissionStatus } from '@/db/schema';
import { upsertUserByEmail } from '@/lib/auth';

/**
 * The fields either side may edit after filing. Title, abstract and keywords are
 * the prose the CFP form collects; format and audience level are here because a
 * proposal that picked the wrong dropdown would otherwise have to be withdrawn
 * and refiled, losing its grades.
 */
export const EDITABLE_FIELDS = [
  'title',
  'abstract',
  'keywords',
  'format',
  'audienceLevel',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type AbstractEdit = {
  title: string;
  abstract: string;
  keywords: string[];
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
};

/**
 * What every editor action on this feature returns. A refused field is a
 * `notice`, not an `error`: the rest of the edit did save, and telling the
 * speaker "nothing happened" would be false.
 */
export type AbstractActionState = { error?: string; notice?: string };

/** `submission_revisions.field` is free text, so the display names live here. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  abstract: 'Abstract',
  keywords: 'Keywords',
  format: 'Format',
  audienceLevel: 'Audience level',
  authors: 'Authors',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * Locks are written by the organizer-side freeze control as column names, and
 * `audienceLevel` and `audience_level` name the same column. Comparing on a
 * flattened key means a lock never misses on spelling — a lock that silently
 * does not hold is worse than no lock at all.
 */
function lockKey(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

export function isFieldLocked(lockedFields: string[] | null, field: EditableField): boolean {
  if (!lockedFields || lockedFields.length === 0) return false;
  const wanted = lockKey(field);
  return lockedFields.some((entry) => lockKey(entry) === wanted);
}

/** Comma-separated free text in, de-duplicated keyword list out. */
export function parseKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const keyword = part.trim().replace(/\s+/g, ' ');
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

function asText(value: string | string[]): string {
  return Array.isArray(value) ? value.join(', ') : value;
}

export function changedFields(current: AbstractEdit, next: AbstractEdit): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => asText(current[field]) !== asText(next[field]));
}

export type EditableSubmission = {
  id: string;
  speakerId: string;
  title: string;
  abstract: string;
  keywords: string[];
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  status: SubmissionStatus;
  lockedFields: string[];
  trackName: string | null;
  speakerName: string | null;
  speakerEmail: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function submissionForEdit(id: string): Promise<EditableSubmission | null> {
  const [row] = await db
    .select({
      id: submissions.id,
      speakerId: submissions.speakerId,
      title: submissions.title,
      abstract: submissions.abstract,
      keywords: submissions.keywords,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      status: submissions.status,
      lockedFields: submissions.lockedFields,
      trackName: tracks.name,
      speakerName: users.name,
      speakerEmail: users.email,
      createdAt: submissions.createdAt,
      updatedAt: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(eq(submissions.id, id))
    .limit(1);
  return row ?? null;
}

export function currentValues(row: EditableSubmission): AbstractEdit {
  return {
    title: row.title,
    abstract: row.abstract,
    keywords: row.keywords,
    format: row.format,
    audienceLevel: row.audienceLevel,
  };
}

/**
 * Write the edit and log it in the same transaction. The row is locked for the
 * duration because the revision's `oldValue` is only true if nothing wrote
 * between the read and the update — an audit trail that can disagree with the
 * row it describes is not one.
 *
 * `ownerId`, when given, goes into the WHERE clause rather than a check before
 * it, so a forged submission id updates zero rows instead of someone else's.
 */
/**
 * Who may write to a submission: the speaker who filed it, or a credited
 * co-author the filer granted access to.
 *
 * One predicate, correlated on `submissions.id`, so it drops into any query
 * already selecting from `submissions`. Every writer below composes this into
 * its WHERE clause rather than checking afterwards, which is what makes a forged
 * submission id update zero rows instead of somebody else's talk. The filer's
 * own access does not read `can_edit`, so nobody can lock themselves out of
 * their own proposal.
 */
export function writableBy(userId: string): SQL {
  return or(
    eq(submissions.speakerId, userId),
    exists(
      db
        .select({ one: sql`1` })
        .from(submissionAuthors)
        .where(
          and(
            eq(submissionAuthors.submissionId, submissions.id),
            eq(submissionAuthors.userId, userId),
            eq(submissionAuthors.canEdit, true),
          ),
        ),
    ),
  )!;
}

/** Whether this person may act on this submission, for a page deciding what to render. */
export async function canWriteSubmission(submissionId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.id, submissionId), writableBy(userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * The name of the unique index that keeps one title per speaker, and the one
 * message every caller shows when it fires.
 *
 * Both are here rather than in each action so the wording cannot drift: a
 * speaker who trips it from the CFP form and an organizer who trips it while
 * renaming an abstract are being told about the same rule.
 */
export const DUPLICATE_TITLE_INDEX = 'submissions_speaker_title_idx';

export function duplicateTitleMessage(title: string): string {
  return `“${title}” is already filed under this speaker. Open it from the list rather than filing it twice.`;
}

/** True when a Postgres unique violation on that index caused this error. */
export function isDuplicateTitleError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (candidate.code !== '23505') return false;
  return (
    candidate.constraint_name === DUPLICATE_TITLE_INDEX ||
    (typeof candidate.message === 'string' && candidate.message.includes(DUPLICATE_TITLE_INDEX))
  );
}

/**
 * Does this speaker already have a proposal under this title?
 *
 * `exceptId` is the row being edited, which must not count as its own
 * duplicate. Withdrawn proposals count: the title is still theirs, and an
 * organizer restores a withdrawn talk with one press, so allowing a second copy
 * would leave two live rows behind that press.
 *
 * This is the readable half of the guard. The unique index on the same pair is
 * the half that survives two tabs, and callers catch it with
 * `isDuplicateTitleError`.
 */
export async function titleAlreadyFiled(
  speakerId: string,
  title: string,
  exceptId?: string,
): Promise<boolean> {
  const conditions = [
    eq(submissions.speakerId, speakerId),
    sql`lower(${submissions.title}) = lower(${title})`,
  ];
  if (exceptId) conditions.push(ne(submissions.id, exceptId));

  const [hit] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(...conditions))
    .limit(1);
  return hit !== undefined;
}

/**
 * Thrown when an edit would rename a proposal onto a title its speaker already
 * uses. Both callers of `applyAbstractEdit` return a form state rather than a
 * page, so this is caught and turned into that state; letting the unique index
 * surface would give an organizer a 500 for a typo.
 */
export class DuplicateTitleError extends Error {
  constructor(readonly title: string) {
    super(duplicateTitleMessage(title));
    this.name = 'DuplicateTitleError';
  }
}

export async function applyAbstractEdit(opts: {
  submissionId: string;
  editorId: string;
  ownerId?: string;
  next: AbstractEdit;
}): Promise<EditableField[]> {
  const scope = opts.ownerId
    ? and(eq(submissions.id, opts.submissionId), writableBy(opts.ownerId))
    : eq(submissions.id, opts.submissionId);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        speakerId: submissions.speakerId,
        title: submissions.title,
        abstract: submissions.abstract,
        keywords: submissions.keywords,
        format: submissions.format,
        audienceLevel: submissions.audienceLevel,
      })
      .from(submissions)
      .where(scope)
      .limit(1)
      .for('update');
    if (!current) return [];

    const { speakerId, ...editable } = current;
    const changed = changedFields(editable, opts.next);
    if (changed.length === 0) return [];

    // Renaming onto a title this speaker already has is the same collision the
    // CFP form refuses, reached from the other direction.
    if (changed.includes('title') && (await titleAlreadyFiled(speakerId, opts.next.title, opts.submissionId))) {
      throw new DuplicateTitleError(opts.next.title);
    }

    await tx
      .update(submissions)
      .set({ ...opts.next, updatedAt: new Date() })
      .where(scope);

    await tx.insert(submissionRevisions).values(
      changed.map((field) => ({
        submissionId: opts.submissionId,
        editorId: opts.editorId,
        field,
        oldValue: asText(editable[field]),
        newValue: asText(opts.next[field]),
      })),
    );

    return changed;
  });
}

export type AuthorRow = {
  userId: string;
  name: string | null;
  email: string;
  position: number;
  affiliation: string | null;
  isPresenter: boolean;
  canEdit: boolean;
};

async function authorRows(submissionIds: string[]): Promise<(AuthorRow & { submissionId: string })[]> {
  if (submissionIds.length === 0) return [];
  return db
    .select({
      submissionId: submissionAuthors.submissionId,
      userId: submissionAuthors.userId,
      name: users.name,
      email: users.email,
      position: submissionAuthors.position,
      affiliation: submissionAuthors.affiliation,
      isPresenter: submissionAuthors.isPresenter,
      canEdit: submissionAuthors.canEdit,
    })
    .from(submissionAuthors)
    .innerJoin(users, eq(users.id, submissionAuthors.userId))
    .where(inArray(submissionAuthors.submissionId, submissionIds))
    .orderBy(asc(submissionAuthors.position), asc(users.email));
}

export async function authorsFor(submissionId: string): Promise<AuthorRow[]> {
  return authorRows([submissionId]);
}

/** One query for a page full of submissions, so the book is not N+1. */
export async function authorsForMany(submissionIds: string[]): Promise<Map<string, AuthorRow[]>> {
  const rows = await authorRows(submissionIds);
  const byId = new Map<string, AuthorRow[]>();
  for (const row of rows) {
    const list = byId.get(row.submissionId) ?? [];
    list.push(row);
    byId.set(row.submissionId, list);
  }
  return byId;
}

/**
 * Submissions filed before co-authors existed carry no `submission_authors`
 * rows at all, so an empty list means "one author, the person who filed it",
 * never "nobody". Every reader of the author list goes through this.
 */
export function withSpeakerFallback(
  rows: AuthorRow[],
  speaker: { userId: string; name: string | null; email: string },
): AuthorRow[] {
  if (rows.length > 0) return rows;
  return [
    {
      userId: speaker.userId,
      name: speaker.name,
      email: speaker.email,
      position: 0,
      affiliation: null,
      isPresenter: true,
      // The filer always may. The column is about everyone else.
      canEdit: true,
    },
  ];
}

export function authorDisplayName(author: Pick<AuthorRow, 'name' | 'email'>): string {
  return author.name ?? author.email;
}

/** The credited author list for one submission, fallback applied. */
export async function authorsForDisplay(submissionId: string): Promise<AuthorRow[]> {
  const [rows, speaker] = await Promise.all([
    authorsFor(submissionId),
    db
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(submissions)
      .innerJoin(users, eq(users.id, submissions.speakerId))
      .where(eq(submissions.id, submissionId))
      .limit(1),
  ]);
  const filer = speaker[0];
  if (!filer) return rows;
  return withSpeakerFallback(rows, filer);
}

function authorSummary(rows: AuthorRow[]): string {
  return rows.map((row) => row.email).join(', ');
}

async function logAuthorChange(
  submissionId: string,
  editorId: string,
  before: string,
  after: string,
): Promise<void> {
  if (before === after) return;
  await db.insert(submissionRevisions).values({
    submissionId,
    editorId,
    field: 'authors',
    oldValue: before,
    newValue: after,
  });
}

/**
 * The filing speaker only gets a `submission_authors` row when someone first
 * touches the author list. Materialising them at position 0 here is what keeps
 * "the filer is author 0" true for rows that predate the table.
 */
async function ensureFilerIsAuthorZero(submissionId: string, speakerId: string): Promise<void> {
  await db
    .insert(submissionAuthors)
    .values({ submissionId, userId: speakerId, position: 0, canEdit: true })
    .onConflictDoNothing();
}

/**
 * Resolve a submission's owner, with `ownerId` in the WHERE clause rather than
 * compared afterwards: a speaker who forges an id gets no row back, which is the
 * same answer as a submission that does not exist.
 */
async function ownedSubmission(
  submissionId: string,
  ownerId?: string,
): Promise<{ id: string; speakerId: string } | null> {
  const [row] = await db
    .select({ id: submissions.id, speakerId: submissions.speakerId })
    .from(submissions)
    .where(
      ownerId
        ? and(eq(submissions.id, submissionId), writableBy(ownerId))
        : eq(submissions.id, submissionId),
    )
    .limit(1);
  return row ?? null;
}

export async function addAuthorByEmail(opts: {
  submissionId: string;
  ownerId?: string;
  editorId: string;
  email: string;
  name: string | null;
  affiliation: string | null;
  isPresenter: boolean;
  canEdit?: boolean;
}): Promise<{ error?: string }> {
  const owned = await ownedSubmission(opts.submissionId, opts.ownerId);
  if (!owned) return { error: 'Submission not found.' };

  // Crediting somebody is a co-author's to do. Granting access is not.
  //
  // `ownedSubmission` runs `writableBy`, which admits a co-author with
  // `can_edit`, and that is the right gate for the author list itself. It is the
  // wrong gate for this one column: a co-author who could grant access could
  // grant it to anyone, which is the sentence `setAuthorAccess` is built around
  // and the reason it compares against `speakerId` rather than using
  // `writableBy`. Without this the two disagreed, and `addAuthorByEmail` was the
  // way round the stricter one.
  //
  // No `ownerId` means the organizer path, which `requireRole('organizer')` has
  // already gated; they may grant.
  const mayGrantAccess = opts.ownerId === undefined || opts.ownerId === owned.speakerId;
  const canEdit = mayGrantAccess ? (opts.canEdit ?? false) : false;

  const person = await upsertUserByEmail(opts.email, opts.name ?? undefined);
  await ensureFilerIsAuthorZero(opts.submissionId, owned.speakerId);

  const before = authorSummary(await authorsFor(opts.submissionId));

  const [seat] = await db
    .select({
      next: sql<number>`coalesce(max(${submissionAuthors.position}), 0) + 1`,
    })
    .from(submissionAuthors)
    .where(eq(submissionAuthors.submissionId, opts.submissionId));

  await db
    .insert(submissionAuthors)
    .values({
      submissionId: opts.submissionId,
      userId: person.id,
      position: seat?.next ?? 1,
      affiliation: opts.affiliation,
      isPresenter: opts.isPresenter,
      canEdit,
    })
    // Re-adding someone already credited edits their affiliation rather than
    // failing; their position is theirs and is not reshuffled by a re-add.
    //
    // A caller who may not grant access does not touch `can_edit` here either.
    // Re-adding is how an affiliation gets corrected, and a correction that
    // silently revoked somebody's access would be `setAuthorAccess` by the back
    // door in the other direction.
    .onConflictDoUpdate({
      target: [submissionAuthors.submissionId, submissionAuthors.userId],
      set: {
        affiliation: opts.affiliation,
        isPresenter: opts.isPresenter,
        ...(mayGrantAccess ? { canEdit } : {}),
      },
    });

  await logAuthorChange(
    opts.submissionId,
    opts.editorId,
    before,
    authorSummary(await authorsFor(opts.submissionId)),
  );
  return {};
}

export async function removeAuthor(opts: {
  submissionId: string;
  ownerId?: string;
  editorId: string;
  userId: string;
}): Promise<{ error?: string }> {
  const owned = await ownedSubmission(opts.submissionId, opts.ownerId);
  if (!owned) return { error: 'Submission not found.' };
  if (opts.userId === owned.speakerId) {
    return { error: 'The speaker who filed the submission cannot be removed from it.' };
  }

  const before = authorSummary(await authorsFor(opts.submissionId));
  await db
    .delete(submissionAuthors)
    .where(
      and(
        eq(submissionAuthors.submissionId, opts.submissionId),
        eq(submissionAuthors.userId, opts.userId),
      ),
    );
  await logAuthorChange(
    opts.submissionId,
    opts.editorId,
    before,
    authorSummary(await authorsFor(opts.submissionId)),
  );
  return {};
}

/**
 * Hand a credited co-author write access, or take it back.
 *
 * Only the filer may call this, which is why `ownerId` is compared to
 * `speakerId` here rather than run through `writableBy`: a co-author who could
 * grant access could grant it to anyone, and the filer would have given away
 * more than they chose to.
 */
export async function setAuthorAccess(opts: {
  submissionId: string;
  ownerId: string;
  editorId: string;
  userId: string;
  canEdit: boolean;
}): Promise<{ error?: string }> {
  const [owned] = await db
    .select({ speakerId: submissions.speakerId })
    .from(submissions)
    .where(and(eq(submissions.id, opts.submissionId), eq(submissions.speakerId, opts.ownerId)))
    .limit(1);
  if (!owned) return { error: 'Submission not found.' };
  if (opts.userId === owned.speakerId) {
    return { error: 'The speaker who filed the submission always has access to it.' };
  }

  const result = await db
    .update(submissionAuthors)
    .set({ canEdit: opts.canEdit })
    .where(
      and(
        eq(submissionAuthors.submissionId, opts.submissionId),
        eq(submissionAuthors.userId, opts.userId),
      ),
    )
    .returning({ userId: submissionAuthors.userId });
  if (result.length === 0) return { error: 'That person is not credited on this submission.' };

  await db.insert(submissionRevisions).values({
    submissionId: opts.submissionId,
    editorId: opts.editorId,
    field: 'authorAccess',
    oldValue: opts.canEdit ? 'view' : 'edit',
    newValue: opts.canEdit ? 'edit' : 'view',
  });

  return {};
}

export type RevisionRow = {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  editorName: string | null;
  editorEmail: string;
};

export async function revisionHistory(submissionId: string): Promise<RevisionRow[]> {
  return db
    .select({
      id: submissionRevisions.id,
      field: submissionRevisions.field,
      oldValue: submissionRevisions.oldValue,
      newValue: submissionRevisions.newValue,
      createdAt: submissionRevisions.createdAt,
      editorName: users.name,
      editorEmail: users.email,
    })
    .from(submissionRevisions)
    .innerJoin(users, eq(users.id, submissionRevisions.editorId))
    .where(eq(submissionRevisions.submissionId, submissionId))
    .orderBy(desc(submissionRevisions.createdAt));
}

export type AbstractIndexRow = {
  id: string;
  title: string;
  abstract: string;
  keywords: string[];
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  status: SubmissionStatus;
  trackId: string | null;
  trackName: string | null;
  speakerName: string | null;
  speakerEmail: string;
  createdAt: Date;
  revisionCount: number;
  lastEditedAt: Date | null;
};

export type AbstractFilters = {
  q?: string | null;
  trackId?: string | null;
  status?: SubmissionStatus | null;
};

/**
 * Revision counts come from a correlated subquery rather than a join: joining
 * `submission_revisions` here would multiply the submission rows and every
 * other count on the page with it.
 */
/** One aggregate over the outer submission's revision log, correlated by id. */
function revisionsOfOuterSubmission(aggregate: SQL) {
  return db
    .select({ value: aggregate })
    .from(submissionRevisions)
    .where(eq(submissionRevisions.submissionId, submissions.id));
}

export async function abstractIndex(filters: AbstractFilters = {}): Promise<AbstractIndexRow[]> {
  const conditions: SQL[] = [];

  const q = filters.q?.trim();
  if (q) {
    const pattern = `%${q}%`;
    const match = or(
      ilike(submissions.title, pattern),
      ilike(submissions.abstract, pattern),
      sql`array_to_string(${submissions.keywords}, ' ') ilike ${pattern}`,
    );
    if (match) conditions.push(match);
  }
  if (filters.trackId) conditions.push(eq(submissions.trackId, filters.trackId));
  if (filters.status) conditions.push(eq(submissions.status, filters.status));

  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      keywords: submissions.keywords,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      status: submissions.status,
      trackId: submissions.trackId,
      trackName: tracks.name,
      speakerName: users.name,
      speakerEmail: users.email,
      createdAt: submissions.createdAt,
      // Built with the query builder, not written into the template: a column
      // interpolated into `sql` renders unqualified, so the correlation read
      // `where "submission_id" = "id"` and bound `"id"` to the subquery's own
      // table. See the note on `contentRowsById` in lib/content.ts.
      revisionCount: sql<number>`(${revisionsOfOuterSubmission(sql`count(*)::int`)})`,
      lastEditedAt: sql<Date | null>`(${revisionsOfOuterSubmission(
        sql`max(${submissionRevisions.createdAt})`,
      )})`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(submissions.title));
}

export type ExportRow = {
  id: string;
  title: string;
  abstract: string;
  speakerName: string | null;
  speakerEmail: string;
  trackName: string | null;
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  status: SubmissionStatus;
  keywords: string[];
  reviewCount: number;
  meanHumanScore: number | null;
  meanAiScore: number | null;
};

/** Every submission with its scoring, for the CSV export. */
export async function exportRows(): Promise<ExportRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      speakerName: users.name,
      speakerEmail: users.email,
      trackName: tracks.name,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      status: submissions.status,
      keywords: submissions.keywords,
      reviewCount: sql<number>`count(${reviews.id})::int`,
      meanHumanScore: sql<
        number | null
      >`avg(${reviews.score}) filter (where ${reviews.source} = 'human')::float`,
      meanAiScore: sql<
        number | null
      >`avg(${reviews.score}) filter (where ${reviews.source} = 'ai')::float`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(reviews, eq(reviews.submissionId, submissions.id))
    .groupBy(submissions.id, tracks.name, users.name, users.email)
    .orderBy(asc(submissions.title));
}

export type BookRow = {
  id: string;
  title: string;
  abstract: string;
  keywords: string[];
  format: SubmissionFormat;
  trackName: string | null;
  trackColour: string | null;
  speakerId: string;
  speakerName: string | null;
  speakerEmail: string;
};

/** Accepted submissions for the printable abstract book, in track order. */
export async function acceptedForBook(): Promise<BookRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      keywords: submissions.keywords,
      format: submissions.format,
      trackName: tracks.name,
      trackColour: tracks.colour,
      speakerId: submissions.speakerId,
      speakerName: users.name,
      speakerEmail: users.email,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(eq(submissions.status, 'accepted'))
    .orderBy(asc(tracks.name), asc(submissions.title));
}

/**
 * RFC 4180 quoting. An abstract routinely contains a comma, a newline and a
 * quotation mark, and any one of them unescaped shifts every later column of
 * the file by one — a corrupted export that still opens is worse than a failed
 * one, because nobody notices.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
