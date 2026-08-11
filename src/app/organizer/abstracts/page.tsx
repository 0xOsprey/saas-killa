import Link from 'next/link';
import { z } from 'zod';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  FieldAction,
  Input,
  LinkButton,
  PageHeader,
  ScoreDots,
  Select,
} from '@/components/ui';
import { StatusTabs } from '@/components/StatusTabs';
import { submissionStatusEnum } from '@/db/schema';
import type { SubmissionStatus } from '@/db/schema';
import {
  ABSTRACT_SORTS,
  ABSTRACT_SORT_LABELS,
  abstractIndex,
  abstractStatusCounts,
  type AbstractSort,
  type SortDirection,
} from '@/lib/abstracts';
import { FORMAT_LABELS, LEVEL_LABELS, STATUS_LABELS, inEventZone } from '@/lib/format';
import { allTracks, getEvent } from '@/lib/queries';

const STATUS_TONE = {
  submitted: 'neutral',
  accepted: 'good',
  rejected: 'bad',
  withdrawn: 'neutral',
} as const;

function asStatus(value: string | undefined): SubmissionStatus | null {
  const found = submissionStatusEnum.enumValues.find((status) => status === value);
  return found ?? null;
}

function asSort(value: string | undefined): AbstractSort {
  return ABSTRACT_SORTS.find((sort) => sort === value) ?? 'title';
}

export default async function AbstractsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    track?: string;
    status?: string;
    sort?: string;
    direction?: string;
  }>;
}) {
  const filters = await searchParams;
  const status = asStatus(filters.status);
  // A hand-edited ?track= that is not a uuid would reach Postgres as a cast
  // error and 500 the page, so an unparseable filter is simply no filter.
  const trackId = z.string().uuid().safeParse(filters.track).data ?? null;
  const q = filters.q ?? '';
  const sort = asSort(filters.sort);
  const direction: SortDirection =
    filters.direction === 'asc' || filters.direction === 'desc'
      ? filters.direction
      : sort === 'title'
        ? 'asc'
        : 'desc';

  const [event, tracks, rows, counts] = await Promise.all([
    getEvent(),
    allTracks(),
    abstractIndex({ q, trackId, status, sort, direction }),
    abstractStatusCounts({ q, trackId }),
  ]);

  const edited = rows.filter((row) => row.revisionCount > 0).length;
  const graded = rows.filter((row) => row.meanScore !== null).length;

  function tabHref(tabStatus: string | null): string {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (trackId) params.set('track', trackId);
    if (tabStatus) params.set('status', tabStatus);
    if (sort && sort !== 'title') params.set('sort', sort);
    if (direction) params.set('direction', direction);
    const search = params.toString();
    return search ? `/organizer/abstracts?${search}` : '/organizer/abstracts';
  }

  const allCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const statusTabs = [
    { value: null, label: 'All', count: allCount },
    ...submissionStatusEnum.enumValues.map((value) => ({
      value,
      label: STATUS_LABELS[value],
      count: counts[value] ?? 0,
    })),
  ];

  // The reverse of whatever is showing, carrying every filter with it. Built as
  // a link rather than a second form control because a chair flipping the
  // ordering is one click, and a submit button that has to be found inside a
  // filter panel is not one.
  const flipped = new URLSearchParams();
  if (q) flipped.set('q', q);
  if (trackId) flipped.set('track', trackId);
  if (status) flipped.set('status', status);
  flipped.set('sort', sort);
  flipped.set('direction', direction === 'desc' ? 'asc' : 'desc');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Abstracts"
        description={`${rows.length} submission(s) shown · ${graded} with a score · ${edited} edited since filing`}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/organizer/abstracts/book" variant="secondary">
              Abstract book
            </LinkButton>
            {/* A route handler, not a page: this must download, not navigate. */}
            <a
              className="inline-flex items-center justify-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-slate-50"
              href="/organizer/abstracts/export"
              data-testid="export-csv"
            >
              Export CSV
            </a>
          </div>
        }
      />

      <StatusTabs tabs={statusTabs} active={status} buildHref={tabHref} />

      <Card>
        <form method="get" className="grid items-start gap-3 sm:grid-cols-[2fr_1fr_auto]">
          <input type="hidden" name="status" value={status ?? ''} />
          <Field label="Search" hint="Title, abstract text and keywords.">
            <Input name="q" defaultValue={q} placeholder="observability" data-testid="abstract-search" />
          </Field>
          <Field label="Track">
            <Select name="track" defaultValue={trackId ?? ''}>
              <option value="">Every track</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </Select>
          </Field>
          <FieldAction>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </FieldAction>
        </form>

        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <form method="get" className="flex flex-wrap items-end gap-3">
            {/* The filters ride along as hidden inputs. Re-sorting must not
                quietly widen the set of rows a chair is looking at. */}
            <input type="hidden" name="q" value={q} />
            <input type="hidden" name="track" value={trackId ?? ''} />
            <input type="hidden" name="status" value={status ?? ''} />
            <input type="hidden" name="direction" value={direction} />
            <Field label="Sort by">
              <Select name="sort" defaultValue={sort} data-testid="sort-by">
                {ABSTRACT_SORTS.map((option) => (
                  <option key={option} value={option}>
                    {ABSTRACT_SORT_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="secondary" data-testid="apply-sort">
              Sort
            </Button>
          </form>

          <Link
            href={`/organizer/abstracts?${flipped.toString()}`}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-slate-50"
            data-testid="flip-direction"
          >
            {direction === 'desc' ? 'Highest first ↓' : 'Lowest first ↑'}
          </Link>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Empty>
          Nothing matches. {q ? <>Try a shorter search than “{q}”.</> : 'Clear the filters.'}
        </Empty>
      ) : null}

      <div className="space-y-2">
        {rows.map((row) => (
          <Card key={row.id} className="space-y-2" data-testid={`abstract-${row.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/organizer/abstracts/${row.id}`}
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {row.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted">
                  {row.speakerName ?? 'Unnamed'} · {row.speakerEmail}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {FORMAT_LABELS[row.format]} · {LEVEL_LABELS[row.audienceLevel]}
                  {row.trackName ? ` · ${row.trackName}` : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <span data-testid={`score-${row.id}`} title={`sorted on ${sort}, ${direction}`}>
                  <ScoreDots score={row.meanScore} />
                </span>
                <span className="text-xs text-muted" data-testid={`review-count-${row.id}`}>
                  {row.reviewCount} review(s)
                  {row.aiCount > 0 ? ` · ${row.humanCount} human, ${row.aiCount} AI` : ''}
                </span>
                <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                {row.revisionCount > 0 && row.lastEditedAt ? (
                  <Link
                    href={`/organizer/abstracts/${row.id}/history`}
                    data-testid={`edited-${row.id}`}
                  >
                    <Badge tone="warn">
                      edited {inEventZone(new Date(row.lastEditedAt), event.timezone, {
                        dateStyle: 'medium',
                      })}
                    </Badge>
                  </Link>
                ) : (
                  <span className="text-xs text-muted">unedited</span>
                )}
              </div>
            </div>

            <p className="line-clamp-2 whitespace-pre-wrap text-sm text-muted">{row.abstract}</p>

            {row.keywords.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {row.keywords.map((keyword) => (
                  <Badge key={keyword}>{keyword}</Badge>
                ))}
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
