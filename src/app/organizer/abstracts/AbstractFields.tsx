import type { ReactNode } from 'react';
import { Badge, Field, Input, Select, Textarea } from '@/components/ui';
import type { AudienceLevel, SubmissionFormat } from '@/db/schema';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';
import type { AbstractEdit, EditableField } from '@/lib/abstracts';

/**
 * The five editable fields, rendered once for both editors. The organizer form
 * and the speaker form differ in what they permit, not in what they collect, and
 * one component is what stops the two drifting into different field sets.
 *
 * A locked field renders as its current value with no input at all. Both actions
 * fall back to the stored value for a field they receive nothing for, so an
 * omitted input is exactly as safe as a rejected one.
 */
export function AbstractFields({
  values,
  locked = [],
  lockLabel = 'locked by organizers',
}: {
  values: AbstractEdit;
  locked?: EditableField[];
  lockLabel?: string;
}) {
  const isLocked = (field: EditableField) => locked.includes(field);

  return (
    <div className="space-y-4">
      {isLocked('title') ? (
        <LockedValue badge={lockLabel} label="Title">{values.title}</LockedValue>
      ) : (
        <Field label="Title">
          <Input name="title" required maxLength={200} defaultValue={values.title} />
        </Field>
      )}

      {isLocked('abstract') ? (
        <LockedValue badge={lockLabel} label="Abstract">{values.abstract}</LockedValue>
      ) : (
        <Field label="Abstract" hint="At least 120 characters. Reviewers read this unattributed.">
          <Textarea name="abstract" required minLength={120} defaultValue={values.abstract} />
        </Field>
      )}

      {isLocked('keywords') ? (
        <LockedValue badge={lockLabel} label="Keywords">{values.keywords.join(', ') || '—'}</LockedValue>
      ) : (
        <Field label="Keywords" hint="Comma separated. Used for search and reviewer matching.">
          <Input name="keywords" defaultValue={values.keywords.join(', ')} />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {isLocked('format') ? (
          <LockedValue badge={lockLabel} label="Format">{FORMAT_LABELS[values.format]}</LockedValue>
        ) : (
          <Field label="Format">
            <Select name="format" defaultValue={values.format}>
              {(Object.keys(FORMAT_LABELS) as SubmissionFormat[]).map((key) => (
                <option key={key} value={key}>
                  {FORMAT_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {isLocked('audienceLevel') ? (
          <LockedValue badge={lockLabel} label="Audience level">{LEVEL_LABELS[values.audienceLevel]}</LockedValue>
        ) : (
          <Field label="Audience level">
            <Select name="audienceLevel" defaultValue={values.audienceLevel}>
              {(Object.keys(LEVEL_LABELS) as AudienceLevel[]).map((key) => (
                <option key={key} value={key}>
                  {LEVEL_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </div>
  );
}

function LockedValue({
  label,
  badge,
  children,
}: {
  label: string;
  badge: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-2 text-sm font-medium text-ink">
        {label}
        <Badge tone="warn">{badge}</Badge>
      </span>
      <div className="whitespace-pre-wrap rounded-md border border-dashed border-line bg-slate-50 px-3 py-2 text-sm text-muted">
        {children}
      </div>
    </div>
  );
}
