import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Select } from '@/components/ui';
import { dayLabel, instantToWallClock } from '@/lib/format';
import {
  assignmentRoster,
  reviewerCompletion,
  reviewersWithOutstanding,
  submissionCoverage,
} from '@/lib/grading';
import { cfpIsOpen, getEvent } from '@/lib/queries';
import {
  addAssignment,
  autoDistribute,
  closeCfpNow,
  extendCfp,
  remindReviewers,
  removeAssignment,
  updateCfpWindow,
} from './actions';

const ERRORS: Record<string, string> = {
  window: 'Both dates are required.',
  order: 'The call cannot close before it opens.',
  distribute: 'Check the distribution numbers and try again.',
  'no-reviewers': 'Nobody holds the reviewer role yet. Grant it on the Speakers tab first.',
  assign: 'Pick both a submission and a reviewer.',
  'not-reviewer': 'That person does not hold the reviewer role.',
  decided: 'That submission has already been decided.',
  'self-review': 'A reviewer cannot be assigned their own proposal.',
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
  const [event, completion, coverage, roster, outstanding] = await Promise.all([
    getEvent(),
    reviewerCompletion(),
    submissionCoverage(),
    assignmentRoster(),
    reviewersWithOutstanding(),
  ]);

  const bySubmission = new Map<string, typeof roster>();
  for (const row of roster) {
    const held = bySubmission.get(row.submissionId);
    if (held) held.push(row);
    else bySubmission.set(row.submissionId, [row]);
  }

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
        description={`${coverage.length} open submission(s) · ${roster.length} assignment(s) · ${totalOutstanding} grade(s) outstanding.`}
        action={
          <Badge tone={open ? 'good' : 'neutral'}>{open ? 'call open' : 'call closed'}</Badge>
        }
      />

      {error ? <Notice tone="bad">{ERRORS[error] ?? 'That did not work.'}</Notice> : null}
      {saved === 'window' ? <Notice tone="good">Call window saved.</Notice> : null}
      {saved === 'extended' ? (
        <Notice tone="good">Deadline extended by {one(params.days)} day(s).</Notice>
      ) : null}
      {saved === 'closed' ? <Notice tone="good">The call is now closed.</Notice> : null}
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
          <h2 className="text-sm font-semibold text-ink">Distribute proposals</h2>
          <p className="mt-0.5 text-xs text-muted">
            Fills open submissions up to the target, least-covered first, skipping anyone at the
            cap and never handing a reviewer their own proposal. Running it again tops up rather
            than reshuffles.
          </p>
        </div>

        <form action={autoDistribute} className="grid gap-4 sm:grid-cols-4 sm:items-end">
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
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="matchTrack" data-testid="match-track" />
              Match on track
            </label>
            <Button type="submit" data-testid="auto-distribute">
              Distribute
            </Button>
          </div>
        </form>
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Reviewer completion</h2>
            <p className="mt-0.5 text-xs text-muted">
              Outstanding counts only ungraded assignments on submissions still open, so a
              decided proposal never nags anybody.
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

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Assign by hand</h2>
          <p className="mt-0.5 text-xs text-muted">
            For the pairing the distributor cannot know about — a conflict it did not see, or an
            expert it had no history for.
          </p>
        </div>

        <form action={addAssignment} className="grid gap-4 sm:grid-cols-4 sm:items-end">
          <Field label="Submission">
            <Select name="submissionId" required defaultValue="" data-testid="manual-submission">
              <option value="" disabled>
                Choose a submission
              </option>
              {coverage.map((row) => (
                <option key={row.submissionId} value={row.submissionId}>
                  {row.title} ({row.assigned} assigned)
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
            Open submissions, thinnest coverage first. A tick means that reviewer has graded it.
          </p>
        </div>

        {coverage.length === 0 ? <Empty>No open submissions.</Empty> : null}

        {coverage.map((row) => {
          const held = bySubmission.get(row.submissionId) ?? [];
          return (
            <div
              key={row.submissionId}
              className="border-b border-line py-2 last:border-0"
              data-testid={`coverage-${row.submissionId}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-ink">{row.title}</span>
                <span className="text-xs text-muted">
                  {row.trackName ? `${row.trackName} · ` : ''}
                  {row.assigned} assigned · {row.reviewCount} review(s)
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {held.length === 0 ? (
                  <span className="text-xs text-muted">Nobody assigned.</span>
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
    </div>
  );
}
