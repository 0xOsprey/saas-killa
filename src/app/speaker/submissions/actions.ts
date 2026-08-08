'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { audienceLevelEnum, submissionFormatEnum } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import {
  addAuthorByEmail,
  applyAbstractEdit,
  canWriteSubmission,
  currentValues,
  fieldLabel,
  isFieldLocked,
  parseKeywords,
  removeAuthor,
  setAuthorAccess,
  submissionForEdit,
  type AbstractActionState,
  type EditableField,
} from '@/lib/abstracts';
import { cfpIsOpen, getEvent } from '@/lib/queries';

/**
 * Speaker-side editing. Two gates the organizer side does not have: the CFP
 * window must be open, and a field an organizer froze in `lockedFields` keeps
 * its stored value.
 *
 * Ownership goes into the WHERE clause of the write rather than a check before
 * it, so a forged submission id updates zero rows instead of someone else's.
 */

const editSchema = z.object({
  title: z.string().min(6, 'Give the talk a title').max(200),
  abstract: z.string().min(120, 'Abstracts under 120 characters are too thin to review').max(5000),
  format: z.enum(submissionFormatEnum.enumValues),
  audienceLevel: z.enum(audienceLevelEnum.enumValues),
});

const authorSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().max(120).nullable(),
  affiliation: z.string().max(200).nullable(),
});

function text(value: FormDataEntryValue | null): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Take the submitted value, or keep the stored one. The form renders no input
 * for a locked field, so a locked value arriving here is a forged post: it is
 * recorded in `refused` and dropped rather than thrown on, because the speaker's
 * other three corrections in the same submit are worth keeping.
 */
function pick(
  field: EditableField,
  submitted: string | null,
  stored: string,
  lockedFields: string[] | null,
  refused: EditableField[],
): string {
  if (submitted === null) return stored;
  if (!isFieldLocked(lockedFields, field)) return submitted;
  if (submitted !== stored) refused.push(field);
  return stored;
}

function revalidateSubmission(submissionId: string): void {
  revalidatePath('/speaker');
  revalidatePath(`/speaker/submissions/${submissionId}/edit`);
  revalidatePath(`/organizer/abstracts/${submissionId}`);
  revalidatePath(`/organizer/abstracts/${submissionId}/history`);
  revalidatePath('/organizer/abstracts');
  revalidatePath(`/agenda/${submissionId}`);
}

export async function saveMyAbstract(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const user = await requireUser();

  const id = z.string().uuid().safeParse(formData.get('submissionId'));
  if (!id.success) return { error: 'Unknown submission.' };

  const [event, submission, mine] = await Promise.all([
    getEvent(),
    submissionForEdit(id.data),
    canWriteSubmission(id.data, user.id),
  ]);
  if (!submission || !mine) return { error: 'Unknown submission.' };

  if (!cfpIsOpen(event)) {
    return {
      error: 'The call for papers is closed, so this can no longer be edited here. Ask an organizer.',
    };
  }

  const current = currentValues(submission);
  const locked = submission.lockedFields;
  const refused: EditableField[] = [];

  const rawKeywords = formData.get('keywords');
  const keywords = pick(
    'keywords',
    rawKeywords === null ? null : parseKeywords(String(rawKeywords)).join(', '),
    current.keywords.join(', '),
    locked,
    refused,
  );

  const parsed = editSchema.safeParse({
    title: pick('title', text(formData.get('title')), current.title, locked, refused),
    abstract: pick('abstract', text(formData.get('abstract')), current.abstract, locked, refused),
    format: pick('format', text(formData.get('format')), current.format, locked, refused),
    audienceLevel: pick(
      'audienceLevel',
      text(formData.get('audienceLevel')),
      current.audienceLevel,
      locked,
      refused,
    ),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const changed = await applyAbstractEdit({
    submissionId: submission.id,
    editorId: user.id,
    ownerId: user.id,
    next: { ...parsed.data, keywords: parseKeywords(keywords) },
  });

  revalidateSubmission(submission.id);

  const state: AbstractActionState = {};
  if (changed.length > 0) {
    state.notice = `Saved. ${changed.length} field(s) added to the revision history.`;
  } else if (refused.length === 0) {
    state.notice = 'No changes to save.';
  }
  if (refused.length > 0) {
    const names = refused.map(fieldLabel).join(' and ');
    state.error =
      refused.length === 1
        ? `${names} is locked by the organizers, so that change was not saved.`
        : `${names} are locked by the organizers, so those changes were not saved.`;
  }
  return state;
}

export async function addMyAuthor(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const user = await requireUser();

  const id = z.string().uuid().safeParse(formData.get('submissionId'));
  if (!id.success) return { error: 'Unknown submission.' };

  const parsed = authorSchema.safeParse({
    email: text(formData.get('email')),
    name: text(formData.get('name')),
    affiliation: text(formData.get('affiliation')),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the co-author details.' };
  }

  const result = await addAuthorByEmail({
    submissionId: id.data,
    ownerId: user.id,
    editorId: user.id,
    email: parsed.data.email,
    name: parsed.data.name,
    affiliation: parsed.data.affiliation,
    isPresenter: formData.get('isPresenter') !== null,
    canEdit: formData.get('canEdit') !== null,
  });
  if (result.error) return { error: result.error };

  revalidateSubmission(id.data);
  return { notice: `${parsed.data.email} is credited on this submission.` };
}

export async function removeMyAuthor(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const user = await requireUser();

  const parsed = z
    .object({ submissionId: z.string().uuid(), userId: z.string().uuid() })
    .safeParse({
      submissionId: formData.get('submissionId'),
      userId: formData.get('userId'),
    });
  if (!parsed.success) return { error: 'Unknown author.' };

  const result = await removeAuthor({
    submissionId: parsed.data.submissionId,
    ownerId: user.id,
    editorId: user.id,
    userId: parsed.data.userId,
  });
  if (result.error) return { error: result.error };

  revalidateSubmission(parsed.data.submissionId);
  return { notice: 'Co-author removed.' };
}

/**
 * Hand a co-author write access, or take it back. Only the filer may: the form
 * this posts from is rendered for them alone, and `setAuthorAccess` compares
 * `ownerId` against `speakerId` rather than going through `writableBy`, so a
 * co-author who forged the post gets 'Submission not found.' rather than the
 * ability to grant access onward.
 */
export async function setMyAuthorAccess(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const user = await requireUser();

  const parsed = z
    .object({ submissionId: z.string().uuid(), userId: z.string().uuid() })
    .safeParse({
      submissionId: formData.get('submissionId'),
      userId: formData.get('userId'),
    });
  if (!parsed.success) return { error: 'Unknown author.' };

  const canEdit = formData.get('canEdit') !== null && formData.get('canEdit') !== '';
  const result = await setAuthorAccess({
    submissionId: parsed.data.submissionId,
    ownerId: user.id,
    editorId: user.id,
    userId: parsed.data.userId,
    canEdit,
  });
  if (result.error) return { error: result.error };

  revalidateSubmission(parsed.data.submissionId);
  return {
    notice: canEdit
      ? 'They can now edit this proposal.'
      : 'They are still credited, but can no longer edit this proposal.',
  };
}
