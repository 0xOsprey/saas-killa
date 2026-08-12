'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { reviews, submissions } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import {
  activeCriteria,
  activeRound,
  conflictedSubmissionIds,
  declareConflict,
  withdrawConflict,
} from '@/lib/rounds';
import { scoreCriteria } from '@/lib/rubric';

const schema = z.object({
  submissionId: z.string().uuid(),
  comment: z.string().max(4000).optional(),
});

/**
 * Send the reviewer back to the queue with a reason.
 *
 * Every refusal below used to be a bare `return`: no message, no redirect, no
 * `revalidatePath`. The reviewer filled in four criteria and a comment, pressed
 * Grade, and the page came back identical with the grade gone. `castCommitteeVote`
 * in the award feature already does this properly, and this is the same shape.
 */
function refuse(reason: 'withdrawn' | 'decided' | 'own' | 'no_round' | 'recused'): never {
  redirect(`/review?grade=${reason}`);
}

/**
 * Record or replace this reviewer's grade. Upsert rather than insert, so a
 * reviewer who changes their mind moves their own score instead of stacking a
 * second one and quietly double-weighting themselves in the average.
 *
 * The form posts whatever the round's scorecard says it posts. Numeric fields
 * land in `reviews.rubric` and are collapsed into `reviews.score`, so the
 * organizer screen, the award tally and the AI comparison all keep reading one
 * integer off the same column they always did; dropdown and free-text answers
 * land in `reviews.answers`, which nothing averages.
 */
export async function submitReview(formData: FormData): Promise<void> {
  const reviewer = await requireRole('reviewer', 'organizer');
  const input = schema.parse({
    submissionId: formData.get('submissionId'),
    comment: (formData.get('comment') as string | null)?.trim() || undefined,
  });

  // A decision is the chair's answer, not a lock on the committee's record.
  //
  // This used to refuse anything no longer 'submitted', on the grounds that a
  // late grade would make the average shift under the organizer's feet. It
  // does, and that turns out to be the point: an appeal, a shortlist re-read and
  // a second opinion after a provisional accept are all ordinary committee work,
  // and all three were impossible to file. Nothing below writes
  // `submissions.status`, so a grade landing here moves the average and leaves
  // the decision exactly where the chair put it. The chair is not surprised by
  // it either: a decided proposal now carries its status on the reviewer's card,
  // and it stays on the coverage board with its review count.
  //
  // Withdrawn is still refused. The speaker took that work back, and a grade on
  // it is a grade on something nobody is offering any more.
  const target = await db.query.submissions.findFirst({
    where: eq(submissions.id, input.submissionId),
  });
  if (!target || target.status === 'withdrawn') refuse('withdrawn');
  if (target.status !== 'submitted') refuse('decided');

  // A reviewer may not grade their own proposal.
  if (target.speakerId === reviewer.id) refuse('own');

  // A grade belongs to a round. With no round open there is nothing to file it
  // against, and silently writing it into the last closed one would reopen a
  // pass the committee has already reported on.
  const round = await activeRound();
  if (!round) refuse('no_round');

  // Somebody who has declared a conflict has said their judgement here is not
  // usable. Accepting the grade anyway would make the declaration decorative.
  const conflicted = await conflictedSubmissionIds(reviewer.id, round.id);
  if (conflicted.has(input.submissionId)) refuse('recused');

  const criteria = await activeCriteria(round.id);

  const rubric: Record<string, number> = {};
  const answers: Record<string, string> = {};
  for (const criterion of criteria) {
    const raw = formData.get(`criterion-${criterion.key}`);
    if (criterion.kind === 'numeric') {
      const value = z.coerce
        .number()
        .int()
        .min(criterion.scaleMin)
        .max(criterion.scaleMax)
        // An out-of-range number is a hand-edited form, not a reviewer's
        // opinion. The midpoint is the honest stand-in for "no usable answer".
        .catch(Math.round((criterion.scaleMin + criterion.scaleMax) / 2))
        .parse(raw);
      rubric[criterion.key] = value;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    // A skipped optional field is left out rather than stored empty, so a
    // reader can tell "answered with nothing" from "never asked".
    if (text) answers[criterion.key] = text.slice(0, 4000);
  }

  const { score, weighted } = scoreCriteria(criteria, rubric);

  await db
    .insert(reviews)
    .values({
      roundId: round.id,
      submissionId: input.submissionId,
      reviewerId: reviewer.id,
      score,
      weightedScore: weighted,
      rubric,
      answers,
      comment: input.comment ?? null,
      source: 'human',
    })
    .onConflictDoUpdate({
      target: [reviews.roundId, reviews.submissionId, reviews.reviewerId],
      set: {
        score,
        weightedScore: weighted,
        rubric,
        answers,
        comment: input.comment ?? null,
        createdAt: sql`now()`,
      },
    });

  revalidatePath('/review');
  revalidatePath('/organizer/submissions');
  revalidatePath('/organizer/abstracts');
  revalidatePath('/organizer/cfp');
}

const conflictSchema = z.object({
  submissionId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

/**
 * Step back from a proposal you cannot judge fairly.
 *
 * The assignment is deliberately left alone. Removing it would make a recusal
 * indistinguishable from work an organizer never handed out, and the number they
 * need is how much of the pile is uncovered because somebody declared. What
 * changes is that the proposal leaves this reviewer's actionable queue and
 * `submitReview` stops accepting a grade on it.
 */
export async function declareConflictOfInterest(formData: FormData): Promise<void> {
  const reviewer = await requireRole('reviewer', 'organizer');
  const input = conflictSchema.parse({
    submissionId: formData.get('submissionId'),
    reason: (formData.get('reason') as string | null)?.trim() || undefined,
  });

  const round = await activeRound();
  if (!round) refuse('no_round');

  await declareConflict({
    roundId: round.id,
    submissionId: input.submissionId,
    reviewerId: reviewer.id,
    reason: input.reason ?? null,
  });

  revalidatePath('/review');
  revalidatePath('/organizer/cfp');
  revalidatePath(`/organizer/rounds/${round.id}`);
  redirect('/review?declared=1');
}

/** Take a declaration back, which is what makes it safe to press to find out what it does. */
export async function withdrawConflictOfInterest(formData: FormData): Promise<void> {
  const reviewer = await requireRole('reviewer', 'organizer');
  const submissionId = z.string().uuid().parse(formData.get('submissionId'));

  const round = await activeRound();
  if (!round) refuse('no_round');

  await withdrawConflict({ roundId: round.id, submissionId, reviewerId: reviewer.id });

  revalidatePath('/review');
  revalidatePath('/organizer/cfp');
  revalidatePath(`/organizer/rounds/${round.id}`);
  redirect('/review?withdrawn=1');
}
