import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { submissionRevisions } from '@/db/schema';
import { DuplicateTitleError, duplicateTitleMessage, isDuplicateTitleError } from '@/lib/abstracts';
import { applyTextEdit, fieldLabel } from '@/lib/content';

/**
 * Putting a submission back to a version the revision log already holds.
 *
 * The log is append-only and stays that way: a restore does not delete or amend
 * the entry it came from, it writes the old text forward as a new edit. So the
 * history after a restore reads as three changes rather than two, the restore
 * carries the organizer who pressed it and the moment they did, and the row and
 * its audit trail never disagree.
 */

/**
 * The only columns a restore may write. THIS ALLOWLIST IS THE FEATURE'S SAFETY
 * PROPERTY, and it is enforced here, on the server, rather than by which
 * buttons the history page chooses to render.
 *
 * `submission_revisions.field` is free text and the log carries far more than
 * prose: `status`, `contentStatus`, `trackId` and the authors list are all
 * logged through `logRevisions`. A restore that replayed whichever field the
 * row happened to name would roll a decision or a moderation state backwards as
 * a side effect of fixing a typo — and `contentIsPublic` gates the public
 * agenda on `contentStatus`, so restoring an abstract could pull a scheduled,
 * approved talk off the published programme. Nobody pressing "restore this
 * wording" is asking for that.
 *
 * Prose is restorable because prose is what a version history is for. Anything
 * that decides where a talk appears is a deliberate act with its own control
 * and its own audit line, and stays out.
 */
export const RESTORABLE_FIELDS = ['title', 'abstract'] as const;

export type RestorableField = (typeof RESTORABLE_FIELDS)[number];

export function isRestorableField(field: string): field is RestorableField {
  return (RESTORABLE_FIELDS as readonly string[]).includes(field);
}

/** Why a field cannot be restored, in one line the history page can print. */
export function unrestorableReason(field: string): string {
  return `${fieldLabel(field)} is not restorable here: it decides where this talk appears, and rolling it back would change the programme rather than the wording.`;
}

export type RestoreResult =
  | { ok: true; field: RestorableField; changed: boolean }
  | { ok: false; reason: string };

/**
 * Restore the value one logged revision produced.
 *
 * The target is the revision's `newValue` — the version that entry created, not
 * the one it replaced. That is what makes the history read as a list of
 * versions: the second-newest entry is the state of the field before the newest
 * edit, so restoring it undoes exactly that edit and keeps everything before it.
 *
 * `submissionId` is in the WHERE clause rather than checked after the read, so
 * a revision id belonging to another talk matches nothing instead of writing
 * one submission's text onto another's.
 */
export async function restoreRevision(opts: {
  revisionId: string;
  submissionId: string;
  editorId: string;
}): Promise<RestoreResult> {
  const [revision] = await db
    .select({
      field: submissionRevisions.field,
      newValue: submissionRevisions.newValue,
    })
    .from(submissionRevisions)
    .where(
      and(
        eq(submissionRevisions.id, opts.revisionId),
        eq(submissionRevisions.submissionId, opts.submissionId),
      ),
    )
    .limit(1);
  if (!revision) return { ok: false, reason: 'That revision is not on this submission.' };

  if (!isRestorableField(revision.field)) {
    return { ok: false, reason: unrestorableReason(revision.field) };
  }
  const field = revision.field;

  // Both restorable columns are NOT NULL, so an empty target is a log entry
  // that could not have been produced by an edit to this field. Refuse rather
  // than write a blank title over a real one.
  const value = revision.newValue?.trim();
  if (!value) {
    return { ok: false, reason: 'That revision has no text to restore.' };
  }

  try {
    // The same writer an ordinary edit uses, so the restore is logged the same
    // way, in the same transaction, with the row held while old and new are read
    // and written.
    const changed = await applyTextEdit({
      submissionId: opts.submissionId,
      editorId: opts.editorId,
      next: { [field]: value },
    });
    return { ok: true, field, changed: changed.length > 0 };
  } catch (error) {
    // Restoring an older title can collide with the one-title-per-speaker index
    // if the speaker has since filed something under that name. The organizer
    // gets the sentence the CFP form and the abstract editor both give.
    if (error instanceof DuplicateTitleError || isDuplicateTitleError(error)) {
      return { ok: false, reason: duplicateTitleMessage(value) };
    }
    throw error;
  }
}
