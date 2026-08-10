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
import { StatusTabs } from '@/components/StatusTabs';
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
  ORGANIZER_DEFAULT_DIRECTION,
  ORGANIZER_SORTS,
  organizerReviewComments,
  organizerStatusCounts,
  organizerSubmissionCount,
  organizerSubmissions,
  organizerTotals,
  type OrganizerDirection,
  type OrganizerSort,
  type ReviewCommentRow,
} from '@/lib/queries';
import { UPLOAD_KIND_LABELS, fileSeriesBySubmission, formatBytes } from '@/lib/uploads';
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
  direction?: OrganizerDirection;
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
  // Written only when it is not the mode's own default, for the same reason the
  // sort is: the plain address has to stay the plain address.
  if (query.direction && query.direction !== ORGANIZER_DEFAULT_DIRECTION[query.sort ?? 'grade']) {
    params.set('direction', query.direction);
  }
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

function asDirection(value: string | undefined, sort: OrganizerSort): OrganizerDirection {
  if (value === 'asc' || value === 'desc') return value;
  return ORGANIZER_DEFAULT_DIRECTION[sort];
}

/** What the flip control should say, in the vocabulary of the mode it flips. */
const DIRECTION_LABELS: Record<OrganizerSort, Record<OrganizerDirection, string>> = {
  grade: { desc: 'Highest first ↓', asc: 'Lowest first ↑' },
  newest: { desc: 'Newest first ↓', asc: 'Oldest first ↑' },
  title: { asc: 'A to Z ↓', desc: 'Z to A ↑' },
};

export default async function OrganizerSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    track?: string;
    content?: string;
    sort?: string;
    direction?: string;
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
  const direction = asDirection(params.direction, sort);
  const showAll = params.per === 'all';
  const filters = { q, status, trackId, content };

  const [matching, totals, tracks, event, statusCounts] = await Promise.all([
    organizerSubmissionCount(filters),
    organizerTotals(),
    allTracks(),
    getEvent(),
    organizerStatusCounts({ q, trackId, content }),
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
    direction,
    ...(showAll ? {} : { limit: PAGE_SIZE, offset }),
  });

  // Everything below is keyed to the rows actually on screen. These four used to
  // read every submission, every document and the whole revision log on every
  // render of this page, whatever it was going to show.
  const ids = rows.map((row) => row.id);
  const [contentRows, history, lastEdits, files, reviewComments] = await Promise.all([
    contentRowsById(ids),
    recentRevisions(ids),
    lastEditBySubmission(ids),
    fileSeriesBySubmission(ids),
    organizerReviewComments(ids),
  ]);

  const current: Query = { q, status, track: trackId, content, sort, direction, page, all: showAll };
  const contentCounts = {
    all: totals.total,
    draft: totals.draft,
    pending: totals.pending,
    approved: totals.approved,
  };
  const allStatusCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const statusTabs = [
    { value: null, label: 'All', count: allStatusCount },
    ...submissionStatusEnum.enumValues.map((value) => ({
      value,
      label: STATUS_LABELS[value],
      count: statusCounts[value] ?? 0,
    })),
  ];
  const sortLabel = ORGANIZER_SORTS.find((option) => option.value === sort)!.label;

  const commentsBySubmission = new Map<string, ReviewCommentRow[]>();
  for (const comment of reviewComments) {
    const held = commentsBySubmission.get(comment.submissionId);
    if (held) held.push(comment);
    else commentsBySubmission.set(comment.submissionId, [comment]);
  }

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
      reviews: commentsBySubmission.get(row.id) ?? [],
      notified: Boolean(row.decisionEmailedAt),
      scheduled: row.scheduled,
      contentStatus: extra?.contentStatus ?? 'draft',
      contentStatusLabel: CONTENT_STATUS_LABELS[extra?.contentStatus ?? 'draft'],
      hasContent: Boolean(extra?.slidesUrl || extra?.recordingUrl || extra?.resourcesNote),
      // A supporting document is private, so this panel is the only place on
      // this screen an organizer can find one. Without it the speaker's upload
      // would be write-only: stored, access-controlled and unreachable by the
      // people it was sent to.
      //
      // The latest version of each chain, with the count beside it. The row
      // that would say "slides.pdf" twice with nothing to tell the copies apart
      // is the defect this replaced.
      files: (files.get(row.id) ?? []).map((series) => ({
        href: series.latest.href,
        detailHref: `/organizer/files/${series.seriesId}`,
        name: series.latest.filename,
        kindLabel: UPLOAD_KIND_LABELS[series.kind],
        size: formatBytes(series.latest.bytes),
        versionCount: series.versions.length,
        commentCount: series.commentCount,
      })),
      filesHref: `/organizer/files?submission=${row.id}`,
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

      <StatusTabs
        tabs={statusTabs}
        active={status}
        buildHref={(value) => submissionsHref({ ...current, status: value as SubmissionStatus | null, page: 1 })}
      />

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
        <form
          method="get"
          className="grid items-end gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
        >
          <input type="hidden" name="status" value={status ?? ''} />
          <Field label="Search" hint="Title, abstract, speaker name and email.">
            <Input
              name="q"
              defaultValue={q}
              placeholder="observability"
              data-testid="board-search"
            />
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
          {/* Its own control rather than three more entries in the sort list.
              Six options that pair a mode with a direction is the shape that
              grows quadratically the next time a mode is added, and it cannot
              express "the ordering I have, reversed" in one place. */}
          <Field label="Order">
            <Select name="direction" defaultValue={direction} data-testid="board-direction">
              <option value="desc">{DIRECTION_LABELS[sort].desc}</option>
              <option value="asc">{DIRECTION_LABELS[sort].asc}</option>
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

        {/* The same parameter the Order select writes, one click away and back
            on page 1. Reversing a sort while staying on page 4 lands the reader
            in the middle of an order they have not seen the top of. */}
        <Link
          href={submissionsHref({
            ...current,
            direction: direction === 'desc' ? 'asc' : 'desc',
            page: 1,
          })}
          data-testid="board-flip-direction"
          className="ml-auto rounded-md border border-line bg-white px-2 py-1 text-xs text-muted hover:text-ink"
        >
          {DIRECTION_LABELS[sort][direction === 'desc' ? 'asc' : 'desc']}
        </Link>
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
