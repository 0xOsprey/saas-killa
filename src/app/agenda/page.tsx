import Link from 'next/link';
import { Badge, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { dayKey, dayLabel, timeOfDay } from '@/lib/format';
import { agenda, getEvent } from '@/lib/queries';

export default async function AgendaPage() {
  const [event, entries, user] = await Promise.all([getEvent(), agenda(), currentUser()]);
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

  const placed = entries.filter((entry) => entry.submissionId !== null);

  // Group by day, then by start time. The query already orders by start then
  // room position, so a single pass preserves both orderings.
  const days = new Map<string, { label: string; times: Map<string, typeof placed> }>();
  for (const entry of placed) {
    const dKey = dayKey(entry.startsAt, event.timezone);
    let day = days.get(dKey);
    if (!day) {
      day = { label: dayLabel(entry.startsAt, event.timezone), times: new Map() };
      days.set(dKey, day);
    }
    const tKey = timeOfDay(entry.startsAt, event.timezone);
    const bucket = day.times.get(tKey);
    if (bucket) bucket.push(entry);
    else day.times.set(tKey, [entry]);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agenda"
        description={`${event.name} · all times ${event.timezone}`}
      />

      {!event.agendaPublished && isOrganizer ? (
        <Notice>Unpublished. Only organizers can see this.</Notice>
      ) : null}

      {placed.length === 0 ? <Empty>Nothing scheduled yet.</Empty> : null}

      {[...days.values()].map((day) => (
        <section key={day.label} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{day.label}</h2>
          {[...day.times.entries()].map(([time, items]) => (
            <div key={time} className="grid gap-3 sm:grid-cols-[5rem_1fr]">
              <div className="pt-1 text-sm tabular-nums text-muted">{time}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((entry) => (
                  <Card
                    key={entry.slotId}
                    className="p-3"
                    style={{ borderLeft: `3px solid ${entry.trackColour ?? '#cbd5e1'}` }}
                  >
                    <Link
                      href={`/agenda/${entry.submissionId}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {entry.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted">
                      {entry.speakerName ?? 'Speaker to be confirmed'} · {entry.roomName}
                    </p>
                    {entry.trackName ? (
                      <Badge className="mt-2">{entry.trackName}</Badge>
                    ) : null}
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
