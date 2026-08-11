import Link from 'next/link';
import { Badge, Button, Card, Empty, Field, FieldAction, Input, Notice, PageHeader, Select } from '@/components/ui';
import { STATUS_LABELS, dayLabel, instantToWallClock } from '@/lib/format';
import {
  assignmentRoster,
  reviewerCompletion,
  reviewersWithOutstanding,
  submissionCoverage,
} from '@/lib/grading';
import { cfpIsOpen, getEvent } from '@/lib/queries';
import { activeRound, carryCandidates, previousRound, roundSummaries } from '@/lib/rounds';
import {
  addAssignment,
  autoDistribute,
  closeCfpNow,
  closeRound,
  extendCfp,
  openRound,
  remindReviewers,
  removeAssignment,
  shortlistIntoRound,
  updateCfpWindow,
} from './actions';

const ERRORS: Record<string, string> = {
  window: 'Both dates are required.',
  order: 'The call cannot close before it opens.',
  distribute: 'Check the distribution numbers and try again.',
  'no-reviewers': 'Nobody holds the reviewer role yet. Grant it on the Speakers tab first.',
  assign: 'Pick both a submission and a reviewer.',
  'not-reviewer': 'That person does not hold the reviewer role.',
  withdrawn: 'The speaker withdrew that proposal, so it is not the committee’s to hand out.',
  'self-review': 'A reviewer cannot be assigned their own proposal.',
  'no-round': 'No review round is open. Open one before assigning or reminding.',
  'round-name': 'Give the round a name.',
  'no-previous-round': 'There is no earlier round to shortlist from.',
  'nothing-shortlisted': 'Tick at least one proposal to carry forward.',
};

function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function OrganizerCfpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [event, rounds, round] = await Promise.all([getEvent(), roundSummaries(), activeRound()]);

  // Every number below is per-round. Without an open round there is nothing to
  // count, so the page renders the round panel alone rather than four empty
  // tables that look like a committee who has done nothing.
  // The shortlist is ranked by how the round before the open one scored, so it
  // is empty when the open round is the first. `previousRound` is the same
  // resolver `shortlistIntoRound` uses, which is what keeps the list on screen
  // and the rows the button carries forward drawn from one round.
  const previous = round ? await previousRound(round.id) : null;

  const [completion, coverage, roster, outstanding, shortlist] = round
    ? await Promise.all([
        reviewerCompletion(round.id),
        submissionCoverage(round.id),
        assignmentRoster(round.id),
        reviewersWithOutstanding(round.id),
        previous ? carryCandidates(previous.id) : Promise.resolve([]),
      ])
    : [[], [], [], [], []];

  const bySubmission = new Map<string, typeof roster>();
  for (const row of roster) {
    const held = bySubmission.get(row.submissionId);
    if (held) held.push(row);
    else bySubmission.set(row.submissionId, [row]);
  }

  const assignId =
    coverage.find((row) => row.submissionId === one(params.assign))?.submissionId ?? '';

  const open = cfpIsOpen(event);
  const error = one(params.error);
  const saved = one(params.saved);
  const assigned = one(params.assigned);
  const sent = one(params.sent);
  const removed = one(params.removed);
  const totalOutstanding = outstanding.reduce((sum, row) => sum + row.outstanding, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Call for papers"
        description={`${coverage.filter((row) => row.status === 'submitted').length} open of ${coverage.length} submission(s) · ${roster.length} assignment(s) · ${totalOutstanding} grade(s) outstanding.`}
        action={
          <div className="flex items-center gap-3">
            <Link
              href="/organizer/cfp/questions"
              className="text-sm text-muted underline hover:text-ink"
            >
              Submission form
            </Link>
            <Badge tone={open ? 'good' : 'neutral'}>{open ? 'call open' : 'call closed'}</Badge>
          </div>
        }
      />

      {error ? <Notice tone="bad">{ERRORS[error] ?? 'That did not work.'}</Notice> : null}
      {saved === 'window' ? <Notice tone="good">Call window saved.</Notice> : null}
      {saved === 'extended' ? (
        <Notice tone="good">Deadline extended by {one(params.days)} day(s).</Notice>
      ) : null}
      {saved === 'closed' ? <Notice tone="good">The call is now closed.</Notice> : null}
      {saved === 'round-opened' ? (
        <Notice tone="good">Round opened. New grades land in it from now on.</Notice>
      ) : null}
      {saved === 'round-closed' ? (
        <Notice tone="good">Round closed. Its scores are kept.</Notice>
      ) : null}
      {assigned ? (
        <Notice tone={Number(one(params.short)) > 0 ? 'warn' : 'good'}>
          {assigned} assignment(s) created.
          {Number(one(params.short)) > 0
            ? ` ${one(params.short)} submission(s) are still short of the target — raise the per-reviewer cap or grant the reviewer role to more people.`
            : ''}
        </Notice>
      ) : null}
      {sent ? (
        <Notice tone="good">
          {sent} reminder(s) sent, {one(params.skipped)} skipped (already reminded in the last 24
          hours).
        </Notice>
      ) : null}
      {removed ? <Notice tone="good">Assignment removed.</Notice> : null}

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">The window</h2>
          <p className="mt-0.5 text-xs text-muted">
            Times are in the event timezone ({event.timezone}). The call currently runs to{' '}
            {dayLabel(event.cfpClosesAt, event.timezone)}.
          </p>
        </div>

        <form action={updateCfpWindow} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Opens">
            <Input
              type="datetime-local"
              name="opensAt"
              required
              defaultValue={instantToWallClock(event.cfpOpensAt, event.timezone)}
              data-testid="cfp-opens-at"
            />
          </Field>
          <Field label="Closes">
            <Input
              type="datetime-local"
              name="closesAt"
              required
              defaultValue={instantToWallClock(event.cfpClosesAt, event.timezone)}
              data-testid="cfp-closes-at"
            />
          </Field>
          <Button type="submit" data-testid="save-cfp-window">
            Save window
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <form action={extendCfp}>
            <input type="hidden" name="days" value="7" />
            <Button type="submit" variant="secondary" data-testid="extend-cfp">
              Extend 7 days
            </Button>
          </form>
          <form action={closeCfpNow}>
            <Button type="submit" variant="secondary" disabled={!open} data-testid="close-cfp">
              Close now
            </Button>
          </form>
        </div>
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Review rounds</h2>
          <p className="mt-0.5 text-xs text-muted">
            Grading happens in the open round. Closing one freezes its scores rather than deleting
            them, so what the committee thought before it met stays answerable.
          </p>
        </div>

        {rounds.length === 0 ? (
          <Empty>No rounds yet. Open the first one before assigning anybody anything.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {rounds.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
                data-testid={`round-${row.id}`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{row.name}</span>
                    <Badge tone={row.open ? 'good' : 'neutral'}>
                      {row.open ? 'open' : 'closed'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {row.assignments} assignment(s) across {row.submissionsCovered} proposal(s) ·{' '}
                    {row.graded} graded ·{' '}
                    {row.meanScore === null ? 'no mean yet' : `mean ${row.meanScore.toFixed(2)}`}
                    {row.dueAt ? ` · due ${dayLabel(row.dueAt, event.timezone)}` : ''}
                  </p>
                </div>

                {row.open ? (
                  <form action={closeRound}>
                    <input type="hidden" name="roundId" value={row.id} />
                    <Button type="submit" variant="secondary" data-testid={`close-round-${row.id}`}>
                      Close round
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <form
          action={openRound}
          className="grid gap-4 border-t border-line pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        >
          <Field label="New round">
            <Input
              name="name"
              required
              maxLength={80}
              placeholder="Round 2 (shortlist)"
              data-testid="round-name"
            />
          </Field>
          <Field label="Grades due (optional)">
            <Input type="datetime-local" name="dueAt" data-testid="round-due-at" />
          </Field>
          <Button type="submit" data-testid="open-round">
            Open round
          </Button>
        </form>
      </Card>

      {round ? (
        <>
      {shortlist.length > 0 ? (
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Shortlist into {round.name}</h2>
            <p className="mt-0.5 text-xs text-muted">
              Ranked by the previous round\u2019s mean. Ticking carries the proposal forward along
              with the reviewers who already read it, on the reasoning that a second read is worth
              more from someone who remembers the first.
            </p>
          </div>

          <form action={shortlistIntoRound} className="space-y-3">
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {shortlist.map((row) => (
                <li key={row.submissionId} className="py-2">
                  <label className="flex items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      name="submissionId"
                      value={row.submissionId}
                      className="mt-1"
                      data-testid={`shortlist-${row.submissionId}`}
                    />
                    <span>
                      {row.title}
                      <span className="mt-0.5 block text-xs text-muted">
                        {row.meanScore === null
                          ? 'ungraded last round'
                          : `mean ${row.meanScore.toFixed(2)} from ${row.reviewCount} review(s)`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
              <Field label="Due (optional)">
                <Input type="datetime-local" name="dueAt" data-testid="shortlist-due-at" />
              </Field>
              <Button type="submit" data-testid="carry-forward">
                Carry forward
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Distribute proposals</h2>
            <p className="mt-0.5 text-xs text-muted">
              Fills open submissions up to the target, least-covered first, skipping anyone at the
              cap and never handing a reviewer their own proposal. Running it again tops up rather
              than reshuffles.
            </p>
          </div>

          <form action={autoDistribute} className="grid gap-4 sm:grid-cols-4 sm:items-start">
            <Field label="Reviews per submission">
              <Input
                type="number"
                name="reviewsPerSubmission"
                min={1}
                max={10}
                defaultValue={3}
                required
                data-testid="reviews-per-submission"
              />
            </Field>
            <Field label="Max per reviewer">
              <Input
                type="number"
                name="maxPerReviewer"
                min={1}
                max={500}
                defaultValue={20}
                required
                data-testid="max-per-reviewer"
              />
            </Field>
            <Field label="Due (optional)" hint="Applied to the rows this run creates.">
              <Input type="datetime-local" name="dueAt" data-testid="distribute-due-at" />
            </Field>
            <div className="flex flex-wrap items-start gap-2">
              <FieldAction>
                <label className="flex h-9 items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="matchTrack" data-testid="match-track" />
                  Match on track
                </label>
              </FieldAction>
              <FieldAction>
                <Button type="submit" data-testid="auto-distribute">
                  Distribute
                </Button>
              </FieldAction>
            </div>
          </form>
        </Card>

        <Card className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Reviewer completion</h2>
              <p className="mt-0.5 text-xs text-muted">
                Assigned is every ask ever made. Outstanding is what is still doable, so complete
                is graded over graded plus outstanding: a reviewer who did everything anyone could
                still do reads 100%. Decided first and recused account for the rest.
              </p>
            </div>
            <form action={remindReviewers}>
              <Button
                type="submit"
                variant="secondary"
                disabled={outstanding.length === 0}
                data-testid="remind-reviewers"
              >
                Remind {outstanding.length} reviewer(s)
              </Button>
            </form>
          </div>

          {completion.length === 0 ? (
            <Empty>Nobody holds the reviewer role yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 font-medium">Reviewer</th>
                  <th className="py-2 text-right font-medium">Assigned</th>
                  <th className="py-2 text-right font-medium">Graded</th>
                  <th className="py-2 text-right font-medium">Outstanding</th>
                  {/* Assigned still counts every ask ever made, which is the
                      point: an unanswered one must not vanish. These two are why
                      it can exceed graded plus outstanding, and without them on
                      screen the gap read as a reviewer who was simply behind. */}
                  <th className="py-2 text-right font-medium">Decided first</th>
                  <th className="py-2 text-right font-medium">Recused</th>
                  <th className="py-2 text-right font-medium">Overdue</th>
                  <th className="py-2 text-right font-medium">Complete</th>
                </tr>
              </thead>
              <tbody>
                {completion.map((row) => (
                  <tr
                    key={row.reviewerId}
                    className="border-b border-line last:border-0"
                    data-testid={`completion-${row.reviewerId}`}
                  >
                    <td className="py-2">
                      <span className="text-ink">{row.name ?? 'Unnamed'}</span>
                      <span className="ml-2 text-xs text-muted">{row.email}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-ink">{row.assigned}</td>
                    <td className="py-2 text-right tabular-nums text-ink">{row.graded}</td>
                    <td className="py-2 text-right tabular-nums text-ink">{row.outstanding}</td>
                    <td
                      className="py-2 text-right tabular-nums"
                      data-testid={`decided-first-${row.reviewerId}`}
                    >
                      {row.decided > 0 ? (
                        <Badge tone="warn">{row.decided}</Badge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td
                      className="py-2 text-right tabular-nums"
                      data-testid={`recused-${row.reviewerId}`}
                    >
                      {row.recused > 0 ? (
                        <Badge>{row.recused}</Badge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {row.overdue > 0 ? (
                        <Badge tone="bad">{row.overdue}</Badge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-ink">
                      {row.completionPct === null ? '—' : `${row.completionPct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card id="assign-by-hand" className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Assign by hand</h2>
            <p className="mt-0.5 text-xs text-muted">
              For the pairing the distributor cannot know about — a conflict it did not see, or an
              expert it had no history for.
            </p>
          </div>

          <form action={addAssignment} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <Field label="Submission">
              <Select name="submissionId" required defaultValue={assignId} data-testid="manual-submission">
                <option value="" disabled>
                  Choose a submission
                </option>
                {coverage.map((row) => (
                  <option key={row.submissionId} value={row.submissionId}>
                    {row.title} ({row.assigned} assigned
                    {row.status === 'submitted' ? '' : `, ${STATUS_LABELS[row.status]}`})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reviewer">
              <Select name="reviewerId" required defaultValue="" data-testid="manual-reviewer">
                <option value="" disabled>
                  Choose a reviewer
                </option>
                {completion.map((row) => (
                  <option key={row.reviewerId} value={row.reviewerId}>
                    {row.name ?? row.email} ({row.outstanding} outstanding)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due (optional)">
              <Input type="datetime-local" name="dueAt" data-testid="manual-due-at" />
            </Field>
            <Button type="submit" data-testid="manual-assign">
              Assign
            </Button>
          </form>
        </Card>

        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Coverage</h2>
            <p className="mt-0.5 text-xs text-muted">
              Every submission on the call, open ones first and thinnest coverage first inside that.
              A tick means that reviewer has graded it. Decided proposals stay on the list because
              who read them is part of how the decision was reached.
            </p>
          </div>

          {coverage.length === 0 ? <Empty>Nothing has been submitted yet.</Empty> : null}

          {coverage.map((row) => {
            const held = bySubmission.get(row.submissionId) ?? [];
            return (
              <div
                key={row.submissionId}
                className="border-b border-line py-2 last:border-0"
                data-testid={`coverage-${row.submissionId}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">
                    {row.title}
                    {row.status === 'submitted' ? null : (
                      <span
                        className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted"
                        data-testid={`coverage-status-${row.submissionId}`}
                      >
                        {STATUS_LABELS[row.status]}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted">
                    {row.trackName ? `${row.trackName} · ` : ''}
                    {row.assigned} assigned · {row.reviewCount} review(s)
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {held.length === 0 ? (
                    <Link
                      href={`?assign=${row.submissionId}#assign-by-hand`}
                      className="text-xs text-ink underline hover:text-accent"
                      data-testid={`assign-${row.submissionId}`}
                    >
                      Nobody assigned · assign
                    </Link>
                  ) : null}
                  {held.map((assignment) => (
                    <form
                      key={assignment.reviewerId}
                      action={removeAssignment}
                      className="inline-flex"
                    >
                      <input type="hidden" name="submissionId" value={assignment.submissionId} />
                      <input type="hidden" name="reviewerId" value={assignment.reviewerId} />
                      <Button
                        type="submit"
                        variant="ghost"
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs"
                        title="Remove this assignment"
                        data-testid={`unassign-${assignment.submissionId}-${assignment.reviewerId}`}
                      >
                        {assignment.graded ? '✓ ' : ''}
                        {assignment.reviewerName ?? assignment.reviewerEmail}
                        {assignment.dueAt
                          ? ` · due ${dayLabel(assignment.dueAt, event.timezone)}`
                          : ''}
                        <span aria-hidden className="text-muted">
                          ×
                        </span>
                      </Button>
                    </form>
                  ))}
                </div>
              </div>
            );
          })}
        </Card>
        </>
      ) : (
        <Notice>
          Nothing is being graded. Open a round above, and the distribution, completion and
          coverage panels come back with it.
        </Notice>
      )}
    </div>
  );
}
