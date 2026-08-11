'use client';

import { useActionState } from 'react';
import { Badge, Button, Card, Field, Notice, Select } from '@/components/ui';
import type { RunReport } from '@/lib/ai-evaluator';
import { runPersonaEvaluation } from './actions';

type PersonaOption = { id: string; name: string; gradeCount: number };
type SubmissionOption = { id: string; title: string; decided: boolean };

/**
 * The run controls and the report of the last run. It is a client component for
 * one reason: `useActionState` is what keeps the outcome on screen after the
 * action returns, and a plain form action throws its return value away — which
 * is the v1 bug this page exists to fix.
 */
export function RunPanel({
  personas,
  submissions,
  configured,
  batchOptions,
  defaultLimit,
  maxBatch,
}: {
  personas: PersonaOption[];
  submissions: SubmissionOption[];
  configured: boolean;
  batchOptions: readonly number[];
  defaultLimit: number;
  maxBatch: number;
}) {
  const [report, formAction, isPending] = useActionState<RunReport | null, FormData>(
    runPersonaEvaluation,
    null,
  );
  const runnable = configured && personas.length > 0;

  return (
    <Card className="space-y-4" data-testid="run-panel">
      <div>
        <h2 className="text-sm font-semibold text-ink">Run an evaluator</h2>
        <p className="mt-0.5 text-xs text-muted">
          One model call per submission, in one request, capped at {maxBatch}. Anything over the
          cap waits for the next run.
        </p>
      </div>

      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <Field label="Persona">
          <Select name="personaId" className="w-56" disabled={!runnable}>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name} ({persona.gradeCount} graded)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cap this run at">
          <Select
            name="limit"
            className="w-32"
            defaultValue={String(defaultLimit)}
            disabled={!runnable}
          >
            {batchOptions.map((option) => (
              <option key={option} value={option}>
                {option} submissions
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Or one proposal"
          hint="Naming one grades it whichever button you press, decided or not."
        >
          <Select name="submissionId" className="w-64" disabled={!runnable} data-testid="run-one">
            <option value="">Every open proposal</option>
            {submissions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
                {option.decided ? ' (decided)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          type="submit"
          name="mode"
          value="pending"
          disabled={!runnable || isPending}
          data-testid="run-pending"
        >
          {isPending ? 'Running…' : 'Grade what it has not seen'}
        </Button>
        <Button
          type="submit"
          name="mode"
          value="replace"
          variant="danger"
          disabled={!runnable || isPending}
          data-testid="run-replace"
        >
          Re-run and replace its own grades
        </Button>
      </form>

      {!runnable ? (
        <Notice tone="warn">
          {configured
            ? 'No active persona to run. Create one below.'
            : 'Set ANTHROPIC_API_KEY to run a persona. Personas can still be written and edited.'}
        </Notice>
      ) : null}

      {report ? <Report report={report} /> : null}
    </Card>
  );
}

function Report({ report }: { report: RunReport }) {
  if (report.error) {
    return <Notice tone="bad">{report.error}</Notice>;
  }

  const failures = report.runs.flatMap((run) => run.failures);

  return (
    <div className="space-y-3 border-t border-line pt-3" data-testid="run-report">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          Last run {new Date(report.ranAt).toLocaleTimeString()}
        </span>
        <Badge tone="good">{report.graded} graded</Badge>
        <Badge>{report.skipped} skipped</Badge>
        <Badge tone={report.failed > 0 ? 'bad' : 'neutral'}>{report.failed} failed</Badge>
        {report.overCap > 0 ? <Badge tone="warn">{report.overCap} left by the cap</Badge> : null}
      </div>

      {report.runs.map((run) => (
        <p key={run.personaId} className="text-xs text-muted">
          {run.personaName} · {run.replaced ? 'replaced its own grades' : 'graded only new work'} ·
          capped at {run.limit}
          {run.skipped > 0 ? ` · ${run.skipped} already graded by it` : ''}
        </p>
      ))}

      {failures.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {failures.map((failure) => (
            <li key={failure.submissionId} className="text-red-700">
              <span className="font-medium">{failure.title}</span> — {failure.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
