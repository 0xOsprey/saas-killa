import { and, eq, sql } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db';
import { awards, bookmarks, rooms, slots, submissions, tracks, users } from '@/db/schema';
import { Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, LEVEL_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { StarButton } from '../StarButton';

export default async function SubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;

  const [row] = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      audienceLevel: submissions.audienceLevel,
      status: submissions.status,
      slidesUrl: submissions.slidesUrl,
      recordingUrl: submissions.recordingUrl,
      resourcesNote: submissions.resourcesNote,
      contentStatus: submissions.contentStatus,
      posterUrl: submissions.posterUrl,
      speakerName: users.name,
      speakerBio: users.bio,
      trackName: tracks.name,
      trackColour: tracks.colour,
      startsAt: slots.startsAt,
      roomName: rooms.name,
      roomCapacity: rooms.capacity,
      bookmarkCount: sql<number>`(
        select count(*) from ${bookmarks}
        where ${bookmarks.submissionId} = ${submissions.id}
      )::int`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(eq(submissions.id, id))
    .limit(1);

  // A detail page for a rejected or still-under-review proposal would leak a
  // decision that has not been announced, so it 404s for everyone but an
  // organizer. The unpublished-agenda rule is the same rule.
  if (!row) notFound();
  if (row.status !== 'accepted' && !isOrganizer) notFound();
  if (!event.agendaPublished && !isOrganizer) notFound();

  const [wins, starred] = await Promise.all([
    db.select({ name: awards.name }).from(awards).where(eq(awards.winnerSubmissionId, row.id)),
    user
      ? db
          .select({ userId: bookmarks.userId })
          .from(bookmarks)
          .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.submissionId, row.id)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  /**
   * Speaker-supplied materials, gated on `contentStatus`.
   *
   * The rule implemented: show a field when the submission is 'approved', or
   * when it is 'draft' and that field is already filled in. 'pending' hides
   * everything — it means the speaker has asked for review and an organizer has
   * not answered, which is the one state where publishing would pre-empt a
   * decision. The 'draft' leg exists because every seeded row is 'draft' with
   * materials already on it, and those must not vanish the day moderation ships.
   */
  const showMaterial = (field: string | null): field is string =>
    field !== null &&
    field.length > 0 &&
    (row.contentStatus === 'approved' || row.contentStatus === 'draft');

  const slidesUrl = showMaterial(row.slidesUrl) ? row.slidesUrl : null;
  const recordingUrl = showMaterial(row.recordingUrl) ? row.recordingUrl : null;
  const resourcesNote = showMaterial(row.resourcesNote) ? row.resourcesNote : null;

  return (
    <article className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={row.title}
        description={
          row.startsAt && row.roomName
            ? `${dayLabel(row.startsAt, event.timezone)} at ${timeOfDay(row.startsAt, event.timezone)} · ${row.roomName}${row.roomCapacity ? ` · seats ${row.roomCapacity}` : ''}`
            : 'Not scheduled yet'
        }
        action={
          <StarButton
            submissionId={row.id}
            starred={starred.length > 0}
            signedIn={user !== null}
            count={row.bookmarkCount}
          />
        }
      />

      <div className="flex flex-wrap gap-2">
        <Badge>{FORMAT_LABELS[row.format]}</Badge>
        <Badge>{LEVEL_LABELS[row.audienceLevel]}</Badge>
        {row.trackName ? <Badge tone="accent">{row.trackName}</Badge> : null}
        {wins.map((w) => (
          <Badge key={w.name} tone="good">
            {w.name}
          </Badge>
        ))}
      </div>

      <Card>
        <p className="whitespace-pre-wrap text-sm text-ink">{row.abstract}</p>
      </Card>

      {row.posterUrl ? (
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Poster</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={row.posterUrl}
            alt={`Poster for ${row.title}`}
            className="w-full rounded-md border border-line"
          />
        </Card>
      ) : null}

      <Card className="space-y-1">
        <h2 className="text-sm font-semibold text-ink">{row.speakerName ?? 'Speaker'}</h2>
        <p className="whitespace-pre-wrap text-sm text-muted">
          {row.speakerBio ?? 'No bio provided.'}
        </p>
      </Card>

      {slidesUrl || recordingUrl || resourcesNote ? (
        <Card className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Materials</h2>
          <div className="flex flex-wrap gap-2">
            {slidesUrl ? (
              <LinkButton href={slidesUrl} variant="secondary">
                Slides
              </LinkButton>
            ) : null}
            {recordingUrl ? (
              <LinkButton href={recordingUrl} variant="secondary">
                Recording
              </LinkButton>
            ) : null}
          </div>
          {resourcesNote ? (
            <p className="whitespace-pre-wrap text-sm text-muted">{resourcesNote}</p>
          ) : null}
        </Card>
      ) : null}
    </article>
  );
}
