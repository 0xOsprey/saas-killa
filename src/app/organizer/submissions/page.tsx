import { Badge, Button, Card, Empty, Notice, PageHeader, ScoreDots } from '@/components/ui';
import { evaluatorConfigured } from '@/lib/ai-evaluator';
import { FORMAT_LABELS, LEVEL_LABELS, STATUS_LABELS } from '@/lib/format';
import { organizerSubmissions } from '@/lib/queries';
import { notifyDecided, runEvaluator, setDecision } from './actions';

const STATUS_TONE = {
  submitted: 'neutral',
  accepted: 'good',
  rejected: 'bad',
  withdrawn: 'neutral',
} as const;

export default async function OrganizerSubmissionsPage() {
  const rows = await organizerSubmissions();

  const counts = {
    submitted: rows.filter((r) => r.status === 'submitted').length,
    accepted: rows.filter((r) => r.status === 'accepted').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  };
  const awaitingEmail = rows.filter(
    (r) => (r.status === 'accepted' || r.status === 'rejected') && !r.decisionEmailedAt,
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Submissions"
        description={`${counts.submitted} undecided · ${counts.accepted} accepted · ${counts.rejected} rejected. Sorted by average grade.`}
        action={
          <div className="flex flex-wrap gap-2">
            {evaluatorConfigured() ? (
              <form action={runEvaluator}>
                <Button type="submit" variant="secondary">
                  Run AI evaluator
                </Button>
              </form>
            ) : null}
            <form action={notifyDecided}>
              <Button type="submit" disabled={awaitingEmail === 0} data-testid="notify-decided">
                Send {awaitingEmail} decision email(s)
              </Button>
            </form>
          </div>
        }
      />

      {evaluatorConfigured() ? null : (
        <Notice>
          The AI evaluator is off. Set <code>ANTHROPIC_API_KEY</code> to have it pre-grade
          abstracts against the rubric. Human grading works without it.
        </Notice>
      )}

      {rows.length === 0 ? <Empty>No submissions yet.</Empty> : null}

      {rows.map((row) => (
        <Card key={row.id} className="space-y-3" data-testid={`submission-${row.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-medium text-ink">{row.title}</h2>
              <p className="mt-0.5 text-xs text-muted">
                {row.speakerName ?? 'Unnamed'} · {row.speakerEmail}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {FORMAT_LABELS[row.format]} · {LEVEL_LABELS[row.audienceLevel]}
                {row.trackName ? ` · ${row.trackName}` : ''}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <ScoreDots score={row.averageScore} />
              <span className="text-xs text-muted">{row.reviewCount} review(s)</span>
              <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
            </div>
          </div>

          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted">{row.abstract}</p>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <form action={setDecision}>
              <input type="hidden" name="submissionId" value={row.id} />
              <input type="hidden" name="status" value="accepted" />
              <Button
                type="submit"
                variant={row.status === 'accepted' ? 'primary' : 'secondary'}
                data-testid={`accept-${row.id}`}
              >
                Accept
              </Button>
            </form>
            <form action={setDecision}>
              <input type="hidden" name="submissionId" value={row.id} />
              <input type="hidden" name="status" value="rejected" />
              <Button type="submit" variant={row.status === 'rejected' ? 'danger' : 'secondary'}>
                Reject
              </Button>
            </form>
            {row.status !== 'submitted' ? (
              <form action={setDecision}>
                <input type="hidden" name="submissionId" value={row.id} />
                <input type="hidden" name="status" value="submitted" />
                <Button type="submit" variant="ghost" className="text-xs">
                  Undecide
                </Button>
              </form>
            ) : null}

            <span className="ml-auto text-xs text-muted">
              {row.decisionEmailedAt ? 'speaker notified' : 'not notified'}
              {row.scheduled ? ' · scheduled' : ''}
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}
