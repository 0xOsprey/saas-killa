'use client';

import { useActionState, useState } from 'react';
import { Badge, Button, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import type { ContactFilters } from '@/lib/contacts';
import {
  previewAnnouncementAction,
  sendAnnouncementAction,
  type PreviewState,
  type SendState,
} from './actions';
import { ANNOUNCEMENT_TEMPLATES, TOKENS, TOKEN_HELP } from './templates';

const NOT_PREVIEWED: PreviewState = {};
const NOT_SENT: SendState = {};

/** What the roster row is reduced to for this screen. The compose form has no use for task counts. */
export type ComposeRecipient = {
  id: string;
  email: string;
  name: string | null;
  sessionTitle: string | null;
};

const FIRST = ANNOUNCEMENT_TEMPLATES[0]!;

/**
 * Write one message, see it filled in for a real speaker, then send a copy to
 * each.
 *
 * The filters ride as hidden fields rather than the ids of the people on
 * screen, the shape `BulkTaskForm` uses, so the action re-runs the same query
 * it was rendered from. The tick boxes are layered on top of that and can only
 * take people out of the resolved set, never add them.
 *
 * All five filters are posted, not only the two this screen has controls for.
 * The action re-resolves from whatever it receives, so a field left behind here
 * would have the send resolve a wider set than the list above it, and the
 * preview would report that wider number as the audience size.
 *
 * Two submit buttons, one form. Preview and Send have to read the same subject,
 * the same body and the same audience or the preview is not evidence of
 * anything, and the only way to guarantee that is for both to post the same
 * fields. `formAction` on the preview button is what overrides the form's own
 * action for that press.
 */
export function ComposeForm({
  filters,
  recipients,
}: {
  filters: ContactFilters;
  recipients: ComposeRecipient[];
}) {
  const [templateId, setTemplateId] = useState(FIRST.id);
  const [subject, setSubject] = useState(FIRST.subject);
  const [body, setBody] = useState(FIRST.body);
  // Everyone in the current view starts ticked. The scope above the form is the
  // primary control and this is the exception to it, so the default has to be
  // "what I filtered to" rather than an empty list somebody has to fill in
  // twice.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(recipients.map((r) => r.id)));

  const [preview, previewAction, previewPending] = useActionState(
    previewAnnouncementAction,
    NOT_PREVIEWED,
  );
  const [sent, sendAction, sendPending] = useActionState(sendAnnouncementAction, NOT_SENT);

  function applyTemplate(id: string): void {
    const template = ANNOUNCEMENT_TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    setTemplateId(id);
    setSubject(template.subject);
    setBody(template.body);
  }

  function toggle(id: string): void {
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const busy = previewPending || sendPending;

  return (
    <form action={sendAction} className="space-y-4" data-testid="compose-form">
      <input type="hidden" name="filter" value={filters.preset} />
      <input type="hidden" name="q" value={filters.q ?? ''} />
      <input type="hidden" name="company" value={filters.company ?? ''} />
      <input type="hidden" name="title" value={filters.title ?? ''} />
      <input type="hidden" name="tag" value={filters.tag ?? ''} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Template"
          hint="Pre-built bodies. Picking one replaces whatever is in the two fields below."
        >
          <Select
            name="template"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            data-testid="compose-template"
          >
            {ANNOUNCEMENT_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Preview as" hint="Whose data the preview fills the merge fields in with.">
          <Select name="previewUserId" data-testid="compose-preview-as">
            {recipients.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name ?? person.email}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Subject">
        <Input
          name="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          placeholder="Welcome to the programme"
          data-testid="compose-subject"
        />
      </Field>

      <Field label="Body">
        <Textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={20000}
          rows={16}
          className="min-h-64 font-mono text-xs"
          data-testid="compose-body"
        />
      </Field>

      {/* The syntax is documented where it is typed rather than in a help page.
          A merge field an organizer cannot name is one they will not use, and
          the send refuses on a token nothing fills in, so this list is also the
          full set of spellings that will not be rejected. */}
      <div className="rounded-md border border-line bg-slate-50 px-3 py-2">
        <p className="text-xs font-medium text-ink">
          Merge fields. Type them into the subject or the body and each speaker gets their own
          copy with these filled in.
        </p>
        <ul className="mt-1.5 space-y-0.5">
          {TOKENS.map((token) => (
            <li key={token} className="text-xs text-muted">
              <code className="rounded bg-white px-1 py-0.5 text-ink">{`{{${token}}}`}</code>{' '}
              {TOKEN_HELP[token]}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-ink">
            Recipients{' '}
            <span className="font-normal text-muted" data-testid="compose-recipient-count">
              {chosen.size} of {recipients.length} ticked
            </span>
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={() => setChosen(new Set(recipients.map((r) => r.id)))}
            >
              All
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={() => setChosen(new Set())}
            >
              None
            </Button>
          </div>
        </div>

        {recipients.length === 0 ? (
          <p className="text-sm text-muted">Nobody matches that filter.</p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {recipients.map((person) => (
              <li key={person.id}>
                <label className="flex items-start gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    name="recipient"
                    value={person.id}
                    checked={chosen.has(person.id)}
                    onChange={() => toggle(person.id)}
                    className="mt-1"
                    data-testid={`compose-recipient-${person.id}`}
                  />
                  <span className="min-w-0">
                    <span className="text-ink">{person.name ?? 'Unnamed'}</span>{' '}
                    <span className="text-xs text-muted">{person.email}</span>
                    {person.sessionTitle ? (
                      <span className="block text-xs text-muted">{person.sessionTitle}</span>
                    ) : (
                      <Badge tone="warn" className="ml-1">
                        no accepted talk
                      </Badge>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          formAction={previewAction}
          disabled={busy || recipients.length === 0}
          title={
            busy
              ? 'Working…'
              : recipients.length === 0
                ? 'No recipients match the current audience'
                : 'Render a preview without sending'
          }
          data-testid="compose-preview"
        >
          {previewPending ? 'Rendering…' : 'Preview'}
        </Button>
        <Button
          type="submit"
          disabled={busy || chosen.size === 0}
          title={
            busy
              ? 'Working…'
              : chosen.size === 0
                ? 'Select at least one recipient'
                : `Send this message to ${chosen.size} speaker(s)`
          }
          data-testid="compose-send"
        >
          {sendPending ? 'Sending…' : `Send to ${chosen.size} speaker(s)`}
        </Button>
        <span className="text-xs text-muted">Preview sends nothing.</span>
      </div>

      {preview.error ? <Notice tone="bad">{preview.error}</Notice> : null}
      {sent.error ? <Notice tone="bad">{sent.error}</Notice> : null}

      {sent.sent !== undefined ? (
        <Notice tone="good">
          <span data-testid="compose-send-result">
            Sent {sent.sent} message(s) · {sent.skipped} on this list skipped.
          </span>{' '}
          Each one is a row in the log below, with its recipient and the time it went.
        </Notice>
      ) : null}

      {preview.rendered ? (
        <div className="space-y-3" data-testid="compose-preview-output">
          <p className="text-sm text-muted">
            Filled in for {preview.rendered.length} of {preview.audienceSize} recipient(s).
            {preview.withoutSession ? (
              <>
                {' '}
                {preview.withoutSession} of them hold no accepted talk, so{' '}
                <code className="rounded bg-slate-100 px-1">{'{{session}}'}</code> reads
                &ldquo;your session&rdquo; for those.
              </>
            ) : null}
          </p>
          {preview.rendered.map((copy) => (
            <div key={copy.email} className="rounded-md border border-line bg-white">
              <div className="border-b border-line px-3 py-2 text-xs text-muted">
                To: <span className="text-ink">{copy.name}</span> · {copy.email}
              </div>
              <div className="px-3 py-2">
                <p className="text-sm font-medium text-ink" data-testid="preview-subject">
                  {copy.subject}
                </p>
                <pre
                  className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink"
                  data-testid="preview-body"
                >
                  {copy.body}
                </pre>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </form>
  );
}
