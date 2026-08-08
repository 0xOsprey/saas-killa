import Link from 'next/link';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { allTracks, getEvent } from '@/lib/queries';
import { speakerDirectory } from '@/lib/speakers';
import { Headshot } from './Headshot';

function excerpt(text: string | null, limit = 180): string | null {
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * The public speaker directory.
 *
 * Gated on the agenda being published, exactly as `/agenda`, `/posters` and
 * `/agenda/[id]` are. "Everyone with an accepted submission" is the list of
 * people who got in, so publishing it early would announce the committee's
 * decisions before the organizers chose to.
 */
export default async function SpeakerDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; track?: string }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const trackId = params.track ?? '';

  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;

  if (!event.agendaPublished && !isOrganizer) {
    return (
      <div className="space-y-4">
        <PageHeader title="Speakers" description={event.name} />
        <Notice>The speaker directory opens when the programme is published.</Notice>
      </div>
    );
  }

  const [tracks, speakers] = await Promise.all([
    allTracks(),
    speakerDirectory({ q, trackId: trackId || undefined }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Speakers"
        description={`${speakers.length} speaker(s) · ${event.name}`}
      />

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search by name, talk title or expertise"
            aria-label="Search speakers"
          />
        </div>
        <Select name="track" defaultValue={trackId} aria-label="Track" className="w-auto">
          <option value="">Every track</option>
          {tracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {q || trackId ? (
          <Link href="/speakers" className="px-2 py-2 text-sm text-muted hover:text-ink">
            Clear
          </Link>
        ) : null}
      </form>

      {speakers.length === 0 ? (
        <Empty>No speaker matches that search.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {speakers.map((speaker) => (
            <Card key={speaker.id} className="space-y-3">
              <div className="flex items-start gap-3">
                <Headshot src={speaker.headshotUrl} name={speaker.name} size="md" />
                <div className="min-w-0">
                  <Link
                    href={`/speakers/${speaker.id}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {speaker.name ?? 'Unnamed speaker'}
                  </Link>
                  <p className="text-xs text-muted">
                    {speaker.acceptedCount} in the programme
                  </p>
                </div>
              </div>

              {speaker.bio ? (
                <p className="text-sm text-muted">{excerpt(speaker.bio)}</p>
              ) : null}

              <div className="flex flex-wrap gap-1.5">
                {speaker.trackNames.map((name) => (
                  <Badge key={name} tone="accent">
                    {name}
                  </Badge>
                ))}
                {speaker.keywords.slice(0, 6).map((keyword) => (
                  <Badge key={keyword}>{keyword}</Badge>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
