import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Notice,
  PageHeader,
  Select,
  ShowMoreText,
} from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { inEventZone } from '@/lib/format';
import { uuidOrNull } from '@/lib/ids';
import { posterGalleryGate } from '@/lib/poster';
import { POSTERS_PER_PAGE, posterGallery } from '@/lib/poster-queries';
import { allTracks, getEvent } from '@/lib/queries';
import { billing } from '@/lib/speakers';
import { BookmarkButton } from './BookmarkButton';
import { PosterKindBadge, PosterMedia } from './PosterMedia';

/**
 * The poster hall. Posters are accepted submissions with artwork and no slot —
 * displayed for the run of the event rather than presented at a time — so they
 * never appear on the schedule grid and get this page instead.
 *
 * Search, track and bookmark filtering all happen in SQL rather than over a
 * fetched array: the page is public, the hall grows every year, and a filter
 * that loads every row to throw most of them away is a filter that stops
 * working exactly when the conference gets big enough to need it.
 */

type Params = { q?: string; track?: string; mine?: string; page?: string };

function hrefFor(params: Params, page: number): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.track) search.set('track', params.track);
  if (params.mine) search.set('mine', '1');
  if (page > 1) search.set('page', String(page));
  const query = search.toString();
  return query ? `/posters?${query}` : '/posters';
}

export default async function PostersPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const [event, user, params] = await Promise.all([getEvent(), currentUser(), searchParams]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;

  const gate = posterGalleryGate(event, isOrganizer);
  if (!gate.open) {
    return (
      <div className="space-y-4">
        <PageHeader title="Posters" description={event.name} />
        {gate.reason === 'embargo' ? (
          <Notice>
            <span data-testid="poster-embargo">
              Posters open on{' '}
              {inEventZone(gate.opensAt, event.timezone, {
                dateStyle: 'long',
                timeStyle: 'short',
              })}
              .
            </span>
          </Notice>
        ) : (
          <Notice>The poster gallery opens when the programme is published.</Notice>
        )}
      </div>
    );
  }

  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const mineOnly = params.mine === '1' && Boolean(user);
  const filters = {
    q: params.q ?? '',
    // A `?track=` that is not a uuid is a stale bookmark, not a request for an
    // error page: it reaches Postgres as a cast and 22P02s the whole gallery.
    // This page is public and signed-out, so that crash is one dead link away
    // from any visitor. An unparseable filter is simply no filter.
    trackId: uuidOrNull(params.track),
    mineOnly,
    page,
  };

  const [tracks, { rows, total }] = await Promise.all([
    allTracks(),
    posterGallery(filters, user?.id ?? null),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / POSTERS_PER_PAGE));
  const filtered = Boolean(filters.q || filters.trackId || mineOnly);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Posters"
        description={`${total} ePoster(s) · ${event.name}`}
        action={
          isOrganizer && !event.agendaPublished ? (
            <Badge tone="warn">organizer preview</Badge>
          ) : undefined
        }
      />

      {/* A GET form: the filter state is the URL, so a filtered hall is a link
          somebody can send, and the back button works. */}
      <Card>
        <form method="get" action="/posters" className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1 space-y-1.5">
            <span className="block text-sm font-medium text-ink">Search</span>
            <Input
              name="q"
              type="search"
              defaultValue={filters.q}
              placeholder="Title, abstract or keyword"
              data-testid="poster-search"
            />
          </label>
          <label className="space-y-1.5">
            <span className="block text-sm font-medium text-ink">Track</span>
            <Select name="track" defaultValue={filters.trackId ?? ''} className="w-48">
              <option value="">All tracks</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </Select>
          </label>
          {user ? (
            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                name="mine"
                value="1"
                defaultChecked={mineOnly}
                className="h-4 w-4 rounded border-line text-accent focus:ring-accent/20"
                data-testid="poster-mine"
              />
              My bookmarks
            </label>
          ) : null}
          <Button type="submit" variant="secondary">
            Filter
          </Button>
          {filtered ? (
            <Link href="/posters" className="pb-2 text-sm text-muted underline hover:text-ink">
              Clear
            </Link>
          ) : null}
        </form>
      </Card>

      {rows.length === 0 ? (
        <Empty>
          {filtered
            ? 'No poster matches those filters.'
            : "No posters in this year's programme."}
        </Empty>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((poster) => {
          const billed = billing(poster.speakerTitle, poster.speakerCompany);
          return (
            <Card
              key={poster.id}
              className="flex flex-col gap-2 p-3"
              style={{ borderLeft: `3px solid ${poster.trackColour ?? '#cbd5e1'}` }}
              data-testid={`poster-${poster.id}`}
            >
              {poster.posterUrl ? (
                <PosterMedia url={poster.posterUrl} title={poster.title} variant="card" />
              ) : null}

              <Link href={`/posters/${poster.id}`} className="font-medium text-ink hover:underline">
                {poster.title}
              </Link>
              {/* Who is standing at the board, and what they do. A hall of
                  thirty boards is walked by people looking for a person as
                  often as for a topic, and the name on its own answered only
                  half of that. */}
              <p className="text-xs text-muted" data-testid="poster-billing">
                {poster.speakerName ?? 'Unnamed'}
                {billed ? ` · ${billed}` : ''}
              </p>
              {/* Posters carry no date or time on purpose: they have no slot and
                  stand for the run of the event, which is what the page header
                  already says. The abstract is the field that was missing. */}
              <ShowMoreText
                text={poster.abstract}
                className="text-xs text-muted"
                testId="poster-more"
              />

              <div className="flex flex-wrap items-center gap-1.5">
                {poster.boardNumber ? (
                  <Badge tone="accent">Board {poster.boardNumber}</Badge>
                ) : null}
                {poster.trackName ? <Badge>{poster.trackName}</Badge> : null}
                {poster.posterUrl ? <PosterKindBadge url={poster.posterUrl} /> : null}
              </div>

              <div className="mt-auto flex items-center justify-between pt-1">
                <Link href={`/posters/${poster.id}`} className="text-xs text-muted hover:text-ink">
                  Full size →
                </Link>
                <BookmarkButton
                  submissionId={poster.id}
                  bookmarked={poster.bookmarked}
                  signedIn={Boolean(user)}
                />
              </div>
            </Card>
          );
        })}
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
          {page > 1 ? (
            <Link href={hrefFor(params, page - 1)} className="text-muted hover:text-ink">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={hrefFor(params, page + 1)}
              className="text-muted hover:text-ink"
              data-testid="poster-next-page"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
