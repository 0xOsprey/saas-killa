'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { criterionKindEnum, reviewRounds, userRoles, users } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import {
  addCriterion,
  addToPool,
  allRounds,
  archiveCriterion,
  ensureRoundCriteria,
  removeFromPool,
  renameRound,
  restoreCriterion,
  setRoundBlind,
  updateCriterion,
} from '@/lib/rounds';
import { criterionKey } from '@/lib/rubric';

/**
 * Round configuration is its own screen rather than another panel on the call
 * for papers, because a round carries four independent things now — its window,
 * its scorecard, its committee and whether it is blind — and the call-for-papers
 * page was already the longest in the app.
 */

function revalidateRounds(roundId?: string): void {
  revalidatePath('/organizer/rounds');
  if (roundId) revalidatePath(`/organizer/rounds/${roundId}`);
  revalidatePath('/organizer/cfp');
  revalidatePath('/review');
}

/** Every outcome comes back as a query string, so the pages stay server components. */
function back(path: string, params: Record<string, string | number>): never {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  redirect(`${path}?${query.toString()}`);
}

const wallClock = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Pick a date and time');

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

async function instantOrNull(raw: string | null): Promise<Date | null> {
  if (!raw) return null;
  if (!wallClock.safeParse(raw).success) return null;
  const event = await getEvent();
  return wallClockToInstant(raw, event.timezone);
}

const roundSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

/**
 * Open a round with its own window. The new round always sorts after every
 * existing one, so "the active round" stays unambiguous, and its scorecard is
 * seeded immediately rather than on first read: an organizer who creates a round
 * and clicks straight into it should find four criteria to edit, not an empty
 * form that fills itself in when somebody happens to look at it.
 */
export async function createRound(formData: FormData): Promise<void> {
  await requireRole('organizer');

  const parsed = roundSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) back('/organizer/rounds', { error: 'round-name' });

  const opensAt = await instantOrNull(optional(formData.get('opensAt')));
  const dueAt = await instantOrNull(optional(formData.get('dueAt')));
  if (opensAt && dueAt && dueAt <= opensAt) back('/organizer/rounds', { error: 'round-order' });

  const existing = await allRounds();
  const position = existing.reduce((max, round) => Math.max(max, round.position), -1) + 1;

  const [created] = await db
    .insert(reviewRounds)
    .values({
      name: parsed.data.name,
      position,
      // Null would mean "opens the moment it is created" to `roundIsOpen`, which
      // is the same answer as now. An explicit instant is what makes the round
      // list able to show a window rather than a single deadline.
      opensAt: opensAt ?? new Date(),
      dueAt,
      blind: formData.get('blind') === 'on',
    })
    .returning();
  if (created) await ensureRoundCriteria(created.id);

  revalidateRounds(created?.id);
  back('/organizer/rounds', { saved: 'round-created' });
}

export async function saveRound(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const parsed = roundSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) back(`/organizer/rounds/${roundId}`, { error: 'round-name' });

  const opensAt = await instantOrNull(optional(formData.get('opensAt')));
  const dueAt = await instantOrNull(optional(formData.get('dueAt')));
  if (opensAt && dueAt && dueAt <= opensAt) {
    back(`/organizer/rounds/${roundId}`, { error: 'round-order' });
  }

  await renameRound({ roundId, name: parsed.data.name, opensAt, dueAt });
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'round' });
}

/**
 * Turn blind review on or off for one round.
 *
 * The setting is per round because the two passes of a real committee are not
 * the same conversation: a first read is anonymous to keep a famous name from
 * carrying a thin abstract, and a shortlist is often deliberately not, because
 * the question has become whether this speaker can hold the keynote slot.
 */
export async function setBlind(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const blind = formData.get('blind') === 'on';
  await setRoundBlind(roundId, blind);
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: blind ? 'blind-on' : 'blind-off' });
}

export async function closeRoundNow(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  await db
    .update(reviewRounds)
    .set({ closedAt: new Date() })
    .where(and(eq(reviewRounds.id, roundId), isNull(reviewRounds.closedAt)));
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'closed' });
}

/**
 * Reopen a closed round. Closing is how an organizer freezes a pass, and until
 * now it was one-way: a round closed by a misclick could only be replaced by a
 * new one, which would have left its grades behind in a container nobody was
 * grading into any more.
 */
export async function reopenRound(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  await db.update(reviewRounds).set({ closedAt: null }).where(eq(reviewRounds.id, roundId));
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'reopened' });
}

const kindSchema = z.enum(criterionKindEnum.enumValues);

const criterionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  kind: kindSchema,
  helpText: z.string().trim().max(300).optional(),
  scaleMin: z.coerce.number().int().min(0).max(99).catch(1),
  scaleMax: z.coerce.number().int().min(1).max(100).catch(5),
  weight: z.coerce.number().int().min(0).max(10).catch(1),
});

/** One choice per line is the only format that survives a comma inside a choice. */
function parseOptions(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const option = line.trim();
    if (!option || seen.has(option)) continue;
    seen.add(option);
    out.push(option);
  }
  return out;
}

function readCriterion(formData: FormData) {
  const parsed = criterionSchema.safeParse({
    label: formData.get('label'),
    kind: formData.get('kind'),
    helpText: (formData.get('helpText') as string | null)?.trim() || undefined,
    scaleMin: formData.get('scaleMin'),
    scaleMax: formData.get('scaleMax'),
    weight: formData.get('weight'),
  });
  if (!parsed.success) return null;

  // A scale with no spread cannot be rescaled onto 1-5, and a select with no
  // choices renders an empty dropdown. Both are configuration mistakes that
  // would only show up as a reviewer unable to file a grade, so they are
  // corrected here rather than refused.
  const scaleMin = parsed.data.scaleMin;
  const scaleMax = parsed.data.scaleMax > scaleMin ? parsed.data.scaleMax : scaleMin + 1;
  const options = parseOptions(formData.get('options'));

  return {
    label: parsed.data.label,
    kind: parsed.data.kind,
    helpText: parsed.data.helpText ?? null,
    scaleMin,
    scaleMax,
    options,
    weight: parsed.data.weight,
  };
}

export async function createCriterion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const input = readCriterion(formData);
  if (!input) back(`/organizer/rounds/${roundId}`, { error: 'criterion' });
  if (input.kind === 'select' && input.options.length === 0) {
    back(`/organizer/rounds/${roundId}`, { error: 'criterion-options' });
  }

  await addCriterion({ roundId, key: criterionKey(input.label), ...input });
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'criterion-added' });
}

export async function saveCriterion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const criterionId = z.string().uuid().parse(formData.get('criterionId'));
  const input = readCriterion(formData);
  if (!input) back(`/organizer/rounds/${roundId}`, { error: 'criterion' });
  if (input.kind === 'select' && input.options.length === 0) {
    back(`/organizer/rounds/${roundId}`, { error: 'criterion-options' });
  }

  await updateCriterion({ criterionId, ...input });
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'criterion-saved' });
}

export async function removeCriterion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const criterionId = z.string().uuid().parse(formData.get('criterionId'));
  await archiveCriterion(criterionId);
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'criterion-removed' });
}

export async function bringBackCriterion(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const criterionId = z.string().uuid().parse(formData.get('criterionId'));
  await restoreCriterion(criterionId);
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'criterion-restored' });
}

/**
 * Put somebody on this round's committee.
 *
 * The reviewer role is checked here rather than trusted from the picker, for the
 * reason every action under `/organizer` re-checks its own: the layout guard
 * does not run for a direct invocation, and a pool holding a speaker account
 * would hand them a queue of proposals they were never cleared to read.
 */
export async function addPoolMember(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const reviewerId = z.string().uuid().parse(formData.get('reviewerId'));

  const holdsRole = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(userRoles.userId, reviewerId),
        eq(userRoles.role, 'reviewer'),
        eq(users.isBot, false),
      ),
    );
  if (holdsRole.length === 0) back(`/organizer/rounds/${roundId}`, { error: 'not-reviewer' });

  await addToPool(roundId, reviewerId);
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'pool-added' });
}

export async function removePoolMember(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const roundId = z.string().uuid().parse(formData.get('roundId'));
  const reviewerId = z.string().uuid().parse(formData.get('reviewerId'));
  await removeFromPool(roundId, reviewerId);
  revalidateRounds(roundId);
  back(`/organizer/rounds/${roundId}`, { saved: 'pool-removed' });
}
