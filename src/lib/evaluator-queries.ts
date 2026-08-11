import { aliasedTable, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { evaluatorPersonas, reviewRounds, reviews, submissions, users } from '@/db/schema';
import type { SubmissionStatus } from '@/db/schema';

/**
 * Read helpers for the evaluator screens. They live here rather than in
 * `queries.ts` because every one of them is about the relationship between an AI
 * grade and a human one, which is a question only these pages ask.
 */

/** Per-source aggregates, reused by the outlier and competitive queries. */
const AI_AVG = sql<number | null>`(avg(${reviews.score}) filter (where ${eq(reviews.source, 'ai')}))::float`;
const HUMAN_AVG = sql<number | null>`(avg(${reviews.score}) filter (where ${eq(reviews.source, 'human')}))::float`;
const AI_COUNT = sql<number>`(count(*) filter (where ${eq(reviews.source, 'ai')}))::int`;
const HUMAN_COUNT = sql<number>`(count(*) filter (where ${eq(reviews.source, 'human')}))::int`;

export type PersonaRosterRow = {
  id: string;
  name: string;
  profession: string | null;
  tone: string | null;
  expertise: string | null;
  weights: Record<string, number>;
  active: boolean;
  botEmail: string;
  gradeCount: number;
};

/** Every persona with the number of grades standing in its name. */
export async function personaRoster(): Promise<PersonaRosterRow[]> {
  return db
    .select({
      id: evaluatorPersonas.id,
      name: evaluatorPersonas.name,
      profession: evaluatorPersonas.profession,
      tone: evaluatorPersonas.tone,
      expertise: evaluatorPersonas.expertise,
      weights: evaluatorPersonas.weights,
      active: evaluatorPersonas.active,
      botEmail: users.email,
      gradeCount: sql<number>`count(${reviews.id})::int`,
    })
    .from(evaluatorPersonas)
    .innerJoin(users, eq(users.id, evaluatorPersonas.userId))
    .leftJoin(reviews, eq(reviews.personaId, evaluatorPersonas.id))
    .groupBy(evaluatorPersonas.id, users.email)
    .orderBy(asc(evaluatorPersonas.createdAt));
}

export type GradableSubmissionRow = {
  id: string;
  title: string;
  decided: boolean;
};

/**
 * What a targeted evaluator run may be pointed at, by title.
 *
 * Withdrawn proposals are left out and decided ones are not: a withdrawn talk is
 * gone, but an accepted one is exactly what a chair wants a second opinion on
 * when someone asks how the decision was reached.
 */
export async function gradableSubmissions(): Promise<GradableSubmissionRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      decided: sql<boolean>`${submissions.status} <> 'submitted'`,
    })
    .from(submissions)
    .where(sql`${submissions.status} <> 'withdrawn'`)
    .orderBy(asc(submissions.title));
}

export type AiGradeRow = {
  reviewId: string;
  submissionId: string;
  title: string;
  personaName: string | null;
  roundName: string;
  score: number;
  overrideScore: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  overriddenAt: Date | null;
  comment: string | null;
  rubric: Record<string, number> | null;
  model: string | null;
  createdAt: Date;
};

/**
 * What the evaluator actually produced, most recent first.
 *
 * A run used to leave nothing on screen that survived a reload: the report lived
 * in the action's return value, so the organizer who pressed the button saw the
 * counts once and the grades themselves only ever appeared folded into a
 * reviewer's queue. This is the run, readable afterwards, with the rationale the
 * model wrote and any human correction sitting beside the number it replaced
 * rather than on top of it.
 */
export async function aiGrades(limit = 25): Promise<AiGradeRow[]> {
  const overrider = aliasedTable(users, 'overrider');
  return db
    .select({
      reviewId: reviews.id,
      submissionId: submissions.id,
      title: submissions.title,
      personaName: evaluatorPersonas.name,
      roundName: reviewRounds.name,
      score: reviews.score,
      overrideScore: reviews.overrideScore,
      overrideReason: reviews.overrideReason,
      overriddenBy: sql<string | null>`coalesce(${overrider.name}, ${overrider.email})`,
      overriddenAt: reviews.overriddenAt,
      comment: reviews.comment,
      rubric: reviews.rubric,
      model: reviews.model,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .innerJoin(submissions, eq(submissions.id, reviews.submissionId))
    .innerJoin(reviewRounds, eq(reviewRounds.id, reviews.roundId))
    .leftJoin(evaluatorPersonas, eq(evaluatorPersonas.id, reviews.personaId))
    .leftJoin(overrider, eq(overrider.id, reviews.overriddenById))
    .where(eq(reviews.source, 'ai'))
    .orderBy(desc(reviews.createdAt))
    .limit(limit);
}

export type OutlierRow = {
  id: string;
  title: string;
  aiScore: number | null;
  humanScore: number | null;
  aiCount: number;
  humanCount: number;
  gap: number;
};

/**
 * Submissions where the machine and the committee disagree by `minGap` or more.
 *
 * Every status, deliberately, and deliberately unlike `mostCompetitive()` below.
 * That one is a triage aid, so it is only about work still in play. This one is
 * an audit of the evaluator itself, and a disagreement on a submission the chair
 * accepted anyway is the most interesting row in the table rather than the least.
 * Filtering to `status = 'submitted'` here would hide exactly the cases worth
 * reviewing, so do not add the filter back to match the query below.
 *
 * A submission graded by only one side has a null gap and drops out of the
 * HAVING, which is the right answer: one grade is not a disagreement.
 */
export async function scoreOutliers(minGap = 2): Promise<OutlierRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      aiScore: AI_AVG,
      humanScore: HUMAN_AVG,
      aiCount: AI_COUNT,
      humanCount: HUMAN_COUNT,
      gap: sql<number>`abs(${AI_AVG} - ${HUMAN_AVG})::float`,
    })
    .from(submissions)
    .innerJoin(reviews, eq(reviews.submissionId, submissions.id))
    .groupBy(submissions.id)
    .having(sql`abs(${AI_AVG} - ${HUMAN_AVG}) >= ${minGap}`)
    .orderBy(desc(sql`abs(${AI_AVG} - ${HUMAN_AVG})`));
}

export type CompetitiveRow = {
  id: string;
  title: string;
  combinedScore: number;
  reviewCount: number;
  aiScore: number | null;
  humanScore: number | null;
};

/**
 * The strongest undecided proposals by combined score, AI and human grades
 * averaged together. This is the top of the pile a chair reads first.
 */
export async function mostCompetitive(limit = 10): Promise<CompetitiveRow[]> {
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      combinedScore: sql<number>`avg(${reviews.score})::float`,
      reviewCount: sql<number>`count(${reviews.id})::int`,
      aiScore: AI_AVG,
      humanScore: HUMAN_AVG,
    })
    .from(submissions)
    .innerJoin(reviews, eq(reviews.submissionId, submissions.id))
    .where(eq(submissions.status, 'submitted'))
    .groupBy(submissions.id)
    .orderBy(desc(sql`avg(${reviews.score})`), asc(submissions.title))
    .limit(limit);
}

export type GradeRow = {
  reviewId: string;
  score: number;
  comment: string | null;
  rubric: Record<string, number> | null;
  /** The persona's name for an AI grade, the reviewer's for a human one. */
  by: string;
  model: string | null;
  createdAt: Date;
};

export type GradeComparisonRow = {
  submissionId: string;
  title: string;
  status: SubmissionStatus;
  human: GradeRow[];
  ai: GradeRow[];
};

/**
 * Every graded submission with its human grades and its AI grades separated.
 *
 * They are two arrays rather than one sorted list because "a human review always
 * wins on display order" is then a property of the data the template cannot get
 * wrong, in the same way blind review is a property of `reviewQueue()`.
 */
export async function gradeComparison(): Promise<GradeComparisonRow[]> {
  const rows = await db
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      status: submissions.status,
      reviewId: reviews.id,
      score: reviews.score,
      comment: reviews.comment,
      rubric: reviews.rubric,
      source: reviews.source,
      model: reviews.model,
      createdAt: reviews.createdAt,
      reviewerName: users.name,
      reviewerEmail: users.email,
      personaName: evaluatorPersonas.name,
    })
    .from(reviews)
    .innerJoin(submissions, eq(submissions.id, reviews.submissionId))
    .innerJoin(users, eq(users.id, reviews.reviewerId))
    .leftJoin(evaluatorPersonas, eq(evaluatorPersonas.id, reviews.personaId))
    .orderBy(asc(submissions.title), asc(reviews.createdAt));

  const grouped = new Map<string, GradeComparisonRow>();
  for (const row of rows) {
    let entry = grouped.get(row.submissionId);
    if (!entry) {
      entry = {
        submissionId: row.submissionId,
        title: row.title,
        status: row.status,
        human: [],
        ai: [],
      };
      grouped.set(row.submissionId, entry);
    }
    const grade: GradeRow = {
      reviewId: row.reviewId,
      score: row.score,
      comment: row.comment,
      rubric: row.rubric,
      by:
        row.source === 'ai'
          ? // A grade written before personas existed has no persona name; it is
            // still that bot user's grade, so the bot's own name is the honest label.
            (row.personaName ?? row.reviewerName ?? row.reviewerEmail)
          : (row.reviewerName ?? row.reviewerEmail),
      model: row.model,
      createdAt: row.createdAt,
    };
    if (row.source === 'ai') entry.ai.push(grade);
    else entry.human.push(grade);
  }

  // Only submissions a person has graded: the point of the table is the human
  // grade with the machine's beside it, and a row with no human grade has
  // nothing to compare against yet.
  return [...grouped.values()].filter((entry) => entry.human.length > 0);
}
