'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { submissions } from '@/db/schema';
import type { ContentStatus } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { applyTextEdit, isLocked, logRevisions, type TextEdit } from '@/lib/content';
import { writableBy } from '@/lib/abstracts';
import { deleteUpload, linkField, saveUpload, uploadHref } from '@/lib/uploads';

/**
 * The speaker's own content surface. Every action scopes its WHERE clause with
 * `writableBy`, so a forged submission id touches zero rows rather than someone
 * else's talk, and every write goes through `applyTextEdit`, which logs one
 * `submission_revisions` row per field it changed.
 *
 * `writableBy` and not a bare `submissions.speakerId`: this screen admits a
 * credited co-author holding `can_edit`, and it has to admit them at the write
 * as well as at the read. When only the reads used it, the co-author reached
 * the form, pressed Save, updated zero rows and was redirected to `?saved=1`.
 */

/**
 * A recording is somebody else's URL — Vimeo, YouTube, a university's own
 * player — and there is no upload for one, so an app-relative path in this
 * column could only be a hand-crafted POST pointing at a 404. Slides take
 * `linkField` instead, because a slide deck can now be a file on this disk.
 */
const urlField = z.string().url().or(z.literal('')).transform((value) => value || null);
const noteField = z
  .string()
  .max(4000)
  .transform((value) => value.trim() || null);

const CONTENT_FIELDS = ['slidesUrl', 'recordingUrl', 'resourcesNote'] as const;

type OwnedRow = {
  id: string;
  contentStatus: ContentStatus;
  lockedFields: string[];
  slidesUrl: string | null;
  recordingUrl: string | null;
  resourcesNote: string | null;
};

/**
 * Restricted to accepted submissions, matching the screen: content for a
 * proposal that is not on the programme has nowhere to appear, so offering to
 * moderate it would only fill the organizer's queue with work that can never
 * publish.
 */
async function loadOwned(submissionId: string, speakerId: string): Promise<OwnedRow | null> {
  const [row] = await db
    .select({
      id: submissions.id,
      contentStatus: submissions.contentStatus,
      lockedFields: submissions.lockedFields,
      slidesUrl: submissions.slidesUrl,
      recordingUrl: submissions.recordingUrl,
      resourcesNote: submissions.resourcesNote,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.id, submissionId),
        writableBy(speakerId),
        eq(submissions.status, 'accepted'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Read the posted fields, skipping any the organizer has frozen.
 *
 * A locked input renders disabled, and a disabled input is not posted at all —
 * so a field is only written when the form actually carried it. Treating an
 * absent field as an instruction to clear the column would let a lock delete
 * the very content it was meant to protect.
 */
function readFields(formData: FormData, lockedFields: string[]): TextEdit {
  const next: TextEdit = {};
  for (const field of CONTENT_FIELDS) {
    if (!formData.has(field) || isLocked(lockedFields, field)) continue;
    const raw = String(formData.get(field) ?? '').trim();
    if (field === 'resourcesNote') next[field] = noteField.parse(raw);
    else if (field === 'slidesUrl') next[field] = linkField.parse(raw);
    else next[field] = urlField.parse(raw);
  }
  return next;
}

/**
 * The slide deck when the speaker attached a file rather than pasting a link.
 *
 * The stored path is folded into the same `TextEdit` the text fields produce,
 * so a file and a URL are one write and one revision row. Two separate routes
 * into `slidesUrl` would eventually disagree about what the history says
 * happened.
 *
 * Returns a refusal to show the speaker, or null when there was nothing to do.
 * An untouched file input still posts, as a zero-byte File, so "no file" is the
 * ordinary case here and not a failure.
 */
async function foldInSlidesUpload(
  formData: FormData,
  row: OwnedRow,
  speakerId: string,
  next: TextEdit,
): Promise<string | null> {
  const file = formData.get('slidesFile');
  if (!(file instanceof File) || file.size === 0) return null;
  if (isLocked(row.lockedFields, 'slidesUrl')) {
    return 'An organizer has frozen the slides on that talk. Ask them to unlock it.';
  }

  const result = await saveUpload({
    file,
    kind: 'slides',
    ownerId: speakerId,
    submissionId: row.id,
  });
  if (!result.ok) return result.reason;

  // The file wins over the text field. A speaker who did both meant the file:
  // it is the one they had to go and find.
  next.slidesUrl = uploadHref(result.upload);
  return null;
}

function refuse(reason: string): never {
  redirect(`/speaker/content?error=${encodeURIComponent(reason)}`);
}

async function setContentStatus(
  row: OwnedRow,
  speakerId: string,
  next: ContentStatus,
): Promise<void> {
  if (row.contentStatus === next) return;
  await db
    .update(submissions)
    .set({ contentStatus: next, updatedAt: new Date() })
    .where(and(eq(submissions.id, row.id), writableBy(speakerId)));
  await logRevisions([
    {
      submissionId: row.id,
      editorId: speakerId,
      field: 'contentStatus',
      oldValue: row.contentStatus,
      newValue: next,
    },
  ]);
}

function revalidate(submissionId: string): void {
  revalidatePath('/speaker/content');
  revalidatePath('/speaker');
  revalidatePath('/organizer/submissions');
  revalidatePath(`/agenda/${submissionId}`);
}

/**
 * Save without asking for review.
 *
 * Approved content is the exception, and the screen already promises it:
 * "Editing it below moves it back to a draft you will need to resubmit."
 * Approved means live on the public agenda, so leaving the status alone would
 * rewrite a published slide or recording URL with material no organizer has
 * seen. The demotion is conditional on the edit having changed something, which
 * is what `applyTextEdit` returns: opening the form and pressing Save without
 * typing should not unpublish a talk.
 */
export async function saveContentDraft(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));
  const row = await loadOwned(id, user.id);
  if (!row) redirect('/speaker/content');

  const next = readFields(formData, row.lockedFields);
  const refusal = await foldInSlidesUpload(formData, row, user.id, next);
  if (refusal) refuse(refusal);

  const changed = await applyTextEdit({
    submissionId: id,
    editorId: user.id,
    ownerId: user.id,
    next,
  });

  if (changed.length > 0 && row.contentStatus === 'approved') {
    await setContentStatus(row, user.id, 'draft');
    revalidate(id);
    redirect('/speaker/content?unpublished=1');
  }

  revalidate(id);
  redirect('/speaker/content?saved=1');
}

/**
 * Save and hand it to the organizers. Submitting empty is refused rather than
 * queued: an organizer opening a review with nothing in it cannot approve or
 * send back anything, and the speaker would be waiting on a decision that has
 * no subject.
 */
export async function submitContentForReview(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));
  const row = await loadOwned(id, user.id);
  if (!row) redirect('/speaker/content');

  const next = readFields(formData, row.lockedFields);
  const refusal = await foldInSlidesUpload(formData, row, user.id, next);
  if (refusal) refuse(refusal);

  await applyTextEdit({ submissionId: id, editorId: user.id, ownerId: user.id, next });

  // Ask the database what is there, not the form plus what the row said before
  // the write. `{ ...row, ...next }` is a projection of an update that may not
  // have happened, and the failure it hid was silent: an edit that matched zero
  // rows still looked non-empty here, so `content_status` flipped to `pending`
  // on a submission whose content columns were all still null, and an organizer
  // opened a review with nothing in it.
  const saved = await loadOwned(id, user.id);
  if (!saved) redirect('/speaker/content');
  if (CONTENT_FIELDS.every((field) => !saved[field])) {
    revalidate(id);
    redirect('/speaker/content?empty=1');
  }

  await setContentStatus(row, user.id, 'pending');
  revalidate(id);
  redirect('/speaker/content?review=1');
}

/**
 * Attach a supporting document: a handout, a data appendix, a signed release.
 *
 * Its own action rather than another field on the content form, because a talk
 * carries any number of these and one file input cannot express "add one more".
 *
 * A document never publishes. It is not in `CONTENT_FIELDS`, so attaching one
 * does not make an otherwise-empty content record submittable, and
 * `readableUpload` keeps it off the public agenda whatever the content status
 * says. That is the point of the kind: this is material for the organizers,
 * and it routinely carries a draft or a phone number nobody agreed to publish.
 */
export async function uploadDocument(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));
  const row = await loadOwned(id, user.id);
  if (!row) redirect('/speaker/content');

  const result = await saveUpload({
    file: formData.get('documentFile'),
    kind: 'document',
    ownerId: user.id,
    submissionId: id,
  });
  if (!result.ok) refuse(result.reason);

  await logRevisions([
    {
      submissionId: id,
      editorId: user.id,
      field: 'document',
      oldValue: null,
      newValue: result.upload.filename,
    },
  ]);

  revalidate(id);
  redirect('/speaker/content?document=1');
}

/**
 * Take a document back down. Scoped to the caller's own uploads, so a co-author
 * with write access can add their own and remove their own but cannot delete
 * the filer's release form out from under them.
 *
 * `?removed=1` goes out whether or not a row matched, deliberately. Given that
 * ownership scope, a miss is either a double submit, where "removed" describes
 * the end state correctly, or somebody else's upload id, where naming the miss
 * would say whether that id exists. Same reasoning as the single 404 on
 * `/files/`.
 */
export async function removeDocument(formData: FormData): Promise<void> {
  const user = await requireUser();
  const submissionId = z.string().uuid().parse(formData.get('submissionId'));
  const uploadId = z.string().uuid().parse(formData.get('uploadId'));

  if (await deleteUpload(uploadId, user.id)) {
    await logRevisions([
      {
        submissionId,
        editorId: user.id,
        field: 'document',
        oldValue: 'attached',
        newValue: null,
      },
    ]);
  }

  revalidate(submissionId);
  redirect('/speaker/content?removed=1');
}

/** Pull it back out of the queue to keep working on it. */
export async function withdrawContentFromReview(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));
  const row = await loadOwned(id, user.id);
  if (!row || row.contentStatus !== 'pending') redirect('/speaker/content');

  await setContentStatus(row, user.id, 'draft');
  revalidate(id);
  redirect('/speaker/content?pulled=1');
}
