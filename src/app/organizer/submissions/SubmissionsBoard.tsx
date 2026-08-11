'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useState, useTransition } from 'react';
import {
  Badge,
  Button,
  Card,
  Input,
  LinkButton,
  ScoreDots,
  Select,
  Textarea,
  cn,
} from '@/components/ui';
import type { ReviewCommentRow } from '@/lib/queries';
import {
  approveContent,
  bulkApproveContent,
  bulkSetLock,
  bulkSetStatus,
  bulkSetTrack,
  editSubmissionText,
  notifyDecided,
  returnContent,
  setDecision,
  setFieldLock,
} from './actions';

export type RevisionEntry = {
  field: string;
  fieldLabel: string;
  who: string;
  when: string;
  oldValue: string | null;
  newValue: string | null;
};

export type BoardRow = {
  id: string;
  title: string;
  abstract: string;
  speakerName: string;
  speakerEmail: string;
  meta: string;
  status: 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
  statusLabel: string;
  statusTone: 'neutral' | 'good' | 'bad' | 'warn' | 'accent';
  averageScore: number | null;
  reviewCount: number;
  reviews: ReviewCommentRow[];
  notified: boolean;
  scheduled: boolean;
  contentStatus: 'draft' | 'pending' | 'approved';
  contentStatusLabel: string;
  hasContent: boolean;
  /**
   * Every file on this submission, one entry per version chain rather than per
   * upload. A supporting document is private, so this panel and the files
   * library are the only two ways to reach one.
   */
  files: {
    href: string;
    detailHref: string;
    name: string;
    kindLabel: string;
    size: string;
    versionCount: number;
    commentCount: number;
  }[];
  /** The library, narrowed to this talk. The per-session files tab. */
  filesHref: string;
  lockedFields: string[];
  revisionCount: number;
  lastEdit: RevisionEntry | null;
  history: RevisionEntry[];
};

export type FieldOption = { field: string; label: string };

const CONTENT_TONE = {
  draft: 'neutral',
  pending: 'warn',
  approved: 'good',
} as const;

/**
 * The organizer's content dashboard. Selection, the inline editors and the
 * expanded panels are client state; every write is a server action that
 * re-validates the page, so the board never holds a second copy of a row it
 * would have to keep in step with the database.
 *
 * Row text renders as text until an editor is opened rather than as an input
 * with a value. A page of forty always-open inputs is slower to read, slower to
 * scan for the row you want, and invisible to anything that matches on the
 * page's text.
 */
export function SubmissionsBoard({
  rows,
  tracks,
  lockableFields,
  statuses,
}: {
  rows: BoardRow[];
  tracks: { id: string; name: string }[];
  lockableFields: FieldOption[];
  statuses: { value: string; label: string }[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
          data-testid="select-all"
          className="h-4 w-4 rounded border-line"
          aria-label="Select every submission on this page"
        />
        {/* "on this page", because that is what it is. The board is paged, and a
            bulk edit reaches the rows in front of the organizer rather than the
            whole call for papers. */}
        <span>{allSelected ? 'Clear selection' : `Select all ${rows.length} on this page`}</span>
      </div>

      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          selected={selected.has(row.id)}
          onToggle={() => toggle(row.id)}
          lockableFields={lockableFields}
        />
      ))}

      {selected.size > 0 ? (
        <BulkBar
          ids={[...selected]}
          tracks={tracks}
          lockableFields={lockableFields}
          statuses={statuses}
          onDone={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  );
}

function Row({
  row,
  selected,
  onToggle,
  lockableFields,
}: {
  row: BoardRow;
  selected: boolean;
  onToggle: () => void;
  lockableFields: FieldOption[];
}) {
  const [draft, setDraft] = useState<{ title: string; abstract: string } | null>(null);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function submitDecision(_prev: void, formData: FormData): Promise<void> {
    await setDecision(formData);
    router.refresh();
  }

  const [_, formAction, deciding] = useActionState(submitDecision, undefined);

  function save() {
    if (!draft) return;
    const data = new FormData();
    data.set('submissionId', row.id);
    data.set('title', draft.title);
    data.set('abstract', draft.abstract);
    startTransition(async () => {
      await editSubmissionText(data);
      setDraft(null);
    });
  }

  function sendBack() {
    const data = new FormData();
    data.set('submissionId', row.id);
    data.set('reason', reason);
    startTransition(async () => {
      await returnContent(data);
      setReason('');
    });
  }

  function run(action: (data: FormData) => Promise<void>, fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    startTransition(async () => {
      await action(data);
    });
  }

  return (
    <Card
      className={cn('space-y-3', pending && 'opacity-60', selected && 'border-ink bg-ink/5')}
      data-testid={`submission-${row.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            data-testid={`select-${row.id}`}
            className="mt-1 h-4 w-4 shrink-0 rounded border-line"
            aria-label={`Select ${row.title}`}
          />
          <div className="min-w-0">
            {/* The board shows the speaker who filed it and nobody else, which
                on a co-authored proposal is a participant list with a name
                missing. The abstract page is where the credited billing and its
                role labels live, so the title is the way there rather than a
                dead heading. */}
            <h2 className="font-medium text-ink">
              <Link
                href={`/organizer/abstracts/${row.id}`}
                className="underline-offset-2 hover:underline"
                data-testid={`open-abstract-${row.id}`}
              >
                {row.title}
              </Link>
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {row.speakerName} · {row.speakerEmail}
            </p>
            <p className="mt-0.5 text-xs text-muted">{row.meta}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <ScoreDots score={row.averageScore} />
          <span className="text-xs text-muted">{row.reviewCount} review(s)</span>
          <Link
            href={`/organizer/submissions?status=${row.status}`}
            className="inline-block"
            title={`Filter submissions by ${row.statusLabel}`}
          >
            <Badge tone={row.statusTone}>{row.statusLabel}</Badge>
          </Link>
          <Link
            href={`/organizer/submissions?content=${row.contentStatus}`}
            className="inline-block"
            title={`Filter submissions by content status: ${row.contentStatusLabel}`}
          >
            <Badge tone={CONTENT_TONE[row.contentStatus]}>
              Content: {row.contentStatusLabel}
            </Badge>
          </Link>
        </div>
      </div>

      {row.reviews.length > 0 ? (
        <details className="rounded-md border border-line p-3" data-testid={`reviews-${row.id}`}>
          <summary className="cursor-pointer text-xs font-medium text-ink">
            Reviewer comments ({row.reviews.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {row.reviews.map((review, index) => (
              <li key={`${review.reviewerEmail}-${index}`} className="text-xs">
                <span className="font-medium text-ink">{review.reviewerName ?? review.reviewerEmail}</span>
                {review.score !== null ? (
                  <span className="ml-2 tabular-nums text-muted">{review.score.toFixed(1)}</span>
                ) : null}
                {review.comment ? (
                  <p className="mt-0.5 whitespace-pre-wrap text-muted">{review.comment}</p>
                ) : (
                  <p className="mt-0.5 text-muted italic">No comment</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {row.lockedFields.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Locked to the speaker:</span>
          {row.lockedFields.map((field) => (
            <Badge key={field} tone="warn">
              {lockableFields.find((option) => option.field === field)?.label ?? field}
            </Badge>
          ))}
        </p>
      ) : null}

      {draft ? (
        <div className="space-y-2">
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            data-testid={`edit-title-${row.id}`}
            aria-label="Title"
          />
          <Textarea
            value={draft.abstract}
            onChange={(e) => setDraft({ ...draft, abstract: e.target.value })}
            data-testid={`edit-abstract-${row.id}`}
            aria-label="Abstract"
          />
          <div className="flex gap-2">
            <Button type="button" onClick={save} data-testid={`save-${row.id}`}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted">{row.abstract}</p>
          <button
            type="button"
            onClick={() => setDraft({ title: row.title, abstract: row.abstract })}
            className="text-xs text-muted underline hover:text-ink"
            data-testid={`edit-${row.id}`}
          >
            Edit title and abstract
          </button>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <form action={formAction}>
          <input type="hidden" name="submissionId" value={row.id} />
          <input type="hidden" name="status" value="accepted" />
          <Button
            type="submit"
            variant={row.status === 'accepted' ? 'primary' : 'secondary'}
            disabled={deciding}
            title={deciding ? 'Saving the decision…' : 'Mark this submission accepted'}
            data-testid={`accept-${row.id}`}
          >
            Accept
          </Button>
        </form>
        <form action={formAction}>
          <input type="hidden" name="submissionId" value={row.id} />
          <input type="hidden" name="status" value="rejected" />
          <Button
            type="submit"
            variant={row.status === 'rejected' ? 'danger' : 'secondary'}
            disabled={deciding}
            title={deciding ? 'Saving the decision…' : 'Mark this submission rejected'}
          >
            Reject
          </Button>
        </form>
        {row.status !== 'submitted' ? (
          <form action={formAction}>
            <input type="hidden" name="submissionId" value={row.id} />
            <input type="hidden" name="status" value="submitted" />
            <Button
              type="submit"
              variant="ghost"
              className="text-xs"
              disabled={deciding}
              title={deciding ? 'Saving the decision…' : 'Put this submission back to submitted'}
            >
              Undecide
            </Button>
          </form>
        ) : null}

        <span className="ml-auto flex items-center gap-1 text-xs text-muted">
          {row.notified ? (
            'speaker notified'
          ) : row.status === 'accepted' || row.status === 'rejected' ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => run(notifyDecided, { ids: row.id })}
              disabled={pending}
              title={pending ? 'Sending the email…' : 'Email this speaker their decision'}
              className="h-auto gap-0 rounded-none px-0 py-0 text-xs text-muted hover:bg-transparent hover:text-ink hover:underline"
              data-testid={`notify-${row.id}`}
            >
              not notified · send
            </Button>
          ) : (
            'not notified'
          )}
          {row.status === 'accepted' && !row.scheduled ? (
            <>
              {' · '}
              <Link
                href="/organizer/schedule"
                className="text-ink underline hover:text-accent"
                data-testid={`schedule-${row.id}`}
              >
                not scheduled
              </Link>
            </>
          ) : row.scheduled ? (
            <>{' · '}scheduled</>
          ) : null}
        </span>
      </div>

      <details className="rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Content and locks
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">
            {row.hasContent
              ? 'Slides, a recording or resources are attached.'
              : 'The speaker has not attached anything yet.'}
          </p>

          {/* `organizer-documents-`, not `organizer-files-`: two specs find this
              panel by that id, and the panel is the same panel. */}
          <div className="space-y-1" data-testid={`organizer-documents-${row.id}`}>
            <p className="text-xs font-medium text-ink">Files ({row.files.length})</p>
            {row.files.length === 0 ? (
              <p className="text-xs text-muted">Nothing uploaded on this talk yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {row.files.map((file) => (
                  <li key={file.href} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <a href={file.href} className="truncate underline hover:text-ink">
                      {file.name}
                    </a>
                    <span className="shrink-0 text-muted">
                      {file.kindLabel} · {file.size} · {file.versionCount} version
                      {file.versionCount === 1 ? '' : 's'}
                      {file.commentCount > 0 ? ` · ${file.commentCount} comment(s)` : ''}
                    </span>
                    <Link
                      href={file.detailHref}
                      className="shrink-0 underline hover:text-ink"
                      data-testid={`file-detail-${row.id}`}
                    >
                      Versions and comments
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={row.filesHref}
              className="inline-block text-xs underline hover:text-ink"
              data-testid={`files-tab-${row.id}`}
            >
              Open the files tab for this session
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {row.contentStatus === 'approved' ? null : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => run(approveContent, { submissionId: row.id })}
                data-testid={`content-approve-${row.id}`}
              >
                Approve content
              </Button>
            )}
            {row.contentStatus === 'draft' ? null : (
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why it is going back"
                  className="min-w-48 flex-1"
                  data-testid={`return-reason-${row.id}`}
                  aria-label="Reason for sending content back"
                />
                <Button
                  type="button"
                  variant="danger"
                  disabled={reason.trim().length < 4}
                  onClick={sendBack}
                  title={
                    reason.trim().length < 4
                      ? 'Add a reason of at least 4 characters'
                      : 'Return this content to the speaker with the reason'
                  }
                  data-testid={`content-return-${row.id}`}
                >
                  Send back
                </Button>
              </div>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-ink">Fields the speaker may not edit</p>
            <div className="flex flex-wrap gap-1.5">
              {lockableFields.map((option) => {
                const locked = row.lockedFields.includes(option.field);
                return (
                  <button
                    key={option.field}
                    type="button"
                    onClick={() =>
                      run(setFieldLock, {
                        submissionId: row.id,
                        field: option.field,
                        locked: locked ? 'false' : 'true',
                      })
                    }
                    data-testid={`lock-${row.id}-${option.field}`}
                    aria-pressed={locked}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs',
                      locked
                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                        : 'border-line bg-white text-muted hover:border-ink',
                    )}
                  >
                    {option.label}
                    {locked ? ' · locked' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </details>

      <div className="border-t border-line pt-2 text-xs text-muted">
        {row.lastEdit ? (
          <details>
            <summary className="cursor-pointer" data-testid={`last-edit-${row.id}`}>
              Last edit: {row.lastEdit.fieldLabel} by {row.lastEdit.who}, {row.lastEdit.when} ·{' '}
              {row.revisionCount} change(s) logged
            </summary>
            <ul className="mt-2 space-y-1.5">
              {row.history.map((entry, index) => (
                <li key={`${entry.when}-${entry.field}-${index}`}>
                  <span className="text-ink">{entry.fieldLabel}</span> by {entry.who}, {entry.when}
                  <span className="block truncate">
                    {entry.oldValue ? `“${entry.oldValue}” → ` : ''}
                    {entry.newValue ? `“${entry.newValue}”` : 'cleared'}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <span>No edits logged yet.</span>
        )}
      </div>
    </Card>
  );
}

/**
 * The bulk bar. It appears only with a selection and sits above the page rather
 * than at the top of it, because the rows an organizer is picking are usually
 * further down the list than the controls would be.
 */
function BulkBar({
  ids,
  tracks,
  lockableFields,
  statuses,
  onDone,
}: {
  ids: string[];
  tracks: { id: string; name: string }[];
  lockableFields: FieldOption[];
  statuses: { value: string; label: string }[];
  onDone: () => void;
}) {
  const [status, setStatus] = useState(statuses[0]?.value ?? 'accepted');
  const [trackId, setTrackId] = useState('');
  const [lockField, setLockField] = useState(lockableFields[0]?.field ?? 'title');
  const [pending, startTransition] = useTransition();

  function run(action: (data: FormData) => Promise<void>, fields: Record<string, string> = {}) {
    const data = new FormData();
    for (const id of ids) data.append('ids', id);
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    startTransition(async () => {
      await action(data);
      onDone();
    });
  }

  return (
    <div className="sticky bottom-4 z-10" data-testid="bulk-bar">
      <Card className={cn('flex flex-wrap items-center gap-3 shadow-md', pending && 'opacity-60')}>
        <span className="text-sm font-medium text-ink">{ids.length} selected</span>

        <div className="flex items-center gap-1.5">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-auto"
            data-testid="bulk-status"
            aria-label="Status to apply"
          >
            {statuses.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(bulkSetStatus, { status })}
            data-testid="bulk-status-apply"
          >
            Set status
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            value={trackId}
            onChange={(e) => setTrackId(e.target.value)}
            className="w-auto"
            data-testid="bulk-track"
            aria-label="Track to apply"
          >
            <option value="">No track</option>
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(bulkSetTrack, { trackId })}
            data-testid="bulk-track-apply"
          >
            Set track
          </Button>
        </div>

        <Button
          type="button"
          variant="secondary"
          onClick={() => run(bulkApproveContent)}
          data-testid="bulk-approve-content"
        >
          Approve content
        </Button>

        {/* A link rather than an action, because the next thing to decide is how
            the archive should be laid out, and that choice belongs beside the
            list of files it applies to. The library opens with these sessions'
            files already picked and the dialog already open. */}
        <LinkButton
          href={`/organizer/files?select=${ids.join(',')}&open=1`}
          variant="secondary"
          data-testid="bulk-download-files"
        >
          Download files
        </LinkButton>

        <div className="flex items-center gap-1.5">
          <Select
            value={lockField}
            onChange={(e) => setLockField(e.target.value)}
            className="w-auto"
            data-testid="bulk-lock-field"
            aria-label="Field to lock or unlock"
          >
            {lockableFields.map((option) => (
              <option key={option.field} value={option.field}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(bulkSetLock, { field: lockField, locked: 'true' })}
            data-testid="bulk-lock"
          >
            Lock
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => run(bulkSetLock, { field: lockField, locked: 'false' })}
            data-testid="bulk-unlock"
          >
            Unlock
          </Button>
        </div>

        <Button type="button" variant="ghost" className="ml-auto" onClick={onDone}>
          Clear
        </Button>
      </Card>
    </div>
  );
}
