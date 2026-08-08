import Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { evaluatorPersonas, reviews, submissions, tracks, userRoles, users } from '@/db/schema';
import type { AudienceLevel, EvaluatorPersona, SubmissionFormat } from '@/db/schema';
import { FORMAT_LABELS, LEVEL_LABELS } from './format';
import { DEFAULT_WEIGHTS, RUBRIC, RUBRIC_KEYS, type RubricKey, weightedScore } from './rubric';

/** v1's single hardcoded evaluator. It is now a persona row like any other. */
export const EVALUATOR_EMAIL = 'ai-evaluator@sessionboard.local';
export const EVALUATOR_MODEL = 'claude-sonnet-5';
export const DEFAULT_PERSONA_NAME = 'AI evaluator';

/**
 * A run holds one server action open for one Anthropic call per submission, so
 * the batch size is the organizer's blast radius as much as their throughput.
 * The ceiling matches what v1 did implicitly; the default is lower because a
 * first run is usually a trial.
 */
export const MAX_BATCH = 50;
export const DEFAULT_BATCH = 25;
export const BATCH_OPTIONS = [5, 10, 25, 50] as const;

/** One request may retry once; past that the batch stalls behind one bad row. */
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_MAX_RETRIES = 1;

/**
 * The rubric moved to `./rubric` so human reviewers grade against the same
 * criteria. Re-exported here because the prompt, the UI legend and the stored
 * breakdown all still resolve it through this module.
 */
export { RUBRIC };
export type { RubricKey };

export type Evaluation = {
  score: number;
  comment: string;
  rubric: Record<RubricKey, number>;
};

/**
 * Exactly the columns the model is allowed to see. Blind review is a property of
 * this type: there is no speaker name, email or bio to leak, so adding one is a
 * visible edit to a named type rather than an accident inside a prompt string.
 */
export type BlindSubmission = {
  title: string;
  abstract: string;
  format: SubmissionFormat;
  audienceLevel: AudienceLevel;
  trackName: string | null;
};

/** The persona fields the prompt and the weighted score read. */
export type PersonaPrompt = Pick<
  EvaluatorPersona,
  'name' | 'profession' | 'tone' | 'expertise' | 'weights'
>;

export type EvaluationFailure = {
  submissionId: string;
  title: string;
  reason: string;
};

export type PersonaRunResult = {
  personaId: string;
  personaName: string;
  limit: number;
  replaced: boolean;
  graded: number;
  /** Already carried this persona's grade, so the default run left them alone. */
  skipped: number;
  failed: number;
  /** Eligible rows the cap left for the next run. */
  overCap: number;
  failures: EvaluationFailure[];
};

export type RunResult = {
  graded: number;
  skipped: number;
  failed: number;
  overCap: number;
  runs: PersonaRunResult[];
};

/**
 * What the organizer screen holds onto between runs. The run summary lives in
 * the action's return value and nowhere else: `email_log` records messages that
 * left the building, and a run is not one.
 */
export type RunReport = RunResult & {
  ranAt: string;
  error: string | null;
};

export function evaluatorConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** The legacy bot's user row, created on first use and granted the reviewer role. */
export async function evaluatorUser() {
  const existing = await db.query.users.findFirst({ where: eq(users.email, EVALUATOR_EMAIL) });
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ email: EVALUATOR_EMAIL, name: DEFAULT_PERSONA_NAME, isBot: true })
    .returning();
  if (!created) throw new Error('failed to create evaluator user');
  await db.insert(userRoles).values({ userId: created.id, role: 'reviewer' }).onConflictDoNothing();
  return created;
}

/**
 * The bot address a persona's grades attribute to. Derived from the name so it
 * is readable in the reviewer list, and never recomputed after creation: a
 * rename that moved the address would orphan every grade the persona had
 * already written.
 */
export function personaEmail(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'persona';
  return `${slug}@sessionboard.local`;
}

/**
 * Create a persona and the bot user that owns its grades, exactly as v1 created
 * its single evaluator. Two personas may be given the same name; the address is
 * suffixed rather than rejected, because the name is a label and the address is
 * an identity.
 */
export async function createPersonaWithBotUser(input: {
  name: string;
  profession: string | null;
  tone: string | null;
  expertise: string | null;
  weights: Record<string, number>;
}): Promise<EvaluatorPersona> {
  const base = personaEmail(input.name);
  let email = base;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const clash = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!clash) break;
    email = base.replace('@', `-${attempt}@`);
  }

  const [bot] = await db
    .insert(users)
    .values({ email, name: input.name, isBot: true })
    .returning();
  if (!bot) throw new Error(`failed to create the bot user for ${input.name}`);
  await db.insert(userRoles).values({ userId: bot.id, role: 'reviewer' }).onConflictDoNothing();

  const [created] = await db
    .insert(evaluatorPersonas)
    .values({
      userId: bot.id,
      name: input.name,
      profession: input.profession,
      tone: input.tone,
      expertise: input.expertise,
      weights: input.weights,
    })
    .returning();
  if (!created) throw new Error(`failed to create the persona ${input.name}`);
  return created;
}

/**
 * Adopt v1's hardcoded evaluator as a persona row. Its grades were written under
 * one bot user with no persona id, so the id is backfilled onto them here: a
 * re-run replaces its own history rather than refusing to touch rows it cannot
 * prove are its own.
 */
export async function ensureDefaultPersona(): Promise<EvaluatorPersona> {
  const bot = await evaluatorUser();
  const existing = await db.query.evaluatorPersonas.findFirst({
    where: eq(evaluatorPersonas.userId, bot.id),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(evaluatorPersonas)
    .values({
      userId: bot.id,
      name: DEFAULT_PERSONA_NAME,
      profession: 'Programme committee reviewer',
      tone: 'Direct, specific, and short',
      expertise: 'General conference programming across every track',
      weights: DEFAULT_WEIGHTS,
    })
    .returning();
  if (!created) throw new Error('failed to create the default evaluator persona');

  await db
    .update(reviews)
    .set({ personaId: created.id })
    .where(
      and(eq(reviews.reviewerId, bot.id), eq(reviews.source, 'ai'), isNull(reviews.personaId)),
    );
  return created;
}

export async function allPersonas(): Promise<EvaluatorPersona[]> {
  return db.select().from(evaluatorPersonas).orderBy(asc(evaluatorPersonas.createdAt));
}

/**
 * The personas a batch run should use. An empty table means a database that
 * predates personas, so the legacy evaluator is adopted; a table where every
 * persona is retired means an organizer switched the evaluator off, and that
 * answer is nothing.
 */
export async function personasForRun(): Promise<EvaluatorPersona[]> {
  const all = await allPersonas();
  if (all.length === 0) return [await ensureDefaultPersona()];
  return all.filter((persona) => persona.active);
}

export async function findPersona(id: string): Promise<EvaluatorPersona | null> {
  const found = await db.query.evaluatorPersonas.findFirst({
    where: eq(evaluatorPersonas.id, id),
  });
  return found ?? null;
}

/**
 * Keep only the criterion keys the rubric actually defines. A persona saved
 * before a criterion existed, or edited by hand, must not push an unknown key
 * into the weighted mean.
 */
function personaWeights(persona: PersonaPrompt): Partial<Record<RubricKey, number>> {
  const picked: Partial<Record<RubricKey, number>> = {};
  for (const key of RUBRIC_KEYS) {
    const weight = persona.weights[key];
    if (typeof weight === 'number' && Number.isFinite(weight) && weight >= 0) picked[key] = weight;
  }
  return picked;
}

const RESPONSE_TOOL: Anthropic.Tool = {
  name: 'record_evaluation',
  description: 'Record the evaluation of one conference submission.',
  input_schema: {
    type: 'object',
    properties: {
      ...Object.fromEntries(
        Object.entries(RUBRIC).map(([key, question]) => [
          key,
          { type: 'integer', minimum: 1, maximum: 5, description: question },
        ]),
      ),
      comment: {
        type: 'string',
        description:
          'Two or three sentences for the human reviewers: the strongest reason to accept and the ' +
          'clearest weakness. Address the proposal, never the speaker.',
      },
    },
    required: [...Object.keys(RUBRIC), 'comment'],
  },
};

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/**
 * Build the persona's instructions. The weights are deliberately absent: they
 * decide how much each criterion counts after the fact, and telling the model
 * which one the committee cares about most would inflate that criterion's raw
 * score instead of weighting an honest one.
 */
function systemPrompt(persona: PersonaPrompt, eventName: string): string {
  const who = persona.profession ? `${persona.name}, ${persona.profession},` : `${persona.name},`;
  const lines = [`You are ${who} one reviewer on the programme committee for ${eventName}.`];
  if (persona.expertise) lines.push(`You judge from this expertise: ${persona.expertise}.`);
  if (persona.tone) lines.push(`Write your note in this tone: ${persona.tone}.`);
  lines.push(
    '',
    'Score each criterion from 1 (poor) to 5 (excellent) and write a short note',
    'for the other reviewers. You are advisory: a human makes the decision.',
    '',
    'Rubric:',
    ...Object.entries(RUBRIC).map(([key, question]) => `- ${key}: ${question}`),
    '',
    'You are not told who submitted this. Do not speculate about the speaker.',
  );
  return lines.join('\n');
}

/**
 * Grade one submission as one persona. The model is given the abstract, format,
 * level and track — never the speaker's name, email or bio, matching the blind
 * review rule that governs human reviewers. A tool call is used rather than free
 * text so the result parses deterministically instead of by regex over prose.
 */
export async function evaluate(
  persona: PersonaPrompt,
  input: BlindSubmission & { eventName: string },
): Promise<Evaluation> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; the AI evaluator is disabled.');

  const client = new Anthropic({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: REQUEST_MAX_RETRIES,
  });

  const message = await client.messages.create({
    model: EVALUATOR_MODEL,
    max_tokens: 1024,
    tools: [RESPONSE_TOOL],
    tool_choice: { type: 'tool', name: 'record_evaluation' },
    system: systemPrompt(persona, input.eventName),
    messages: [
      {
        role: 'user',
        content: [
          `Title: ${input.title}`,
          `Format: ${FORMAT_LABELS[input.format]}`,
          `Audience level: ${LEVEL_LABELS[input.audienceLevel]}`,
          `Track: ${input.trackName ?? 'unassigned'}`,
          '',
          'Abstract:',
          input.abstract,
        ].join('\n'),
      },
    ],
  });

  const call = message.content.find((block) => block.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    throw new Error('evaluator returned no tool call');
  }
  const raw = call.input as Record<string, unknown>;

  const rubric = Object.fromEntries(
    RUBRIC_KEYS.map((key) => [key, clampScore(raw[key])]),
  ) as Record<RubricKey, number>;

  return {
    // The persona's weights collapse the breakdown to the single 1-5 integer
    // every existing consumer reads off `reviews.score`, so a weighted AI grade
    // still averages with a human one on the same scale.
    score: weightedScore(rubric, personaWeights(persona)),
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    rubric,
  };
}

function failureReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Grade the submitted pool as one persona.
 *
 * `replace` is the difference between the two buttons an organizer has: the
 * default leaves rows this persona has already graded alone, and replace
 * regrades them after a rubric or weight change. Every candidate is selected
 * rather than a `LIMIT`ed page, because the count the cap left behind is part of
 * the report and a limited query cannot tell you what it dropped.
 */
export async function runPersona(
  persona: EvaluatorPersona,
  options: { eventName: string; roundId: string; limit?: number; replace?: boolean },
): Promise<PersonaRunResult> {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_BATCH));
  const replace = options.replace ?? false;
  const { roundId } = options;

  const candidates = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
      alreadyGraded: sql<boolean>`${reviews.id} is not null`,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(
      reviews,
      and(
        eq(reviews.submissionId, submissions.id),
        eq(reviews.reviewerId, persona.userId),
        // Scoped to the round being graded. A persona that read this proposal in
        // round one has not read it in round two, and treating the earlier grade
        // as "already done" would make a shortlist round a no-op.
        eq(reviews.roundId, roundId),
      ),
    )
    .where(eq(submissions.status, 'submitted'))
    .orderBy(asc(submissions.createdAt));

  const eligible = replace ? candidates : candidates.filter((row) => !row.alreadyGraded);
  const batch = eligible.slice(0, limit);

  const result: PersonaRunResult = {
    personaId: persona.id,
    personaName: persona.name,
    limit,
    replaced: replace,
    graded: 0,
    skipped: candidates.length - eligible.length,
    failed: 0,
    overCap: eligible.length - batch.length,
    failures: [],
  };

  for (const row of batch) {
    try {
      const evaluation = await evaluate(persona, {
        title: row.title,
        abstract: row.abstract,
        format: row.format,
        audienceLevel: row.audienceLevel,
        trackName: row.trackName,
        eventName: options.eventName,
      });

      // `setWhere` is the guard that keeps a re-run inside its own lane: the
      // update fires only when the row it collided with is this persona's AI
      // grade. A human grade, or another persona's, is left exactly as it was.
      const written = await db
        .insert(reviews)
        .values({
          roundId,
          submissionId: row.id,
          reviewerId: persona.userId,
          score: evaluation.score,
          comment: evaluation.comment,
          source: 'ai',
          rubric: evaluation.rubric,
          model: EVALUATOR_MODEL,
          personaId: persona.id,
        })
        .onConflictDoUpdate({
          target: [reviews.roundId, reviews.submissionId, reviews.reviewerId],
          setWhere: and(eq(reviews.source, 'ai'), eq(reviews.personaId, persona.id)),
          set: {
            score: evaluation.score,
            comment: evaluation.comment,
            rubric: evaluation.rubric,
            model: EVALUATOR_MODEL,
            personaId: persona.id,
            createdAt: sql`now()`,
          },
        })
        .returning({ id: reviews.id });

      if (written.length === 0) {
        result.failed += 1;
        result.failures.push({
          submissionId: row.id,
          title: row.title,
          reason: 'an existing grade on this row belongs to another reviewer, not replaced',
        });
        continue;
      }
      result.graded += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        submissionId: row.id,
        title: row.title,
        reason: failureReason(error),
      });
      console.error(`[ai-evaluator] ${persona.name} failed on ${row.id}:`, error);
    }
  }

  return result;
}

/**
 * Run every active persona over what it has not already graded, inside one
 * round. The round is an explicit argument rather than looked up here, because
 * the two callers reach it differently: a server action already holds the open
 * round, and the CLI has to be told which one it is grading into.
 */
export async function evaluatePending(
  eventName: string,
  roundId: string,
  limit = DEFAULT_BATCH,
): Promise<RunResult> {
  const personas = await personasForRun();
  const runs: PersonaRunResult[] = [];
  for (const persona of personas) {
    runs.push(await runPersona(persona, { eventName, roundId, limit }));
  }
  return summarise(runs);
}

export function summarise(runs: PersonaRunResult[]): RunResult {
  return {
    graded: runs.reduce((total, run) => total + run.graded, 0),
    skipped: runs.reduce((total, run) => total + run.skipped, 0),
    failed: runs.reduce((total, run) => total + run.failed, 0),
    overCap: runs.reduce((total, run) => total + run.overCap, 0),
    runs,
  };
}
