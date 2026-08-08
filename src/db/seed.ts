import { rm } from 'node:fs/promises';
import { eq, inArray, sql } from 'drizzle-orm';
import { UPLOAD_DIR } from '../lib/upload-dir';
import { db } from './index';
import {
  awardNominees,
  awards,
  bookmarks,
  evaluatorPersonas,
  events,
  formQuestions,
  portalPages,
  reviewAssignments,
  reviewRounds,
  reviews,
  slots,
  submissionAnswers,
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
  // Deliberately smaller than the number of people who star the headline talk
  // below, so the room-capacity warning has a placement that actually trips it.
  // At 60 seats nothing in a 28-account fixture could ever exceed it.
  { name: 'Workshop room', capacity: 18, position: 2 },
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
/**
 * Speaker-supplied materials and their moderation state. Both bands are needed
 * and for different screens: the `pending` rows are what the organizer's
 * approve queue has to act on, and the `approved` rows are the only ones a
 * public detail page will render a Materials card for. Seeding only `pending`
 * left that card unreachable on a fresh clone, which reads as a missing
 * feature. `draft` rows carry nothing, which is what a speaker who has not
 * uploaded yet actually looks like.
 */
function contentFor(index: number, status: SubmissionStatus) {
  const nothing = {
    slidesUrl: null,
    recordingUrl: null,
    resourcesNote: null,
    contentStatus: 'draft' as const,
  };
  if (status !== 'accepted') return nothing;
  if (index % 4 === 1) {
    return {
      ...nothing,
      slidesUrl: `https://example.com/slides/${index + 1}.pdf`,
      contentStatus: 'pending' as const,
    };
  }
  if (index % 4 === 2) {
    return {
      slidesUrl: `https://example.com/slides/${index + 1}.pdf`,
      recordingUrl: `https://example.com/recordings/${index + 1}.mp4`,
      resourcesNote: 'Repo and the load-test harness are linked from the last slide.',
      contentStatus: 'approved' as const,
    };
  }
  return nothing;
}

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
        submission_answers, form_questions, submission_revisions,
        submission_authors, speaker_tasks, speaker_availability, email_log,
        evaluator_personas, reviews, review_rounds, slots, submissions,
        uploads, portal_pages, integration_runs, auth_sessions,
        magic_link_tokens, user_roles, users, rooms, tracks, events
      restart identity cascade
    `);
    console.log('✓ tables truncated');

    // The bytes live outside the database. Truncating `uploads` alone would
    // leave every file ever uploaded on disk with no row pointing at it, which
    // nothing would ever read again and nothing would ever delete.
    await rm(UPLOAD_DIR, { recursive: true, force: true });
    console.log('✓ uploads/ cleared');
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
      ...contentFor(i, status),
      posterUrl:
        format === 'poster'
          ? `https://placehold.co/900x1200/png?text=${encodeURIComponent(`${head}+${i + 1}`)}`
          : null,
    };
  });

  const submissionRows = await db.insert(submissions).values(proposals).returning();

  // Two rounds, the first closed. A single round would render every per-round
  // number identically to the all-time number, and the one bug rounds can have
  // is a query that forgot to scope itself.
  const [roundOne, roundTwo] = await db
    .insert(reviewRounds)
    .values([
      {
        name: 'Round 1',
        position: 0,
        opensAt: new Date(now.getTime() - 30 * day),
        dueAt: new Date(now.getTime() - 8 * day),
        closedAt: new Date(now.getTime() - 7 * day),
      },
      {
        name: 'Round 2 (shortlist)',
        position: 1,
        opensAt: new Date(now.getTime() - 6 * day),
        dueAt: new Date(now.getTime() + 7 * day),
      },
    ])
    .returning();
  if (!roundOne || !roundTwo) throw new Error('failed to insert the review rounds');

  // Grade about two thirds of the pool so the organizer screen opens on a real
  // spread rather than a wall of "no grades".
  const graded = submissionRows.slice(0, Math.floor(submissionRows.length * 0.65));
  const reviewValues = graded.flatMap((submission) =>
    reviewerRows
      .filter(() => random() > 0.25)
      .map((reviewer) => ({
        roundId: roundOne.id,
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
        roundId: roundTwo.id,
        submissionId: submission.id,
        reviewerId: reviewer.id,
        dueAt,
      }));
  });
  await db.insert(reviewAssignments).values(assignmentValues).onConflictDoNothing();

  // Round one's assignments, all completed. Without them the closed round shows
  // a 0% completion rate beside grades that plainly exist, which is the exact
  // discrepancy a round-scoping bug produces.
  const roundOneAssignments = graded.flatMap((submission) =>
    reviewerRows.map((reviewer) => ({
      roundId: roundOne.id,
      submissionId: submission.id,
      reviewerId: reviewer.id,
      dueAt: new Date(now.getTime() - 8 * day),
    })),
  );
  await db.insert(reviewAssignments).values(roundOneAssignments).onConflictDoNothing();

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
  // A true mean, not a running one. Folding as (seen + score) / 2 weights the
  // last grade at half and the first at a quarter, so the gap the outlier rows
  // below are supposed to open against SQL's avg() would not have been the two
  // points they are meant to demonstrate.
  const humanTotals = new Map<string, { sum: number; count: number }>();
  for (const row of reviewValues) {
    const seen = humanTotals.get(row.submissionId) ?? { sum: 0, count: 0 };
    humanTotals.set(row.submissionId, { sum: seen.sum + row.score, count: seen.count + 1 });
  }
  const humanMean = new Map(
    [...humanTotals].map(([id, { sum, count }]) => [id, sum / count] as const),
  );
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
      roundId: roundOne.id,
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
        // The filer's own row, materialised at position 0. `canEdit` is set for
        // the same reason `ensureFilerIsAuthorZero` sets it: nothing reads it on
        // the filer's path, and a false here would read as though they had been
        // locked out of their own proposal.
        { submissionId: submission.id, userId: submission.speakerId, position: 0, canEdit: true },
        {
          submissionId: submission.id,
          userId: co.id,
          position: 1,
          affiliation: ['Northwind Labs', 'Acme Systems', 'Contoso Research'][i % 3]!,
          isPresenter: i % 3 !== 2,
          // Half the co-authors can act, half are credited only. Both paths are
          // reachable, which is what makes the difference testable.
          canEdit: i % 2 === 0,
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
  // One headline talk that everybody stars. Spread evenly, no submission gets
  // more than about five stars, and the smallest room seats 18, so the
  // room-capacity warning had no placement anywhere that could trip it.
  const headliner = accepted[0];
  const bookmarkValues = [
    ...(headliner
      ? speakerRows.map((user) => ({ userId: user.id, submissionId: headliner.id }))
      : []),
    ...speakerRows.slice(0, 14).flatMap((user, i) =>
      accepted
        .filter((_, j) => (i + j) % 3 === 0)
        .map((submission) => ({ userId: user.id, submissionId: submission.id })),
    ),
  ];
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

  // A configured form, exercising every kind and both narrowing rules, with one
  // branch two levels deep. A single flat text question would let a broken
  // visibility pass through unnoticed.
  const questionRows = await db
    .insert(formQuestions)
    .values([
      {
        prompt: 'Have you given this talk before?',
        helpText: 'A talk that has run elsewhere is welcome. We just like to know.',
        kind: 'checkbox' as const,
        position: 0,
      },
      {
        prompt: 'Where, and roughly when?',
        kind: 'short_text' as const,
        required: true,
        position: 1,
      },
      {
        prompt: 'Link to a recording, if there is one',
        kind: 'url' as const,
        position: 2,
      },
      {
        prompt: 'What will the audience be able to do afterwards?',
        helpText: 'Two or three sentences. Concrete beats aspirational.',
        kind: 'long_text' as const,
        required: true,
        position: 3,
      },
      {
        prompt: 'How much of the room needs to be at a keyboard?',
        kind: 'select' as const,
        options: ['Nobody', 'Some of them', 'Everybody'],
        required: true,
        position: 4,
        formats: ['workshop_90'],
      },
      {
        prompt: 'Which ethics board approved this work?',
        kind: 'short_text' as const,
        position: 5,
        trackIds: [trackRows.find((t) => t.name === 'Research')!.id],
      },
    ])
    .returning();

  const [askedBefore, askedWhere, askedRecording] = questionRows;
  // The two follow-ups hang off the first, so a proposal that answers "no"
  // renders neither. Set here rather than at insert because a question's parent
  // is another question's id, which does not exist until the insert returns.
  await db
    .update(formQuestions)
    .set({ showIfQuestionId: askedBefore!.id, showIfValue: 'yes' })
    .where(inArray(formQuestions.id, [askedWhere!.id, askedRecording!.id]));

  const answerValues = submissionRows.flatMap((submission, i) => {
    const rows: { submissionId: string; questionId: string; value: string }[] = [
      {
        submissionId: submission.id,
        questionId: questionRows[3]!.id,
        value:
          'Run the audit on a job they are afraid of, name its real consumers, and delete one of them.',
      },
    ];
    // A third have given it before, and those are the only ones with the branch
    // answered. The rest leave it empty, which is the state the form produces.
    if (i % 3 === 0) {
      rows.push({ submissionId: submission.id, questionId: askedBefore!.id, value: 'yes' });
      rows.push({
        submissionId: submission.id,
        questionId: askedWhere!.id,
        value: `${['SREcon', 'PyCon', 'a company all-hands'][i % 3]}, about a year ago`,
      });
    }
    if (submission.format === 'workshop_90') {
      rows.push({
        submissionId: submission.id,
        questionId: questionRows[4]!.id,
        value: ['Nobody', 'Some of them', 'Everybody'][i % 3]!,
      });
    }
    return rows;
  });
  await db.insert(submissionAnswers).values(answerValues).onConflictDoNothing();

  // A part-built schedule.
  //
  // Left empty, a fresh clone opens on a blank grid, an empty public agenda, an
  // export with nothing in it and two widgets with nothing to show. Four
  // screens then look broken when they are only unused. Two days of bands with
  // most of the talks placed is what a programme actually looks like a month
  // out, and it leaves the pool and half the boxes empty, which is where the
  // dragging is still visible.
  //
  // Bands are offsets from the event's own start instant rather than wall
  // clocks: the grid renders them in the event timezone, and building them from
  // a formatted string here would put the fixture and the renderer in
  // disagreement on a DST boundary.
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const bands: { offsetMs: number; minutes: number; label: string | null }[] = [
    { offsetMs: 0, minutes: 45, label: null },
    { offsetMs: HOUR, minutes: 45, label: null },
    { offsetMs: 2 * HOUR, minutes: 45, label: null },
    { offsetMs: 3 * HOUR, minutes: 60, label: 'Lunch' },
    { offsetMs: 4.5 * HOUR, minutes: 45, label: null },
    { offsetMs: day, minutes: 45, label: null },
    { offsetMs: day + HOUR, minutes: 45, label: null },
    { offsetMs: day + 2 * HOUR, minutes: 30, label: 'Coffee and posters' },
  ];

  const slotRows = await db
    .insert(slots)
    .values(
      bands.flatMap((band) =>
        roomRows.map((room) => ({
          roomId: room.id,
          startsAt: new Date(startsOn.getTime() + band.offsetMs),
          endsAt: new Date(startsOn.getTime() + band.offsetMs + band.minutes * MINUTE),
          label: band.label,
        })),
      ),
    )
    .returning();

  // A poster is displayed for the length of the event rather than presented in
  // a band, so it is never placed. Three talks stay in the pool: an organizer
  // opening the grid should have something left to drag.
  const schedulable = accepted.filter((submission) => submission.format !== 'poster');
  const openSlots = slotRows.filter((slot) => slot.label === null);
  const placements = schedulable.slice(0, Math.max(schedulable.length - 3, 0));

  for (const [i, submission] of placements.entries()) {
    const slot = openSlots[i];
    if (!slot) break;
    await db.update(slots).set({ submissionId: submission.id }).where(eq(slots.id, slot.id));
  }

  // Two wiki pages, one published and one draft, so the portal has something in
  // it on a fresh reset and the draft/published split is visible without
  // anybody having to write a page first.
  const pageRows = await db
    .insert(portalPages)
    .values([
      {
        slug: 'venue-and-av',
        title: 'Venue and AV',
        summary: 'Where to go, what is on the lectern, and who to find when it does not work.',
        position: 0,
        published: true,
        body: [
          '<p>The venue is the Corn Exchange, two minutes from the station. Speaker',
          'registration is the desk on the left as you come in.</p>',
          '<h2>What is on the lectern</h2>',
          '<ul>',
          '  <li>HDMI and USB-C, both with power delivery</li>',
          '  <li>A wireless presenter with a laser pointer</li>',
          '  <li>A confidence monitor showing your current slide and the clock</li>',
          '</ul>',
          '<p>Adapters for anything older live in a box at the AV desk. If your deck',
          'needs sound, say so at <a href="/speaker/pages/before-you-arrive">registration</a>',
          'rather than on the day.</p>',
          '<h2>Getting here</h2>',
          '<iframe src="https://www.google.com/maps?output=embed&q=Corn+Exchange" width="600" height="340" title="Venue map"></iframe>',
        ].join('\n'),
      },
      {
        slug: 'before-you-arrive',
        title: 'Before you arrive',
        summary: 'The three things we need from you, and when.',
        position: 1,
        published: false,
        body: [
          '<p>This page is still being written.</p>',
          '<ol><li>Upload your slides</li><li>Confirm your travel</li><li>Tell us about AV</li></ol>',
        ].join('\n'),
      },
    ])
    .returning({ id: portalPages.id });

  console.log(
    [
      `✓ event: ${event.name}`,
      `✓ ${trackRows.length} tracks, ${roomRows.length} rooms`,
      `✓ ${speakerRows.length} speakers, ${reviewerRows.length} reviewers`,
      `✓ ${submissionRows.length} submissions (${accepted.length} accepted, ${submitted.length} undecided)`,
      `✓ ${reviewValues.length} human reviews, ${aiValues.length} AI reviews, ${assignmentValues.length} assignments`,
      `✓ ${taskValues.length} speaker tasks, ${bookmarkValues.length} bookmarks, ${authorValues.length} author rows`,
      `✓ ${awardRows.length} awards, ${nomineeValues.length} nominees`,
      `✓ 2 review rounds (round 1 closed), ${questionRows.length} form questions, ${answerValues.length} answers`,
      `✓ ${slotRows.length} slots over 2 days, ${placements.length} talks placed, agenda unpublished`,
      `✓ ${pageRows.length} portal pages (1 published, 1 draft)`,
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
