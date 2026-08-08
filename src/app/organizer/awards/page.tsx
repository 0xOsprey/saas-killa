import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { awardNominees, awardVotes, awards, submissions, users } from '@/db/schema';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { currentUser } from '@/lib/auth';
import {
  castVote,
  closeVoting,
  createAward,
  nominate,
  reopenVoting,
  withdrawNomination,
} from './actions';

export default async function AwardsPage() {
  const me = await currentUser();

  const [allAwards, accepted, nominees, votes, myVotes] = await Promise.all([
    db.select().from(awards).orderBy(asc(awards.createdAt)),
    db
      .select({
        id: submissions.id,
        title: submissions.title,
        speakerName: users.name,
      })
      .from(submissions)
      .innerJoin(users, eq(users.id, submissions.speakerId))
      .where(eq(submissions.status, 'accepted'))
      .orderBy(asc(submissions.title)),
    db
      .select({
        awardId: awardNominees.awardId,
        submissionId: awardNominees.submissionId,
        title: submissions.title,
        speakerName: users.name,
      })
      .from(awardNominees)
      .innerJoin(submissions, eq(submissions.id, awardNominees.submissionId))
      .innerJoin(users, eq(users.id, submissions.speakerId))
      .orderBy(asc(submissions.title)),
    db
      .select({
        awardId: awardVotes.awardId,
        submissionId: awardVotes.submissionId,
        votes: sql<number>`count(*)::int`,
      })
      .from(awardVotes)
      .groupBy(awardVotes.awardId, awardVotes.submissionId),
    me
      ? db.select().from(awardVotes).where(eq(awardVotes.judgeId, me.id))
      : Promise.resolve([]),
  ]);

  const voteCount = new Map(votes.map((v) => [`${v.awardId}:${v.submissionId}`, v.votes]));
  const myVoteFor = new Map(myVotes.map((v) => [v.awardId, v.submissionId]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Awards"
        description="Nominate accepted talks, let the committee vote, then declare a winner."
      />

      {allAwards.length === 0 ? <Empty>No award categories yet.</Empty> : null}

      {allAwards.map((award) => {
        const mine = nominees.filter((n) => n.awardId === award.id);
        const closed = Boolean(award.votingClosedAt);
        return (
          <Card key={award.id} className="space-y-3" data-testid={`award-${award.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-medium text-ink">{award.name}</h2>
                {award.description ? (
                  <p className="mt-0.5 text-xs text-muted">{award.description}</p>
                ) : null}
              </div>
              <Badge tone={closed ? 'good' : 'neutral'}>
                {closed ? 'voting closed' : 'voting open'}
              </Badge>
            </div>

            {mine.length === 0 ? (
              <p className="text-xs text-muted">Nothing nominated yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {mine.map((nominee) => {
                  const count = voteCount.get(`${award.id}:${nominee.submissionId}`) ?? 0;
                  const isWinner = award.winnerSubmissionId === nominee.submissionId;
                  const isMine = myVoteFor.get(award.id) === nominee.submissionId;
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
                      {isWinner ? <Badge tone="good">winner</Badge> : null}
                      <span className="text-xs tabular-nums text-muted">{count} vote(s)</span>
                      {!closed ? (
                        <>
                          <form action={castVote}>
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
                          <form action={withdrawNomination}>
                            <input type="hidden" name="awardId" value={award.id} />
                            <input
                              type="hidden"
                              name="submissionId"
                              value={nominee.submissionId}
                            />
                            <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                              remove
                            </Button>
                          </form>
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {!closed ? (
              <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <form action={nominate} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="awardId" value={award.id} />
                  <Field label="Nominate">
                    <Select name="submissionId" className="w-72" defaultValue="">
                      <option value="" disabled>
                        Pick an accepted talk
                      </option>
                      {accepted.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} — {s.speakerName ?? 'Unnamed'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button type="submit" variant="secondary">
                    Add
                  </Button>
                </form>
                <form action={closeVoting} className="ml-auto">
                  <input type="hidden" name="awardId" value={award.id} />
                  <Button type="submit" disabled={mine.length === 0}>
                    Close voting
                  </Button>
                </form>
              </div>
            ) : (
              <form action={reopenVoting} className="border-t border-line pt-3">
                <input type="hidden" name="awardId" value={award.id} />
                <Button type="submit" variant="ghost" className="text-xs">
                  Reopen voting
                </Button>
              </form>
            )}
          </Card>
        );
      })}

      <Card className="max-w-xl space-y-3">
        <h2 className="text-sm font-semibold text-ink">New award category</h2>
        <form action={createAward} className="space-y-3">
          <Field label="Name">
            <Input name="name" required placeholder="Best talk" data-testid="award-name" />
          </Field>
          <Field label="Description">
            <Textarea name="description" className="min-h-16" />
          </Field>
          <Button type="submit" variant="secondary">
            Create
          </Button>
        </form>
      </Card>
    </div>
  );
}
