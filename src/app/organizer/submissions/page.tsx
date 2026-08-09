import Link from 'next/link';
import { z } from 'zod';
import {
  Button,
  Card,
  Empty,
  Field,
  Input,
  LinkButton,
  Notice,
  PageHeader,
  Select,
  cn,
} from '@/components/ui';
import { contentStatusEnum, submissionStatusEnum } from '@/db/schema';
import type { ContentStatus, SubmissionStatus } from '@/db/schema';
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
import {
  allTracks,
  getEvent,
  ORGANIZER_SORTS,
  organizerSubmissionCount,
  organizerSubmissions,
  organizerTotals,
  type OrganizerSort,
} from '@/lib/queries';
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
const CONTENT_FILTERS: { value: ContentStatus | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'pending', label: 'Awaiting review' },
  { value: 'approved', label: 'Approved' },
  { value: 'draft', label: 'Draft' },
];

/**
 * Rows per page. Twenty-five is about a screen and a half of the board's cards,
 * which is enough to scan without being the whole call for papers: the page
 * rendered all 40 seeded submissions at 17,000 pixels and 2,500 DOM nodes, and
 * a real event's several hundred would have been proportionally worse.
 */
const PAGE_SIZE = 25;

type Query = {
  q?: string;
  status?: SubmissionStatus | null;
  track?: string | null;
  content?: ContentStatus | null;
  sort?: OrganizerSort;
  page?: number;
  all?: boolean;
};

/**
 * One link back to this page, carrying everything the reader had set.
 *
 * The content chips used to be bare `?content=` hrefs, so pressing one from a
 * filtered board silently threw the search and the sort away. Defaults are left
 * out of the query string rather than written as `sort=grade`, which keeps the
 * unfiltered address `/organizer/submissions` and the browser history readable.
 */
function submissionsHref(query: Query): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (query.track) params.set('track', query.track);
  if (query.content) params.set('content', query.content);
  if (query.sort && query.sort !== 'grade') params.set('sort', query.sort);
  if (query.all) params.set('per', 'all');
  if (query.page && query.page > 1) params.set('page', String(query.page));

  const search = params.toString();
  return search ? `/organizer/submissions?${search}` : '/organizer/submissions';
}

function asStatus(value: string | undefined): SubmissionStatus | null {
  return submissionStatusEnum.enumValues.find((status) => status === value) ?? null;
}

function asContentStatus(value: string | undefined): ContentStatus | null {
  return contentStatusEnum.enumValues.find((status) => status === value) ?? null;
}

function asSort(value: string | undefined): OrganizerSort {
  return ORGANIZER_SORTS.find((sort) => sort.value === value)?.value ?? 'grade';
}

export default async function OrganizerSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    track?: string;
    content?: string;
    sort?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const params = await searchParams;

  const q = params.q?.trim() ?? '';
  const status = asStatus(params.status);
  // A hand-edited ?track= that is not a uuid would reach Postgres as a cast
  // error and 500 the page, so an unparseable filter is simply no filter.
  const trackId = z.string().uuid().safeParse(params.track).data ?? null;
  const content = asContentStatus(params.content);
  const sort = asSort(params.sort);
  const showAll = params.per === 'all';
  const filters = { q, status, trackId, content };

  const [matching, totals, tracks, event] = await Promise.all([
    organizerSubmissionCount(filters),
    organizerTotals(),
    allTracks(),
    getEvent(),
  ]);

  // Clamp rather than render an empty page 9: a filter narrowed from the page
  // an organizer was already on otherwise takes them somewhere with nothing on
  // it and no way back but the pager they can no longer see.
  const pageCount = Math.max(1, Math.ceil(matching / PAGE_SIZE));
  const requested = Number.parseInt(params.page ?? '1', 10);
  const page = showAll ? 1 : Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), pageCount);
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await organizerSubmissions({
    ...filters,
    sort,
    ...(showAll ? {} : { limit: PAGE_SIZE, offset }),
  });

  // Everything below is keyed to the rows actually on screen. These four used to
  // read every submission, every document and the whole revision log on every
  // render of this page, whatever it was going to show.
  const ids = rows.map((row) => row.id);
  const [contentRows, history, lastEdits, documents] = await Promise.all([
    contentRowsById(ids),
    recentRevisions(ids),
    lastEditBySubmission(ids),
    documentsFor(ids),
  ]);

  const current: Query = { q, status, track: trackId, content, sort, page, all: showAll };
  const contentCounts = {
    all: totals.total,
    draft: totals.draft,
    pending: totals.pending,
    approved: totals.approved,
  };
  const sortLabel = ORGANIZER_SORTS.find((option) => option.value === sort)!.label;

  const board: BoardRow[] = rows.map((row) => {
    const extra = contentRows.get(row.id);
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
        description={`${totals.submitted} undecided · ${totals.accepted} accepted · ${totals.rejected} rejected. Sorted by ${sortLabel.toLowerCase()}.`}
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
              <Button
                type="submit"
                disabled={totals.awaitingEmail === 0}
                data-testid="notify-decided"
              >
                {/* At zero this has always been disabled, but it still read
                    "Send 0 decision email(s)", which is an instruction to press
                    a control that does nothing. Say the state instead. */}
                {totals.awaitingEmail === 0
                  ? 'Everyone decided has been told'
                  : `Send ${totals.awaitingEmail} decision email(s)`}
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

      {totals.pending > 0 ? (
        <Notice tone="accent">
          <span data-testid="content-queue">
            {totals.pending} submission(s) have content awaiting review. Nothing submitted for
            review appears on the public agenda until it is approved.
          </span>
        </Notice>
      ) : null}

      <Card>
        {/* A GET form, so the filtered board is an address: linkable, reloadable
            and back-button-able. It carries no `page`, which is what makes
            narrowing the filters land on the first page of the new result
            rather than page 4 of a result that no longer has one.

            These controls are `board-*` rather than `submission-*` on purpose.
            A row card is `submission-<id>`, and two specs find rows with
            `[data-testid^="submission-"]`, which a filter named
            `submission-search` would join silently: the count comes out five
            too high and nothing says why. */}
        <form method="get" className="grid items-end gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
          <Field label="Search" hint="Title, abstract, speaker name and email.">
            <Input
              name="q"
              defaultValue={q}
              placeholder="observability"
              data-testid="board-search"
            />
          </Field>
          <Field label="Decision">
            <Select name="status" defaultValue={status ?? ''} data-testid="board-status">
              <option value="">Every status</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Track">
            <Select name="track" defaultValue={trackId ?? ''} data-testid="board-track">
              <option value="">Every track</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sort by">
            <Select name="sort" defaultValue={sort} data-testid="board-sort">
              {ORGANIZER_SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" data-testid="board-apply">
            Apply
          </Button>
          {content ? <input type="hidden" name="content" value={content} /> : null}
          {showAll ? <input type="hidden" name="per" value="all" /> : null}
        </form>
      </Card>

      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-muted">Content:</span>
        {CONTENT_FILTERS.map((option) => (
          <Link
            key={option.label}
            href={submissionsHref({ ...current, content: option.value, page: 1 })}
            data-testid={`filter-${option.value ?? 'all'}`}
            className={cn(
              'rounded-md border px-2 py-1 text-xs',
              content === option.value
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-white text-muted hover:text-ink',
            )}
          >
            {option.label} ({contentCounts[option.value ?? 'all']})
          </Link>
        ))}
      </div>

      <div
        className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
        data-testid="pager"
      >
        <span data-testid="pager-range">
          {matching === 0
            ? 'No submissions match these filters.'
            : showAll
              ? `Showing all ${matching}`
              : `Showing ${offset + 1}–${offset + rows.length} of ${matching}`}
        </span>
        <div className="flex flex-wrap items-center gap-3">
          {showAll ? (
            <Link href={submissionsHref({ ...current, all: false })} data-testid="page-paged">
              Back to pages of {PAGE_SIZE}
            </Link>
          ) : (
            <>
              {page > 1 ? (
                <Link href={submissionsHref({ ...current, page: page - 1 })} data-testid="page-prev">
                  ← Previous
                </Link>
              ) : (
                <span className="opacity-40">← Previous</span>
              )}
              <span data-testid="page-of">
                Page {page} of {pageCount}
              </span>
              {page < pageCount ? (
                <Link href={submissionsHref({ ...current, page: page + 1 })} data-testid="page-next">
                  Next →
                </Link>
              ) : (
                <span className="opacity-40">Next →</span>
              )}
              {matching > PAGE_SIZE ? (
                <Link href={submissionsHref({ ...current, all: true })} data-testid="page-all">
                  Show all {matching}
                </Link>
              ) : null}
            </>
          )}
        </div>
      </div>

      {totals.total === 0 ? (
        <Empty>No submissions yet.</Empty>
      ) : board.length === 0 ? (
        <Empty>
          Nothing matches. {q ? <>Try a shorter search than “{q}”.</> : 'Clear the filters.'}
        </Empty>
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
