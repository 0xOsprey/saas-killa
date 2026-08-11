import Link from 'next/link';
import { Badge, Button, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { acceleventsConfig, recentRuns, runById } from '@/lib/accelevents';
import { inEventZone } from '@/lib/format';
import { uuidOrNull } from '@/lib/ids';
import { getEvent } from '@/lib/queries';
import { runAcceleventsExport } from './actions';

/**
 * The Accelevents push, and every push before it.
 *
 * Dynamic because the run list is the point and a cached copy would show the
 * export you just ran as not having happened.
 */
export const dynamic = 'force-dynamic';

function statusTone(status: string): 'good' | 'bad' | 'neutral' {
  if (status === 'ok') return 'good';
  if (status === 'failed') return 'bad';
  return 'neutral';
}

export default async function IntegrationsScreen({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const params = await searchParams;
  const config = acceleventsConfig();
  const [event, runs] = await Promise.all([getEvent(), recentRuns()]);
  // `?run=` is a link into one past push, so it gets bookmarked and outlives
  // the row it names. A non-uuid would 22P02 the screen; no run just means no
  // detail card, and the run list below it is the point of the page anyway.
  const runId = uuidOrNull(params.run);
  const opened = runId ? await runById(runId) : null;
  const dryRun = config.mode === 'dry_run';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accelevents"
        description="One-way. The programme goes out; nothing comes back and nothing here is ever overwritten by theirs."
        action={
          <form id="export" action={runAcceleventsExport}>
            <Button type="submit" data-testid="run-export">
              {dryRun ? 'Run a dry export' : 'Push to Accelevents'}
            </Button>
          </form>
        }
      />

      <Card className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={dryRun ? 'neutral' : 'good'}>
            <span data-testid="integration-mode">{dryRun ? 'Dry run' : 'Live'}</span>
          </Badge>
          <span className="text-sm text-muted" data-testid="integration-target">
            {config.baseUrl ?? 'no endpoint configured'}
          </span>
        </div>

        {dryRun ? (
          <p className="text-sm text-muted" data-testid="dry-run-explainer">
            Every request is built and checked against a recorded copy of what Accelevents
            accepts, and none of them leave this machine. Set{' '}
            <code className="rounded bg-slate-100 px-1">{config.missing.join(', ')}</code> to go
            live. The key is read from the environment and is never shown here or written to a
            run.
          </p>
        ) : (
          <Notice tone="warn">
            Live. Pressing the button writes {event.name} into the Accelevents event at{' '}
            {config.baseUrl}.
          </Notice>
        )}
      </Card>

      {opened ? (
        <Card className="space-y-3" data-testid="run-detail">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">
              {opened.mode === 'dry_run' ? 'Dry run' : 'Live run'} ·{' '}
              {inEventZone(opened.startedAt, event.timezone, { timeStyle: 'medium' })}
            </h2>
            <div className="flex items-center gap-2">
              <Badge tone={statusTone(opened.status)}>
                <span data-testid="run-status">{opened.status}</span>
              </Badge>
              <Link
                href={`/organizer/integrations/${opened.id}/bundle`}
                className="text-sm text-accent hover:underline"
                data-testid="run-bundle-link"
              >
                Download the bundle
              </Link>
            </div>
          </div>

          {opened.error ? <Notice tone="bad">{opened.error}</Notice> : null}

          <p className="text-xs text-muted">
            <span data-testid="run-request-count">{opened.requests.length}</span> request(s):{' '}
            {opened.trackCount} track(s), {opened.speakerCount} speaker(s), {opened.sessionCount}{' '}
            session(s).
          </p>

          <ul className="space-y-1 text-sm" data-testid="run-requests">
            {opened.requests.map((request, index) => (
              <li
                key={`${request.path}-${index}`}
                data-testid={`run-request-${index}`}
                className="flex flex-wrap items-center gap-2 border-b border-line/60 pb-1 last:border-0"
              >
                <Badge tone={request.status >= 200 && request.status < 300 ? 'good' : 'bad'}>
                  {request.status}
                </Badge>
                <code className="text-xs text-muted">
                  {request.method} {request.path}
                </code>
                <span className="text-ink">
                  {typeof request.body === 'object' && request.body !== null
                    ? String((request.body as { label?: string }).label ?? '')
                    : ''}
                </span>
                {request.remoteId ? (
                  <span className="text-xs text-muted">→ {request.remoteId}</span>
                ) : null}
                {request.error ? <span className="text-xs text-rose-600">{request.error}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-3 font-medium">Every push, most recent first</h2>
        {runs.length === 0 ? (
          <Empty>
            Nothing has been exported yet.{' '}
            <Link href="#export" className="text-accent hover:underline">
              Run the first export
            </Link>
            .
          </Empty>
        ) : (
          <ul className="space-y-2" data-testid="run-list">
            {runs.map((run) => (
              <li
                key={run.id}
                data-testid={`run-${run.id}`}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2 text-sm last:border-0"
              >
                <div>
                  <Link
                    href={`/organizer/integrations?run=${run.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {inEventZone(run.startedAt, event.timezone, { timeStyle: 'medium' })}
                  </Link>
                  <p className="text-xs text-muted">
                    {run.mode === 'dry_run' ? 'Dry run' : 'Live'} · {run.requests.length} request(s)
                    · {run.sessionCount} session(s), {run.speakerCount} speaker(s)
                  </p>
                </div>
                <Badge tone={statusTone(run.status)}>{run.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
