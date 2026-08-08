import Link from 'next/link';
import { Badge, Button, Card, Empty, LinkButton, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import {
  COMMUNITY_WINDOW_LABELS,
  awardDetails,
  committeeOpen,
  communityWindow,
  tally,
} from '@/lib/awards';
import { dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { AwardTally } from './AwardTally';
import { castCommunityVote } from './actions';

const VOTE_MESSAGES: Record<string, { tone: 'good' | 'bad'; text: string }> = {
  ok: { tone: 'good', text: 'Your vote is in. You can change it while voting is open.' },
  closed: { tone: 'bad', text: 'Voting for that award is not open, so nothing was recorded.' },
  not_nominated: { tone: 'bad', text: 'That submission is not nominated for the award.' },
  unknown: { tone: 'bad', text: 'That award no longer exists.' },
};

/**
 * The public results page. Before this existed a winner was only discoverable
 * by opening the one submission's detail page and noticing a badge, which is no
 * way to publish a result.
 */
export default async function AwardsPage({
  searchParams,
}: {
  searchParams: Promise<{ vote?: string }>;
}) {
  const [{ vote }, event, details, me] = await Promise.all([
    searchParams,
    getEvent(),
    awardDetails(),
    currentUser(),
  ]);

  const notice = vote ? VOTE_MESSAGES[vote] : undefined;
  const anyOpenToVote = details.some((d) => communityWindow(d.award) === 'open');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Awards"
        description={`${event.name} · nominees, finalists and results`}
        action={
          me?.roles.some((role) => role === 'organizer' || role === 'reviewer') ? (
            <LinkButton href="/awards/judge" variant="secondary">
              Judge awards
            </LinkButton>
          ) : null
        }
      />

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {!me && anyOpenToVote ? (
        <Notice tone="accent">
          Voting is open.{' '}
          <Link href="/login" className="font-medium underline">
            Sign in
          </Link>{' '}
          to cast a ballot.
        </Notice>
      ) : null}

      {details.length === 0 ? <Empty>No award categories yet.</Empty> : null}

      {details.map((detail) => {
        const { award } = detail;
        const publicVote = communityWindow(award);
        const open = committeeOpen(award);
        const winner = detail.nominees.find((n) => n.submissionId === award.winnerSubmissionId);
        const myBallot = me
          ? detail.ballots.find((b) => b.judgeId === me.id && b.channel === 'community')
          : undefined;
        const finalists = detail.nominees.filter((n) => n.isFinalist);

        return (
          <Card key={award.id} className="space-y-4" data-testid={`award-${award.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-medium text-ink">{award.name}</h2>
                {award.description ? (
                  <p className="mt-0.5 text-xs text-muted">{award.description}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={open ? 'neutral' : 'good'}>
                  {open ? 'voting open' : 'voting closed'}
                </Badge>
                {publicVote !== 'disabled' ? (
                  <Badge tone={publicVote === 'open' ? 'accent' : 'neutral'}>
                    {COMMUNITY_WINDOW_LABELS[publicVote]}
                  </Badge>
                ) : null}
              </div>
            </div>

            {award.publicVoting && (award.votingOpensAt || award.votingClosesAt) ? (
              <p className="text-xs text-muted">
                Community voting{' '}
                {award.votingOpensAt
                  ? `opens ${dayLabel(award.votingOpensAt, event.timezone)} at ${timeOfDay(award.votingOpensAt, event.timezone)}`
                  : 'is open now'}
                {award.votingClosesAt
                  ? ` and closes ${dayLabel(award.votingClosesAt, event.timezone)} at ${timeOfDay(award.votingClosesAt, event.timezone)}`
                  : ''}
                {` · all times ${event.timezone}`}
              </p>
            ) : null}

            {winner ? (
              <Notice tone="good">
                <span className="font-medium">Winner: {winner.title}</span>
                <span className="text-xs"> · {winner.speakerName ?? 'Unnamed'}</span>
                {award.winnerOverrideReason ? (
                  <span className="mt-1 block text-xs">
                    Chosen by the organizers rather than by the tally: {award.winnerOverrideReason}
                  </span>
                ) : null}
              </Notice>
            ) : !open ? (
              <Notice>Voting has closed and no winner was declared.</Notice>
            ) : null}

            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-semibold text-ink">Nominees</h3>
                <span className="text-xs text-muted">
                  {detail.nominees.length} nominated
                  {finalists.length > 0 ? ` · ${finalists.length} finalist` : ''}
                  {finalists.length > 1 ? 's' : ''}
                </span>
              </div>

              {detail.nominees.length === 0 ? (
                <p className="text-xs text-muted">Nothing nominated yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.nominees.map((nominee) => {
                    const isMine = myBallot?.submissionId === nominee.submissionId;
                    return (
                      <li
                        key={nominee.submissionId}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 flex-1">
                          <Link
                            href={`/agenda/${nominee.submissionId}`}
                            className="font-medium text-ink hover:underline"
                          >
                            {nominee.title}
                          </Link>{' '}
                          <span className="text-xs text-muted">
                            {nominee.speakerName ?? 'Unnamed'}
                          </span>
                        </span>
                        {nominee.isFinalist ? <Badge tone="accent">finalist</Badge> : null}
                        {award.winnerSubmissionId === nominee.submissionId ? (
                          <Badge tone="good">winner</Badge>
                        ) : null}
                        {me && publicVote === 'open' ? (
                          <form action={castCommunityVote}>
                            <input type="hidden" name="awardId" value={award.id} />
                            <input
                              type="hidden"
                              name="submissionId"
                              value={nominee.submissionId}
                            />
                            <Button
                              type="submit"
                              variant={isMine ? 'primary' : 'secondary'}
                              className="px-2 py-1 text-xs"
                            >
                              {isMine ? 'your vote' : 'vote'}
                            </Button>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <div className="grid gap-4 border-t border-line pt-3 sm:grid-cols-2">
              <AwardTally
                tally={tally(detail, 'committee')}
                winnerSubmissionId={award.winnerSubmissionId}
                sealed={open}
              />
              <AwardTally
                tally={tally(detail, 'community')}
                winnerSubmissionId={award.winnerSubmissionId}
                note={
                  award.publicVoting
                    ? undefined
                    : 'Community voting is off for this award.'
                }
              />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
