import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Badge, Card, PageHeader, ShowMoreText } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { billing, speakerProfile } from '@/lib/speakers';
import { Headshot } from '../Headshot';

/** Past this many characters a bio is folded behind Show more. */
const BIO_FOLD = 260;

/**
 * One public speaker page. `speakerProfile` returns null for an account with
 * nothing accepted, so this 404s rather than turning every address that ever
 * submitted into a public page — the same rule the agenda detail page follows.
 */
export default async function SpeakerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;
  if (!event.agendaPublished && !isOrganizer) notFound();

  const speaker = await speakerProfile(parsed.data);
  if (!speaker) notFound();

  return (
    <article className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={speaker.name ?? 'Speaker'}
        description={`${speaker.acceptedSubmissions.length} in the programme at ${event.name}`}
        action={
          <Link href="/speakers" className="px-2 py-2 text-sm text-muted hover:text-ink">
            All speakers
          </Link>
        }
      />

      <Card className="flex flex-wrap items-start gap-4">
        <Headshot src={speaker.headshotUrl} name={speaker.name} size="lg" />
        <div className="min-w-56 flex-1 space-y-2">
          {/* Above the bio rather than in the header, because the header line
              already carries the event and the talk count and this is the one
              fact an attendee scans for. Nothing renders when it is empty. */}
          {billing(speaker.title, speaker.company) ? (
            <p className="text-sm font-medium text-ink" data-testid="speaker-billing">
              {billing(speaker.title, speaker.company)}
            </p>
          ) : null}
          {speaker.bio ? (
            <ShowMoreText
              text={speaker.bio}
              lines={3}
              foldAfter={BIO_FOLD}
              className="text-sm text-ink"
              testId="bio-toggle"
            />
          ) : (
            <p className="text-sm text-muted">No bio provided.</p>
          )}
        </div>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">
          Accepted submissions ({speaker.acceptedSubmissions.length})
        </h2>
        {speaker.acceptedSubmissions.map((submission) => (
          <Card
            key={submission.id}
            className="space-y-2"
          >
            <Link
              href={`/agenda/${submission.id}`}
              className="font-medium text-ink hover:underline"
            >
              {submission.title}
            </Link>
            <p className="text-xs text-muted">
              {submission.startsAt && submission.roomName
                ? `${dayLabel(submission.startsAt, event.timezone)} at ${timeOfDay(submission.startsAt, event.timezone)} · ${submission.roomName}`
                : 'Not scheduled yet'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{FORMAT_LABELS[submission.format]}</Badge>
              {submission.trackName ? <Badge tone="accent">{submission.trackName}</Badge> : null}
              {submission.keywords.map((keyword) => (
                <Badge key={keyword}>{keyword}</Badge>
              ))}
            </div>
          </Card>
        ))}
      </section>
    </article>
  );
}
