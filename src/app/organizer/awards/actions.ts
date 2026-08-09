'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { awardNominees, awardVotes, awards, submissions, voteChannelEnum } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import {
  WINNER_EMAIL_KIND,
  awardDetail,
  parseCriteriaInput,
  tally,
  winnersAwaitingNotification,
} from '@/lib/awards';
import { sendAndLog } from '@/lib/email';
import { wallClockToInstant } from '@/lib/format';
import { getEvent } from '@/lib/queries';

/**
 * Awards now render in three places: the organizer console, the public results
 * page, and the committee ballot. A declared winner also shows on the agenda
 * detail page, which is why `/agenda` is still in the list.
 */
function revalidateAwards() {
  revalidatePath('/organizer/awards');
  revalidatePath('/awards');
  revalidatePath('/awards/judge');
  revalidatePath('/agenda');
}

function text(formData: FormData, field: string): string | undefined {
  const value = formData.get(field);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function checked(formData: FormData, field: string): boolean {
  return formData.get(field) !== null;
}

export async function createAward(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({ name: z.string().min(2).max(120), description: z.string().max(1000).optional() })
    .parse({ name: text(formData, 'name'), description: text(formData, 'description') });

  await db.insert(awards).values({
    name: input.name,
    description: input.description ?? null,
    publicVoting: checked(formData, 'publicVoting'),
  });
  revalidateAwards();
}

/**
 * Edit the category: its wording, whether the community may vote, the window
 * that bounds them, and the weighted criteria committee judges score against.
 *
 * Times arrive as a bare wall clock from `datetime-local` and are read in the
 * event's timezone, the same way the schedule grid reads its own, so a window
 * an organizer typed in the event's zone is the window attendees experience.
 */
export async function editAward(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({
      awardId: z.string().uuid(),
      name: z.string().min(2).max(120),
      description: z.string().max(1000).optional(),
      criteria: z.string().max(4000).optional(),
      votingOpensAt: z.string().optional(),
      votingClosesAt: z.string().optional(),
    })
    .parse({
      awardId: formData.get('awardId'),
      name: text(formData, 'name'),
      description: text(formData, 'description'),
      criteria: text(formData, 'criteria'),
      votingOpensAt: text(formData, 'votingOpensAt'),
      votingClosesAt: text(formData, 'votingClosesAt'),
    });

  const event = await getEvent();
  const opensAt = input.votingOpensAt
    ? wallClockToInstant(input.votingOpensAt, event.timezone)
    : null;
  const closesAt = input.votingClosesAt
    ? wallClockToInstant(input.votingClosesAt, event.timezone)
    : null;
  if (opensAt && closesAt && opensAt >= closesAt) {
    throw new Error('Community voting has to open before it closes.');
  }

  await db
    .update(awards)
    .set({
      name: input.name,
      description: input.description ?? null,
      publicVoting: checked(formData, 'publicVoting'),
      votingOpensAt: opensAt,
      votingClosesAt: closesAt,
      criteria: parseCriteriaInput(input.criteria ?? ''),
    })
    .where(eq(awards.id, input.awardId));
  revalidateAwards();
}

/**
 * Retire a category without destroying what the committee did in it.
 *
 * This is the default way to get rid of an award, and `deleteAward` below is
 * the exception rather than the other way round. `award_votes.award_id` and
 * `award_nominees.award_id` both cascade, so a delete takes every ballot with
 * it and there is no undo; the repository already holds the opposite principle
 * for `form_questions.archived_at` and `evaluator_personas.active`, which exist
 * so graded work survives a change of mind about its container.
 */
export async function archiveAward(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));
  await db
    .update(awards)
    .set({ archivedAt: new Date() })
    .where(and(eq(awards.id, awardId), isNull(awards.archivedAt)));
  revalidateAwards();
}

/** Put an archived category back. The ballots were never touched. */
export async function restoreAward(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));
  await db.update(awards).set({ archivedAt: null }).where(eq(awards.id, awardId));
  revalidateAwards();
}

/**
 * Destroy a category outright, for the one case where nothing is lost: a
 * category nobody has voted in. A mistyped name created two minutes ago should
 * not have to live on in an archive forever.
 *
 * Two guards, and both are server-side because the button that reaches this is
 * not the only thing that can POST to it. Without `confirm=yes` it round-trips
 * through `?confirmAward=`, the same shape `deleteRoom` and `deleteTrack` use.
 * With a single ballot cast it refuses outright and says why, because at that
 * point the cascade is destroying somebody's judgement and archiving is the
 * answer.
 */
export async function deleteAward(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));

  if (formData.get('confirm') !== 'yes') {
    redirect(`/organizer/awards?confirmAward=${awardId}`);
  }

  const [ballot] = await db
    .select({ awardId: awardVotes.awardId })
    .from(awardVotes)
    .where(eq(awardVotes.awardId, awardId))
    .limit(1);
  if (ballot) {
    redirect(`/organizer/awards?award=has_ballots`);
  }

  await db.delete(awards).where(eq(awards.id, awardId));
  revalidateAwards();
  redirect('/organizer/awards');
}

const nomineeSchema = z.object({
  awardId: z.string().uuid(),
  submissionId: z.string().uuid(),
});

export async function nominate(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = nomineeSchema.parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
  });

  // Only accepted work can be nominated: an award for a talk nobody will see
  // is not a thing an organizer means to create.
  const target = await db.query.submissions.findFirst({
    where: eq(submissions.id, input.submissionId),
  });
  if (!target || target.status !== 'accepted') return;

  await db.insert(awardNominees).values(input).onConflictDoNothing();
  revalidateAwards();
}

/**
 * Take a nominee back out of the running.
 *
 * Asks first, but only when somebody has voted for this nominee. With no
 * ballots, nominating the same talk again undoes it, and a confirmation on
 * every `remove` in a list of a dozen names is friction that teaches an
 * organizer to click straight through the one that mattered.
 *
 * With ballots it is worth a stop, and the banner has to be exact about what
 * happens, because it is not what it looks like: `award_votes` carries no
 * foreign key to `award_nominees`, so nothing is deleted. The votes stop being
 * counted, because every tally joins the nominee list, and re-nominating
 * brings all of them back. Losing a standing and losing the ballots behind it
 * are different losses, and the copy says which one this is.
 */
export async function withdrawNomination(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = nomineeSchema.parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
  });

  if (formData.get('confirm') !== 'yes') {
    const [ballot] = await db
      .select({ judgeId: awardVotes.judgeId })
      .from(awardVotes)
      .where(
        and(eq(awardVotes.awardId, input.awardId), eq(awardVotes.submissionId, input.submissionId)),
      )
      .limit(1);
    if (ballot) {
      redirect(
        `/organizer/awards?confirmWithdraw=${input.submissionId}&confirmWithdrawAward=${input.awardId}`,
      );
    }
  }

  await db
    .delete(awardNominees)
    .where(
      and(
        eq(awardNominees.awardId, input.awardId),
        eq(awardNominees.submissionId, input.submissionId),
      ),
    );
  revalidateAwards();
}

/**
 * Promote out of round one, or demote back into it. One row, one flag: the
 * committee tally can then be asked for finalists alone without moving anything
 * or losing who was originally in the running.
 */
export async function setFinalist(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = nomineeSchema.extend({ isFinalist: z.enum(['true', 'false']) }).parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
    isFinalist: formData.get('isFinalist'),
  });

  await db
    .update(awardNominees)
    .set({ isFinalist: input.isFinalist === 'true' })
    .where(
      and(
        eq(awardNominees.awardId, input.awardId),
        eq(awardNominees.submissionId, input.submissionId),
      ),
    );
  revalidateAwards();
}

/**
 * Close voting and declare the result from one channel's tally.
 *
 * Which channel decides is the organizer's call at close time, because both are
 * legitimate: a committee prize reads the committee tally, a People's Choice
 * reads the community one. They are never summed, and the losing channel's
 * numbers stay on the public page so the declared result is checkable against
 * the ballots that produced it.
 *
 * A tie declares nobody. Breaking one is a judgement about the work, so it goes
 * through `overrideWinner`, which demands a reason and says so publicly, rather
 * than being silently resolved by whichever row sorted first.
 *
 * Nothing is emailed here. `notifyWinners` is a separate press, matching how
 * accept/reject already works: an organizer can close, look at the result,
 * change their mind and override, all before a word leaves the building.
 */
export async function closeVoting(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z
    .object({
      awardId: z.string().uuid(),
      decideFrom: z.enum(voteChannelEnum.enumValues),
      finalistsOnly: z.coerce.boolean(),
    })
    .parse({
      awardId: formData.get('awardId'),
      decideFrom: formData.get('decideFrom') ?? 'committee',
      finalistsOnly: formData.get('finalistsOnly') === 'true',
    });

  const detail = await awardDetail(input.awardId);
  if (!detail || detail.award.votingClosedAt) return;

  // A hand-picked winner outranks the tally. An organizer who overrode first
  // and closed second meant the override, and recomputing here would throw away
  // both their decision and the reason they gave for it.
  const winnerSubmissionId = detail.award.winnerOverrideReason
    ? detail.award.winnerSubmissionId
    : (tally(detail, input.decideFrom, input.finalistsOnly).leader?.submissionId ?? null);

  await db
    .update(awards)
    .set({ votingClosedAt: new Date(), winnerSubmissionId })
    .where(eq(awards.id, input.awardId));
  revalidateAwards();
}

/**
 * Reopen voting, refusing while a winner stands.
 *
 * The alternative was to clear the winner as a side effect, and that quietly
 * destroys an override reason — the one record of why a human overruled the
 * ballots. Retracting a published result should be a deliberate act, so it is
 * its own button: `clearWinner`, then reopen.
 */
export async function reopenVoting(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));

  const award = await db.query.awards.findFirst({ where: eq(awards.id, awardId) });
  if (!award || award.winnerSubmissionId) return;

  await db.update(awards).set({ votingClosedAt: null }).where(eq(awards.id, awardId));
  revalidateAwards();
}

/** Retract a declared result, and the override reason with it. */
export async function clearWinner(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const awardId = z.string().uuid().parse(formData.get('awardId'));
  await db
    .update(awards)
    .set({ winnerSubmissionId: null, winnerOverrideReason: null })
    .where(eq(awards.id, awardId));
  revalidateAwards();
}

/**
 * Set the winner by hand against the tally. The reason is mandatory and it is
 * printed on the public page: an overridden result that looks like a computed
 * one is dishonest, and the reason is the only thing that tells the two apart.
 */
export async function overrideWinner(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = nomineeSchema.extend({ reason: z.string().min(8).max(500) }).parse({
    awardId: formData.get('awardId'),
    submissionId: formData.get('submissionId'),
    reason: text(formData, 'reason'),
  });

  // Only a nominee can win. A submission id typed into the form by hand does
  // not become a winner without going through nomination first.
  const nominee = await db.query.awardNominees.findFirst({
    where: and(
      eq(awardNominees.awardId, input.awardId),
      eq(awardNominees.submissionId, input.submissionId),
    ),
  });
  if (!nominee) return;

  await db
    .update(awards)
    .set({ winnerSubmissionId: input.submissionId, winnerOverrideReason: input.reason })
    .where(eq(awards.id, input.awardId));
  revalidateAwards();
}

/**
 * Mail every declared winner's speaker, once.
 *
 * `email_log` is the idempotency record, exactly as its comment describes, but
 * it carries no award column — so the key is (kind, submissionId, subject) and
 * the subject names the award. That is what lets one submission that won two
 * categories receive two mails while a second press of this button sends none.
 *
 * The row is written per send rather than in one pass at the end, matching
 * `notifyDecided`: a failure halfway through leaves the speakers already told
 * marked as told, and a retry resumes instead of mailing them twice.
 */
export async function notifyWinners(): Promise<void> {
  await requireRole('organizer');
  const event = await getEvent();

  for (const winner of await winnersAwaitingNotification(event.name)) {
    await sendAndLog(winner.mail, {
      userId: winner.speakerId,
      kind: WINNER_EMAIL_KIND,
      submissionId: winner.submissionId,
    });
  }

  revalidateAwards();
}
