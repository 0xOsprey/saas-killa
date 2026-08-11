import { Card, LinkButton, Notice } from '@/components/ui';
import { dayLabel } from '@/lib/format';
import { cfpIsOpen, getEvent } from '@/lib/queries';

export default async function HomePage() {
  const event = await getEvent();
  const open = cfpIsOpen(event);
  const zone = event.timezone;

  return (
    <div className="-mx-4 -my-8 flex min-h-[calc(100dvh-7rem)] flex-col justify-center px-4 py-8">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-4 text-xs font-mono uppercase tracking-[0.2em] text-muted">
          {dayLabel(event.startsOn, zone)} to {dayLabel(event.endsOn, zone)} · {zone}
        </p>
        <h1 className="font-display text-5xl tracking-tight text-ink md:text-7xl">
          {event.name}
        </h1>
        {event.tagline ? (
          <p className="mt-4 text-lg text-muted md:text-xl">{event.tagline}</p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {open ? (
            <LinkButton href="/cfp">Submit a proposal</LinkButton>
          ) : (
            <LinkButton href="/agenda" variant="secondary">
              See the agenda
            </LinkButton>
          )}
          <LinkButton href="/speakers" variant="secondary">
            View speakers
          </LinkButton>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          <Card>
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted">When</h2>
            <p className="mt-1 text-sm text-ink">
              {dayLabel(event.startsOn, zone)} to {dayLabel(event.endsOn, zone)}
            </p>
          </Card>
          <Card>
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted">Call for papers</h2>
            <p className="mt-1 text-sm text-ink">
              {dayLabel(event.cfpOpensAt, zone)} to {dayLabel(event.cfpClosesAt, zone)}
            </p>
          </Card>
        </div>

        <div className="mt-6">
          {open ? (
            <Notice tone="good">
              The call for papers is open. Talks, workshops, lightning talks and posters are all
              welcome.
            </Notice>
          ) : (
            <Notice>
              The call for papers is closed. The programme is published on the{' '}
              <a className="underline" href="/agenda">
                agenda
              </a>
              .
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
