import Link from 'next/link';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader } from '@/components/ui';
import { dayLabel } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { criteriaByRound, poolsByRound, roundSummaries } from '@/lib/rounds';
import { createRound } from './actions';
import { ScorecardSummary } from './Scorecard';

const ERRORS: Record<string, string> = {
  'round-name': 'Give the round a name.',
  'round-order': 'A round cannot close before it opens.',
};

const SAVED: Record<string, string> = {
  'round-created': 'Round created. It starts with the four default criteria; edit them below.',
};

function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * The evaluation plan: every pass of review with its window, its scorecard, its
 * committee and whether it is blind.
 *
 * Everything here used to be one four-line panel on the call-for-papers screen,
 * where a round was a name and an optional deadline and every round in the
 * conference graded against the same four criteria compiled into the app. The
 * list shows each round's scorecard inline on purpose: whether two rounds really
 * differ is a question you can only answer by seeing both.
 */
export default async function OrganizerRoundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [event, rounds, criteria, pools] = await Promise.all([
    getEvent(),
    roundSummaries(),
    criteriaByRound(),
    poolsByRound(),
  ]);

  const error = one(params.error);
  const saved = one(params.saved);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Review rounds"
        description={`${rounds.length} round(s). Each one carries its own dates, scorecard, reviewer pool and blind setting.`}
        action={
          <Link href="/organizer/cfp" className="text-sm text-muted underline hover:text-ink">
            Assignments and progress
          </Link>
        }
      />

      {error ? <Notice tone="bad">{ERRORS[error] ?? 'That did not work.'}</Notice> : null}
      {saved && SAVED[saved] ? <Notice tone="good">{SAVED[saved]}</Notice> : null}

      {rounds.length === 0 ? (
        <Empty>No rounds yet. Open the first one below before assigning anybody anything.</Empty>
      ) : null}

      {rounds.map((round) => {
        const pool = pools.get(round.id) ?? [];
        return (
          <Card key={round.id} className="space-y-3" data-testid={`round-card-${round.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/organizer/rounds/${round.id}`}
                    className="font-medium text-ink underline-offset-2 hover:underline"
                    data-testid={`round-link-${round.id}`}
                  >
                    {round.name}
                  </Link>
                  <Badge tone={round.open ? 'good' : 'neutral'}>
                    {round.open ? 'open' : 'closed'}
                  </Badge>
                  <Badge tone={round.blind ? 'accent' : 'warn'} data-testid={`blind-${round.id}`}>
                    {round.blind ? 'blind review' : 'names visible'}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted" data-testid={`window-${round.id}`}>
                  Opens{' '}
                  {round.opensAt ? dayLabel(round.opensAt, event.timezone) : 'as soon as created'} ·
                  closes {round.dueAt ? dayLabel(round.dueAt, event.timezone) : 'no close date'}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {round.assignments} assignment(s) across {round.submissionsCovered} proposal(s) ·{' '}
                  {round.graded} graded ·{' '}
                  {round.meanScore === null ? 'no mean yet' : `mean ${round.meanScore.toFixed(2)}`}
                </p>
              </div>
              <div className="text-right text-xs text-muted">
                {pool.length === 0 ? (
                  <span>pool: everyone with the reviewer role</span>
                ) : (
                  <span data-testid={`pool-count-${round.id}`}>
                    pool: {pool.length} reviewer(s)
                  </span>
                )}
              </div>
            </div>

            <div className="border-t border-line pt-3">
              <p className="mb-1.5 text-xs font-medium text-ink">Scorecard</p>
              <ScorecardSummary criteria={criteria.get(round.id) ?? []} />
            </div>
          </Card>
        );
      })}

      <Card className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">New round</h2>
          <p className="mt-0.5 text-xs text-muted">
            Times are in the event timezone ({event.timezone}). A new round starts with the four
            default criteria, which you then edit into whatever this pass is actually asking.
          </p>
        </div>

        <form action={createRound} className="space-y-3">
          <Field label="Name">
            <Input
              name="name"
              required
              maxLength={80}
              placeholder="Initial Review"
              data-testid="new-round-name"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Opens">
              <Input type="datetime-local" name="opensAt" data-testid="new-round-opens-at" />
            </Field>
            <Field label="Closes">
              <Input type="datetime-local" name="dueAt" data-testid="new-round-due-at" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="blind" defaultChecked data-testid="new-round-blind" />
            Blind review: hide author identity from reviewers in this round
          </label>
          <Button type="submit" data-testid="create-round">
            Create round
          </Button>
        </form>
      </Card>
    </div>
  );
}
