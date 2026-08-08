import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { awardNominees, awardVotes, awards, emailLog, submissions, users } from '@/db/schema';
import type { Award, VoteChannel } from '@/db/schema';
import type { Mail } from '@/lib/email';
import { env } from '@/lib/env';

/**
 * Awards: nomination, two-channel voting, weighted tallies, and the declared
 * winner.
 *
 * The tally is computed in JS rather than SQL because a weighted ballot's score
 * lives in a jsonb object keyed by organizer-defined criterion keys, and the
 * weights live in a second jsonb column on a different table. Expressing that
 * as an aggregate would be a page of `jsonb_each_text` for an arithmetic mean
 * over at most a few hundred rows.
 */

export type Criterion = { key: string; label: string; weight: number };

export type Nominee = {
  submissionId: string;
  title: string;
  speakerName: string | null;
  isFinalist: boolean;
};

export type Ballot = {
  judgeId: string;
  submissionId: string;
  channel: VoteChannel;
  scores: Record<string, number> | null;
};

/**
 * Everything one award needs to render or to decide, with the raw ballots kept
 * so a caller can re-tally under a different toggle without a second round
 * trip. No speaker email: this payload reaches the public page, and the habit
 * of never selecting a column the template must not print is what keeps
 * `reviewQueue()` honest too. `notifyWinners` joins for the address itself.
 */
export type AwardDetail = {
  award: Award;
  criteria: Criterion[];
  nominees: Nominee[];
  ballots: Ballot[];
};

export type TallyRow = Nominee & {
  /** How many judges picked this submission in this channel. */
  ballots: number;
  /** Weighted mean when the award has criteria, otherwise the ballot count. */
  score: number;
};

export type Tally = {
  channel: VoteChannel;
  weighted: boolean;
  finalistsOnly: boolean;
  rows: TallyRow[];
  /** Total ballots cast in this channel, including any for a withdrawn nominee. */
  cast: number;
  /** The unambiguous top row, or null when nobody voted or the top is tied. */
  leader: TallyRow | null;
  tied: boolean;
};

const CRITERION_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Read `awards.criteria` defensively. Postgres validates that the column is
 * jsonb and nothing more, so a hand-edited row can hold anything; a malformed
 * entry is dropped rather than allowed to produce a NaN score downstream.
 */
export function criteriaOf(award: Pick<Award, 'criteria'>): Criterion[] {
  const raw: unknown = award.criteria;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Criterion[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { key, label, weight } = entry as Partial<Criterion>;
    if (typeof key !== 'string' || !CRITERION_KEY.test(key) || seen.has(key)) continue;
    if (typeof label !== 'string' || label.length === 0) continue;
    const w = typeof weight === 'number' && Number.isFinite(weight) ? weight : 1;
    seen.add(key);
    out.push({ key, label, weight: Math.max(0, w) });
  }
  return out;
}

/**
 * Parse the organizer's criteria textarea: one criterion per line, written
 * `key | Label | weight`. The key is explicit rather than slugged from the
 * label because it is the key stored in every `award_votes.scores` object
 * already cast — deriving it from the label would orphan every stored
 * breakdown the moment someone fixed a typo in the wording.
 */
export function parseCriteriaInput(text: string): Criterion[] {
  const out: Criterion[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [rawKey, rawLabel, rawWeight] = trimmed.split('|').map((part) => part.trim());
    const key = (rawKey ?? '').toLowerCase();
    if (!CRITERION_KEY.test(key)) {
      throw new Error(
        `"${rawKey}" is not a usable criterion key: lower-case letters, digits, _ and - only.`,
      );
    }
    if (seen.has(key)) throw new Error(`duplicate criterion key "${key}"`);
    const weight = Number(rawWeight ?? '1');
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`criterion "${key}" needs a weight of 0 or more`);
    }
    seen.add(key);
    out.push({ key, label: rawLabel && rawLabel.length > 0 ? rawLabel : key, weight });
  }
  return out;
}

/** Render criteria back into the textarea format `parseCriteriaInput` reads. */
export function criteriaToInput(criteria: Criterion[]): string {
  return criteria.map((c) => `${c.key} | ${c.label} | ${c.weight}`).join('\n');
}

export const MIN_CRITERION_SCORE = 1;
export const MAX_CRITERION_SCORE = 5;

/**
 * Collapse one judge's per-criterion breakdown to a single number.
 *
 * `weightedScore()` in `src/lib/rubric.ts` does the same arithmetic but is
 * fixed to the four submission-review criteria; award criteria are whatever an
 * organizer typed, so the keys cannot be shared. The zero-divisor fallback is
 * the same: all weights zero means the unweighted mean rather than NaN.
 */
export function ballotScore(
  scores: Record<string, number> | null,
  criteria: Criterion[],
): number {
  if (!scores || criteria.length === 0) return 0;
  let total = 0;
  let divisor = 0;
  let plainTotal = 0;
  let plainCount = 0;
  for (const criterion of criteria) {
    const value = scores[criterion.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const clamped = Math.min(MAX_CRITERION_SCORE, Math.max(MIN_CRITERION_SCORE, value));
    total += clamped * criterion.weight;
    divisor += criterion.weight;
    plainTotal += clamped;
    plainCount += 1;
  }
  if (plainCount === 0) return 0;
  return divisor === 0 ? plainTotal / plainCount : total / divisor;
}

/**
 * Rank one channel's ballots. Committee and community are always tallied
 * separately and never summed: the same person may hold a committee seat and an
 * attendee ballot, and adding the two would weight them twice.
 *
 * Order is score, then how many judges backed the row, then title. The last
 * term is what makes the ranking reproducible — without it two rows on equal
 * score come back in whatever order the array happened to hold, and re-running
 * a close could pick a different winner from identical data.
 */
export function tally(
  detail: AwardDetail,
  channel: VoteChannel,
  finalistsOnly = false,
): Tally {
  // A rubric only applies to committee judging; a community ballot is always a
  // single unweighted pick, which is what the `scores` column comment says.
  const weighted = channel === 'committee' && detail.criteria.length > 0;
  const inChannel = detail.ballots.filter((b) => b.channel === channel);
  const pool = detail.nominees.filter((n) => !finalistsOnly || n.isFinalist);

  const rows: TallyRow[] = pool
    .map((nominee) => {
      // Ballots for a withdrawn nomination fall out here rather than being
      // counted for a submission that is no longer in the running.
      const forRow = inChannel.filter((b) => b.submissionId === nominee.submissionId);
      const score = weighted
        ? forRow.length === 0
          ? 0
          : forRow.reduce((sum, b) => sum + ballotScore(b.scores, detail.criteria), 0) /
            forRow.length
        : forRow.length;
      return { ...nominee, ballots: forRow.length, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.ballots !== a.ballots) return b.ballots - a.ballots;
      return a.title.localeCompare(b.title);
    });

  const contenders = rows.filter((row) => row.ballots > 0);
  const top = contenders[0] ?? null;
  const tied = contenders.length > 1 && contenders[1]!.score === top!.score;

  return {
    channel,
    weighted,
    finalistsOnly,
    rows,
    cast: inChannel.length,
    leader: top && !tied ? top : null,
    tied,
  };
}

export type CommunityWindow = 'disabled' | 'not_started' | 'open' | 'ended' | 'closed';

/**
 * Where an award sits in its community voting window. `votingOpensAt` and
 * `votingClosesAt` bound the community channel only; committee judging runs
 * until an organizer closes voting outright. A null bound is unbounded on that
 * side, so an award can open immediately and run until the close.
 */
export function communityWindow(award: Award, now = new Date()): CommunityWindow {
  // 'disabled' outranks 'closed' so an award that never ran a community ballot
  // reports one state rather than two, and the badge for it stays off the page.
  if (!award.publicVoting) return 'disabled';
  if (award.votingClosedAt) return 'closed';
  if (award.votingOpensAt && now < award.votingOpensAt) return 'not_started';
  if (award.votingClosesAt && now > award.votingClosesAt) return 'ended';
  return 'open';
}

export function committeeOpen(award: Award): boolean {
  return award.votingClosedAt === null;
}

export const COMMUNITY_WINDOW_LABELS: Record<CommunityWindow, string> = {
  disabled: 'community voting off',
  not_started: 'community voting not open yet',
  open: 'community voting open',
  ended: 'community voting window has passed',
  closed: 'voting closed',
};

/**
 * Load awards with their nominees and every ballot cast. Three queries rather
 * than one join so a nominee with no ballots and an award with no nominees both
 * survive the round trip intact.
 */
export async function awardDetails(awardId?: string): Promise<AwardDetail[]> {
  const rows = awardId
    ? await db.select().from(awards).where(eq(awards.id, awardId))
    : await db.select().from(awards).orderBy(asc(awards.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [nominees, ballots] = await Promise.all([
    db
      .select({
        awardId: awardNominees.awardId,
        submissionId: awardNominees.submissionId,
        title: submissions.title,
        speakerName: users.name,
        isFinalist: awardNominees.isFinalist,
      })
      .from(awardNominees)
      .innerJoin(submissions, eq(submissions.id, awardNominees.submissionId))
      .innerJoin(users, eq(users.id, submissions.speakerId))
      .where(inArray(awardNominees.awardId, ids))
      .orderBy(asc(submissions.title)),
    db
      .select({
        awardId: awardVotes.awardId,
        judgeId: awardVotes.judgeId,
        submissionId: awardVotes.submissionId,
        channel: awardVotes.channel,
        scores: awardVotes.scores,
      })
      .from(awardVotes)
      .where(inArray(awardVotes.awardId, ids)),
  ]);

  return rows.map((award) => ({
    award,
    criteria: criteriaOf(award),
    nominees: nominees.filter((n) => n.awardId === award.id).map(({ awardId: _, ...n }) => n),
    ballots: ballots.filter((b) => b.awardId === award.id).map(({ awardId: _, ...b }) => b),
  }));
}

export async function awardDetail(awardId: string): Promise<AwardDetail | null> {
  const [only] = await awardDetails(awardId);
  return only ?? null;
}

/** Accepted submissions an organizer can still nominate. */
export async function nominatableSubmissions() {
  return db
    .select({ id: submissions.id, title: submissions.title, speakerName: users.name })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .where(eq(submissions.status, 'accepted'))
    .orderBy(asc(submissions.title));
}

/**
 * The congratulations mail. The subject carries the award name because
 * `email_log` has no award column: the only key `notifyWinners` can dedupe on
 * is (kind, submissionId, subject), and one submission can win two awards.
 */
export function awardWinnerMail(
  to: string,
  title: string,
  awardName: string,
  eventName: string,
): Mail {
  return {
    to,
    subject: `Congratulations — "${title}" won ${awardName}`,
    text: [
      `"${title}" has won ${awardName} at ${eventName}.`,
      '',
      'Congratulations, and thank you for bringing it to the programme.',
      '',
      `The result is published here: ${env().APP_URL}/awards`,
    ].join('\n'),
  };
}

export const WINNER_EMAIL_KIND = 'award_winner';

export type PendingWinner = {
  awardName: string;
  submissionId: string;
  title: string;
  speakerId: string;
  speakerEmail: string;
  mail: Mail;
};

/**
 * Declared winners nobody has been told about yet. The organizer page counts
 * these so the send button states what it will actually do, and `notifyWinners`
 * sends exactly this list — one source for the count and for the work, so the
 * two cannot drift apart.
 */
export async function winnersAwaitingNotification(eventName: string): Promise<PendingWinner[]> {
  const declared = await db
    .select({
      awardName: awards.name,
      submissionId: submissions.id,
      title: submissions.title,
      speakerId: users.id,
      speakerEmail: users.email,
    })
    .from(awards)
    .innerJoin(submissions, eq(submissions.id, awards.winnerSubmissionId))
    .innerJoin(users, eq(users.id, submissions.speakerId));

  const logged = await db
    .select({ submissionId: emailLog.submissionId, subject: emailLog.subject })
    .from(emailLog)
    .where(eq(emailLog.kind, WINNER_EMAIL_KIND));
  const sent = new Set(logged.map((row) => `${row.submissionId}:${row.subject}`));

  return declared
    .map((winner) => ({
      ...winner,
      mail: awardWinnerMail(
        winner.speakerEmail,
        winner.title,
        winner.awardName,
        eventName,
      ),
    }))
    .filter((winner) => !sent.has(`${winner.submissionId}:${winner.mail.subject}`));
}
