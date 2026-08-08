import type { QuestionKind } from '@/db/schema';

/**
 * The organizer-defined half of the submission form.
 *
 * Everything here is pure so the same rules run in three places: the server
 * action that validates a submission, the client component that shows and hides
 * fields as the speaker types, and the tests. A branch that hides a field in the
 * browser but not on the server is a required-field error nobody can clear.
 */

export type QuestionShape = {
  id: string;
  prompt: string;
  helpText: string | null;
  kind: QuestionKind;
  required: boolean;
  position: number;
  options: string[];
  formats: string[];
  trackIds: string[];
  showIfQuestionId: string | null;
  showIfValue: string | null;
};

export const QUESTION_KIND_LABELS: Record<QuestionKind, string> = {
  short_text: 'Short text',
  long_text: 'Paragraph',
  select: 'Choose one',
  checkbox: 'Yes / no',
  url: 'Link',
};

/** A checkbox posts this when ticked and nothing at all when not. */
export const CHECKED = 'yes';

export type AnswerMap = Record<string, string>;

export type FormContext = {
  format: string;
  trackId: string | null;
};

/**
 * Does this question apply to a proposal of this shape at all?
 *
 * An empty list means "every one", not "none". That is the default a new
 * question is created with, so the common case of a question everybody answers
 * needs no configuration.
 */
export function appliesTo(question: QuestionShape, ctx: FormContext): boolean {
  if (question.formats.length > 0 && !question.formats.includes(ctx.format)) return false;
  if (question.trackIds.length > 0) {
    if (!ctx.trackId || !question.trackIds.includes(ctx.trackId)) return false;
  }
  return true;
}

/**
 * The questions to show, in order, given what has been answered so far.
 *
 * Resolved in one forward pass rather than to a fixed point. A dependency may
 * only point at an earlier question, which the editor enforces, so by the time
 * a branch is evaluated its parent's visibility is already decided. A branch
 * whose parent is hidden is hidden too, however the parent's stale answer reads,
 * which is what stops a hidden answer from resurrecting a grandchild.
 */
export function visibleQuestions(
  questions: QuestionShape[],
  ctx: FormContext,
  answers: AnswerMap,
): QuestionShape[] {
  const ordered = [...questions].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const shown = new Set<string>();
  const out: QuestionShape[] = [];

  for (const question of ordered) {
    if (!appliesTo(question, ctx)) continue;

    if (question.showIfQuestionId) {
      if (!shown.has(question.showIfQuestionId)) continue;
      const parentAnswer = answers[question.showIfQuestionId] ?? '';
      if (parentAnswer !== (question.showIfValue ?? '')) continue;
    }

    shown.add(question.id);
    out.push(question);
  }

  return out;
}

/** The field name a question's input posts under. */
export function fieldName(questionId: string): string {
  return `q_${questionId}`;
}

/** The question id a posted field name refers to, or null if it is not one. */
export function questionIdFromField(name: string): string | null {
  return name.startsWith('q_') ? name.slice(2) : null;
}

export type AnswerError = { questionId: string; message: string };

export type ValidationResult =
  | { ok: true; answers: AnswerMap }
  | { ok: false; errors: AnswerError[] };

function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check the answers to the questions that are actually showing.
 *
 * Answers to hidden questions are dropped rather than rejected. A speaker who
 * ticks a box, fills in the branch it opened and then unticks it has answered a
 * question that is no longer being asked, and storing that answer would show it
 * to a committee as though it had been.
 */
export function validateAnswers(
  questions: QuestionShape[],
  ctx: FormContext,
  raw: AnswerMap,
): ValidationResult {
  const visible = visibleQuestions(questions, ctx, raw);
  const errors: AnswerError[] = [];
  const answers: AnswerMap = {};

  for (const question of visible) {
    const value = (raw[question.id] ?? '').trim();

    if (value === '') {
      if (question.required) {
        errors.push({ questionId: question.id, message: `"${question.prompt}" is required.` });
      }
      continue;
    }

    if (question.kind === 'select' && !question.options.includes(value)) {
      errors.push({
        questionId: question.id,
        message: `"${value}" is not one of the choices for "${question.prompt}".`,
      });
      continue;
    }

    if (question.kind === 'url' && !looksLikeUrl(value)) {
      errors.push({
        questionId: question.id,
        message: `"${question.prompt}" needs a full http:// or https:// address.`,
      });
      continue;
    }

    if (question.kind === 'checkbox' && value !== CHECKED) {
      errors.push({ questionId: question.id, message: `"${question.prompt}" is not a yes or no.` });
      continue;
    }

    if (value.length > 4000) {
      errors.push({ questionId: question.id, message: `"${question.prompt}" is too long.` });
      continue;
    }

    answers[question.id] = value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, answers };
}

/** How an answer reads on a page, rather than how it is stored. */
export function displayAnswer(question: QuestionShape, value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  if (question.kind === 'checkbox') return value === CHECKED ? 'Yes' : 'No';
  return value;
}

/**
 * Questions a given question may depend on: earlier ones only.
 *
 * Forward-only dependencies are what make `visibleQuestions` a single pass, and
 * they make a cycle unrepresentable rather than merely discouraged.
 */
export function possibleParents(
  questions: QuestionShape[],
  question: Pick<QuestionShape, 'id' | 'position'>,
): QuestionShape[] {
  return questions
    .filter((candidate) => candidate.id !== question.id && candidate.position < question.position)
    .sort((a, b) => a.position - b.position);
}

/** The answers a parent question can branch on. */
export function branchValues(parent: QuestionShape): string[] {
  if (parent.kind === 'checkbox') return [CHECKED];
  if (parent.kind === 'select') return parent.options;
  return [];
}
