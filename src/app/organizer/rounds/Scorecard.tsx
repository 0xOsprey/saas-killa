import { Badge } from '@/components/ui';
import type { RoundCriterion } from '@/db/schema';

/**
 * A round's scorecard in one line per field, compact enough that the round list
 * can show what each round actually grades on without opening it.
 *
 * That is the whole reason it exists as a component rather than markup inside
 * the detail page: "two rounds with different scorecards" is a claim you can
 * only check by seeing both at once.
 */
export function CriterionSummary({ criterion }: { criterion: RoundCriterion }) {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`criterion-${criterion.id}`}>
      <Badge tone={criterion.archivedAt ? 'neutral' : 'accent'}>{criterion.label}</Badge>
      <span className="text-xs text-muted">{criterionShape(criterion)}</span>
    </span>
  );
}

/** The field's type and its range, in the words the scorecard editor uses. */
export function criterionShape(criterion: RoundCriterion): string {
  if (criterion.kind === 'numeric') {
    const weight = criterion.weight === 1 ? '' : ` · weight ${criterion.weight}`;
    return `numeric ${criterion.scaleMin}-${criterion.scaleMax}${weight}`;
  }
  if (criterion.kind === 'select') {
    return `dropdown · ${criterion.options.join(' / ') || 'no choices set'}`;
  }
  return 'free text';
}

export function ScorecardSummary({ criteria }: { criteria: RoundCriterion[] }) {
  const live = criteria.filter((criterion) => criterion.archivedAt === null);
  if (live.length === 0) {
    return <p className="text-xs text-muted">No criteria on this scorecard yet.</p>;
  }
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {live.map((criterion) => (
        <li key={criterion.id}>
          <CriterionSummary criterion={criterion} />
        </li>
      ))}
    </ul>
  );
}
