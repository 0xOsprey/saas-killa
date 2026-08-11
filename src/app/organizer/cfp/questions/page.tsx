import Link from 'next/link';
import { Badge, Button, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { submissionFormatEnum } from '@/db/schema';
import { editorQuestions } from '@/lib/question-queries';
import { QUESTION_KIND_LABELS, possibleParents } from '@/lib/questions';
import { allTracks } from '@/lib/queries';
import { BranchForm } from './BranchForm';
import { QuestionForm } from './QuestionForm';
import {
  addQuestion,
  archiveQuestion,
  moveQuestion,
  restoreQuestion,
  setBranch,
  updateQuestion,
} from './actions';

const ERRORS: Record<string, string> = {
  question: 'Check the wording and the answer type.',
  options: 'A choose-one question needs at least two choices.',
  'branch-self': 'A question cannot depend on itself.',
  'branch-value': 'Pick the answer that reveals it.',
  'branch-missing': 'That question is no longer on the form.',
  'branch-order': 'A question can only depend on one above it.',
  move: 'That question is already at the end.',
};

const SAVED: Record<string, string> = {
  added: 'Question added to the end of the form.',
  updated: 'Question saved.',
  moved: 'Order changed.',
  archived: 'Question retired. Answers already given are kept.',
  restored: 'Question restored to the end of the form.',
  'branch-set': 'Rule saved.',
  'branch-cleared': 'Rule cleared. The question is now always shown.',
};

function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [questions, tracks] = await Promise.all([editorQuestions(), allTracks()]);

  const live = questions.filter((question) => question.archivedAt === null);
  const archived = questions.filter((question) => question.archivedAt !== null);
  const trackName = new Map(tracks.map((track) => [track.id, track.name]));

  const error = one(params.error);
  const saved = one(params.saved);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Submission form"
        description="The questions a speaker answers on top of title, abstract and bio. Answers are shown to the committee alongside the proposal."
        action={
          <Link href="/organizer/cfp" className="text-sm text-muted underline hover:text-ink">
            Back to the call
          </Link>
        }
      />

      {error ? <Notice tone="bad">{ERRORS[error] ?? 'That did not save.'}</Notice> : null}
      {saved && SAVED[saved] ? <Notice tone="good">{SAVED[saved]}</Notice> : null}

      {live.length === 0 ? (
        <Empty>
          No extra questions yet. Everything below the abstract is optional; add one only when the
          committee would grade differently for knowing the answer.
        </Empty>
      ) : (
        <ol className="space-y-4">
          {live.map((question, index) => {
            const parents = possibleParents(live, question);
            const scope = [
              ...question.formats.map((format) => format.replace(/_/g, ' ')),
              ...question.trackIds.map((id) => trackName.get(id) ?? 'a deleted track'),
            ];

            return (
              <li key={question.id}>
                <Card className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-muted">Question {index + 1}</p>
                      <p className="text-sm font-medium text-ink">{question.prompt}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge>{QUESTION_KIND_LABELS[question.kind]}</Badge>
                        {question.required ? <Badge tone="accent">Required</Badge> : null}
                        {scope.length > 0 ? (
                          <span className="text-xs text-muted">Only for {scope.join(', ')}</span>
                        ) : (
                          <span className="text-xs text-muted">Asked of everyone</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <form action={moveQuestion}>
                        <input type="hidden" name="questionId" value={question.id} />
                        <input type="hidden" name="direction" value="up" />
                        <Button
                          type="submit"
                          variant="ghost"
                          disabled={index === 0}
                          title={index === 0 ? 'Already first' : 'Move up'}
                        >
                          Up
                        </Button>
                      </form>
                      <form action={moveQuestion}>
                        <input type="hidden" name="questionId" value={question.id} />
                        <input type="hidden" name="direction" value="down" />
                        <Button
                          type="submit"
                          variant="ghost"
                          disabled={index === live.length - 1}
                          title={index === live.length - 1 ? 'Already last' : 'Move down'}
                        >
                          Down
                        </Button>
                      </form>
                      <form action={archiveQuestion}>
                        <input type="hidden" name="questionId" value={question.id} />
                        <Button type="submit" variant="danger">
                          Retire
                        </Button>
                      </form>
                    </div>
                  </div>

                  <div className="border-t border-line pt-3">
                    <BranchForm
                      action={setBranch}
                      questionId={question.id}
                      parents={parents}
                      showIfQuestionId={question.showIfQuestionId}
                      showIfValue={question.showIfValue}
                    />
                  </div>

                  <details className="border-t border-line pt-3">
                    <summary className="cursor-pointer text-sm text-muted hover:text-ink">
                      Edit wording, type and scope
                    </summary>
                    <div className="mt-3">
                      <QuestionForm
                        action={updateQuestion}
                        question={question}
                        tracks={tracks}
                        formats={submissionFormatEnum.enumValues}
                        submitLabel="Save question"
                      />
                    </div>
                  </details>
                </Card>
              </li>
            );
          })}
        </ol>
      )}

      <Card className="space-y-3">
        <h2 className="text-sm font-medium text-ink">Add a question</h2>
        <p className="text-xs text-muted">
          It goes to the end of the form. Move it up afterwards; a question can only branch off one
          above it.
        </p>
        <QuestionForm
          action={addQuestion}
          tracks={tracks}
          formats={submissionFormatEnum.enumValues}
          submitLabel="Add question"
        />
      </Card>

      {archived.length > 0 ? (
        <Card className="space-y-3">
          <h2 className="text-sm font-medium text-ink">Retired</h2>
          <p className="text-xs text-muted">
            Off the form, but still shown on any proposal that answered them. The committee graded
            those answers, so they are kept rather than deleted.
          </p>
          <ul className="space-y-2">
            {archived.map((question) => (
              <li
                key={question.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm"
              >
                <span className="text-muted">{question.prompt}</span>
                <form action={restoreQuestion}>
                  <input type="hidden" name="questionId" value={question.id} />
                  <Button type="submit" variant="secondary">
                    Restore
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
