'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { audienceLevelEnum, submissionFormatEnum } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import {
  addAuthorByEmail,
  applyAbstractEdit,
  currentValues,
  parseKeywords,
  removeAuthor,
  submissionForEdit,
  type AbstractActionState,
} from '@/lib/abstracts';

/**
 * Organizer-side editing. Unlike the speaker action there is no CFP window and
 * no lock check: the locks exist to stop a speaker rewriting a proposal under
 * review, and an organizer fixing a typo is the case they were built for.
 *
 * Every action re-checks the role itself. The layout guard does not run for a
 * direct action invocation.
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

function revalidateAbstract(submissionId: string): void {
  revalidatePath('/organizer/abstracts');
  revalidatePath(`/organizer/abstracts/${submissionId}`);
  revalidatePath(`/organizer/abstracts/${submissionId}/history`);
  revalidatePath('/organizer/abstracts/book');
  revalidatePath('/organizer/submissions');
  revalidatePath(`/agenda/${submissionId}`);
  revalidatePath('/speaker');
}

export async function saveAbstract(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const organizer = await requireRole('organizer');

  const id = z.string().uuid().safeParse(formData.get('submissionId'));
  if (!id.success) return { error: 'Unknown submission.' };

  const row = await submissionForEdit(id.data);
  if (!row) return { error: 'Unknown submission.' };
  const current = currentValues(row);

  // A field the form did not send keeps its stored value rather than blanking.
  const parsed = editSchema.safeParse({
    title: text(formData.get('title')) ?? current.title,
    abstract: text(formData.get('abstract')) ?? current.abstract,
    format: formData.get('format') ?? current.format,
    audienceLevel: formData.get('audienceLevel') ?? current.audienceLevel,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const keywordsField = formData.get('keywords');
  const changed = await applyAbstractEdit({
    submissionId: row.id,
    editorId: organizer.id,
    next: {
      ...parsed.data,
      keywords: keywordsField === null ? current.keywords : parseKeywords(String(keywordsField)),
    },
  });

  revalidateAbstract(row.id);
  if (changed.length === 0) return { notice: 'No changes to save.' };
  return { notice: `Saved. ${changed.length} field(s) added to the revision history.` };
}

export async function addAuthorAction(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const organizer = await requireRole('organizer');

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
    editorId: organizer.id,
    email: parsed.data.email,
    name: parsed.data.name,
    affiliation: parsed.data.affiliation,
    isPresenter: formData.get('isPresenter') !== null,
  });
  if (result.error) return { error: result.error };

  revalidateAbstract(id.data);
  return { notice: `${parsed.data.email} is credited on this submission.` };
}

export async function removeAuthorAction(
  _prev: AbstractActionState,
  formData: FormData,
): Promise<AbstractActionState> {
  const organizer = await requireRole('organizer');

  const parsed = z
    .object({ submissionId: z.string().uuid(), userId: z.string().uuid() })
    .safeParse({
      submissionId: formData.get('submissionId'),
      userId: formData.get('userId'),
    });
  if (!parsed.success) return { error: 'Unknown author.' };

  const result = await removeAuthor({
    submissionId: parsed.data.submissionId,
    editorId: organizer.id,
    userId: parsed.data.userId,
  });
  if (result.error) return { error: result.error };

  revalidateAbstract(parsed.data.submissionId);
  return { notice: 'Co-author removed.' };
}
