import Link from 'next/link';
import { z } from 'zod';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Select,
} from '@/components/ui';
import { submissionStatusEnum } from '@/db/schema';
import type { SubmissionStatus } from '@/db/schema';
import { abstractIndex } from '@/lib/abstracts';
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

export default async function AbstractsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; track?: string; status?: string }>;
}) {
  const filters = await searchParams;
  const status = asStatus(filters.status);
  // A hand-edited ?track= that is not a uuid would reach Postgres as a cast
  // error and 500 the page, so an unparseable filter is simply no filter.
  const trackId = z.string().uuid().safeParse(filters.track).data ?? null;
  const q = filters.q ?? '';

  const [event, tracks, rows] = await Promise.all([
    getEvent(),
    allTracks(),
    abstractIndex({ q, trackId, status }),
  ]);

  const edited = rows.filter((row) => row.revisionCount > 0).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Abstracts"
        description={`${rows.length} submission(s) shown · ${edited} edited since filing`}
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

      <Card>
        <form method="get" className="grid items-end gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
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
          <Field label="Status">
            <Select name="status" defaultValue={status ?? ''}>
              <option value="">Every status</option>
              {submissionStatusEnum.enumValues.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
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
