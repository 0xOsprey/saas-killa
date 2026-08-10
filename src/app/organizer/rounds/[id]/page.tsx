import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import type { RoundCriterion } from '@/db/schema';
import { dayLabel, instantToWallClock } from '@/lib/format';
import { reviewerCompletion } from '@/lib/grading';
import { getEvent } from '@/lib/queries';
import {
  conflictsForRound,
  ensureRoundCriteria,
  findRound,
  roundIsOpen,
  roundPool,
} from '@/lib/rounds';
import {
  addPoolMember,
  bringBackCriterion,
  closeRoundNow,
  createCriterion,
  removeCriterion,
  removePoolMember,
  reopenRound,
  saveCriterion,
  saveRound,
  setBlind,
} from '../actions';
import { criterionShape } from '../Scorecard';

const ERRORS: Record<string, string> = {
  'round-name': 'Give the round a name.',
  'round-order': 'A round cannot close before it opens.',
  criterion: 'Check the criterion’s name and numbers and try again.',
  'criterion-options': 'A dropdown needs at least one choice, one per line.',
  'not-reviewer': 'That person does not hold the reviewer role.',
};

const SAVED: Record<string, string> = {
  round: 'Round saved.',
  'blind-on': 'Blind review on. Reviewers in this round no longer see who wrote what.',
  'blind-off': 'Blind review off. Reviewers in this round now see the author list.',
  closed: 'Round closed. Its scores are kept.',
  reopened: 'Round reopened. New grades land in it again.',
  'criterion-added': 'Criterion added to this round’s scorecard.',
  'criterion-saved': 'Criterion saved.',
  'criterion-removed': 'Criterion taken off the scorecard. Grades already filed against it stay.',
  'criterion-restored': 'Criterion back on the scorecard.',
  'pool-added': 'Reviewer added to this round’s pool.',
  'pool-removed': 'Reviewer taken off this round’s pool. Their grades stay.',
};

function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function RoundDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const round = await findRound(parsed.data);
  if (!round) notFound();

  const [event, criteria, pool, roster, conflicts] = await Promise.all([
    getEvent(),
    ensureRoundCriteria(round.id),
    roundPool(round.id),
    reviewerCompletion(round.id),
    conflictsForRound(round.id),
  ]);

  const query = await searchParams;
  const error = one(query.error);
  const saved = one(query.saved);
  const open = roundIsOpen(round);
  const live = criteria.filter((criterion) => criterion.archivedAt === null);
  const archived = criteria.filter((criterion) => criterion.archivedAt !== null);
  const inPool = new Set(pool.map((member) => member.reviewerId));
  const addable = roster.filter((row) => !inPool.has(row.reviewerId));

  return (
    <div className="space-y-5">
      <PageHeader
        title={round.name}
        description={`Opens ${
          round.opensAt ? dayLabel(round.opensAt, event.timezone) : 'immediately'
        } · closes ${round.dueAt ? dayLabel(round.dueAt, event.timezone) : 'no close date'}`}
        action={
          <div className="flex items-center gap-3">
            <Badge tone={open ? 'good' : 'neutral'}>{open ? 'open' : 'closed'}</Badge>
            <Link href="/organizer/rounds" className="text-sm text-muted underline hover:text-ink">
              All rounds
            </Link>
          </div>
        }
      />

      {error ? <Notice tone="bad">{ERRORS[error] ?? 'That did not work.'}</Notice> : null}
      {saved && SAVED[saved] ? <Notice tone="good">{SAVED[saved]}</Notice> : null}

      <Card className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Name and window</h2>
          <p className="mt-0.5 text-xs text-muted">
            Times are in the event timezone ({event.timezone}). Grading is refused before the open
            date and after the round is closed.
          </p>
        </div>

        <form action={saveRound} className="space-y-3">
          <input type="hidden" name="roundId" value={round.id} />
          <Field label="Name">
            <Input
              name="name"
              required
              maxLength={80}
              defaultValue={round.name}
              data-testid="round-name"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Opens">
              <Input
                type="datetime-local"
                name="opensAt"
                defaultValue={
                  round.opensAt ? instantToWallClock(round.opensAt, event.timezone) : ''
                }
                data-testid="round-opens-at"
              />
            </Field>
            <Field label="Closes">
              <Input
                type="datetime-local"
                name="dueAt"
                defaultValue={round.dueAt ? instantToWallClock(round.dueAt, event.timezone) : ''}
                data-testid="round-due-at"
              />
            </Field>
          </div>
          <Button type="submit" data-testid="save-round">
            Save round
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <form action={setBlind} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="roundId" value={round.id} />
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="blind"
                defaultChecked={round.blind}
                data-testid="blind-toggle"
              />
              Blind review: hide author identity from reviewers in this round
            </label>
            <Button type="submit" variant="secondary" data-testid="save-blind">
              Save
            </Button>
          </form>
        </div>

        <div className="border-t border-line pt-3">
          {open ? (
            <form action={closeRoundNow}>
              <input type="hidden" name="roundId" value={round.id} />
              <Button type="submit" variant="secondary" data-testid="close-round">
                Close round
              </Button>
            </form>
          ) : (
            <form action={reopenRound}>
              <input type="hidden" name="roundId" value={round.id} />
              <Button type="submit" variant="secondary" data-testid="reopen-round">
                Reopen round
              </Button>
            </form>
          )}
        </div>
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Scorecard</h2>
          <p className="mt-0.5 text-xs text-muted">
            What a reviewer fills in for this round. Only numeric fields reach the score: a
            dropdown answer and a paragraph are recorded and read, never averaged. A weight of 0
            drops a numeric field out of the mean without taking it off the form.
          </p>
        </div>

        {live.length === 0 ? <Empty>No criteria. Add the first one below.</Empty> : null}

        {live.map((criterion) => (
          <CriterionForm key={criterion.id} roundId={round.id} criterion={criterion} />
        ))}

        <div className="space-y-3 border-t border-line pt-4">
          <h3 className="text-sm font-medium text-ink">Add a criterion</h3>
          <CriterionForm roundId={round.id} />
        </div>

        {archived.length > 0 ? (
          <div className="space-y-2 border-t border-line pt-4">
            <h3 className="text-sm font-medium text-ink">Taken off the scorecard</h3>
            <p className="text-xs text-muted">
              Kept rather than deleted, because grades were filed against them and a score whose
              criterion is gone is unreadable.
            </p>
            {archived.map((criterion) => (
              <form
                key={criterion.id}
                action={bringBackCriterion}
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="roundId" value={round.id} />
                <input type="hidden" name="criterionId" value={criterion.id} />
                <Badge>{criterion.label}</Badge>
                <span className="text-xs text-muted">{criterionShape(criterion)}</span>
                <Button type="submit" variant="ghost" className="text-xs">
                  Put it back
                </Button>
              </form>
            ))}
          </div>
        ) : null}
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Reviewer pool</h2>
          <p className="mt-0.5 text-xs text-muted">
            Who sits on this round&rsquo;s committee. An empty pool means every reviewer, which is
            how the distributor behaved before pools existed. With anyone in it, the distributor
            hands work only to these people.
          </p>
        </div>

        {pool.length === 0 ? (
          <Empty>Nobody scoped to this round yet, so it is open to every reviewer.</Empty>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="pool-list">
            {pool.map((member) => (
              <li key={member.reviewerId}>
                <form action={removePoolMember} className="inline-flex">
                  <input type="hidden" name="roundId" value={round.id} />
                  <input type="hidden" name="reviewerId" value={member.reviewerId} />
                  <Button
                    type="submit"
                    variant="ghost"
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-xs"
                    title="Take them off this round"
                    data-testid={`pool-remove-${member.reviewerId}`}
                  >
                    {member.name ?? member.email}
                    <span aria-hidden className="text-muted">
                      ×
                    </span>
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {addable.length > 0 ? (
          <form action={addPoolMember} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="roundId" value={round.id} />
            <Field label="Add a reviewer">
              <Select
                name="reviewerId"
                required
                defaultValue=""
                className="w-64"
                data-testid="pool-picker"
              >
                <option value="" disabled>
                  Choose a reviewer
                </option>
                {addable.map((row) => (
                  <option key={row.reviewerId} value={row.reviewerId}>
                    {row.name ?? row.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" data-testid="pool-add">
              Add to pool
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted">Every reviewer is already on this round.</p>
        )}
      </Card>

      <Card className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Declared conflicts</h2>
          <p className="mt-0.5 text-xs text-muted">
            A reviewer who recused themselves from a proposal in this round. Their assignment is
            left in place deliberately: the number worth knowing is how much of the pile is
            uncovered because somebody stepped back, and a deleted row cannot say that.
          </p>
        </div>

        {conflicts.length === 0 ? (
          <Empty>Nobody has declared a conflict in this round.</Empty>
        ) : (
          <ul className="divide-y divide-line" data-testid="conflict-list">
            {conflicts.map((conflict) => (
              <li
                key={`${conflict.submissionId}-${conflict.reviewerId}`}
                className="py-2"
                data-testid={`conflict-${conflict.submissionId}-${conflict.reviewerId}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">{conflict.submissionTitle}</span>
                  <span className="text-xs text-muted">
                    {conflict.reviewerName ?? conflict.reviewerEmail} ·{' '}
                    {dayLabel(conflict.declaredAt, event.timezone)}
                  </span>
                </div>
                {conflict.reason ? (
                  <p className="mt-0.5 text-xs text-muted">{conflict.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * One criterion, edited or created. The same markup for both so the two cannot
 * drift into offering different fields, which is how a scorecard editor ends up
 * able to create something it cannot edit.
 *
 * Every field is rendered whatever the kind. A conditional form would need a
 * client component, and the trade is worth it the other way round: a scale
 * showing on a text field is a hint that reads as noise, and a field that
 * appears only after a dropdown changes is a field nobody with scripting off can
 * reach. The action ignores what the kind does not use.
 */
function CriterionForm({ roundId, criterion }: { roundId: string; criterion?: RoundCriterion }) {
  const action = criterion ? saveCriterion : createCriterion;
  const testId = criterion ? `criterion-form-${criterion.id}` : 'criterion-form-new';

  return (
    <form
      action={action}
      className="space-y-3 rounded-md border border-line p-3"
      data-testid={testId}
    >
      <input type="hidden" name="roundId" value={roundId} />
      {criterion ? <input type="hidden" name="criterionId" value={criterion.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Name">
          <Input
            name="label"
            required
            maxLength={80}
            defaultValue={criterion?.label ?? ''}
            placeholder="Originality"
            data-testid={criterion ? `label-${criterion.id}` : 'new-criterion-label'}
          />
        </Field>
        <Field label="Field type">
          <Select
            name="kind"
            defaultValue={criterion?.kind ?? 'numeric'}
            data-testid={criterion ? `kind-${criterion.id}` : 'new-criterion-kind'}
          >
            <option value="numeric">Numeric rating</option>
            <option value="select">Dropdown</option>
            <option value="text">Free text</option>
          </Select>
        </Field>
      </div>

      <Field label="Question" hint="Shown under the field to the reviewer. Optional.">
        <Input
          name="helpText"
          maxLength={300}
          defaultValue={criterion?.helpText ?? ''}
          placeholder="Does this cover ground the audience has not already heard?"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Scale from" hint="Numeric only.">
          <Input
            type="number"
            name="scaleMin"
            min={0}
            max={99}
            defaultValue={criterion?.scaleMin ?? 1}
            data-testid={criterion ? `scale-min-${criterion.id}` : 'new-criterion-scale-min'}
          />
        </Field>
        <Field label="Scale to" hint="Numeric only.">
          <Input
            type="number"
            name="scaleMax"
            min={1}
            max={100}
            defaultValue={criterion?.scaleMax ?? 5}
            data-testid={criterion ? `scale-max-${criterion.id}` : 'new-criterion-scale-max'}
          />
        </Field>
        <Field label="Weight" hint="Numeric only. 0 drops it from the score.">
          <Input
            type="number"
            name="weight"
            min={0}
            max={10}
            defaultValue={criterion?.weight ?? 1}
            data-testid={criterion ? `weight-${criterion.id}` : 'new-criterion-weight'}
          />
        </Field>
      </div>

      <Field label="Choices" hint="Dropdown only. One per line, so a comma inside a choice survives.">
        <Textarea
          name="options"
          className="min-h-16"
          defaultValue={(criterion?.options ?? []).join('\n')}
          placeholder={'Accept\nMaybe\nReject'}
          data-testid={criterion ? `options-${criterion.id}` : 'new-criterion-options'}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant={criterion ? 'secondary' : 'primary'}
          data-testid={criterion ? `save-criterion-${criterion.id}` : 'add-criterion'}
        >
          {criterion ? 'Save' : 'Add criterion'}
        </Button>
        {criterion ? (
          <>
            {/* `formAction` rather than a second form, because a form inside a
                form is not valid markup and the browser drops the inner one. */}
            <Button
              type="submit"
              formAction={removeCriterion}
              variant="danger"
              className="text-xs"
              data-testid={`remove-criterion-${criterion.id}`}
            >
              Take off scorecard
            </Button>
            <span className="text-xs text-muted">
              stored as <code>{criterion.key}</code> · {criterionShape(criterion)}
            </span>
          </>
        ) : null}
      </div>

      {criterion ? null : (
        <p className="text-xs text-muted">
          The name becomes this criterion&rsquo;s storage key and does not change afterwards, so a
          later rename is a display edit and every score already filed keeps its field.
        </p>
      )}
    </form>
  );
}
