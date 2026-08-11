import { displayAnswer } from '@/lib/questions';
import type { AnsweredQuestion } from '@/lib/question-queries';

/**
 * What a speaker answered to the organizer-configured questions.
 *
 * Shared by the review queue and the organizer's submission detail, because a
 * committee that grades on an answer and an organizer who decides on one need
 * to be looking at the same words. Reads nothing from `users`, so it is safe on
 * the blind queue.
 */
export function AnswerList({ answers }: { answers: AnsweredQuestion[] }) {
  if (answers.length === 0) return null;

  return (
    <dl className="space-y-2 rounded-md border border-line bg-slate-50 p-3" data-testid="answers">
      {answers.map(({ question, value }) => (
        <div key={question.id}>
          <dt className="text-xs font-medium text-muted">{question.prompt}</dt>
          <dd className="whitespace-pre-wrap text-sm text-ink">
            {question.kind === 'url' ? (
              <a
                href={value}
                className="text-accent underline"
                rel="noreferrer noopener"
                target="_blank"
              >
                {value}
              </a>
            ) : (
              displayAnswer(question, value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
