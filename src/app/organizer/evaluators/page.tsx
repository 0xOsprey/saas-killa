import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Notice,
  PageHeader,
  ScoreDots,
  Select,
  Textarea,
} from '@/components/ui';
import {
  BATCH_OPTIONS,
  DEFAULT_BATCH,
  EVALUATOR_MODEL,
  MAX_BATCH,
  evaluatorConfigured,
} from '@/lib/ai-evaluator';
import { aiGrades, gradableSubmissions, personaRoster } from '@/lib/evaluator-queries';
import type { AiGradeRow, PersonaRosterRow } from '@/lib/evaluator-queries';
import { inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { RUBRIC, RUBRIC_KEYS, RUBRIC_LABELS } from '@/lib/rubric';
import {
  clearAiOverride,
  createPersona,
  overrideAiScore,
  restorePersona,
  retirePersona,
  updatePersona,
} from './actions';
import { RunPanel } from './RunPanel';

export default async function EvaluatorsPage() {
  const configured = evaluatorConfigured();
  const [event, personas, grades, gradable] = await Promise.all([
    getEvent(),
    personaRoster(),
    aiGrades(25),
    gradableSubmissions(),
  ]);
  const active = personas.filter((persona) => persona.active);
  const overridden = grades.filter((grade) => grade.overrideScore !== null).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI evaluators"
        description={`Reviewer personas graded by ${EVALUATOR_MODEL}. Each one owns a bot reviewer account and writes ordinary reviews a human can override.`}
        action={
          <Link
            href="/organizer/evaluators/audit"
            className="text-sm text-muted underline hover:text-ink"
          >
            Outliers and grade audit
          </Link>
        }
      />

      {configured ? null : (
        <Notice>
          The AI evaluator is off. Set <code>ANTHROPIC_API_KEY</code> to run a persona. Personas can
          still be written and edited here; nothing calls the model without the key.
        </Notice>
      )}

      <RunPanel
        personas={active.map((persona) => ({
          id: persona.id,
          name: persona.name,
          gradeCount: persona.gradeCount,
        }))}
        submissions={gradable}
        configured={configured}
        batchOptions={BATCH_OPTIONS}
        defaultLimit={DEFAULT_BATCH}
        maxBatch={MAX_BATCH}
      />

      <Card className="space-y-3" data-testid="ai-grades">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            What the evaluator wrote ({grades.length} shown
            {overridden > 0 ? `, ${overridden} overridden` : ''})
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Every AI grade, newest first, with the rationale the model gave for it. An override
            replaces the number every aggregate reads without erasing the one the model produced.
          </p>
        </div>
        {grades.length === 0 ? (
          <Empty>
            No AI grade has been written yet. Run a persona above and its grades appear here with
            their reasoning.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {grades.map((grade) => (
              <AiGradeCard key={grade.reviewId} grade={grade} timezone={event.timezone} />
            ))}
          </ul>
        )}
      </Card>

      {personas.length === 0 ? (
        <Empty>No personas yet. The first one you create becomes the reviewer that grades.</Empty>
      ) : null}

      {personas.map((persona) => (
        <PersonaCard key={persona.id} persona={persona} />
      ))}

      <Card className="max-w-2xl space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">New persona</h2>
          <p className="mt-0.5 text-xs text-muted">
            Creating one also creates its bot reviewer account, so its grades attribute exactly
            like a person&rsquo;s.
          </p>
        </div>
        <form action={createPersona} className="space-y-3">
          <PersonaFields />
          <Button type="submit" variant="secondary" data-testid="create-persona">
            Create persona
          </Button>
        </form>
      </Card>
    </div>
  );
}

/**
 * One AI grade, its reasoning, and the control that lets a chair disagree with it.
 *
 * The override form and the clear control are one form with two submit buttons
 * rather than two forms, because a nested form does not exist in HTML: the inner
 * one is dropped by the parser and its button silently posts the outer action.
 */
function AiGradeCard({ grade, timezone }: { grade: AiGradeRow; timezone: string }) {
  const overridden = grade.overrideScore !== null;
  const rubric = Object.entries(grade.rubric ?? {});

  return (
    <li
      className="space-y-2 rounded-md border border-line px-3 py-2.5"
      data-testid={`ai-grade-${grade.reviewId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/organizer/abstracts/${grade.submissionId}`}
            className="text-sm font-medium text-ink underline-offset-2 hover:underline"
          >
            {grade.title}
          </Link>
          <p className="mt-0.5 text-xs text-muted">
            <Badge tone="accent">AI</Badge> {grade.personaName ?? 'retired persona'} ·{' '}
            {grade.roundName} · {grade.model ?? 'model not recorded'} ·{' '}
            {inEventZone(grade.createdAt, timezone, { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* The machine's own number stays legible next to the human's. An
              override that hid what it replaced would make the audit table
              above unreadable a week later. */}
          <span data-testid={`ai-score-${grade.reviewId}`}>
            <ScoreDots score={grade.overrideScore ?? grade.score} />
          </span>
          {overridden ? (
            <span className="text-xs text-muted" data-testid={`ai-original-${grade.reviewId}`}>
              AI said {grade.score} · chair says {grade.overrideScore}
            </span>
          ) : (
            <span className="text-xs text-muted">AI score {grade.score}</span>
          )}
        </div>
      </div>

      {rubric.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {rubric.map(([key, value]) => (
            <Badge key={key}>
              {RUBRIC_LABELS[key as keyof typeof RUBRIC_LABELS] ?? key} {value}
            </Badge>
          ))}
        </div>
      ) : null}

      {grade.comment ? (
        <p
          className="whitespace-pre-wrap text-sm text-muted"
          data-testid={`ai-rationale-${grade.reviewId}`}
        >
          {grade.comment}
        </p>
      ) : (
        <p className="text-sm text-muted">The model returned a score with no rationale.</p>
      )}

      {overridden ? (
        <Notice tone="warn">
          Overridden by {grade.overriddenBy ?? 'an organizer'}
          {grade.overriddenAt
            ? ` on ${inEventZone(grade.overriddenAt, timezone, { dateStyle: 'medium' })}`
            : ''}
          {grade.overrideReason ? `: ${grade.overrideReason}` : '.'}
        </Notice>
      ) : null}

      <form action={overrideAiScore} className="flex flex-wrap items-end gap-2 border-t border-line pt-2.5">
        <input type="hidden" name="reviewId" value={grade.reviewId} />
        <Field label="Chair's score">
          <Select
            name="score"
            defaultValue={String(grade.overrideScore ?? grade.score)}
            data-testid={`override-score-${grade.reviewId}`}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <div className="min-w-56 flex-1">
          <Field label="Why">
            <Input
              name="reason"
              maxLength={500}
              defaultValue={grade.overrideReason ?? ''}
              placeholder="Read it myself, the methodology holds up"
            />
          </Field>
        </div>
        <Button
          type="submit"
          variant="secondary"
          data-testid={`override-save-${grade.reviewId}`}
        >
          {overridden ? 'Update override' : 'Override'}
        </Button>
        {overridden ? (
          <Button
            type="submit"
            variant="ghost"
            formAction={clearAiOverride}
            data-testid={`override-clear-${grade.reviewId}`}
          >
            Put the AI score back
          </Button>
        ) : null}
      </form>
    </li>
  );
}

function PersonaCard({ persona }: { persona: PersonaRosterRow }) {
  return (
    <Card className="max-w-2xl space-y-3" data-testid={`persona-${persona.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-medium text-ink">{persona.name}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {persona.profession ?? 'no profession set'} · {persona.botEmail}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{persona.gradeCount} grade(s)</Badge>
          <Badge tone={persona.active ? 'good' : 'neutral'}>
            {persona.active ? 'active' : 'retired'}
          </Badge>
        </div>
      </div>

      <form action={updatePersona} className="space-y-3 border-t border-line pt-3">
        <input type="hidden" name="personaId" value={persona.id} />
        <PersonaFields persona={persona} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </div>
      </form>

      <div className="border-t border-line pt-3">
        {persona.active ? (
          <form action={retirePersona}>
            <input type="hidden" name="personaId" value={persona.id} />
            <Button type="submit" variant="danger" className="text-xs">
              Retire
            </Button>
            <span className="ml-2 text-xs text-muted">
              Stops it grading. Its {persona.gradeCount} existing grade(s) stay where reviewers can
              read them.
            </span>
          </form>
        ) : (
          <form action={restorePersona}>
            <input type="hidden" name="personaId" value={persona.id} />
            <Button type="submit" variant="ghost" className="text-xs">
              Restore
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

/** Shared by the create form and every edit form, so they cannot drift apart. */
function PersonaFields({ persona }: { persona?: PersonaRosterRow }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            name="name"
            required
            minLength={2}
            maxLength={80}
            defaultValue={persona?.name ?? ''}
            placeholder="Dr Amara Osei"
            data-testid="persona-name"
          />
        </Field>
        <Field label="Profession">
          <Input
            name="profession"
            maxLength={400}
            defaultValue={persona?.profession ?? ''}
            placeholder="Staff engineer, distributed systems"
          />
        </Field>
      </div>
      <Field label="Tone" hint="How the note to the other reviewers should read.">
        <Input
          name="tone"
          maxLength={400}
          defaultValue={persona?.tone ?? ''}
          placeholder="Blunt, practical, allergic to buzzwords"
        />
      </Field>
      <Field label="Expertise" hint="What this reviewer judges from. Never shown to speakers.">
        <Textarea
          name="expertise"
          maxLength={400}
          className="min-h-16"
          defaultValue={persona?.expertise ?? ''}
          placeholder="Fifteen years running production databases; has seen every migration story go wrong"
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Criterion weights</legend>
        <p className="text-xs text-muted">
          The stored 1-5 score is the weighted mean of these. 0 drops a criterion entirely.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {RUBRIC_KEYS.map((key) => (
            <Field key={key} label={RUBRIC_LABELS[key]} hint={RUBRIC[key]}>
              <Input
                type="number"
                name={`weight_${key}`}
                min={0}
                max={10}
                step={1}
                defaultValue={persona?.weights[key] ?? 1}
                data-testid={`weight-${key}`}
              />
            </Field>
          ))}
        </div>
      </fieldset>
    </>
  );
}
