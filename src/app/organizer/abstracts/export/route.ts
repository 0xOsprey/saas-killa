import { currentUser } from '@/lib/auth';
import { exportRows, toCsv } from '@/lib/abstracts';

const HEADER = [
  'id',
  'title',
  'abstract',
  'speaker_name',
  'speaker_email',
  'track',
  'format',
  'level',
  'status',
  'keywords',
  'review_count',
  'mean_human_score',
  'mean_ai_score',
];

function score(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}

/**
 * The scoring export. A route handler rather than a page because the browser has
 * to save this, and organizer-only because it carries speaker identity beside
 * the grades that decided them.
 *
 * `requireRole` is not used here: it throws, and a thrown authorisation error in
 * a route handler is a 500 that reads like an outage. A 403 is the answer.
 */
export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  if (!user.roles.includes('organizer')) {
    return new Response('Organizer access only.', { status: 403 });
  }

  const rows = await exportRows();
  const csv = toCsv(
    HEADER,
    rows.map((row) => [
      row.id,
      row.title,
      row.abstract,
      row.speakerName,
      row.speakerEmail,
      row.trackName,
      row.format,
      row.audienceLevel,
      row.status,
      row.keywords.join('; '),
      row.reviewCount,
      score(row.meanHumanScore),
      score(row.meanAiScore),
    ]),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="abstracts-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
