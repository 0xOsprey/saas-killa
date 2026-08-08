import { currentUser } from '@/lib/auth';
import { exportRows, toCsv } from '@/lib/abstracts';
import { answersByQuestion, editorQuestions } from '@/lib/question-queries';
import { displayAnswer } from '@/lib/questions';

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

  // The organizer-configured questions become columns, in form order, retired
  // ones included. A retired question that was answered is data somebody
  // decided on, and dropping the column would silently shorten the record.
  // Every submission gets every column so the file stays rectangular; a
  // proposal that was never asked a question leaves its cell empty.
  const questions = await editorQuestions();
  const answers = await answersByQuestion(rows.map((row) => row.id));

  const csv = toCsv(
    [...HEADER, ...questions.map((question) => question.prompt)],
    rows.map((row) => {
      const given = new Map(
        (answers.get(row.id) ?? []).map((entry) => [entry.question.id, entry.value]),
      );
      return [
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
        ...questions.map((question) =>
          given.has(question.id) ? displayAnswer(question, given.get(question.id)) : '',
        ),
      ];
    }),
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
