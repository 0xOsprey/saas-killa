import Anthropic from '@anthropic-ai/sdk';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { reviews, submissions, tracks, userRoles, users } from '@/db/schema';
import { FORMAT_LABELS, LEVEL_LABELS } from './format';
import { RUBRIC, type RubricKey } from './rubric';

export const EVALUATOR_EMAIL = 'ai-evaluator@sessionboard.local';
export const EVALUATOR_MODEL = 'claude-sonnet-5';

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

export function evaluatorConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** The bot's user row, created on first use and granted the reviewer role. */
export async function evaluatorUser() {
  const existing = await db.query.users.findFirst({ where: eq(users.email, EVALUATOR_EMAIL) });
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ email: EVALUATOR_EMAIL, name: 'AI evaluator', isBot: true })
    .returning();
  if (!created) throw new Error('failed to create evaluator user');
  await db.insert(userRoles).values({ userId: created.id, role: 'reviewer' }).onConflictDoNothing();
  return created;
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
 * Grade one submission. The model is given the abstract, format, level and
 * track — never the speaker's name or bio, matching the blind-review rule that
 * governs human reviewers. A tool call is used rather than free text so the
 * result parses deterministically instead of by regex over prose.
 */
export async function evaluate(input: {
  title: string;
  abstract: string;
  format: keyof typeof FORMAT_LABELS;
  audienceLevel: keyof typeof LEVEL_LABELS;
  trackName: string | null;
  eventName: string;
}): Promise<Evaluation> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; the AI evaluator is disabled.');

  const client = new Anthropic({ apiKey });
  const rubricLines = Object.entries(RUBRIC)
    .map(([key, question]) => `- ${key}: ${question}`)
    .join('\n');

  const message = await client.messages.create({
    model: EVALUATOR_MODEL,
    max_tokens: 1024,
    tools: [RESPONSE_TOOL],
    tool_choice: { type: 'tool', name: 'record_evaluation' },
    system: [
      `You are one reviewer on the programme committee for ${input.eventName}.`,
      'Score each criterion from 1 (poor) to 5 (excellent) and write a short note',
      'for the other reviewers. You are advisory: a human makes the decision.',
      '',
      'Rubric:',
      rubricLines,
      '',
      'You are not told who submitted this. Do not speculate about the speaker.',
    ].join('\n'),
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
    (Object.keys(RUBRIC) as RubricKey[]).map((key) => [key, clampScore(raw[key])]),
  ) as Record<RubricKey, number>;

  const values = Object.values(rubric);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  return {
    // The stored score is the rubric mean rounded to an integer, so an AI grade
    // sits on the same 1-5 scale as a human one and averages with it cleanly.
    score: Math.min(5, Math.max(1, Math.round(mean))),
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    rubric,
  };
}

/**
 * Grade every submitted proposal the evaluator has not already seen. Returns a
 * count rather than throwing on the first failure: one bad submission should
 * not abandon the rest of the batch.
 */
export async function evaluatePending(
  eventName: string,
  limit = 50,
): Promise<{ graded: number; failed: number }> {
  const bot = await evaluatorUser();

  const pending = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      trackName: tracks.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(
      reviews,
      and(eq(reviews.submissionId, submissions.id), eq(reviews.reviewerId, bot.id)),
    )
    .where(and(eq(submissions.status, 'submitted'), isNull(reviews.id)))
    .limit(limit);

  let graded = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const result = await evaluate({ ...row, eventName });
      await db
        .insert(reviews)
        .values({
          submissionId: row.id,
          reviewerId: bot.id,
          score: result.score,
          comment: result.comment,
          source: 'ai',
          rubric: result.rubric,
          model: EVALUATOR_MODEL,
        })
        .onConflictDoUpdate({
          target: [reviews.submissionId, reviews.reviewerId],
          set: {
            score: result.score,
            comment: result.comment,
            rubric: result.rubric,
            model: EVALUATOR_MODEL,
            createdAt: sql`now()`,
          },
        });
      graded += 1;
    } catch (error) {
      failed += 1;
      console.error(`[ai-evaluator] ${row.id} failed:`, error);
    }
  }

  return { graded, failed };
}
