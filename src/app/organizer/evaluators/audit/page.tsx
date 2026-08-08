import Link from 'next/link';
import { Badge, Card, Empty, PageHeader, ScoreDots } from '@/components/ui';
import { STATUS_LABELS } from '@/lib/format';
import { gradeComparison, mostCompetitive, scoreOutliers } from '@/lib/evaluator-queries';
import type { GradeRow } from '@/lib/evaluator-queries';

/** The gap at which a chair should read the abstract themselves. */
const OUTLIER_GAP = 2;

export default async function EvaluatorAuditPage() {
  const [outliers, competitive, comparison] = await Promise.all([
    scoreOutliers(OUTLIER_GAP),
    mostCompetitive(10),
    gradeComparison(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Grade audit"
        description="Where the machine and the committee disagree, what is winning, and every AI grade next to the human grade for the same proposal."
        action={
          <Link href="/organizer/evaluators" className="text-sm text-muted underline hover:text-ink">
            Personas and runs
          </Link>
        }
      />

      <Card className="space-y-3" data-testid="outliers">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            Outliers ({outliers.length})
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Every proposal where the AI and the human mean differ by {OUTLIER_GAP} or more, decided
            or not. A disagreement on something you accepted anyway is the row worth reading.
          </p>
        </div>
        {outliers.length === 0 ? (
          <Empty>
            Nothing disagrees by {OUTLIER_GAP} or more. A proposal needs both an AI grade and a
            human grade to appear here.
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {outliers.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 font-medium text-ink">{row.title}</span>
                <span className="text-xs tabular-nums text-muted">
                  AI {row.aiScore?.toFixed(1) ?? '—'} ({row.aiCount}) · human{' '}
                  {row.humanScore?.toFixed(1) ?? '—'} ({row.humanCount})
                </span>
                <Badge tone="warn">gap {row.gap.toFixed(1)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-3" data-testid="competitive">
        <div>
          <h2 className="text-sm font-semibold text-ink">Most competitive</h2>
          <p className="mt-0.5 text-xs text-muted">
            The strongest undecided proposals by combined score, AI and human grades averaged
            together.
          </p>
        </div>
        {competitive.length === 0 ? (
          <Empty>Nothing graded yet.</Empty>
        ) : (
          <ol className="space-y-1.5">
            {competitive.map((row, index) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
              >
                <span className="w-6 text-xs tabular-nums text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 font-medium text-ink">{row.title}</span>
                <span className="text-xs tabular-nums text-muted">
                  AI {row.aiScore?.toFixed(1) ?? '—'} · human {row.humanScore?.toFixed(1) ?? '—'} ·{' '}
                  {row.reviewCount} review(s)
                </span>
                <ScoreDots score={row.combinedScore} />
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Human grades, with the AI beside them</h2>
          <p className="text-xs text-muted">
            Every proposal a person has graded. The human grade is the record; the AI grade is
            advisory and never edits it, so a human override is simply the two disagreeing.
          </p>
        </div>

        {comparison.length === 0 ? (
          <Empty>No human grades yet.</Empty>
        ) : (
          comparison.map((row) => (
            <Card key={row.submissionId} className="space-y-2" data-testid={`compare-${row.submissionId}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="font-medium text-ink">{row.title}</h3>
                <Badge>{STATUS_LABELS[row.status]}</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <GradeList title="Human" tone="good" grades={row.human} />
                <GradeList title="AI" tone="accent" grades={row.ai} />
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Humans render from `row.human` and the AI from `row.ai`, in that column order.
 * The query hands back two arrays for exactly this reason: the ordering rule is
 * not something this template can get wrong.
 */
function GradeList({
  title,
  tone,
  grades,
}: {
  title: string;
  tone: 'good' | 'accent';
  grades: GradeRow[];
}) {
  return (
    <div className="space-y-1.5">
      <Badge tone={tone}>{title}</Badge>
      {grades.length === 0 ? (
        <p className="text-xs text-muted">none</p>
      ) : (
        grades.map((grade) => (
          <div key={grade.reviewId} className="rounded-md border border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="font-medium text-ink">{grade.by}</span>
              <span className="tabular-nums">scored {grade.score}/5</span>
              {grade.model ? <span>{grade.model}</span> : null}
            </div>
            {grade.rubric ? (
              <ul className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
                {Object.entries(grade.rubric).map(([key, value]) => (
                  <li key={key}>
                    {key}: <span className="tabular-nums text-ink">{value}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {grade.comment ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{grade.comment}</p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
