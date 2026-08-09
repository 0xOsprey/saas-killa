import { Badge, Empty } from '@/components/ui';
import type { Tally } from '@/lib/awards';

const CHANNEL_LABELS = {
  committee: 'Committee',
  community: "People's Choice",
} as const;

/**
 * One channel's standings. Committee and community are rendered as two of
 * these, side by side and never added together: the primary key on
 * `award_votes` is (awardId, judgeId, channel) precisely so a judge who also
 * votes as an attendee appears in both without counting twice.
 *
 * `sealed` hides the numbers while the ballot is still open. A live committee
 * tally tells judges how their colleagues voted before they have voted
 * themselves, which is the thing blind review exists to prevent.
 *
 * The community tally on the public page is rendered without it, deliberately.
 * The harm `sealed` prevents is peer influence inside a small deciding body. A
 * People's Choice leaderboard is a running score the audience is meant to
 * watch, and hiding it until voting closed would take away the reason to vote.
 */
export function AwardTally({
  tally,
  winnerSubmissionId,
  sealed = false,
  note,
}: {
  tally: Tally;
  winnerSubmissionId: string | null;
  sealed?: boolean;
  note?: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-ink">{CHANNEL_LABELS[tally.channel]}</h3>
        <span className="text-xs text-muted">
          {tally.cast} ballot{tally.cast === 1 ? '' : 's'}
          {tally.weighted ? ' · weighted rubric' : ''}
          {tally.finalistsOnly ? ' · finalists only' : ''}
        </span>
      </div>

      {note ? <p className="text-xs text-muted">{note}</p> : null}

      {sealed ? (
        <p className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-muted">
          Sealed until voting closes.
        </p>
      ) : tally.rows.length === 0 ? (
        <Empty>Nothing to count.</Empty>
      ) : (
        <ol className="space-y-1">
          {tally.rows.map((row, index) => (
            <li
              key={row.submissionId}
              className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm"
              data-testid={`tally-${tally.channel}-${row.submissionId}`}
            >
              <span className="w-5 text-xs tabular-nums text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-ink">{row.title}</span>{' '}
                <span className="text-xs text-muted">{row.speakerName ?? 'Unnamed'}</span>
              </span>
              {row.isFinalist ? <Badge tone="accent">finalist</Badge> : null}
              {winnerSubmissionId === row.submissionId ? <Badge tone="good">winner</Badge> : null}
              <span className="text-xs tabular-nums text-muted">
                {tally.weighted
                  ? `${row.score.toFixed(2)} · ${row.ballots} ballot${row.ballots === 1 ? '' : 's'}`
                  : `${row.ballots} vote${row.ballots === 1 ? '' : 's'}`}
              </span>
            </li>
          ))}
        </ol>
      )}

      {!sealed && tally.tied ? (
        <p className="text-xs text-amber-800">
          Tied at the top. Nothing is declared from a tie; an organizer picks and says why.
        </p>
      ) : null}
    </section>
  );
}
