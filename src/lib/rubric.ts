/**
 * The grading rubric, shared by human reviewers and AI evaluator personas.
 *
 * It lives in its own module because four separate surfaces read it: the
 * reviewer form, the AI prompt, the reviewer-facing legend, and the stored
 * `reviews.rubric` breakdown. When it lived inside the evaluator, a human grade
 * was one bare integer and the two kinds of review were not comparable.
 */
export const RUBRIC = {
  clarity: 'Is the abstract specific about what the audience will see and learn?',
  originality: 'Does this cover ground the audience has not already heard?',
  relevance: 'Does it fit the track and the stated audience level?',
  credibility: 'Does the proposal show the speaker has actually done this work?',
} as const;

export type RubricKey = keyof typeof RUBRIC;

export const RUBRIC_KEYS = Object.keys(RUBRIC) as RubricKey[];

export const RUBRIC_LABELS: Record<RubricKey, string> = {
  clarity: 'Clarity',
  originality: 'Originality',
  relevance: 'Relevance',
  credibility: 'Credibility',
};

/** Equal weight until an organizer says otherwise on a persona. */
export const DEFAULT_WEIGHTS: Record<RubricKey, number> = {
  clarity: 1,
  originality: 1,
  relevance: 1,
  credibility: 1,
};

export function clampScore(n: unknown): number {
  const value = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 3;
  return Math.min(5, Math.max(1, value));
}

/**
 * Collapse a per-criterion breakdown to the single 1-5 integer every existing
 * consumer reads off `reviews.score`. A weight of 0 drops a criterion; all
 * weights 0 falls back to the unweighted mean rather than dividing by zero.
 */
export function weightedScore(
  rubric: Partial<Record<RubricKey, number>>,
  weights: Partial<Record<RubricKey, number>> = DEFAULT_WEIGHTS,
): number {
  let total = 0;
  let divisor = 0;
  let plainTotal = 0;
  let plainCount = 0;
  for (const key of RUBRIC_KEYS) {
    const value = rubric[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const weight = weights[key] ?? 0;
    total += value * weight;
    divisor += weight;
    plainTotal += value;
    plainCount += 1;
  }
  if (plainCount === 0) return 3;
  if (divisor === 0) return clampScore(plainTotal / plainCount);
  return clampScore(total / divisor);
}
