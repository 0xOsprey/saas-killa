import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Badge, Card, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { inEventZone } from '@/lib/format';
import { posterGalleryGate } from '@/lib/poster';
import { posterById } from '@/lib/poster-queries';
import { getEvent } from '@/lib/queries';
import { BookmarkButton } from '../BookmarkButton';
import { PosterKindBadge, PosterMedia } from '../PosterMedia';

/**
 * The full-size view is a route rather than a lightbox, for three reasons that
 * all point the same way: a poster hall is meant to be linkable, so a poster
 * needs its own URL to send to a colleague; the embargo and moderation rules
 * are then applied server-side on a direct hit instead of only where the grid
 * happens to render; and it needs no client JavaScript, which is the rest of
 * this app's habit.
 */
export default async function PosterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, event, user] = await Promise.all([params, getEvent(), currentUser()]);
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const isOrganizer = user?.roles.includes('organizer') ?? false;

  const gate = posterGalleryGate(event, isOrganizer);
  if (!gate.open) {
    return (
      <div className="space-y-4">
        <PageHeader title="Posters" description={event.name} />
        {gate.reason === 'embargo' ? (
          <Notice>
            Posters open on{' '}
            {inEventZone(gate.opensAt, event.timezone, {
              dateStyle: 'long',
              timeStyle: 'short',
            })}
            .
          </Notice>
        ) : (
          <Notice>The poster gallery opens when the programme is published.</Notice>
        )}
      </div>
    );
  }

  const poster = await posterById(parsed.data, {
    userId: user?.id ?? null,
    includeHidden: isOrganizer,
  });
  if (!poster || !poster.posterUrl) notFound();

  const byline = poster.authors
    .map((author) =>
      author.affiliation ? `${author.name ?? 'Unnamed'} (${author.affiliation})` : author.name,
    )
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="mx-auto max-w-4xl space-y-5">
      <Link href="/posters" className="text-sm text-muted hover:text-ink">
        ← All posters
      </Link>

      <PageHeader
        title={poster.title}
        description={byline || undefined}
        action={
          <BookmarkButton
            submissionId={poster.id}
            bookmarked={poster.bookmarked}
            signedIn={Boolean(user)}
          />
        }
      />

      <div className="flex flex-wrap gap-2">
        {poster.boardNumber ? (
          <Badge tone="accent" data-testid="poster-board">
            Board {poster.boardNumber}
          </Badge>
        ) : null}
        {poster.trackName ? <Badge>{poster.trackName}</Badge> : null}
        <PosterKindBadge url={poster.posterUrl} />
        {poster.keywords.map((keyword) => (
          <Badge key={keyword} tone="neutral">
            {keyword}
          </Badge>
        ))}
      </div>

      <Card
        className="space-y-3"
      >
        <PosterMedia url={poster.posterUrl} title={poster.title} variant="full" />
      </Card>

      <Card className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Abstract</h2>
        <p className="whitespace-pre-wrap text-sm text-ink">{poster.abstract}</p>
      </Card>

      {event.agendaPublished ? (
        <Link href={`/agenda/${poster.id}`} className="block text-sm text-muted hover:text-ink">
          Speaker bio and materials →
        </Link>
      ) : null}
    </article>
  );
}
