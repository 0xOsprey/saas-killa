import { and, eq, sql } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { awards, bookmarks, rooms, slots, submissions, tracks, users } from '@/db/schema';
import { Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { contentIsPublic } from '@/lib/content';
import { FORMAT_LABELS, LEVEL_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { billing } from '@/lib/speakers';
import { StarButton } from '../StarButton';

export default async function SubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

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
      speakerTitle: users.title,
      speakerCompany: users.company,
      speakerBio: users.bio,
      trackName: tracks.name,
      trackColour: tracks.colour,
      startsAt: slots.startsAt,
      // The end as well as the start. A detail page reading "10:00" answers
      // when to turn up and not whether the talk collides with the next thing
      // an attendee wanted, which is the question this page is opened to
      // settle. The agenda grid gets away with a start alone because the band
      // it sits in supplies the rest.
      endsAt: slots.endsAt,
      roomName: rooms.name,
      roomCapacity: rooms.capacity,
      // The query builder, not a hand-written template: an interpolated column
      // renders unqualified, and this one only worked because `bookmarks` has
      // no `id` column of its own for the bare `"id"` to bind to. See the note
      // on `contentRowsById` in lib/content.ts for what that costs elsewhere.
      bookmarkCount: sql<number>`(${db
        .select({ n: sql<number>`count(*)::int` })
        .from(bookmarks)
        .where(eq(bookmarks.submissionId, submissions.id))})`,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.speakerId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(slots, eq(slots.submissionId, submissions.id))
    .leftJoin(rooms, eq(rooms.id, slots.roomId))
    .where(eq(submissions.id, parsed.data))
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
   * Through `contentIsPublic` rather than a local copy of its rule. This page
   * used to spell the same two clauses out by hand, and the copy drifted from
   * `readableUpload`, which serves the file the link points at: an accepted talk
   * at 'draft' rendered a Slides button whose `/files/` target answered 404,
   * because one gate published on draft and the other demanded approval.
   */
  const showMaterial = (field: string | null): field is string =>
    contentIsPublic(row.contentStatus, field);

  const slidesUrl = showMaterial(row.slidesUrl) ? row.slidesUrl : null;
  const recordingUrl = showMaterial(row.recordingUrl) ? row.recordingUrl : null;
  const resourcesNote = showMaterial(row.resourcesNote) ? row.resourcesNote : null;

  return (
    <article className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={row.title}
        description={
          row.startsAt && row.roomName
            ? // `endsAt` comes off the same slot row as `startsAt`, so it is
              // never the missing half of a placed talk. The fallback is there
              // for the type, not for a state anyone can reach.
              `${dayLabel(row.startsAt, event.timezone)}, ${timeOfDay(row.startsAt, event.timezone)}${
                row.endsAt ? ` to ${timeOfDay(row.endsAt, event.timezone)}` : ''
              } · ${row.roomName}${row.roomCapacity ? ` · seats ${row.roomCapacity}` : ''}`
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
        {/* Between the name and the bio, and gone when neither column is set,
            so a speaker who has filled in nothing still gets a clean card. */}
        {billing(row.speakerTitle, row.speakerCompany) ? (
          <p className="text-sm text-ink">{billing(row.speakerTitle, row.speakerCompany)}</p>
        ) : null}
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
