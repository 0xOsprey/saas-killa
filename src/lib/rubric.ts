import { sql } from 'drizzle-orm';
import { reviews } from '@/db/schema';

/**
 * The grading rubric, shared by human reviewers and AI evaluator personas.
 *
 * It lives in its own module because four separate surfaces read it: the
 * reviewer form, the AI prompt, the reviewer-facing legend, and the stored
 * `reviews.rubric` breakdown. When it lived inside the evaluator, a human grade
 * was one bare integer and the two kinds of review were not comparable.
 *
 * These four are no longer the scorecard. They are the scorecard a round is
 * seeded with: `round_criteria` holds what a round actually grades on, and a
 * round with no rows there gets these. The AI evaluator still prompts against
 * this constant, because the model is asked one fixed question and an organizer
 * renaming a criterion should not silently rewrite the prompt.
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

/** The scorecard a round is seeded with, in the order it renders. */
export const DEFAULT_CRITERIA = RUBRIC_KEYS.map((key, position) => ({
  key,
  label: RUBRIC_LABELS[key],
  helpText: RUBRIC[key],
  kind: 'numeric' as const,
  scaleMin: 1,
  scaleMax: 5,
  options: [] as string[],
  weight: 1,
  position,
}));

/** Just enough of a `round_criteria` row to score against it. */
export type ScoredCriterion = {
  key: string;
  kind: 'numeric' | 'select' | 'text';
  scaleMin: number;
  scaleMax: number;
  weight: number;
};

/**
 * Put a criterion's raw value on the 1-5 scale `reviews.score` is expressed in.
 *
 * A round scored out of 10 and a round scored out of 5 have to end up
 * comparable, because the organizer's results table averages both and the award
 * tally reads the same column. Rescaling at write time rather than at read time
 * means a stored grade never depends on what the scale happened to be when
 * somebody opened the page: an organizer widening a scale afterwards changes
 * what new grades mean, not what old ones did.
 *
 * A degenerate scale (min equal to max, or inverted) has no spread to map, so it
 * collapses to the middle rather than dividing by zero.
 */
export function toFiveScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 3;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 3;
  const clamped = Math.min(max, Math.max(min, value));
  return 1 + ((clamped - min) * 4) / (max - min);
}

/**
 * Collapse a filled scorecard to the two numbers a review row stores.
 *
 * `score` is the rounded integer every existing consumer reads, and `weighted`
 * is the same arithmetic before rounding. Both are needed: rounding is what
 * makes a 2:1 weighting over 4 and 2 (3.33) indistinguishable from an even one
 * (3.0), and an organizer who configured weights is owed the difference on
 * screen.
 *
 * Only numeric criteria count. A dropdown answer and a paragraph are recorded
 * and read, never averaged.
 */
export function scoreCriteria(
  criteria: ScoredCriterion[],
  values: Record<string, number>,
): { score: number; weighted: number } {
  let total = 0;
  let divisor = 0;
  let plainTotal = 0;
  let plainCount = 0;

  for (const criterion of criteria) {
    if (criterion.kind !== 'numeric') continue;
    const raw = values[criterion.key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const scaled = toFiveScale(raw, criterion.scaleMin, criterion.scaleMax);
    const weight = Number.isFinite(criterion.weight) ? Math.max(0, criterion.weight) : 0;
    total += scaled * weight;
    divisor += weight;
    plainTotal += scaled;
    plainCount += 1;
  }

  // Every weight at 0 is an organizer saying nothing counts, which is not an
  // answer a mean can give. Falling back to the unweighted mean keeps the grade
  // filed rather than refusing it over a configuration mistake.
  if (plainCount === 0) return { score: 3, weighted: 3 };
  const weighted = divisor === 0 ? plainTotal / plainCount : total / divisor;
  return { score: clampScore(weighted), weighted };
}

/**
 * A stable column key from a label an organizer typed. Keys join a stored grade
 * to the criterion it was filed under, so they are generated once at creation
 * and never recomputed from a later rename.
 */
export function criterionKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'criterion'
  );
}

/**
 * One review's contribution to an aggregate.
 *
 * Three columns collapse into one number here, in the order a reader would
 * expect to be believed: a human's override beats the grade it replaced, the
 * unrounded weighted mean beats the integer it was rounded into, and the integer
 * is what a grade filed before either of those existed has. Doing it in the
 * query rather than the page is what keeps sorting and displaying the same
 * number, which is the whole of what a sortable results table promises.
 *
 * It sits in this module rather than beside the one board that first needed it
 * because two boards show a submission's aggregate, and until now they
 * disagreed. `/organizer/abstracts` collapsed the three columns;
 * `/organizer/submissions` averaged the raw integer. Measured on the live
 * instance after a chair overrode one AI grade from 4 down to 2: the same
 * proposal read 4.0 on one screen and 2.0 on the other, with nothing on either
 * saying which number the decision would be made on. A weight or an override
 * that moves one and not the other is not a rounding difference. It is two
 * different answers to the same question.
 */
export const EFFECTIVE_SCORE = sql<number>`coalesce(
  ${reviews.overrideScore}::real,
  ${reviews.weightedScore},
  ${reviews.score}::real
)`;
