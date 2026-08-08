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
  Textarea,
} from '@/components/ui';
import {
  BATCH_OPTIONS,
  DEFAULT_BATCH,
  EVALUATOR_MODEL,
  MAX_BATCH,
  evaluatorConfigured,
} from '@/lib/ai-evaluator';
import { personaRoster } from '@/lib/evaluator-queries';
import type { PersonaRosterRow } from '@/lib/evaluator-queries';
import { RUBRIC, RUBRIC_KEYS, RUBRIC_LABELS } from '@/lib/rubric';
import { createPersona, restorePersona, retirePersona, updatePersona } from './actions';
import { RunPanel } from './RunPanel';

export default async function EvaluatorsPage() {
  const configured = evaluatorConfigured();
  const personas = await personaRoster();
  const active = personas.filter((persona) => persona.active);

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
        configured={configured}
        batchOptions={BATCH_OPTIONS}
        defaultLimit={DEFAULT_BATCH}
        maxBatch={MAX_BATCH}
      />

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
