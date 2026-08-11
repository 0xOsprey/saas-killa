'use client';

import { useActionState } from 'react';
import { Badge, Button, Card, Notice } from '@/components/ui';
import type { PreviewRow, RowOutcome } from '@/lib/contact-import';
import { importContactsAction, type ImportState } from './actions';

const EMPTY: ImportState = {};

const OUTCOME_TONE: Record<RowOutcome, 'good' | 'accent' | 'bad'> = {
  create: 'good',
  match: 'accent',
  reject: 'bad',
};

const OUTCOME_LABEL: Record<RowOutcome, string> = {
  create: 'New',
  match: 'Existing',
  reject: 'Rejected',
};

/**
 * Upload, look, then write.
 *
 * The preview is a separate press from the import on purpose: a contact list
 * arrives from somebody else's export and the first thing an organizer wants to
 * know is what it thinks it is going to do. The file's text rides back in a
 * hidden field between the two presses, so the rows that get written are the
 * rows that were shown.
 */
export function ImportForm() {
  const [state, formAction, pending] = useActionState(importContactsAction, EMPTY);
  const outcome = state.result ?? state.preview;

  return (
    <div className="space-y-4">
      <Card>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="intent" value="preview" />
          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-ink">Contacts CSV</span>
            <input
              type="file"
              name="file"
              accept=".csv,text/csv,text/plain"
              required
              data-testid="import-file"
              className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-accent file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-700"
            />
            <span className="block text-xs text-muted">
              A header row, then one contact per row. Email, name, job title, company, bio and tags
              are read; anything else is ignored. Nothing is written until you have seen the
              preview.
            </span>
          </label>
          <Button type="submit" disabled={pending} data-testid="import-preview">
            {pending ? 'Reading…' : 'Preview the file'}
          </Button>
        </form>
      </Card>

      {state.error ? (
        <Notice tone="bad">
          <span data-testid="import-error">{state.error}</span>
        </Notice>
      ) : null}

      {outcome?.problem ? (
        <Notice tone="bad">
          <span data-testid="import-problem">{outcome.problem}</span>
        </Notice>
      ) : null}

      {state.result && !state.result.problem ? (
        <Notice tone="good">
          <div data-testid="import-result">
            <p className="font-medium">
              {state.result.counts.create} contact(s) created, {state.result.counts.match} matched an
              existing contact, {state.result.counts.reject} row(s) rejected.
            </p>
            <p className="text-sm">
              The new contacts are in the directory now. A matched contact kept every value it
              already had.
            </p>
          </div>
        </Notice>
      ) : null}

      {outcome && !outcome.problem && outcome.rows.length > 0 ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-ink">
              {state.result ? 'What was imported' : 'What this will do'}
            </h2>
            <p className="text-xs text-muted">
              {state.fileName ? `${state.fileName} · ` : ''}
              Columns read: {outcome.recognised.join(', ')}
              {outcome.unmapped.length > 0 ? ` · ignored: ${outcome.unmapped.join(', ')}` : ''}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1 pr-3">Row</th>
                  <th className="py-1 pr-3">Outcome</th>
                  <th className="py-1 pr-3">Name</th>
                  <th className="py-1 pr-3">Email</th>
                  <th className="py-1 pr-3">Job title</th>
                  <th className="py-1 pr-3">Company</th>
                  <th className="py-1">What happens</th>
                </tr>
              </thead>
              <tbody data-testid="import-preview-rows">
                {outcome.rows.map((row) => (
                  <PreviewRowView key={row.line} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          {state.result ? null : (
            <form action={formAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="intent" value="write" />
              <input type="hidden" name="csv" value={state.csv ?? ''} />
              <input type="hidden" name="fileName" value={state.fileName ?? ''} />
              <Button
                type="submit"
                disabled={pending || outcome.counts.create + outcome.counts.match === 0}
                data-testid="import-confirm"
              >
                {pending
                  ? 'Importing…'
                  : `Import ${outcome.counts.create} new and update ${outcome.counts.match} existing`}
              </Button>
              <span className="text-xs text-muted">
                Rejected rows are skipped. Nothing already on a contact is overwritten.
              </span>
            </form>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function PreviewRowView({ row }: { row: PreviewRow }) {
  return (
    <tr className="border-t border-line align-top" data-testid={`import-row-${row.outcome}`}>
      <td className="py-2 pr-3 tabular-nums text-muted">{row.line}</td>
      <td className="py-2 pr-3">
        <Badge tone={OUTCOME_TONE[row.outcome]}>{OUTCOME_LABEL[row.outcome]}</Badge>
      </td>
      <td className="py-2 pr-3 text-ink">{row.name ?? '—'}</td>
      <td className="py-2 pr-3 wrap-anywhere text-ink">{row.email ?? '—'}</td>
      <td className="py-2 pr-3 text-muted">{row.title ?? '—'}</td>
      <td className="py-2 pr-3 text-muted">{row.company ?? '—'}</td>
      <td className="py-2 text-muted">
        {row.note}
        {row.tags.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {row.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </span>
        ) : null}
      </td>
    </tr>
  );
}
