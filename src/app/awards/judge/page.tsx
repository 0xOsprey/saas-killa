import { redirect } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  LinkButton,
  Notice,
  PageHeader,
  Select,
} from '@/components/ui';
import { currentUser } from '@/lib/auth';
import {
  MAX_CRITERION_SCORE,
  MIN_CRITERION_SCORE,
  awardDetails,
  committeeOpen,
  tally,
} from '@/lib/awards';
import { AwardTally } from '../AwardTally';
import { castCommitteeVote } from './actions';

const BALLOT_MESSAGES: Record<string, { tone: 'good' | 'bad'; text: string }> = {
  ok: { tone: 'good', text: 'Ballot recorded. You can change it until voting closes.' },
  closed: { tone: 'bad', text: 'Voting for that award has closed, so nothing was recorded.' },
  not_nominated: { tone: 'bad', text: 'That submission is not nominated for the award.' },
  incomplete: { tone: 'bad', text: `Score every criterion from ${MIN_CRITERION_SCORE} to ${MAX_CRITERION_SCORE}.` },
  unknown: { tone: 'bad', text: 'That award no longer exists.' },
};

/**
 * The committee ballot, deliberately outside `/organizer`. The guard is here
 * rather than in a layout because `/awards` above it is public: a layout guard
 * would have to let everyone through anyway.
 */
export default async function JudgeAwardsPage({
  searchParams,
}: {
  searchParams: Promise<{ ballot?: string }>;
}) {
  const [{ ballot }, me] = await Promise.all([searchParams, currentUser()]);
  if (!me) redirect('/login');
  if (!me.roles.some((role) => role === 'organizer' || role === 'reviewer')) {
    return <Notice tone="bad">Committee access only.</Notice>;
  }

  const details = await awardDetails();
  const notice = ballot ? BALLOT_MESSAGES[ballot] : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Judge awards"
        description="One committee ballot per award. Attendee voting is counted separately."
        action={
          <LinkButton href="/awards" variant="secondary">
            Public results
          </LinkButton>
        }
      />

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {details.length === 0 ? <Empty>No award categories yet.</Empty> : null}

      {details.map((detail) => {
        const { award, criteria } = detail;
        const open = committeeOpen(award);
        const mine = detail.ballots.find((b) => b.judgeId === me.id && b.channel === 'committee');
        const myPick = detail.nominees.find((n) => n.submissionId === mine?.submissionId);

        return (
          <Card key={award.id} className="space-y-3" data-testid={`judge-award-${award.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-medium text-ink">{award.name}</h2>
                {award.description ? (
                  <p className="mt-0.5 text-xs text-muted">{award.description}</p>
                ) : null}
              </div>
              <Badge tone={open ? 'neutral' : 'good'}>
                {open ? 'voting open' : 'voting closed'}
              </Badge>
            </div>

            {myPick ? (
              <p className="text-xs text-muted">
                Your ballot: <span className="font-medium text-ink">{myPick.title}</span>
                {mine?.scores
                  ? ` · ${criteria
                      .map((c) => `${c.label} ${mine.scores?.[c.key] ?? '—'}`)
                      .join(' · ')}`
                  : ''}
              </p>
            ) : null}

            {detail.nominees.length === 0 ? (
              <p className="text-xs text-muted">Nothing nominated yet.</p>
            ) : !open ? (
              <AwardTally
                tally={tally(detail, 'committee')}
                winnerSubmissionId={award.winnerSubmissionId}
              />
            ) : criteria.length === 0 ? (
              // No criteria: one unweighted pick, exactly as v1 behaved.
              <ul className="space-y-1.5">
                {detail.nominees.map((nominee) => {
                  const isMine = mine?.submissionId === nominee.submissionId;
                  return (
                    <li
                      key={nominee.submissionId}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-ink">{nominee.title}</span>{' '}
                        <span className="text-xs text-muted">
                          {nominee.speakerName ?? 'Unnamed'}
                        </span>
                      </span>
                      {nominee.isFinalist ? <Badge tone="accent">finalist</Badge> : null}
                      <form action={castCommitteeVote}>
                        <input type="hidden" name="awardId" value={award.id} />
                        <input type="hidden" name="submissionId" value={nominee.submissionId} />
                        <Button
                          type="submit"
                          variant={isMine ? 'primary' : 'secondary'}
                          className="px-2 py-1 text-xs"
                        >
                          {isMine ? 'your ballot' : 'vote'}
                        </Button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <form action={castCommitteeVote} className="space-y-3">
                <input type="hidden" name="awardId" value={award.id} />
                <Field label="Nominee">
                  <Select
                    name="submissionId"
                    className="max-w-md"
                    defaultValue={mine?.submissionId ?? ''}
                    required
                  >
                    <option value="" disabled>
                      Pick the entry you are scoring
                    </option>
                    {detail.nominees.map((nominee) => (
                      <option key={nominee.submissionId} value={nominee.submissionId}>
                        {nominee.title}
                        {nominee.isFinalist ? ' (finalist)' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  {criteria.map((criterion) => (
                    <Field
                      key={criterion.key}
                      label={criterion.label}
                      hint={`weight ${criterion.weight} · ${MIN_CRITERION_SCORE} to ${MAX_CRITERION_SCORE}`}
                    >
                      <Select
                        name={`score_${criterion.key}`}
                        defaultValue={String(mine?.scores?.[criterion.key] ?? '')}
                        required
                      >
                        <option value="" disabled>
                          —
                        </option>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>

                <Button type="submit">{mine ? 'Update ballot' : 'Submit ballot'}</Button>
              </form>
            )}
          </Card>
        );
      })}
    </div>
  );
}
