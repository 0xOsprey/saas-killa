'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { evaluatorPersonas, users } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import {
  DEFAULT_BATCH,
  MAX_BATCH,
  createPersonaWithBotUser,
  evaluatorConfigured,
  findPersona,
  runPersona,
  summarise,
} from '@/lib/ai-evaluator';
import type { RunReport } from '@/lib/ai-evaluator';
import { getEvent } from '@/lib/queries';
import { RUBRIC_KEYS } from '@/lib/rubric';

function revalidateEvaluators() {
  revalidatePath('/organizer/evaluators');
  revalidatePath('/organizer/evaluators/audit');
}

const textField = z.string().trim().max(400).optional();

const personaSchema = z.object({
  name: z.string().trim().min(2).max(80),
  profession: textField,
  tone: textField,
  expertise: textField,
});

/** A weight of 0 drops a criterion; anything unparseable falls back to even. */
const weightSchema = z.coerce.number().int().min(0).max(10).catch(1);

function readPersona(formData: FormData) {
  return personaSchema.parse({
    name: formData.get('name'),
    profession: formData.get('profession') ?? undefined,
    tone: formData.get('tone') ?? undefined,
    expertise: formData.get('expertise') ?? undefined,
  });
}

function readWeights(formData: FormData): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const key of RUBRIC_KEYS) {
    weights[key] = weightSchema.parse(formData.get(`weight_${key}`));
  }
  return weights;
}

/** Blank means "not set", which the prompt leaves out entirely. */
function orNull(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export async function createPersona(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = readPersona(formData);

  await createPersonaWithBotUser({
    name: input.name,
    profession: orNull(input.profession),
    tone: orNull(input.tone),
    expertise: orNull(input.expertise),
    weights: readWeights(formData),
  });

  revalidateEvaluators();
  revalidatePath('/organizer/speakers');
}

export async function updatePersona(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const personaId = z.string().uuid().parse(formData.get('personaId'));
  const input = readPersona(formData);

  const persona = await findPersona(personaId);
  if (!persona) return;

  await db
    .update(evaluatorPersonas)
    .set({
      name: input.name,
      profession: orNull(input.profession),
      tone: orNull(input.tone),
      expertise: orNull(input.expertise),
      weights: readWeights(formData),
    })
    .where(eq(evaluatorPersonas.id, personaId));

  // The bot's display name follows the persona so the reviewer list reads
  // right. Its address deliberately does not: it is the identity every grade
  // already written is attributed to.
  await db.update(users).set({ name: input.name }).where(eq(users.id, persona.userId));

  revalidateEvaluators();
  revalidatePath('/organizer/speakers');
  revalidatePath('/review');
}

/**
 * Retire a persona rather than delete it. Its grades are ordinary `reviews`
 * rows that human reviewers have already read and averaged against; destroying
 * them would silently move every affected submission's score.
 */
export async function retirePersona(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const personaId = z.string().uuid().parse(formData.get('personaId'));
  await db
    .update(evaluatorPersonas)
    .set({ active: false })
    .where(eq(evaluatorPersonas.id, personaId));
  revalidateEvaluators();
}

export async function restorePersona(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const personaId = z.string().uuid().parse(formData.get('personaId'));
  await db
    .update(evaluatorPersonas)
    .set({ active: true })
    .where(eq(evaluatorPersonas.id, personaId));
  revalidateEvaluators();
}

const runSchema = z.object({
  personaId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(MAX_BATCH).catch(DEFAULT_BATCH),
  mode: z.enum(['pending', 'replace']).catch('pending'),
});

function emptyReport(error: string | null): RunReport {
  return {
    graded: 0,
    skipped: 0,
    failed: 0,
    overCap: 0,
    runs: [],
    ranAt: new Date().toISOString(),
    error,
  };
}

/**
 * Run one persona and hand the outcome back to the page. The result is the
 * return value rather than a log line, because an organizer who pressed a button
 * is owed a report and `console.error` is not one.
 */
export async function runPersonaEvaluation(_previous: RunReport | null, formData: FormData): Promise<RunReport> {
  await requireRole('organizer');
  const input = runSchema.parse({
    personaId: formData.get('personaId'),
    limit: formData.get('limit'),
    mode: formData.get('mode'),
  });

  if (!evaluatorConfigured()) {
    return emptyReport('ANTHROPIC_API_KEY is not set, so the evaluator is off. Nothing was called.');
  }

  const persona = await findPersona(input.personaId);
  if (!persona) return emptyReport('That persona no longer exists.');
  if (!persona.active) {
    return emptyReport(`${persona.name} is retired. Restore it before running it.`);
  }

  const event = await getEvent();
  const run = await runPersona(persona, {
    eventName: event.name,
    limit: input.limit,
    replace: input.mode === 'replace',
  });

  revalidateEvaluators();
  revalidatePath('/organizer/submissions');
  revalidatePath('/review');

  return { ...summarise([run]), ranAt: new Date().toISOString(), error: null };
}
