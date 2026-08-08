import { asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { formQuestions, submissionAnswers } from '@/db/schema';
import type { AnswerMap, QuestionShape } from './questions';

/**
 * Reads and writes for the organizer-defined half of the submission form. The
 * rules live in `questions.ts`, which stays free of the database so a client
 * component can import it.
 */

function toShape(row: typeof formQuestions.$inferSelect): QuestionShape {
  return {
    id: row.id,
    prompt: row.prompt,
    helpText: row.helpText,
    kind: row.kind,
    required: row.required,
    position: row.position,
    options: row.options,
    formats: row.formats,
    trackIds: row.trackIds,
    showIfQuestionId: row.showIfQuestionId,
    showIfValue: row.showIfValue,
  };
}

/** The live form. Archived questions are excluded; their answers survive. */
export async function activeQuestions(): Promise<QuestionShape[]> {
  const rows = await db
    .select()
    .from(formQuestions)
    .where(isNull(formQuestions.archivedAt))
    .orderBy(asc(formQuestions.position), asc(formQuestions.createdAt));
  return rows.map(toShape);
}

export type EditorQuestion = QuestionShape & { archivedAt: Date | null };

/** Every question including the archived ones, for the editor. */
export async function editorQuestions(): Promise<EditorQuestion[]> {
  const rows = await db
    .select()
    .from(formQuestions)
    .orderBy(asc(formQuestions.position), asc(formQuestions.createdAt));
  return rows.map((row) => ({ ...toShape(row), archivedAt: row.archivedAt }));
}

export async function answersFor(submissionId: string): Promise<AnswerMap> {
  const rows = await db
    .select({ questionId: submissionAnswers.questionId, value: submissionAnswers.value })
    .from(submissionAnswers)
    .where(eq(submissionAnswers.submissionId, submissionId));

  return Object.fromEntries(rows.map((row) => [row.questionId, row.value]));
}

export async function answersForMany(submissionIds: string[]): Promise<Map<string, AnswerMap>> {
  const out = new Map<string, AnswerMap>();
  if (submissionIds.length === 0) return out;

  const rows = await db
    .select({
      submissionId: submissionAnswers.submissionId,
      questionId: submissionAnswers.questionId,
      value: submissionAnswers.value,
    })
    .from(submissionAnswers)
    .where(inArray(submissionAnswers.submissionId, submissionIds));

  for (const row of rows) {
    const bucket = out.get(row.submissionId) ?? {};
    bucket[row.questionId] = row.value;
    out.set(row.submissionId, bucket);
  }
  return out;
}

/**
 * Replace a submission's answers with exactly this set.
 *
 * Delete-then-insert rather than upsert, because the set shrinks as well as
 * grows: a speaker who unticks a box that opened a branch has un-answered the
 * branch, and an upsert would leave the old answer sitting there. Both
 * statements run in one transaction so a submission is never briefly answerless.
 */
export async function saveAnswers(submissionId: string, answers: AnswerMap): Promise<void> {
  const rows = Object.entries(answers).map(([questionId, value]) => ({
    submissionId,
    questionId,
    value,
  }));

  await db.transaction(async (tx) => {
    await tx.delete(submissionAnswers).where(eq(submissionAnswers.submissionId, submissionId));
    if (rows.length > 0) await tx.insert(submissionAnswers).values(rows);
  });
}

export type AnsweredQuestion = { question: QuestionShape; value: string };

/**
 * A submission's answers paired with the questions that asked them, archived
 * ones included. The committee graded what was asked at the time, so a page
 * showing an answer has to be able to show a question that is no longer live.
 */
export async function answeredQuestions(submissionId: string): Promise<AnsweredQuestion[]> {
  const rows = await db
    .select({ question: formQuestions, value: submissionAnswers.value })
    .from(submissionAnswers)
    .innerJoin(formQuestions, eq(formQuestions.id, submissionAnswers.questionId))
    .where(eq(submissionAnswers.submissionId, submissionId))
    .orderBy(asc(formQuestions.position), asc(formQuestions.createdAt));

  return rows.map((row) => ({ question: toShape(row.question), value: row.value }));
}

/**
 * The same pairing for a page full of submissions, in one query rather than one
 * per card. Archived questions are joined in for the same reason as above: a
 * reviewer reading a proposal has to see the question the answer answered, even
 * when the organizer has since taken it off the form.
 *
 * Nothing here touches `users`, so it is safe on the blind review queue.
 */
export async function answersByQuestion(
  submissionIds: string[],
): Promise<Map<string, AnsweredQuestion[]>> {
  const out = new Map<string, AnsweredQuestion[]>();
  if (submissionIds.length === 0) return out;

  const rows = await db
    .select({
      submissionId: submissionAnswers.submissionId,
      question: formQuestions,
      value: submissionAnswers.value,
    })
    .from(submissionAnswers)
    .innerJoin(formQuestions, eq(formQuestions.id, submissionAnswers.questionId))
    .where(inArray(submissionAnswers.submissionId, submissionIds))
    .orderBy(asc(formQuestions.position), asc(formQuestions.createdAt));

  for (const row of rows) {
    const bucket = out.get(row.submissionId) ?? [];
    bucket.push({ question: toShape(row.question), value: row.value });
    out.set(row.submissionId, bucket);
  }
  return out;
}
