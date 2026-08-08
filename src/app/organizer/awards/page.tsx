import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LinkButton,
  Notice,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import {
  COMMUNITY_WINDOW_LABELS,
  awardDetails,
  committeeOpen,
  communityWindow,
  criteriaToInput,
  nominatableSubmissions,
  tally,
  winnersAwaitingNotification,
} from '@/lib/awards';
import { instantToWallClock } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { AwardTally } from '../../awards/AwardTally';
import {
  clearWinner,
  closeVoting,
  createAward,
  deleteAward,
  editAward,
  nominate,
  notifyWinners,
  overrideWinner,
  reopenVoting,
  setFinalist,
  withdrawNomination,
} from './actions';

/**
 * Which awards are being tallied on finalists alone. The toggle is a link
 * rather than stored state because it is a way of looking at the ballots, not a
 * property of the award; the close form carries the same flag so the result an
 * organizer declares is the one they were looking at when they pressed it.
 */
function finalistSet(raw: string | string[] | undefined): Set<string> {
  const list = Array.isArray(raw) ? raw : raw ? raw.split(',') : [];
  return new Set(list.filter((id) => id.length > 0));
}

function toggleHref(current: Set<string>, awardId: string): string {
  const next = new Set(current);
  if (!next.delete(awardId)) next.add(awardId);
  const value = [...next].join(',');
  return value.length > 0 ? `/organizer/awards?finalists=${value}` : '/organizer/awards';
}

export default async function OrganizerAwardsPage({
  searchParams,
}: {
  searchParams: Promise<{ finalists?: string | string[] }>;
}) {
  const [params, event, details, accepted] = await Promise.all([
    searchParams,
    getEvent(),
    awardDetails(),
    nominatableSubmissions(),
  ]);
  const finalistsOnly = finalistSet(params.finalists);
  // What the button will actually do, not how many winners exist: a second
  // press after a send has nothing to send, and it should say so.
  const unmailed = (await winnersAwaitingNotification(event.name)).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Awards"
        description="Nominate accepted work, run the committee and the audience separately, then declare a result."
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/awards" variant="secondary">
              Public page
            </LinkButton>
            <form action={notifyWinners}>
              <Button type="submit" disabled={unmailed === 0}>
                {unmailed === 0
                  ? 'Winners all notified'
                  : `Email ${unmailed} winner${unmailed === 1 ? '' : 's'}`}
              </Button>
            </form>
          </div>
        }
      />

      <Notice tone="accent">
        Closing voting declares a result and sends nothing. Emailing the winners is the button
        above, so a result can be reviewed, overridden or retracted before a word leaves the
        building.
      </Notice>

      {details.length === 0 ? <Empty>No award categories yet.</Empty> : null}

      {details.map((detail) => {
        const { award, criteria } = detail;
        const open = committeeOpen(award);
        const publicVote = communityWindow(award);
        const onlyFinalists = finalistsOnly.has(award.id);
        const committee = tally(detail, 'committee', onlyFinalists);
        const community = tally(detail, 'community', onlyFinalists);
        const winner = detail.nominees.find((n) => n.submissionId === award.winnerSubmissionId);
        const nominated = new Set(detail.nominees.map((n) => n.submissionId));

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
                <Badge tone={publicVote === 'open' ? 'accent' : 'neutral'}>
                  {COMMUNITY_WINDOW_LABELS[publicVote]}
                </Badge>
                {criteria.length > 0 ? (
                  <Badge>{criteria.length}-criterion rubric</Badge>
                ) : (
                  <Badge>single pick</Badge>
                )}
              </div>
            </div>

            {winner ? (
              <Notice tone={award.winnerOverrideReason ? 'warn' : 'good'}>
                <span className="font-medium">Winner: {winner.title}</span>
                <span className="text-xs"> · {winner.speakerName ?? 'Unnamed'}</span>
                {award.winnerOverrideReason ? (
                  <span className="mt-1 block text-xs">
                    Overridden by hand. Published reason: {award.winnerOverrideReason}
                  </span>
                ) : null}
              </Notice>
            ) : null}

            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-semibold text-ink">Nominees</h3>
                <Link
                  href={toggleHref(finalistsOnly, award.id)}
                  className="text-xs text-muted underline hover:text-ink"
                >
                  {onlyFinalists ? 'counting finalists only' : 'count finalists only'}
                </Link>
              </div>

              {detail.nominees.length === 0 ? (
                <p className="text-xs text-muted">Nothing nominated yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.nominees.map((nominee) => (
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
                      {award.winnerSubmissionId === nominee.submissionId ? (
                        <Badge tone="good">winner</Badge>
                      ) : null}
                      <form action={setFinalist}>
                        <input type="hidden" name="awardId" value={award.id} />
                        <input type="hidden" name="submissionId" value={nominee.submissionId} />
                        <input
                          type="hidden"
                          name="isFinalist"
                          value={nominee.isFinalist ? 'false' : 'true'}
                        />
                        <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                          {nominee.isFinalist ? 'demote' : 'promote'}
                        </Button>
                      </form>
                      {open ? (
                        <form action={withdrawNomination}>
                          <input type="hidden" name="awardId" value={award.id} />
                          <input type="hidden" name="submissionId" value={nominee.submissionId} />
                          <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                            remove
                          </Button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {open ? (
                <form action={nominate} className="flex flex-wrap items-end gap-2 pt-1">
                  <input type="hidden" name="awardId" value={award.id} />
                  <Field label="Nominate" hint="Accepted submissions only.">
                    <Select name="submissionId" className="w-72" defaultValue="" required>
                      <option value="" disabled>
                        Pick an accepted talk
                      </option>
                      {accepted
                        .filter((s) => !nominated.has(s.id))
                        .map((s) => (
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
              ) : null}
            </section>

            <div className="grid gap-4 border-t border-line pt-3 sm:grid-cols-2">
              <AwardTally tally={committee} winnerSubmissionId={award.winnerSubmissionId} />
              <AwardTally
                tally={community}
                winnerSubmissionId={award.winnerSubmissionId}
                note={award.publicVoting ? undefined : 'Community voting is off for this award.'}
              />
            </div>

            <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
              {open ? (
                <form action={closeVoting} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="awardId" value={award.id} />
                  <input
                    type="hidden"
                    name="finalistsOnly"
                    value={onlyFinalists ? 'true' : 'false'}
                  />
                  <Field label="Decide from" hint="The two tallies are never added together.">
                    <Select name="decideFrom" defaultValue="committee">
                      <option value="committee">Committee tally</option>
                      <option value="community">People&apos;s Choice tally</option>
                    </Select>
                  </Field>
                  <Button type="submit" disabled={detail.nominees.length === 0}>
                    Close voting
                  </Button>
                </form>
              ) : (
                <>
                  <form action={reopenVoting}>
                    <input type="hidden" name="awardId" value={award.id} />
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={award.winnerSubmissionId !== null}
                    >
                      Reopen voting
                    </Button>
                  </form>
                  {award.winnerSubmissionId ? (
                    <form action={clearWinner}>
                      <input type="hidden" name="awardId" value={award.id} />
                      <Button type="submit" variant="danger">
                        Retract the winner
                      </Button>
                    </form>
                  ) : null}
                  {award.winnerSubmissionId ? (
                    <p className="text-xs text-muted">
                      Reopening is refused while a winner stands: retract it first, deliberately,
                      rather than losing the override reason as a side effect.
                    </p>
                  ) : null}
                </>
              )}
            </div>

            <details className="border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                Override the winner
              </summary>
              <form action={overrideWinner} className="mt-3 max-w-xl space-y-3">
                <input type="hidden" name="awardId" value={award.id} />
                <Field label="Winner" hint="Any nominee, whatever the tally says.">
                  <Select
                    name="submissionId"
                    defaultValue={award.winnerSubmissionId ?? ''}
                    required
                  >
                    <option value="" disabled>
                      Pick a nominee
                    </option>
                    {detail.nominees.map((nominee) => (
                      <option key={nominee.submissionId} value={nominee.submissionId}>
                        {nominee.title}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Reason"
                  hint="Printed on the public page. An overridden result that looks computed is dishonest."
                >
                  <Textarea
                    name="reason"
                    className="min-h-16"
                    required
                    minLength={8}
                    defaultValue={award.winnerOverrideReason ?? ''}
                  />
                </Field>
                <Button type="submit" variant="secondary">
                  Set winner by hand
                </Button>
              </form>
            </details>

            <details className="border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                Edit this category
              </summary>
              <form action={editAward} className="mt-3 max-w-xl space-y-3">
                <input type="hidden" name="awardId" value={award.id} />
                <Field label="Name">
                  <Input name="name" required defaultValue={award.name} />
                </Field>
                <Field label="Description">
                  <Textarea
                    name="description"
                    className="min-h-16"
                    defaultValue={award.description ?? ''}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="publicVoting"
                    defaultChecked={award.publicVoting}
                    className="h-4 w-4 rounded border-line"
                  />
                  Let any signed-in attendee vote
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Community voting opens" hint={`Times in ${event.timezone}.`}>
                    <Input
                      type="datetime-local"
                      name="votingOpensAt"
                      defaultValue={
                        award.votingOpensAt
                          ? instantToWallClock(award.votingOpensAt, event.timezone)
                          : ''
                      }
                    />
                  </Field>
                  <Field label="Community voting closes">
                    <Input
                      type="datetime-local"
                      name="votingClosesAt"
                      defaultValue={
                        award.votingClosesAt
                          ? instantToWallClock(award.votingClosesAt, event.timezone)
                          : ''
                      }
                    />
                  </Field>
                </div>
                <Field
                  label="Weighted criteria"
                  hint="One per line: key | Label | weight. Empty means one unweighted pick. The key is stored in every ballot, so rename the label freely and leave the key alone."
                >
                  <Textarea
                    name="criteria"
                    className="min-h-20 font-mono text-xs"
                    defaultValue={criteriaToInput(criteria)}
                    placeholder={'impact | Impact on the field | 2\ndelivery | Delivery | 1'}
                  />
                </Field>
                <Button type="submit" variant="secondary">
                  Save
                </Button>
              </form>
            </details>

            <details className="border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-medium text-red-700">
                Delete this category
              </summary>
              <div className="mt-3 space-y-2">
                <p className="text-sm text-ink">
                  Deleting {award.name} destroys {detail.nominees.length} nominee
                  {detail.nominees.length === 1 ? '' : 's'} and {detail.ballots.length} ballot
                  {detail.ballots.length === 1 ? '' : 's'} ({committee.cast} committee,{' '}
                  {community.cast} community). Nothing about the submissions themselves changes.
                </p>
                <form action={deleteAward}>
                  <input type="hidden" name="awardId" value={award.id} />
                  <Button type="submit" variant="danger">
                    Delete {award.name}
                  </Button>
                </form>
              </div>
            </details>
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
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="publicVoting" className="h-4 w-4 rounded border-line" />
            Let any signed-in attendee vote
          </label>
          <Button type="submit" variant="secondary">
            Create
          </Button>
        </form>
      </Card>
    </div>
  );
}
