import { sql } from 'drizzle-orm';
import { db } from './index';
import {
  awardNominees,
  awards,
  bookmarks,
  evaluatorPersonas,
  events,
  reviewAssignments,
  reviews,
  rooms,
  speakerAvailability,
  speakerTasks,
  submissionAuthors,
  submissionRevisions,
  submissions,
  tracks,
  userRoles,
  users,
} from './schema';
import type { AudienceLevel, SubmissionFormat, SubmissionStatus } from './schema';

const RESET = process.argv.includes('--reset');

const TRACKS = [
  { name: 'Systems', colour: '#0ea5e9' },
  { name: 'Practice', colour: '#8b5cf6' },
  { name: 'Research', colour: '#10b981' },
  { name: 'Ops', colour: '#f59e0b' },
];

const ROOMS = [
  { name: 'Main hall', capacity: 400, position: 0 },
  { name: 'Studio', capacity: 120, position: 1 },
  { name: 'Workshop room', capacity: 60, position: 2 },
];

const TITLE_HEADS = [
  'Rebuilding',
  'Debugging',
  'Scaling',
  'Rethinking',
  'Shipping',
  'Measuring',
  'Retiring',
  'Hardening',
  'Migrating',
  'Instrumenting',
];

const TITLE_TAILS = [
  'our review pipeline',
  'a scheduler nobody trusted',
  'the CFP that ate the conference',
  'a database under real load',
  'the queue that would not drain',
  'a build from 40 minutes to 4',
  'an on-call rotation people wanted',
  'the deploy nobody could roll back',
  'a search index at three in the morning',
  'the service mesh we could not remove',
];

const FORMATS: SubmissionFormat[] = [
  'talk_25',
  'talk_25',
  'talk_45',
  'lightning_10',
  'workshop_90',
  'poster',
];

const LEVELS: AudienceLevel[] = ['beginner', 'intermediate', 'intermediate', 'advanced'];

/** Two or three of these land on every proposal, so keyword search has a corpus. */
const KEYWORDS = [
  'postgres',
  'observability',
  'incident-response',
  'ci-cd',
  'kubernetes',
  'caching',
  'latency',
  'migrations',
  'on-call',
  'cost',
  'testing',
  'queues',
];

/**
 * Decisions on the fixture. Without them the agenda, the poster gallery, the
 * speaker directory and every award surface open empty, because each one filters
 * to accepted work. Rows 15 onward stay undecided so the review queue and the
 * "an undecided proposal is not reachable" test both still have material.
 *
 * Posters are special-cased because format is drawn by the same seeded PRNG that
 * picks every other field, and it places all four posters at indices 15, 21, 26
 * and 39 — every one of them outside the accepted band. That left the poster
 * hall and the "Best poster" award empty on a fresh clone, which reads as a
 * broken feature rather than the coincidence it is. One poster stays undecided
 * so the format is represented in the review queue too.
 */
function statusFor(index: number, format: SubmissionFormat): SubmissionStatus {
  if (format === 'poster') return index === 39 ? 'submitted' : 'accepted';
  if (index >= 15) return 'submitted';
  return index % 5 === 4 ? 'rejected' : 'accepted';
}

/**
 * Deterministic pseudo-random. A seed that shuffles differently on every run
 * makes a failing end-to-end test unreproducible, so the generator is seeded
 * from a constant and the fixture is identical every time.
 */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function abstractFor(title: string, random: () => number): string {
  const sentences = [
    `${title} started as a two-week job and took most of a year.`,
    'This talk walks through what the system looked like before, the three measurements that changed our minds, and the design we landed on.',
    'We will spend most of the time on the parts that did not work: the abstraction that leaked, the metric that was measuring the wrong thing, and the rollback we could not perform.',
    'You will leave with a checklist you can run against your own stack on the flight home, and a clear sense of when this approach is the wrong one.',
    random() > 0.5
      ? 'No prior knowledge of our stack is assumed; every diagram is in the handout.'
      : 'Some familiarity with distributed systems will help, but the examples stand alone.',
  ];
  return sentences.join(' ');
}

async function main() {
  if (RESET) {
    // Order matters: children first, and TRUNCATE ... CASCADE would take the
    // whole graph anyway, but naming the tables keeps the blast radius visible.
    await db.execute(sql`
      truncate table
        award_votes, award_nominees, awards, bookmarks, review_assignments,
        submission_revisions, submission_authors, speaker_tasks,
        speaker_availability, email_log, evaluator_personas, reviews, slots,
        submissions, auth_sessions, magic_link_tokens, user_roles, users,
        rooms, tracks, events
      restart identity cascade
    `);
    console.log('✓ tables truncated');
  }

  const existing = await db.select().from(events).limit(1);
  if (existing.length > 0 && !RESET) {
    console.log('Event already seeded. Re-run with --reset to start clean.');
    return;
  }

  const random = makeRandom(20260808);

  // The event runs a comfortable distance in the future and the CFP is open
  // now, so a fresh clone lands on a submittable form rather than a closed one.
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const startsOn = new Date(now.getTime() + 90 * day);
  startsOn.setUTCHours(9, 0, 0, 0);

  const [event] = await db
    .insert(events)
    .values({
      name: 'Sessionboard Conf',
      tagline: 'One track of hard problems, two days, no keynote about culture.',
      timezone: 'Europe/London',
      startsOn,
      endsOn: new Date(startsOn.getTime() + day),
      cfpOpensAt: new Date(now.getTime() - 14 * day),
      cfpClosesAt: new Date(now.getTime() + 30 * day),
      agendaPublished: false,
    })
    .returning();
  if (!event) throw new Error('failed to insert event');

  const trackRows = await db.insert(tracks).values(TRACKS).returning();
  const roomRows = await db.insert(rooms).values(ROOMS).returning();

  const organizerEmail = process.env.BOOTSTRAP_ORGANIZER_EMAIL ?? 'organizer@example.com';

  const [organizer] = await db
    .insert(users)
    .values({
      email: organizerEmail,
      name: 'Programme chair',
      bio: 'Runs the programme committee.',
    })
    .returning();
  if (!organizer) throw new Error('failed to insert organizer');
  await db
    .insert(userRoles)
    .values([
      { userId: organizer.id, role: 'organizer' as const },
      { userId: organizer.id, role: 'reviewer' as const },
    ]);

  const reviewerRows = await db
    .insert(users)
    .values(
      [1, 2, 3].map((n) => ({
        email: `reviewer${n}@example.com`,
        name: `Reviewer ${n}`,
        bio: 'Programme committee.',
      })),
    )
    .returning();
  await db
    .insert(userRoles)
    .values(reviewerRows.map((r) => ({ userId: r.id, role: 'reviewer' as const })));

  // 40 submissions across 24 speakers, so some speakers hold more than one and
  // the double-booking warning has something real to fire on.
  const speakerRows = await db
    .insert(users)
    .values(
      Array.from({ length: 24 }, (_, i) => ({
        email: `speaker${i + 1}@example.com`,
        name: `Speaker ${i + 1}`,
        bio: `Builds and operates ${['payments', 'search', 'storage', 'streaming'][i % 4]} systems. This is their ${i % 3 === 0 ? 'first' : 'third'} time on this stage.`,
      })),
    )
    .returning();
  await db
    .insert(userRoles)
    .values(speakerRows.map((s) => ({ userId: s.id, role: 'speaker' as const })));

  const proposals = Array.from({ length: 40 }, (_, i) => {
    const head = TITLE_HEADS[i % TITLE_HEADS.length]!;
    const tail = TITLE_TAILS[Math.floor(i / TITLE_HEADS.length) % TITLE_TAILS.length]!;
    const title = `${head} ${tail}`;
    const format = FORMATS[Math.floor(random() * FORMATS.length)]!;
    const speaker = speakerRows[i % speakerRows.length]!;
    const track = trackRows[Math.floor(random() * trackRows.length)]!;
    const status = statusFor(i, format);
    return {
      speakerId: speaker.id,
      trackId: track.id,
      title: `${title} (${i + 1})`,
      abstract: abstractFor(title, random),
      format,
      audienceLevel: LEVELS[Math.floor(random() * LEVELS.length)]!,
      status,
      keywords: [
        KEYWORDS[i % KEYWORDS.length]!,
        KEYWORDS[(i * 5 + 3) % KEYWORDS.length]!,
        ...(i % 3 === 0 ? [KEYWORDS[(i * 7 + 1) % KEYWORDS.length]!] : []),
      ],
      // Half the accepted speakers have confirmed, so the organizer roster shows
      // the "not confirmed" badge doing its job rather than an all-green column.
      speakerConfirmedAt: status === 'accepted' && i % 2 === 0 ? new Date() : null,
      // A few accepted talks arrive with slides waiting on approval, so the
      // content moderation queue is not empty on a fresh clone.
      slidesUrl:
        status === 'accepted' && i % 4 === 1
          ? `https://example.com/slides/${i + 1}.pdf`
          : null,
      contentStatus:
        status === 'accepted' && i % 4 === 1 ? ('pending' as const) : ('draft' as const),
      posterUrl:
        format === 'poster'
          ? `https://placehold.co/900x1200/png?text=${encodeURIComponent(`${head}+${i + 1}`)}`
          : null,
    };
  });

  const submissionRows = await db.insert(submissions).values(proposals).returning();

  // Grade about two thirds of the pool so the organizer screen opens on a real
  // spread rather than a wall of "no grades".
  const graded = submissionRows.slice(0, Math.floor(submissionRows.length * 0.65));
  const reviewValues = graded.flatMap((submission) =>
    reviewerRows
      .filter(() => random() > 0.25)
      .map((reviewer) => ({
        submissionId: submission.id,
        reviewerId: reviewer.id,
        score: 1 + Math.floor(random() * 5),
        comment: random() > 0.6 ? 'Clear scope, and the failure stories are the good part.' : null,
        source: 'human' as const,
      })),
  );
  if (reviewValues.length > 0) {
    await db.insert(reviews).values(reviewValues).onConflictDoNothing();
  }

  const accepted = submissionRows.filter((s) => s.status === 'accepted');
  const submitted = submissionRows.filter((s) => s.status === 'submitted');

  // Who owes a grade on what. Two reviewers per undecided proposal, which is the
  // shape the assignment screen defaults to, and one batch in six is already
  // overdue so the completion dashboard has a red number to show.
  const assignmentValues = submitted.flatMap((submission, i) => {
    const overdue = i % 6 === 0;
    const dueAt = new Date(now.getTime() + (overdue ? -2 : 7) * day);
    return [reviewerRows[i % reviewerRows.length]!, reviewerRows[(i + 1) % reviewerRows.length]!]
      .filter((reviewer, index, list) => list.indexOf(reviewer) === index)
      .map((reviewer) => ({
        submissionId: submission.id,
        reviewerId: reviewer.id,
        dueAt,
      }));
  });
  await db.insert(reviewAssignments).values(assignmentValues).onConflictDoNothing();

  // The v1 evaluator, as a persona row. The address matches the constant the
  // evaluator adopts on first use, so the app finds this row instead of minting
  // a second bot beside it.
  const [evaluatorBot] = await db
    .insert(users)
    .values({ email: 'ai-evaluator@sessionboard.local', name: 'AI evaluator', isBot: true })
    .returning();
  if (!evaluatorBot) throw new Error('failed to insert the evaluator bot');
  await db.insert(userRoles).values({ userId: evaluatorBot.id, role: 'reviewer' as const });

  const [persona] = await db
    .insert(evaluatorPersonas)
    .values({
      userId: evaluatorBot.id,
      name: 'AI evaluator',
      profession: 'Programme committee reviewer',
      tone: 'Direct, specific, and short',
      expertise: 'General conference programming across every track',
      weights: { clarity: 1, originality: 1, relevance: 1, credibility: 1 },
    })
    .returning();
  if (!persona) throw new Error('failed to insert the evaluator persona');

  // AI grades are seeded rather than generated, because generating them means
  // calling a paid API from a seed script. Every fifth row is pushed two points
  // away from the human mean so the outlier list opens with real entries.
  const humanMean = new Map<string, number>();
  for (const row of reviewValues) {
    const seen = humanMean.get(row.submissionId) ?? 0;
    humanMean.set(row.submissionId, seen === 0 ? row.score : (seen + row.score) / 2);
  }
  const aiValues = submissionRows.slice(0, 22).map((submission, i) => {
    const mean = humanMean.get(submission.id) ?? 3;
    const target = i % 5 === 0 ? (mean >= 3 ? 1 : 5) : Math.min(5, Math.max(1, Math.round(mean)));
    const spread = (n: number) => Math.min(5, Math.max(1, target + n));
    const rubric = {
      clarity: spread(0),
      originality: spread(i % 3 === 0 ? 1 : 0),
      relevance: spread(0),
      credibility: spread(i % 4 === 0 ? -1 : 0),
    };
    const score = Math.round(
      (rubric.clarity + rubric.originality + rubric.relevance + rubric.credibility) / 4,
    );
    return {
      submissionId: submission.id,
      reviewerId: evaluatorBot.id,
      score,
      comment:
        'The scope is legible and the failure stories carry the talk. Marked down where the abstract promises a checklist it never describes.',
      source: 'ai' as const,
      rubric,
      model: 'claude-sonnet-5',
      personaId: persona.id,
    };
  });
  await db.insert(reviews).values(aiValues).onConflictDoNothing();

  // Co-authors on a quarter of the pool. The rest have none on purpose, so the
  // author list is exercised on both its populated and its fallback path.
  const authorValues = submissionRows
    .filter((_, i) => i % 4 === 0)
    .flatMap((submission, i) => {
      const co = speakerRows[(i * 3 + 5) % speakerRows.length]!;
      if (co.id === submission.speakerId) return [];
      return [
        { submissionId: submission.id, userId: submission.speakerId, position: 0 },
        {
          submissionId: submission.id,
          userId: co.id,
          position: 1,
          affiliation: ['Northwind Labs', 'Acme Systems', 'Contoso Research'][i % 3]!,
          isPresenter: i % 3 !== 2,
        },
      ];
    });
  await db.insert(submissionAuthors).values(authorValues).onConflictDoNothing();

  // What accepted speakers still owe. Nobody in the fixture has a headshot, so
  // that task is the one the chase screens are actually built around.
  const taskValues = accepted.flatMap((submission, i) => [
    {
      userId: submission.speakerId,
      submissionId: null,
      kind: 'headshot' as const,
      label: 'Send a headshot, 800px square or larger',
      dueAt: new Date(now.getTime() + (i % 4 === 0 ? -3 : 10) * day),
      completedAt: i % 5 === 0 ? new Date(now.getTime() - day) : null,
    },
    {
      userId: submission.speakerId,
      submissionId: submission.id,
      kind: 'slides' as const,
      label: 'Upload slides for your session',
      dueAt: new Date(now.getTime() + 21 * day),
      completedAt: null,
    },
  ]);
  await db.insert(speakerTasks).values(taskValues);

  // Stars on accepted work. These are the only demand signal the room-capacity
  // warning and the poster gallery's engagement column have to read.
  const bookmarkValues = speakerRows.slice(0, 14).flatMap((user, i) =>
    accepted
      .filter((_, j) => (i + j) % 3 === 0)
      .map((submission) => ({ userId: user.id, submissionId: submission.id })),
  );
  await db.insert(bookmarks).values(bookmarkValues).onConflictDoNothing();

  // Three speakers who cannot be scheduled on the morning of day one.
  await db.insert(speakerAvailability).values(
    accepted.slice(0, 3).map((submission) => ({
      userId: submission.speakerId,
      startsAt: startsOn,
      endsAt: new Date(startsOn.getTime() + 4 * 60 * 60 * 1000),
      note: 'Arriving on the late flight, not available before lunch on day one.',
    })),
  );

  // A short edit history, so the audit trail opens with something in it.
  await db.insert(submissionRevisions).values(
    accepted.slice(0, 4).map((submission) => ({
      submissionId: submission.id,
      editorId: organizer.id,
      field: 'title',
      oldValue: submission.title.replace(/\s\(\d+\)$/, ''),
      newValue: submission.title,
    })),
  );

  const awardRows = await db
    .insert(awards)
    .values([
      {
        name: 'Best talk',
        description: 'Voted by the programme committee after the event.',
        votingOpensAt: now,
        votingClosesAt: new Date(now.getTime() + 30 * day),
        criteria: [
          { key: 'impact', label: 'Impact', weight: 3 },
          { key: 'delivery', label: 'Delivery', weight: 2 },
          { key: 'originality', label: 'Originality', weight: 1 },
        ],
      },
      {
        name: 'Best poster',
        description: 'Voted by attendees at the poster session.',
        publicVoting: true,
        votingOpensAt: now,
        votingClosesAt: new Date(now.getTime() + 30 * day),
      },
    ])
    .returning();

  const [bestTalk, bestPoster] = awardRows;
  const nomineeValues = [
    ...accepted
      .filter((s) => s.format !== 'poster')
      .slice(0, 6)
      .map((s, i) => ({
        awardId: bestTalk!.id,
        submissionId: s.id,
        isFinalist: i < 2,
      })),
    ...accepted
      .filter((s) => s.format === 'poster')
      .map((s) => ({ awardId: bestPoster!.id, submissionId: s.id })),
  ];
  if (nomineeValues.length > 0) {
    await db.insert(awardNominees).values(nomineeValues).onConflictDoNothing();
  }

  console.log(
    [
      `✓ event: ${event.name}`,
      `✓ ${trackRows.length} tracks, ${roomRows.length} rooms`,
      `✓ ${speakerRows.length} speakers, ${reviewerRows.length} reviewers`,
      `✓ ${submissionRows.length} submissions (${accepted.length} accepted, ${submitted.length} undecided)`,
      `✓ ${reviewValues.length} human reviews, ${aiValues.length} AI reviews, ${assignmentValues.length} assignments`,
      `✓ ${taskValues.length} speaker tasks, ${bookmarkValues.length} bookmarks, ${authorValues.length} author rows`,
      `✓ ${awardRows.length} awards, ${nomineeValues.length} nominees`,
      `✓ organizer: ${organizerEmail}`,
      '',
      'Sign in at /login with the organizer address. With RESEND_API_KEY unset the',
      'link is printed to this terminal and written to .mail/.',
    ].join('\n'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
