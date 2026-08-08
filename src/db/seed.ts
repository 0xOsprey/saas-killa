import { sql } from 'drizzle-orm';
import { db } from './index';
import {
  awards,
  events,
  reviews,
  rooms,
  submissions,
  tracks,
  userRoles,
  users,
} from './schema';
import type { AudienceLevel, SubmissionFormat } from './schema';

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
        award_votes, award_nominees, awards, reviews, slots, submissions,
        auth_sessions, magic_link_tokens, user_roles, users, rooms, tracks, events
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
    return {
      speakerId: speaker.id,
      trackId: track.id,
      title: `${title} (${i + 1})`,
      abstract: abstractFor(title, random),
      format,
      audienceLevel: LEVELS[Math.floor(random() * LEVELS.length)]!,
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

  await db.insert(awards).values([
    { name: 'Best talk', description: 'Voted by the programme committee after the event.' },
    { name: 'Best poster', description: 'Voted by attendees at the poster session.' },
  ]);

  console.log(
    [
      `✓ event: ${event.name}`,
      `✓ ${trackRows.length} tracks, ${roomRows.length} rooms`,
      `✓ ${speakerRows.length} speakers, ${reviewerRows.length} reviewers`,
      `✓ ${submissionRows.length} submissions, ${reviewValues.length} reviews`,
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
