import Link from 'next/link';
import { Badge, Card, Empty, Notice, PageHeader, ShowMoreText } from '@/components/ui';
import type { AgendaSearchParams, AgendaSlot } from '@/lib/agenda-filters';
import { agendaDays, agendaSlots, hasActiveFilters, parseAgendaFilters } from '@/lib/agenda-filters';
import { currentUser } from '@/lib/auth';
import { FORMAT_LABELS, dayKey, dayLabel, timeOfDay } from '@/lib/format';
import { allRooms, allTracks, getEvent } from '@/lib/queries';
import { billing } from '@/lib/speakers';
import { AgendaFilterBar } from './AgendaFilters';
import { StarButton } from './StarButton';

/** A slot the query returned with a submission in it, narrowed once at the fold. */
type PlacedSession = AgendaSlot & { submissionId: string; title: string };

/** One start time on one day: the talks running then, and any named block. */
type Bucket = {
  time: string;
  sessions: PlacedSession[];
  /** Label to the rooms it covers. A venue-wide break is one slot per room. */
  blocks: Map<string, string[]>;
};


export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<AgendaSearchParams>;
}) {
  const params = await searchParams;
  const filters = parseAgendaFilters(params);
  const [event, user] = await Promise.all([getEvent(), currentUser()]);
  const isOrganizer = user?.roles.includes('organizer') ?? false;

  if (!event.agendaPublished && !isOrganizer) {
    return (
      <div className="space-y-4">
        <PageHeader title="Agenda" description={event.name} />
        <Notice>
          The programme is not published yet. It appears here as soon as the organizers are happy
          with it.
        </Notice>
      </div>
    );
  }

  const [entries, tracks, rooms, days] = await Promise.all([
    agendaSlots(filters, event.timezone, user?.id ?? null),
    allTracks(),
    allRooms(),
    agendaDays(event.timezone),
  ]);

  // Group by day, then by start time. The query already orders by start then
  // room position, so a single pass preserves both orderings.
  const programme = new Map<string, { label: string; times: Map<string, Bucket> }>();
  let sessionCount = 0;

  for (const entry of entries) {
    const dKey = dayKey(entry.startsAt, event.timezone);
    let day = programme.get(dKey);
    if (!day) {
      day = { label: dayLabel(entry.startsAt, event.timezone), times: new Map() };
      programme.set(dKey, day);
    }
    const tKey = timeOfDay(entry.startsAt, event.timezone);
    let bucket = day.times.get(tKey);
    if (!bucket) {
      bucket = { time: tKey, sessions: [], blocks: new Map() };
      day.times.set(tKey, bucket);
    }

    if (entry.submissionId !== null && entry.title !== null) {
      bucket.sessions.push({ ...entry, submissionId: entry.submissionId, title: entry.title });
      sessionCount += 1;
    } else if (entry.label) {
      const covered = bucket.blocks.get(entry.label);
      if (covered) covered.push(entry.roomName);
      else bucket.blocks.set(entry.label, [entry.roomName]);
    }
  }

  // A day that only contains a break is not a day worth a heading.
  const populated = [...programme.values()].filter((day) =>
    [...day.times.values()].some((bucket) => bucket.sessions.length > 0),
  );

  const narrowed = hasActiveFilters(filters) || filters.mine;

  return (
    <div className="space-y-6">
      <PageHeader title="Agenda" description={`${event.name} · all times ${event.timezone}`} />

      {!event.agendaPublished && isOrganizer ? (
        <Notice>Unpublished. Only organizers can see this.</Notice>
      ) : null}

      <AgendaFilterBar
        filters={filters}
        tracks={tracks}
        rooms={rooms}
        days={days}
        signedIn={user !== null}
        matchCount={sessionCount}
      />

      {sessionCount === 0 ? (
        <Empty>
          {filters.mine && !user ? (
            <>
              <Link href="/login" className="text-accent underline">
                Sign in
              </Link>{' '}
              to star talks and build your own agenda.
            </>
          ) : filters.mine ? (
            'Nothing starred yet. Press the star on a talk to add it here.'
          ) : narrowed ? (
            'No sessions match these filters.'
          ) : (
            'Nothing scheduled yet.'
          )}
        </Empty>
      ) : null}

      {populated.map((day) => (
        <section key={day.label} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{day.label}</h2>
          {[...day.times.values()].map((bucket) => (
            <div key={bucket.time} className="grid gap-3 sm:grid-cols-[5rem_1fr]">
              <div className="pt-1 text-sm tabular-nums text-muted">{bucket.time}</div>
              <div className="space-y-2">
                {[...bucket.blocks.entries()].map(([label, roomNames]) => (
                  <div
                    key={label}
                    data-testid={`block-${label}`}
                    className="rounded-lg border border-dashed border-line bg-slate-100 px-3 py-2 text-sm font-medium text-muted"
                  >
                    {label}
                    {roomNames.length === 1 ? (
                      <span className="ml-2 text-xs font-normal">{roomNames[0]}</span>
                    ) : null}
                  </div>
                ))}

                {bucket.sessions.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {bucket.sessions.map((entry) => {
                      const billed = billing(entry.speakerTitle, entry.speakerCompany);
                      return (
                        <Card
                          key={entry.slotId}
                          className="flex items-start justify-between gap-2 p-3"
                          style={{ borderLeft: `3px solid ${entry.trackColour ?? '#cbd5e1'}` }}
                        >
                          <div className="min-w-0">
                            <Link
                              href={`/agenda/${entry.submissionId}`}
                              className="font-medium text-ink hover:underline"
                            >
                              {entry.title}
                            </Link>
                            {/* The date and time in full, on the card itself.
                                The band header down the left already carries
                                the start, but a card read on its own answered
                                "which room" and never "when", and the room now
                                rides on this line rather than the byline's. */}
                            <p className="mt-0.5 text-xs text-muted" data-testid="agenda-when">
                              {dayLabel(entry.startsAt, event.timezone)} ·{' '}
                              {timeOfDay(entry.startsAt, event.timezone)} to{' '}
                              {timeOfDay(entry.endsAt, event.timezone)} · {entry.roomName}
                            </p>
                            <p className="text-xs text-muted" data-testid="agenda-billing">
                              {entry.speakerName ?? 'Speaker to be confirmed'}
                              {billed ? ` · ${billed}` : ''}
                            </p>
                            {entry.abstract ? (
                              <div className="mt-1">
                                <ShowMoreText
                                  text={entry.abstract}
                                  className="text-xs text-muted"
                                  testId="agenda-more"
                                />
                              </div>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {entry.trackName ? <Badge>{entry.trackName}</Badge> : null}
                              {entry.format ? (
                                <Badge tone="neutral">{FORMAT_LABELS[entry.format]}</Badge>
                              ) : null}
                            </div>
                          </div>
                          <StarButton
                            submissionId={entry.submissionId}
                            starred={entry.bookmarkedByMe}
                            signedIn={user !== null}
                            count={entry.bookmarkCount}
                          />
                        </Card>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
