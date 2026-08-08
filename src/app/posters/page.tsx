import { and, asc, eq, isNotNull } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import { submissions, tracks, users } from '@/db/schema';
import { Badge, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { getEvent } from '@/lib/queries';

/**
 * ePoster gallery. Posters are accepted submissions with artwork and no slot —
 * they are displayed for the run of the event rather than presented at a time,
 * so they never appear on the schedule grid and get their own page instead.
 */
export default async function PostersPage() {
  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;

  if (!event.agendaPublished && !isOrganizer) {
    return (
      <div className="space-y-4">
        <PageHeader title="Posters" description={event.name} />
        <Notice>The poster gallery opens when the programme is published.</Notice>
      </div>
    );
  }

  const posters = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      posterUrl: submissions.posterUrl,
      speakerName: users.name,
      trackName: tracks.name,
      trackColour: tracks.colour,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .where(
      and(
        eq(submissions.status, 'accepted'),
        eq(submissions.format, 'poster'),
        isNotNull(submissions.posterUrl),
      ),
    )
    .orderBy(asc(submissions.title));

  return (
    <div className="space-y-5">
      <PageHeader title="Posters" description={`${posters.length} ePoster(s) · ${event.name}`} />

      {posters.length === 0 ? <Empty>No posters in this year&rsquo;s programme.</Empty> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {posters.map((poster) => (
          <Card
            key={poster.id}
            className="space-y-2 p-3"
            style={{ borderLeft: `3px solid ${poster.trackColour ?? '#cbd5e1'}` }}
          >
            <Link href={`/agenda/${poster.id}`} className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={poster.posterUrl ?? ''}
                alt={`Poster: ${poster.title}`}
                className="aspect-[3/4] w-full rounded-md border border-line object-cover"
              />
              <span className="mt-2 block font-medium text-ink hover:underline">
                {poster.title}
              </span>
            </Link>
            <p className="text-xs text-muted">{poster.speakerName ?? 'Unnamed'}</p>
            {poster.trackName ? <Badge>{poster.trackName}</Badge> : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
