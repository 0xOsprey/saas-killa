import { sql, type SQL } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** `lower(col)`, for an index that has to be case-insensitive. */
function lower(column: AnyPgColumn): SQL {
  return sql`lower(${column})`;
}

/**
 * Vocabulary, fixed once so nothing in this codebase drifts into a synonym:
 *
 *   submission    a proposal, at any status; a poster is a submission too
 *   review        one reviewer's score and comment on one submission
 *   track         a topical grouping a submission is proposed into
 *   room          a physical room sessions run in
 *   slot          a (room, start, end) box on the schedule grid
 *   award         a prize category accepted submissions are nominated into
 *   authSession   a logged-in browser session
 *   assignment    a (submission, reviewer) pair one grade is owed on
 *   revision      one logged edit to one field of one submission
 *   author        a person credited on a submission; the filer is author 0
 *   task          something a speaker owes, with a deadline
 *   bookmark      an attendee starring a submission
 *   persona       a configured AI evaluator, backed by a bot user row
 *   round         one pass of committee review; assignments and reviews belong to one
 *   question      an organizer-defined field on the submission form
 *   answer        one submission's response to one question
 *   upload        a file on this server's disk, addressed by /files/<id>
 *
 * "session" alone is deliberately never used for conference content, because it
 * would collide with the login session. Accepted submissions placed in a slot
 * are what the public agenda renders; they are still submissions.
 */

export const roleEnum = pgEnum('role', ['organizer', 'reviewer', 'speaker']);

export const submissionStatusEnum = pgEnum('submission_status', [
  'submitted',
  'accepted',
  'rejected',
  'withdrawn',
]);

export const submissionFormatEnum = pgEnum('submission_format', [
  'talk_25',
  'talk_45',
  'workshop_90',
  'lightning_10',
  'poster',
]);

export const audienceLevelEnum = pgEnum('audience_level', [
  'beginner',
  'intermediate',
  'advanced',
]);

/** Human grades and AI grades share the reviews table; this column tells them apart. */
export const reviewSourceEnum = pgEnum('review_source', ['human', 'ai']);

/**
 * Speaker-supplied content (slides, recording, resources, poster artwork) is
 * published only once an organizer approves it. 'draft' is the speaker still
 * working, 'pending' is submitted for review, 'approved' is public. Anything
 * not approved is invisible on the public detail page.
 */
export const contentStatusEnum = pgEnum('content_status', ['draft', 'pending', 'approved']);

/**
 * A committee ballot and a People's Choice ballot are counted separately, so a
 * judge who also votes as an attendee does not double-weight one submission.
 */
export const voteChannelEnum = pgEnum('vote_channel', ['committee', 'community']);

/**
 * The shapes an organizer-defined question can take. Deliberately short: every
 * one of these renders to a native input with no client-side widget, because a
 * form the organizer configures is only useful if it cannot be configured into
 * something that fails to submit.
 */
export const questionKindEnum = pgEnum('question_kind', [
  'short_text',
  'long_text',
  'select',
  'checkbox',
  'url',
]);

/**
 * What an uploaded file is for. The kind decides the size cap, the file types
 * accepted and who may read it back, so it is an enum rather than free text:
 * a typo in a kind string would otherwise widen an access rule silently.
 */
export const uploadKindEnum = pgEnum('upload_kind', [
  'headshot',
  'slides',
  'poster',
  'document',
]);

/** How a push of the programme to an outside platform ended. */
export const integrationRunStatusEnum = pgEnum('integration_run_status', [
  'running',
  'ok',
  'failed',
]);

/**
 * How a bulk file export ended. The archive is built while the organizer waits,
 * so 'queued' and 'generating' are short-lived; they are still separate states
 * because the row is what the screen reads, and a build that dies mid-way has to
 * be distinguishable from one nobody started. 'failed' keeps the reason.
 */
export const fileExportStatusEnum = pgEnum('file_export_status', [
  'queued',
  'generating',
  'ready',
  'failed',
]);

/**
 * The shapes one scorecard criterion can take.
 *
 * Deliberately three. 'numeric' is the only kind that reaches the weighted mean,
 * so the arithmetic behind `reviews.score` never has to decide what a sentence is
 * worth; 'select' and 'text' are recorded verbatim in `reviews.answers` and read
 * by a person. Nothing here renders to a client-side widget, for the same reason
 * `question_kind` is short: a scorecard an organizer configures is only useful if
 * it cannot be configured into something that fails to submit.
 */
export const criterionKindEnum = pgEnum('criterion_kind', ['numeric', 'select', 'text']);

/** What a speaker still owes: each row in speaker_tasks is one of these. */
export const speakerTaskKindEnum = pgEnum('speaker_task_kind', [
  'headshot',
  'bio',
  'slides',
  'poster',
  'confirm',
  'other',
]);

/**
 * One row. The app is single-event per deploy; the table exists so the CFP
 * window, the event name and the timezone are data rather than constants.
 */
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  tagline: text('tagline'),
  timezone: text('timezone').notNull().default('UTC'),
  startsOn: timestamp('starts_on', { withTimezone: true }).notNull(),
  endsOn: timestamp('ends_on', { withTimezone: true }).notNull(),
  cfpOpensAt: timestamp('cfp_opens_at', { withTimezone: true }).notNull(),
  cfpClosesAt: timestamp('cfp_closes_at', { withTimezone: true }).notNull(),
  agendaPublished: boolean('agenda_published').notNull().default(false),
  /**
   * Poster embargo. Null means no embargo and the gallery follows the agenda's
   * publish flag; a future timestamp hides the gallery until it passes. Posters
   * are frequently under a journal embargo the agenda is not.
   */
  posterEmbargoUntil: timestamp('poster_embargo_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name'),
    /**
     * How a speaker is billed: job title and employer, shown beside the name on
     * the roster, the public directory, the agenda card and the embed feed.
     *
     * On the person rather than on `submissionAuthors.affiliation`, which
     * credits one contributor on one paper and is right to stay there. Someone
     * who changes job changes it once, here, and every talk they are on follows.
     */
    title: text('title'),
    company: text('company'),
    bio: text('bio'),
    headshotUrl: text('headshot_url'),
    /**
     * Travel and access requirements, kept on the person rather than on a
     * submission. Someone who needs step-free access or a visa letter needs it
     * for every talk they are on, and a copy per proposal is a copy that goes
     * stale on one of them.
     */
    travelNotes: text('travel_notes'),
    /** The AI evaluator owns a user row so its grades attribute like anyone's. */
    isBot: boolean('is_bot').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(t.email)],
);

/** A user may hold more than one role; organizers are usually reviewers too. */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/**
 * Magic-link tokens. Only the SHA-256 hash is stored, so a database read does
 * not yield a usable login link. Single use: `consumedAt` is set on redemption
 * and a second redemption is rejected.
 */
export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('magic_link_tokens_hash_idx').on(t.tokenHash)],
);

/** Browser login sessions. The cookie carries the id plus an HMAC over it. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

export const tracks = pgTable('tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  colour: text('colour').notNull().default('#64748b'),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  capacity: integer('capacity'),
  position: integer('position').notNull().default(0),
});

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    speakerId: uuid('speaker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    abstract: text('abstract').notNull(),
    format: submissionFormatEnum('format').notNull(),
    audienceLevel: audienceLevelEnum('audience_level').notNull(),
    status: submissionStatusEnum('status').notNull().default('submitted'),
    /**
     * Set when an organizer sends the accept or reject email. Decision and
     * notification are deliberately separate: an organizer can flip a status
     * while deciding and nothing leaves the building until they press send.
     */
    decisionEmailedAt: timestamp('decision_emailed_at', { withTimezone: true }),
    /**
     * The placement the last schedule email described: `<startsAt>|<roomId>`,
     * or the literal `unscheduled`. Null means no schedule email has ever gone
     * out for this submission.
     *
     * This is the idempotency key for `notifySchedule`, in the same shape as
     * `decisionEmailedAt` above, and it has to hold the placement rather than a
     * timestamp: an organizer moves a talk twice and moves it back, and a
     * timestamp would send a "your time has changed" mail describing the time
     * the speaker already has.
     */
    scheduleNoticeKey: text('schedule_notice_key'),
    /**
     * RFC 5545 SEQUENCE of the last invitation sent. Incremented per notice,
     * because a calendar client ignores a re-sent VEVENT whose sequence has not
     * gone up, and the speaker would keep the superseded time with no sign
     * anything was wrong.
     */
    scheduleNoticeSeq: integer('schedule_notice_seq').notNull().default(0),
    /** Speaker's own confirmation that they will attend, after acceptance. */
    speakerConfirmedAt: timestamp('speaker_confirmed_at', { withTimezone: true }),
    /**
     * Set when the speaker says they can no longer present it.
     *
     * A column of its own rather than clearing `speakerConfirmedAt`, because the
     * two nulls mean different things to an organizer: one is somebody who has
     * not answered and needs chasing, the other is somebody who has answered and
     * needs replacing. Every existing count is `speakerConfirmedAt is null`, and
     * a decline that only cleared it would put the second person back in the
     * first queue.
     *
     * Mutually exclusive with the confirmation by construction: each of the two
     * actions clears the other, so no query has to decide which one wins.
     *
     * Not `status: 'withdrawn'`, which is the bigger move: that takes the talk
     * off the programme entirely. Declining says the accepted talk still stands
     * and this speaker cannot give it.
     */
    speakerDeclinedAt: timestamp('speaker_declined_at', { withTimezone: true }),
    /** ePoster artwork. Only meaningful when format is 'poster'. */
    posterUrl: text('poster_url'),
    /** Poster hall board this poster hangs on. Only meaningful for posters. */
    boardNumber: text('board_number'),
    /** Post-event content, surfaced on the public detail page once present. */
    slidesUrl: text('slides_url'),
    recordingUrl: text('recording_url'),
    resourcesNote: text('resources_note'),
    /** Gate on the four fields above. Nothing publishes until an organizer approves. */
    contentStatus: contentStatusEnum('content_status').notNull().default('draft'),
    /**
     * Why an organizer last sent this content back, in their own words.
     *
     * A property of the current draft rather than a line in the history, which
     * is what the speaker's question is: they open the screen and see a draft
     * they thought they had submitted, and need to know what to change. Every
     * status move clears it and only `returnContent` writes it, so it can never
     * describe a state the content has since left — the case that matters is
     * approved content edited back into a draft, where a surviving reason would
     * read as an organizer having just sent it back.
     *
     * The move itself is still logged to `submission_revisions` by
     * `moveContent`, so the audit trail keeps every return; this column keeps
     * the one that is still outstanding.
     */
    contentReturnReason: text('content_return_reason'),
    /** Free-text topics, used for gallery filtering and reviewer matching. */
    keywords: text('keywords').array().notNull().default([]),
    /**
     * Column names an organizer has frozen against speaker edits, e.g.
     * ["title"]. The speaker-facing edit action refuses anything listed here;
     * an organizer can still write the field.
     */
    lockedFields: jsonb('locked_fields').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('submissions_status_idx').on(t.status),
    index('submissions_speaker_idx').on(t.speakerId),
    /**
     * One title per speaker, case-insensitively.
     *
     * The defect this closes is not a race, it is the browser back button: file
     * a proposal with scripting off, press back, find the form still populated,
     * press submit, and the CFP holds two identical proposals from one person.
     * `submitProposal` checks for that before it inserts and reports it in the
     * form, which is the half a speaker sees.
     *
     * This index is the half a check cannot cover. A check and an insert are
     * two statements with a window between them, and two tabs are enough to
     * find it.
     *
     * Case-insensitive because a duplicate is a duplicate to every reader, and
     * "Rethinking Our Pipeline" is not a second talk.
     */
    uniqueIndex('submissions_speaker_title_idx').on(t.speakerId, lower(t.title)),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * 1 to 5, validated in the app layer before insert. For a rubric grade this
     * is the weighted mean of `rubric`, rounded, so every consumer that only
     * wants one number keeps working.
     */
    score: integer('score').notNull(),
    comment: text('comment'),
    source: reviewSourceEnum('source').notNull().default('human'),
    /**
     * Per-criterion breakdown, keyed by the criterion keys in `src/lib/rubric.ts`.
     * Both humans and the AI evaluators fill this in; it was AI-only in v1.
     */
    rubric: jsonb('rubric').$type<Record<string, number>>(),
    /**
     * The non-numeric half of the scorecard: one string per 'select' or 'text'
     * criterion, keyed the same way `rubric` is.
     *
     * A second column rather than a wider `rubric`, because `rubric` is typed as
     * numbers and four separate consumers already read it that way. A dropdown
     * answer put in there would be a string arriving where an average is
     * computed, and the failure would be a silent NaN in a committee's mean
     * rather than a type error anyone could see.
     */
    answers: jsonb('answers').$type<Record<string, string>>(),
    /**
     * The weighted mean before it was rounded into `score`.
     *
     * `score` is an integer because every consumer that wants one number reads
     * it, and it cannot stop being one without breaking them. But rounding is
     * what makes a weighted grade indistinguishable from an unweighted one: a
     * scorecard weighted 2:1 over 4 and 2 is 3.33 and an even one is 3.0, and
     * both round to 3. This column is what lets an aggregate show the committee
     * the difference their weights actually made. Null on every grade filed
     * before per-round scorecards existed, so readers coalesce to `score`.
     */
    weightedScore: real('weighted_score'),
    /**
     * A human's replacement for this grade's number, with who did it and why.
     *
     * The original `score` is deliberately left alone. An override is a claim
     * about a grade, and a claim that overwrites what it disagrees with cannot
     * be checked afterwards; keeping both is what makes "the machine said 5 and
     * the chair said 3" a readable sentence rather than a lost one. Aggregates
     * read `coalesce(override_score, score)`, so the override is what counts
     * without the AI's own answer being destroyed to make it count.
     */
    overrideScore: integer('override_score'),
    overrideReason: text('override_reason'),
    overriddenById: uuid('overridden_by_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    model: text('model'),
    /** Which evaluator persona produced an AI grade. Null for human grades. */
    personaId: uuid('persona_id'),
    /** Which pass of review this grade belongs to. */
    roundId: uuid('round_id')
      .notNull()
      .references(() => reviewRounds.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One review per reviewer per submission per round; re-scoring inside a
    // round updates the row, and a later round adds one beside it.
    uniqueIndex('reviews_round_submission_reviewer_idx').on(
      t.roundId,
      t.submissionId,
      t.reviewerId,
    ),
    index('reviews_source_idx').on(t.source),
  ],
);

/**
 * A box on the schedule grid. `submissionId` is null until an organizer places
 * an accepted submission into it. Unique on (room, start) so two submissions
 * cannot occupy the same box.
 */
export const slots = pgTable(
  'slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),
    /**
     * A named non-session block: "Lunch", "Registration", "Coffee". Set only
     * when `submissionId` is null. A break spanning the venue is one labelled
     * slot per room, which is what the grid already knows how to draw.
     */
    label: text('label'),
  },
  (t) => [
    uniqueIndex('slots_room_start_idx').on(t.roomId, t.startsAt),
    // A submission can be placed in at most one slot.
    uniqueIndex('slots_submission_idx').on(t.submissionId),
  ],
);

export const awards = pgTable('awards', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** Set when an organizer closes voting and declares the result. */
  winnerSubmissionId: uuid('winner_submission_id').references(() => submissions.id, {
    onDelete: 'set null',
  }),
  votingClosedAt: timestamp('voting_closed_at', { withTimezone: true }),
  /**
   * Community voting. When true anyone signed in may cast a 'community' ballot
   * inside the window below; the committee ballot is unaffected either way, so
   * an award can run both and report them separately.
   */
  publicVoting: boolean('public_voting').notNull().default(false),
  votingOpensAt: timestamp('voting_opens_at', { withTimezone: true }),
  votingClosesAt: timestamp('voting_closes_at', { withTimezone: true }),
  /**
   * Weighted judging criteria, e.g. [{key:'impact',label:'Impact',weight:2}].
   * Empty means a single unweighted pick, which is how v1 behaved.
   */
  criteria: jsonb('criteria')
    .$type<{ key: string; label: string; weight: number }[]>()
    .notNull()
    .default([]),
  /** Set when an organizer overrides the tally by hand, with their reason. */
  winnerOverrideReason: text('winner_override_reason'),
  /**
   * Retired from every list without destroying the ballots underneath.
   *
   * `award_votes.award_id` and `award_nominees.award_id` both cascade, so a
   * plain delete takes every ballot the committee cast with it and there is no
   * undo. This is the same escape `form_questions.archived_at` and
   * `evaluator_personas.active` give for the same reason: work the committee
   * already did survives the organizer changing their mind about the container.
   */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Accepted submissions an organizer put in the running for an award. */
export const awardNominees = pgTable(
  'award_nominees',
  {
    awardId: uuid('award_id')
      .notNull()
      .references(() => awards.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    /** Promoted out of round one. Finalist-only awards tally these alone. */
    isFinalist: boolean('is_finalist').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.awardId, t.submissionId] })],
);

/**
 * One vote per person per award per channel; re-voting moves the vote. The
 * channel is in the key so a judge who also votes as an attendee casts two
 * ballots that are counted in two different tallies, never summed.
 */
export const awardVotes = pgTable(
  'award_votes',
  {
    awardId: uuid('award_id')
      .notNull()
      .references(() => awards.id, { onDelete: 'cascade' }),
    judgeId: uuid('judge_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    channel: voteChannelEnum('channel').notNull().default('committee'),
    /**
     * Per-criterion scores keyed by `awards.criteria[].key`. Null for a plain
     * unweighted pick, which is what a community ballot always is.
     */
    scores: jsonb('scores').$type<Record<string, number>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.awardId, t.judgeId, t.channel] })],
);

/**
 * Which reviewer owes a grade on which submission. v1 showed every reviewer
 * every submitted row; with assignments the queue is per-reviewer, "max reviews
 * per submission" becomes countable, and a completion rate is a real number
 * rather than a guess.
 */
export const reviewAssignments = pgTable(
  'review_assignments',
  {
    roundId: uuid('round_id')
      .notNull()
      .references(() => reviewRounds.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The round is in the key. Without it a shortlist round could not re-ask the
    // same reviewer about the same submission, which is the whole point of one.
    primaryKey({ columns: [t.roundId, t.submissionId, t.reviewerId] }),
    index('review_assignments_reviewer_idx').on(t.reviewerId),
  ],
);

/**
 * Append-only edit log for submission text. One row per field changed, so the
 * detail page can show who changed the abstract and to what. Never updated,
 * never deleted: an audit trail that can be rewritten is not one.
 */
export const submissionRevisions = pgTable(
  'submission_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    editorId: uuid('editor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('submission_revisions_submission_idx').on(t.submissionId, t.createdAt)],
);

/**
 * Co-presenters. `submissions.speakerId` stays the owning account that filed
 * and can edit; this table is everyone who appears on the billing, in order.
 * The owner is row 0, so a listing reads straight off `position`.
 */
export const submissionAuthors = pgTable(
  'submission_authors',
  {
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    affiliation: text('affiliation'),
    /** False for a credited co-author who will not be in the room. */
    isPresenter: boolean('is_presenter').notNull().default(true),
    /**
     * Whether this author may act on the submission, not merely be named on it.
     * Off by default: crediting somebody is the common case, and handing them
     * write access to a proposal should be a thing the filer chose. The owner's
     * own access never reads this column, so nobody can lock themselves out.
     */
    canEdit: boolean('can_edit').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.userId] }),
    index('submission_authors_user_idx').on(t.userId),
  ],
);

/** What a speaker still owes, with a deadline the organizer can chase. */
export const speakerTasks = pgTable(
  'speaker_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for an account-level task like a headshot, which spans every talk. */
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'cascade',
    }),
    kind: speakerTaskKindEnum('kind').notNull(),
    label: text('label').notNull(),
    instructions: text('instructions'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('speaker_tasks_user_idx').on(t.userId)],
);

/**
 * A file a speaker put on this server's disk.
 *
 * The bytes live under a gitignored `uploads/` directory and are served back by
 * `/files/<id>`; this row is the index and the access-control record. There is
 * deliberately no blob store and no signed URL — one machine, one disk, and a
 * route handler that checks who is asking.
 *
 * Two names per file, and the split is the security property:
 *
 *   `storedName`  machine-generated, `<uuid><ext>`, and the only string that
 *                 ever reaches the filesystem. The extension comes from the
 *                 sniffed magic bytes, never from what the browser sent, so
 *                 there is no user-controlled path component to traverse with.
 *   `filename`    the sanitized original, shown to humans and put in the
 *                 `content-disposition` header. Never touches disk.
 *
 * `submissionId` is null for an account-level file — a headshot belongs to the
 * person, not to any one talk.
 */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'cascade',
    }),
    kind: uploadKindEnum('kind').notNull(),
    filename: text('filename').notNull(),
    storedName: text('stored_name').notNull(),
    /** The sniffed type, not the declared one. This is what gets served back. */
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    /**
     * The first upload in this file's version chain, or null when this row is
     * itself the first.
     *
     * Re-uploading into a deliverable slot writes a new row carrying the
     * predecessor's series rather than overwriting anything, so every earlier
     * version keeps its own id, its own bytes and its own `/files/<id>` address.
     * `submissions.slides_url` moves on to the newest member; the older file is
     * still there and still served.
     *
     * Null rather than backfilled to the row's own id. Every upload that
     * predates versioning is a chain of one, and reading it as `series_id ?? id`
     * says so without a data migration that has to be right the first time.
     *
     * No foreign key, deliberately. A chain outlives its head — a speaker may
     * drop v1 and keep v2 — and a cascade off `uploads.id` would take the
     * survivors and the thread hanging off them with it.
     */
    seriesId: uuid('series_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('uploads_owner_idx').on(t.ownerId),
    index('uploads_submission_idx').on(t.submissionId),
    index('uploads_series_idx').on(t.seriesId),
  ],
);

/**
 * A note on a file, from a speaker or an organizer, in one thread both sides
 * read.
 *
 * Hung on the version chain rather than on one `uploads` row, which is why this
 * column is `series_id` and not `upload_id`. The conversation a conference has
 * about a deck is about the deck: a speaker asks a question on Tuesday's file,
 * uploads a better one on Friday, and the organizer answering on Monday is
 * answering that same question. Keyed to the row, the reply would land on a file
 * the speaker had already replaced and neither of them would see the other.
 *
 * Never edited and never deleted, on the same reasoning as
 * `submission_revisions`: attribution that can be rewritten afterwards is not
 * attribution.
 */
export const uploadComments = pgTable(
  'upload_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `uploads.series_id ?? uploads.id`. No foreign key: see `uploads.seriesId`. */
    seriesId: uuid('series_id').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('upload_comments_series_idx').on(t.seriesId, t.createdAt)],
);

/**
 * One organizer's request for an archive of speaker files.
 *
 * A row rather than a streamed response, because "did that export work" is a
 * question asked after the tab is closed. The archive is written to the upload
 * directory under a generated name and handed back by a route that checks the
 * role, so a link copied out of the address bar is not a public door onto every
 * supporting document a committee was ever sent.
 *
 * `uploadIds` is the exact set of files written, resolved to the latest version
 * of each at the moment of the build. Keeping it means a finished archive can
 * say what it holds without opening it, and an organizer who exported yesterday
 * can see they got yesterday's deck.
 */
export const fileExports = pgTable(
  'file_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: fileExportStatusEnum('status').notNull().default('queued'),
    /** 'session', 'speaker' or 'flat'. Decides the folder each entry lands in. */
    grouping: text('grouping').notNull().default('session'),
    uploadIds: jsonb('upload_ids').$type<string[]>().notNull().default([]),
    /** `<uuid>.zip` under the upload directory. Null until the build finishes. */
    storedName: text('stored_name'),
    fileCount: integer('file_count').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    /** Why a build stopped, in words an organizer can act on. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('file_exports_requested_idx').on(t.requestedById, t.createdAt)],
);

/**
 * An attendee starring a talk or a poster. Backs both the personal agenda and
 * the poster gallery's bookmarks; they are the same gesture on the same row.
 */
export const bookmarks = pgTable(
  'bookmarks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.submissionId] })],
);

/**
 * A configured AI reviewer. v1 hardcoded one persona and one rubric in source;
 * this makes the tone, the expertise and the criterion weights data an
 * organizer can edit. Each persona owns a bot `users` row so its grades
 * attribute exactly like a human's.
 */
export const evaluatorPersonas = pgTable('evaluator_personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  profession: text('profession'),
  tone: text('tone'),
  expertise: text('expertise'),
  /** Criterion key to weight, keyed by `src/lib/rubric.ts`. */
  weights: jsonb('weights').$type<Record<string, number>>().notNull().default({}),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every message the platform sent, written after the send. Two jobs: it is the
 * receipt an organizer reads instead of asking "did that go out", and it is the
 * idempotency record that stops a bulk reminder firing twice in one day.
 */
export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    /** False when RESEND_API_KEY is unset and the mail only reached .mail/. */
    delivered: boolean('delivered').notNull().default(false),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_log_user_idx').on(t.userId, t.sentAt)],
);

/**
 * Organizer-authored pages in the speaker portal: the venue guide, the AV
 * requirements, the travel and expenses policy, the code of conduct.
 *
 * A wiki rather than a settings screen, because this is the material an
 * organizer rewrites every year and there is no way to know in advance which
 * pages a given conference needs. `slug` is the address and the link target, so
 * one page reaches another as `/speaker/pages/<slug>`.
 *
 * `body` holds the HTML as the organizer typed it, never as it renders.
 * Sanitising on write would mean a page could not be edited back out of a
 * mistake, and a tightened allowlist would not apply to anything already saved.
 * `sanitizeHtml` runs on every read instead. See `src/lib/sanitize-html.ts`.
 */
export const portalPages = pgTable(
  'portal_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** One line under the title in the index. Optional. */
    summary: text('summary'),
    body: text('body').notNull().default(''),
    /** Draft pages are invisible to speakers and readable by organizers. */
    published: boolean('published').notNull().default(false),
    /** Hand order for the index; ties break on title. */
    position: integer('position').notNull().default(0),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('portal_pages_slug_idx').on(t.slug)],
);

/** One call in a run: what was asked for, and what the far end said. */
export type IntegrationRequestLog = {
  method: string;
  path: string;
  body: unknown;
  status: number;
  /** The id the far end gave this object, when it gave one. */
  remoteId: string | null;
  error: string | null;
};

/**
 * One push of the programme to an outside event platform.
 *
 * The integration is one-way by construction: this table records what we sent
 * and what came back, and nothing in it is ever read back into a submission, a
 * slot or a speaker. Accelevents holds a copy; this app holds the original.
 *
 * `requests` is the exact list of calls the run made, method, path and body,
 * kept whether they were sent or only rehearsed. That is what makes a dry run
 * worth anything: an organizer can read what would go over the wire before
 * anyone points this at a live event.
 *
 * A run is never deleted. "What did we send them on the Tuesday" is the first
 * question anyone asks when two systems disagree.
 */
export const integrationRuns = pgTable(
  'integration_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    target: text('target').notNull().default('accelevents'),
    /** 'dry_run' rehearses against fixtures. 'live' is the only mode that leaves this host. */
    mode: text('mode').notNull(),
    status: integrationRunStatusEnum('status').notNull().default('running'),
    /** Where a live run went, recorded so a mis-set base URL is visible afterwards. */
    baseUrl: text('base_url'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    speakerCount: integer('speaker_count').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    trackCount: integer('track_count').notNull().default(0),
    requests: jsonb('requests').$type<IntegrationRequestLog[]>().notNull().default([]),
    error: text('error'),
    startedById: uuid('started_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('integration_runs_started_idx').on(t.startedAt)],
);

/** When a speaker cannot be scheduled. Read by the agenda conflict checker. */
export const speakerAvailability = pgTable(
  'speaker_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    note: text('note'),
  },
  (t) => [index('speaker_availability_user_idx').on(t.userId)],
);

/**
 * One pass of committee review. Every assignment and every review belongs to
 * exactly one, so "round two" is a real container rather than a second grade on
 * the same row: the same reviewer can be asked for a fresh opinion on the same
 * submission after a shortlist, and the two grades coexist instead of one
 * overwriting the other.
 *
 * A round is never deleted. Closing it is what stops new grades arriving, and
 * an organizer comparing rounds needs the closed one to still be there.
 */
export const reviewRounds = pgTable('review_rounds', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Ascending. Round one sorts first; the highest open position is the active one. */
  position: integer('position').notNull().default(0),
  opensAt: timestamp('opens_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  /** Set when an organizer closes the round. No grade may be filed after this. */
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /**
   * Whether reviewers in this round see who wrote what.
   *
   * Defaulted on, and the default is the interesting half: blind review used to
   * be a property of two queries selecting no speaker column, which made it
   * unbreakable and unconfigurable at the same time. Those queries still select
   * no speaker column. Turning this off makes the page fetch the billing
   * separately rather than widening them, so the thing that guarantees a blind
   * round is still structural and an open round is an explicit second query
   * somebody has to have written.
   */
  blind: boolean('blind').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One field on one round's scorecard.
 *
 * Rounds used to share four criteria hardcoded in `src/lib/rubric.ts`, which
 * made "a shortlist round scored out of 10" unsayable and "add a recommendation
 * dropdown" a code change. A round with no rows here is seeded from those same
 * four, so every grade already filed still reads against the criteria it was
 * filed under.
 *
 * `key` is the join to `reviews.rubric` and `reviews.answers`, and it never
 * changes: renaming the label of a criterion is a display edit, renaming its key
 * would orphan every score stored under the old one.
 *
 * Archived rather than deleted, for the reason `form_questions.archived_at`
 * exists: a score whose criterion is gone is unreadable, and the scores are what
 * the committee actually decided on.
 */
export const roundCriteria = pgTable(
  'round_criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => reviewRounds.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    kind: criterionKindEnum('kind').notNull().default('numeric'),
    /** The question under the field, shown to the reviewer. */
    helpText: text('help_text'),
    /** The ends of a 'numeric' scale. Ignored by the other two kinds. */
    scaleMin: integer('scale_min').notNull().default(1),
    scaleMax: integer('scale_max').notNull().default(5),
    /** Choices for a 'select'. Ignored by the other two kinds. */
    options: jsonb('options').$type<string[]>().notNull().default([]),
    /**
     * How much this criterion counts in the weighted mean. 0 drops it entirely.
     * Only 'numeric' reads it, because only a number can be averaged.
     */
    weight: integer('weight').notNull().default(1),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('round_criteria_round_key_idx').on(t.roundId, t.key),
    index('round_criteria_round_position_idx').on(t.roundId, t.position),
  ],
);

/**
 * Who is on a round's committee.
 *
 * The `reviewer` role says somebody may review at all; this says which passes
 * they sit on, so a specialist pulled in for a shortlist is not carrying the
 * whole first round. An empty pool means the round is open to everyone holding
 * the role, which is how the app behaved before pools existed and is what keeps
 * an organizer who never opens this screen from finding their distributor has
 * nobody to hand work to.
 */
export const roundReviewers = pgTable(
  'round_reviewers',
  {
    roundId: uuid('round_id')
      .notNull()
      .references(() => reviewRounds.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roundId, t.reviewerId] }),
    index('round_reviewers_reviewer_idx').on(t.reviewerId),
  ],
);

/**
 * A reviewer's declaration that they cannot judge a submission fairly.
 *
 * Scoped to the round rather than to the pair alone, because a conflict is a
 * statement about one reading: the colleague who co-wrote the paper in round one
 * may have left by the shortlist, and an organizer re-forming a committee needs
 * to ask again rather than inherit an answer.
 *
 * The assignment row is deliberately left in place. Deleting it would make the
 * recusal indistinguishable from work that was never handed out, and the number
 * an organizer needs is how much of the pile is uncovered *because* somebody
 * stepped back.
 */
export const reviewConflicts = pgTable(
  'review_conflicts',
  {
    roundId: uuid('round_id')
      .notNull()
      .references(() => reviewRounds.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** In the reviewer's own words. Optional: the declaration is the point. */
    reason: text('reason'),
    declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roundId, t.submissionId, t.reviewerId] }),
    index('review_conflicts_reviewer_idx').on(t.reviewerId),
  ],
);

/**
 * A question an organizer added to the submission form.
 *
 * Visibility is two independent filters plus one dependency. `formats` and
 * `trackIds` narrow which proposals see the question at all; empty means every
 * one, which is the common case and therefore the default. `showIfQuestionId`
 * with `showIfValue` is the conditional branch: the question appears only once
 * the named earlier question holds that answer.
 *
 * Questions are archived rather than deleted, because an answer whose question
 * no longer exists is unreadable and the answers are what a committee graded.
 */
export const formQuestions = pgTable(
  'form_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prompt: text('prompt').notNull(),
    helpText: text('help_text'),
    kind: questionKindEnum('kind').notNull().default('short_text'),
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull().default(0),
    /** Choices for a 'select'. Ignored by every other kind. */
    options: jsonb('options').$type<string[]>().notNull().default([]),
    /** Formats this question applies to. Empty means all of them. */
    formats: jsonb('formats').$type<string[]>().notNull().default([]),
    /** Tracks this question applies to. Empty means all of them. */
    trackIds: jsonb('track_ids').$type<string[]>().notNull().default([]),
    /** Show only when the question named here holds `showIfValue`. */
    showIfQuestionId: uuid('show_if_question_id'),
    showIfValue: text('show_if_value'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('form_questions_position_idx').on(t.position)],
);

/**
 * One submission's answer to one question, stored as text whatever the kind.
 *
 * Text for every kind is a deliberate trade. A typed column per kind would let
 * Postgres validate, but the question's kind is itself editable, so the column
 * a value lives in would have to move when an organizer changes a select to a
 * short text. Validation happens once, at the form boundary, against the kind
 * the question has now.
 */
export const submissionAnswers = pgTable(
  'submission_answers',
  {
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => formQuestions.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.questionId] }),
    index('submission_answers_question_idx').on(t.questionId),
  ],
);

/**
 * The contact layer.
 *
 * Everything below hangs off `users` rather than off `submissions`, and that is
 * the point of it. The roster at /organizer/speakers answers "who is speaking at
 * this event"; the tags an organizer files someone under, the note about why
 * they declined last time and where they sit in the invitation pipeline are all
 * facts about the person that outlive any one proposal. Hanging them on a
 * submission would lose them the moment it was withdrawn, and would duplicate
 * them for anyone who submits twice.
 */

/** An organizer's private note on a person. Never rendered outside /organizer. */
export const contactNotes = pgTable(
  'contact_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contact_notes_contact_idx').on(t.contactId, t.createdAt)],
);

/**
 * A free-text label on a person, lowercased at the boundary.
 *
 * A join table rather than a `text[]` column so a filter is an index lookup and
 * so the tag vocabulary can be read back without scanning every contact. The
 * primary key is what stops the same tag being applied twice.
 */
export const contactTags = pgTable(
  'contact_tags',
  {
    contactId: uuid('contact_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tag] }), index('contact_tags_tag_idx').on(t.tag)],
);

/**
 * A saved filter, so a segment an organizer builds once is something they can
 * come back to rather than a query string they have to rebuild.
 *
 * `query` stores the serialized search parameters, not a row set. A segment is a
 * question and it has to keep answering it as contacts change; freezing the
 * membership would turn "speakers with no headshot" into a stale list the day
 * after someone uploads one.
 */
export const contactSegments = pgTable(
  'contact_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    query: text('query').notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contact_segments_name_idx').on(lower(t.name))],
);

/**
 * A column on the invitation pipeline board.
 *
 * Stages are rows rather than an enum because the board is the part of a contact
 * database an organizer is most likely to want to shape to their own process,
 * and an enum would make adding "Awaiting contract" a migration.
 */
export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pipeline_stages_position_idx').on(t.position)],
);

/**
 * One person's card on the board. A person is on the board at most once, which
 * is why the contact is the primary key rather than a surrogate id.
 */
export const pipelineCards = pgTable(
  'pipeline_cards',
  {
    contactId: uuid('contact_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pipeline_cards_stage_idx').on(t.stageId, t.position)],
);

/**
 * Every stage change, kept forever.
 *
 * The card carries where someone is now; this carries how they got there, which
 * is the half an organizer actually asks about later ("when did we invite
 * them?"). `fromStageId` is nullable because the first move is an entry onto the
 * board from nowhere.
 */
export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromStageId: uuid('from_stage_id').references(() => pipelineStages.id, {
      onDelete: 'set null',
    }),
    toStageId: uuid('to_stage_id').references(() => pipelineStages.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pipeline_events_contact_idx').on(t.contactId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type ContactNote = typeof contactNotes.$inferSelect;
export type ContactTag = typeof contactTags.$inferSelect;
export type ContactSegment = typeof contactSegments.$inferSelect;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type PipelineCard = typeof pipelineCards.$inferSelect;
export type PipelineEvent = typeof pipelineEvents.$inferSelect;
export type ReviewRound = typeof reviewRounds.$inferSelect;
export type RoundCriterion = typeof roundCriteria.$inferSelect;
export type CriterionKind = (typeof criterionKindEnum.enumValues)[number];
export type RoundReviewer = typeof roundReviewers.$inferSelect;
export type ReviewConflict = typeof reviewConflicts.$inferSelect;
export type FormQuestion = typeof formQuestions.$inferSelect;
export type SubmissionAnswer = typeof submissionAnswers.$inferSelect;
export type QuestionKind = (typeof questionKindEnum.enumValues)[number];
export type Submission = typeof submissions.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Slot = typeof slots.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Track = typeof tracks.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Award = typeof awards.$inferSelect;
export type ReviewAssignment = typeof reviewAssignments.$inferSelect;
export type SubmissionRevision = typeof submissionRevisions.$inferSelect;
export type SubmissionAuthor = typeof submissionAuthors.$inferSelect;
export type SpeakerTask = typeof speakerTasks.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type UploadComment = typeof uploadComments.$inferSelect;
export type FileExport = typeof fileExports.$inferSelect;
export type FileExportStatus = (typeof fileExportStatusEnum.enumValues)[number];
export type Bookmark = typeof bookmarks.$inferSelect;
export type EvaluatorPersona = typeof evaluatorPersonas.$inferSelect;
export type EmailLogRow = typeof emailLog.$inferSelect;
export type SpeakerAvailability = typeof speakerAvailability.$inferSelect;
export type PortalPage = typeof portalPages.$inferSelect;
export type IntegrationRun = typeof integrationRuns.$inferSelect;
export type IntegrationRunStatus = (typeof integrationRunStatusEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type SubmissionStatus = (typeof submissionStatusEnum.enumValues)[number];
export type SubmissionFormat = (typeof submissionFormatEnum.enumValues)[number];
export type AudienceLevel = (typeof audienceLevelEnum.enumValues)[number];
export type ReviewSource = (typeof reviewSourceEnum.enumValues)[number];
export type ContentStatus = (typeof contentStatusEnum.enumValues)[number];
export type VoteChannel = (typeof voteChannelEnum.enumValues)[number];
export type SpeakerTaskKind = (typeof speakerTaskKindEnum.enumValues)[number];
export type UploadKind = (typeof uploadKindEnum.enumValues)[number];
