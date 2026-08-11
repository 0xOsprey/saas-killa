'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { formQuestions, questionKindEnum, submissionFormatEnum } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { editorQuestions } from '@/lib/question-queries';

function revalidateForm(): void {
  revalidatePath('/organizer/cfp/questions');
  revalidatePath('/cfp');
}

function back(params: Record<string, string | number>): never {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  redirect(`/organizer/cfp/questions?${query.toString()}`);
}

/** A textarea of choices, one per line, is how a select's options are typed. */
function parseOptions(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const option = line.trim();
    if (option === '' || seen.has(option)) continue;
    seen.add(option);
    out.push(option);
    if (out.length === 25) break;
  }
  return out;
}

function checkedValues(formData: FormData, field: string, allowed: readonly string[]): string[] {
  return formData
    .getAll(field)
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => allowed.includes(value));
}

/** Ticked track boxes, kept to well-formed ids so a stray field cannot widen the filter. */
function checkedTrackIds(formData: FormData): string[] {
  return formData
    .getAll('trackIds')
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => z.string().uuid().safeParse(value).success);
}

const questionSchema = z.object({
  prompt: z.string().trim().min(3).max(300),
  helpText: z.string().trim().max(500).nullable(),
  kind: z.enum(questionKindEnum.enumValues),
  required: z.boolean(),
});

function read(formData: FormData) {
  return questionSchema.safeParse({
    prompt: formData.get('prompt'),
    helpText: (formData.get('helpText') as string | null)?.trim() || null,
    kind: formData.get('kind'),
    required: formData.get('required') === 'on',
  });
}

/**
 * Add a question to the end of the form.
 *
 * Position is assigned rather than asked for. Dependencies may only point
 * backwards, so a question's place in the order is what decides whether it can
 * branch off another, and letting an organizer type a number would let them
 * type one that breaks an existing branch.
 */
export async function addQuestion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const parsed = read(formData);
  if (!parsed.success) back({ error: 'question' });

  const existing = await editorQuestions();
  const position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;

  const options = parsed.data.kind === 'select' ? parseOptions(formData.get('options')) : [];
  if (parsed.data.kind === 'select' && options.length < 2) back({ error: 'options' });

  await db.insert(formQuestions).values({
    prompt: parsed.data.prompt,
    helpText: parsed.data.helpText,
    kind: parsed.data.kind,
    required: parsed.data.required,
    position,
    options,
    formats: checkedValues(formData, 'formats', submissionFormatEnum.enumValues),
    trackIds: checkedTrackIds(formData),
  });

  revalidateForm();
  back({ saved: 'added' });
}

export async function updateQuestion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('questionId'));
  const parsed = read(formData);
  if (!parsed.success) back({ error: 'question' });

  const options = parsed.data.kind === 'select' ? parseOptions(formData.get('options')) : [];
  if (parsed.data.kind === 'select' && options.length < 2) back({ error: 'options' });

  await db
    .update(formQuestions)
    .set({
      prompt: parsed.data.prompt,
      helpText: parsed.data.helpText,
      kind: parsed.data.kind,
      required: parsed.data.required,
      options,
      formats: checkedValues(formData, 'formats', submissionFormatEnum.enumValues),
      trackIds: checkedTrackIds(formData),
    })
    .where(eq(formQuestions.id, id));

  // A kind change can strip the answers a branch was keyed to. Any child whose
  // parent no longer offers its trigger value is unhooked rather than left
  // pointing at a value nobody can now give, which would hide it forever.
  if (parsed.data.kind !== 'select' && parsed.data.kind !== 'checkbox') {
    await db
      .update(formQuestions)
      .set({ showIfQuestionId: null, showIfValue: null })
      .where(eq(formQuestions.showIfQuestionId, id));
  }

  revalidateForm();
  back({ saved: 'updated' });
}

/**
 * Point a question at the answer that reveals it, or clear the dependency.
 *
 * The parent must sort earlier. That is checked here and not only in the UI: a
 * cycle would make `visibleQuestions` wrong rather than merely awkward, and the
 * single forward pass is what keeps it cheap.
 */
export async function setBranch(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('questionId'));
  const parentRaw = (formData.get('showIfQuestionId') as string | null)?.trim() || null;
  const value = (formData.get('showIfValue') as string | null)?.trim() || null;

  if (!parentRaw) {
    await db
      .update(formQuestions)
      .set({ showIfQuestionId: null, showIfValue: null })
      .where(eq(formQuestions.id, id));
    revalidateForm();
    back({ saved: 'branch-cleared' });
  }

  const parentId = z.string().uuid().parse(parentRaw);
  if (parentId === id) back({ error: 'branch-self' });
  if (!value) back({ error: 'branch-value' });

  const questions = await editorQuestions();
  const child = questions.find((row) => row.id === id);
  const parent = questions.find((row) => row.id === parentId);
  if (!child || !parent) back({ error: 'branch-missing' });
  if (parent.position >= child.position) back({ error: 'branch-order' });

  await db
    .update(formQuestions)
    .set({ showIfQuestionId: parentId, showIfValue: value })
    .where(eq(formQuestions.id, id));

  revalidateForm();
  back({ saved: 'branch-set' });
}

/**
 * Swap a question with its neighbour.
 *
 * Any branch the move would invert is cleared in the same transaction. Silently
 * reordering into a backwards dependency is the one way this screen could
 * produce a form that renders differently from the one the validator checks.
 */
export async function moveQuestion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('questionId'));
  const direction = formData.get('direction') === 'up' ? -1 : 1;

  const questions = await editorQuestions();
  const index = questions.findIndex((row) => row.id === id);
  const swapWith = questions[index + direction];
  if (index === -1 || !swapWith) back({ error: 'move' });

  const moving = questions[index]!;

  await db.transaction(async (tx) => {
    await tx
      .update(formQuestions)
      .set({ position: swapWith.position })
      .where(eq(formQuestions.id, moving.id));
    await tx
      .update(formQuestions)
      .set({ position: moving.position })
      .where(eq(formQuestions.id, swapWith.id));

    // Both rows have moved, so either could now precede a parent it used to
    // follow. Clearing on the pair is enough: nothing else changed order.
    for (const [child, parent] of [
      [moving, swapWith],
      [swapWith, moving],
    ] as const) {
      await tx
        .update(formQuestions)
        .set({ showIfQuestionId: null, showIfValue: null })
        .where(and(eq(formQuestions.id, child.id), eq(formQuestions.showIfQuestionId, parent.id)));
    }
  });

  revalidateForm();
  back({ saved: 'moved' });
}

/**
 * Retire a question without losing what was answered.
 *
 * Deleting would cascade the answers away, and the answers are part of what the
 * committee graded. Children are unhooked so they do not vanish along with a
 * parent that is no longer on the form.
 */
export async function archiveQuestion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('questionId'));

  await db.transaction(async (tx) => {
    await tx
      .update(formQuestions)
      .set({ archivedAt: new Date() })
      .where(and(eq(formQuestions.id, id), isNull(formQuestions.archivedAt)));
    await tx
      .update(formQuestions)
      .set({ showIfQuestionId: null, showIfValue: null })
      .where(eq(formQuestions.showIfQuestionId, id));
  });

  revalidateForm();
  back({ saved: 'archived' });
}

export async function restoreQuestion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('questionId'));

  // Restored to the end of the form. Its old position may now belong to
  // something else, and two questions at one position is an order that depends
  // on the tiebreak rather than on anything an organizer chose.
  const questions = await editorQuestions();
  const position = questions
    .filter((row) => row.id !== id)
    .reduce((max, row) => Math.max(max, row.position), -1) + 1;

  await db
    .update(formQuestions)
    .set({ archivedAt: null, position })
    .where(eq(formQuestions.id, id));

  revalidateForm();
  back({ saved: 'restored' });
}
