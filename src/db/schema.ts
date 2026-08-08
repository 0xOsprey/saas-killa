import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name'),
    bio: text('bio'),
    headshotUrl: text('headshot_url'),
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
    /** Speaker's own confirmation that they will attend, after acceptance. */
    speakerConfirmedAt: timestamp('speaker_confirmed_at', { withTimezone: true }),
    /** ePoster artwork. Only meaningful when format is 'poster'. */
    posterUrl: text('poster_url'),
    /** Post-event content, surfaced on the public detail page once present. */
    slidesUrl: text('slides_url'),
    recordingUrl: text('recording_url'),
    resourcesNote: text('resources_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('submissions_status_idx').on(t.status),
    index('submissions_speaker_idx').on(t.speakerId),
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
    /** 1 to 5, validated in the app layer before insert. */
    score: integer('score').notNull(),
    comment: text('comment'),
    source: reviewSourceEnum('source').notNull().default('human'),
    /** AI grades carry their per-criterion breakdown; human grades leave it null. */
    rubric: jsonb('rubric').$type<Record<string, number>>(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One review per reviewer per submission; re-scoring updates the row.
    uniqueIndex('reviews_submission_reviewer_idx').on(t.submissionId, t.reviewerId),
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
  },
  (t) => [primaryKey({ columns: [t.awardId, t.submissionId] })],
);

/** One vote per judge per award; re-voting moves the vote. */
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.awardId, t.judgeId] })],
);

export type User = typeof users.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Slot = typeof slots.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Track = typeof tracks.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Award = typeof awards.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
export type SubmissionStatus = (typeof submissionStatusEnum.enumValues)[number];
export type SubmissionFormat = (typeof submissionFormatEnum.enumValues)[number];
export type AudienceLevel = (typeof audienceLevelEnum.enumValues)[number];
export type ReviewSource = (typeof reviewSourceEnum.enumValues)[number];
