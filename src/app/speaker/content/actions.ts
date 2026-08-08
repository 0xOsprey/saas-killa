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

/**
 * The speaker's own content surface. Every action scopes its WHERE clause to
 * the caller's speaker id, so a forged submission id touches zero rows rather
 * than someone else's talk, and every write goes through `applyTextEdit`, which
 * logs one `submission_revisions` row per field it changed.
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
    next[field] = field === 'resourcesNote' ? noteField.parse(raw) : urlField.parse(raw);
  }
  return next;
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

/** Save without asking for review. The row stays where it is. */
export async function saveContentDraft(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(formData.get('submissionId'));
  const row = await loadOwned(id, user.id);
  if (!row) redirect('/speaker/content');

  await applyTextEdit({
    submissionId: id,
    editorId: user.id,
    ownerId: user.id,
    next: readFields(formData, row.lockedFields),
  });

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
  await applyTextEdit({ submissionId: id, editorId: user.id, ownerId: user.id, next });

  const after = { ...row, ...next };
  const empty = CONTENT_FIELDS.every((field) => !after[field]);
  if (empty) {
    revalidate(id);
    redirect('/speaker/content?empty=1');
  }

  await setContentStatus(row, user.id, 'pending');
  revalidate(id);
  redirect('/speaker/content?review=1');
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
