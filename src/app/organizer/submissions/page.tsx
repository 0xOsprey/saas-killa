import Link from 'next/link';
import { Button, Empty, LinkButton, Notice, PageHeader, cn } from '@/components/ui';
import { contentStatusEnum, submissionStatusEnum } from '@/db/schema';
import { evaluatorConfigured } from '@/lib/ai-evaluator';
import {
  CONTENT_STATUS_LABELS,
  contentRowsById,
  fieldLabel,
  knownLocks,
  lastEditBySubmission,
  LOCKABLE_FIELDS,
  recentRevisions,
  type RevisionRow,
} from '@/lib/content';
import { FORMAT_LABELS, LEVEL_LABELS, STATUS_LABELS, inEventZone } from '@/lib/format';
import { allTracks, getEvent, organizerSubmissions } from '@/lib/queries';
import { documentsFor, formatBytes, uploadHref } from '@/lib/uploads';
import { gradePending, notifyDecided } from './actions';
import { SubmissionsBoard, type BoardRow } from './SubmissionsBoard';

const STATUS_TONE = {
  submitted: 'neutral',
  accepted: 'good',
  rejected: 'bad',
  withdrawn: 'neutral',
} as const;

const LOCKABLE_OPTIONS = LOCKABLE_FIELDS.map((field) => ({ field, label: fieldLabel(field) }));

const STATUS_OPTIONS = submissionStatusEnum.enumValues.map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

/**
 * The moderation queue is this filter rather than a separate screen: the row an
 * organizer approves content on is the row they were already deciding.
 */
const CONTENT_FILTERS: { value: 'draft' | 'pending' | 'approved' | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'pending', label: 'Awaiting review' },
  { value: 'approved', label: 'Approved' },
  { value: 'draft', label: 'Draft' },
];

export default async function OrganizerSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ content?: string }>;
}) {
  const [rows, content, history, lastEdits, tracks, event, params] = await Promise.all([
    organizerSubmissions(),
    contentRowsById(),
    recentRevisions(),
    lastEditBySubmission(),
    allTracks(),
    getEvent(),
    searchParams,
  ]);

  const filter = contentStatusEnum.enumValues.find((value) => value === params.content) ?? null;
  const documents = await documentsFor(rows.map((row) => row.id));

  const counts = {
    submitted: rows.filter((r) => r.status === 'submitted').length,
    accepted: rows.filter((r) => r.status === 'accepted').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  };
  const awaitingEmail = rows.filter(
    (r) => (r.status === 'accepted' || r.status === 'rejected') && !r.decisionEmailedAt,
  ).length;
  const statuses = rows.map((row) => content.get(row.id)?.contentStatus ?? 'draft');
  const contentCounts = {
    all: rows.length,
    draft: statuses.filter((s) => s === 'draft').length,
    pending: statuses.filter((s) => s === 'pending').length,
    approved: statuses.filter((s) => s === 'approved').length,
  };
  const awaitingContent = contentCounts.pending;

  const board: BoardRow[] = rows
    .filter((row) => !filter || (content.get(row.id)?.contentStatus ?? 'draft') === filter)
    .map((row) => {
      const extra = content.get(row.id);
      return {
        id: row.id,
        title: row.title,
        abstract: row.abstract,
        speakerName: row.speakerName ?? 'Unnamed',
        speakerEmail: row.speakerEmail,
        meta: [
          FORMAT_LABELS[row.format],
          LEVEL_LABELS[row.audienceLevel],
          ...(row.trackName ? [row.trackName] : []),
        ].join(' · '),
        status: row.status,
        statusLabel: STATUS_LABELS[row.status],
        statusTone: STATUS_TONE[row.status],
        averageScore: row.averageScore,
        reviewCount: row.reviewCount,
        notified: Boolean(row.decisionEmailedAt),
        scheduled: row.scheduled,
        contentStatus: extra?.contentStatus ?? 'draft',
        contentStatusLabel: CONTENT_STATUS_LABELS[extra?.contentStatus ?? 'draft'],
        hasContent: Boolean(extra?.slidesUrl || extra?.recordingUrl || extra?.resourcesNote),
        // A supporting document is private, so this panel is the only place an
        // organizer can find one. Without it the speaker's upload would be
        // write-only: stored, access-controlled and unreachable by the people
        // it was sent to.
        documents: (documents.get(row.id) ?? []).map((document) => ({
          href: uploadHref(document),
          name: document.filename,
          size: formatBytes(document.bytes),
        })),
        lockedFields: knownLocks(extra?.lockedFields ?? []),
        revisionCount: extra?.revisionCount ?? 0,
        lastEdit: toEntry(lastEdits.get(row.id) ?? null, event.timezone),
        history: (history.get(row.id) ?? []).flatMap((entry) => {
          const mapped = toEntry(entry, event.timezone);
          return mapped ? [mapped] : [];
        }),
      };
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Submissions"
        description={`${counts.submitted} undecided · ${counts.accepted} accepted · ${counts.rejected} rejected. Sorted by average grade.`}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/organizer/settings" variant="secondary">
              Event settings
            </LinkButton>
            {evaluatorConfigured() ? (
              <form action={gradePending}>
                <Button type="submit" variant="secondary">
                  Run AI evaluator
                </Button>
              </form>
            ) : null}
            <form action={notifyDecided}>
              <Button type="submit" disabled={awaitingEmail === 0} data-testid="notify-decided">
                {/* At zero this has always been disabled, but it still read
                    "Send 0 decision email(s)", which is an instruction to press
                    a control that does nothing. Say the state instead. */}
                {awaitingEmail === 0
                  ? 'Everyone decided has been told'
                  : `Send ${awaitingEmail} decision email(s)`}
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

      {awaitingContent > 0 ? (
        <Notice tone="accent">
          <span data-testid="content-queue">
            {awaitingContent} submission(s) have content awaiting review. Nothing submitted for
            review appears on the public agenda until it is approved.
          </span>
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-muted">Content:</span>
        {CONTENT_FILTERS.map((option) => (
          <Link
            key={option.label}
            href={
              option.value
                ? `/organizer/submissions?content=${option.value}`
                : '/organizer/submissions'
            }
            data-testid={`filter-${option.value ?? 'all'}`}
            className={cn(
              'rounded-md border px-2 py-1 text-xs',
              filter === option.value
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-white text-muted hover:text-ink',
            )}
          >
            {option.label} ({contentCounts[option.value ?? 'all']})
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty>No submissions yet.</Empty>
      ) : board.length === 0 ? (
        <Empty>Nothing with that content status.</Empty>
      ) : (
        <SubmissionsBoard
          rows={board}
          tracks={tracks.map((track) => ({ id: track.id, name: track.name }))}
          lockableFields={LOCKABLE_OPTIONS}
          statuses={STATUS_OPTIONS}
        />
      )}
    </div>
  );
}

/**
 * A revision as the board renders it. The timestamp is formatted here rather
 * than in the client component, where the browser's locale would disagree with
 * the server's and fail hydration.
 */
function toEntry(row: RevisionRow | null, timezone: string) {
  if (!row) return null;
  return {
    field: row.field,
    fieldLabel: fieldLabel(row.field),
    who: row.editorName ?? row.editorEmail,
    when: inEventZone(row.createdAt, timezone, { dateStyle: 'medium', timeStyle: 'short' }),
    oldValue: truncate(row.oldValue),
    newValue: truncate(row.newValue),
  };
}

/** An abstract is thousands of characters; a history line is one line. */
function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}
