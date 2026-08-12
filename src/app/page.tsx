import { Card, LinkButton, Notice } from '@/components/ui';
import { eventCity, shortDateRange } from '@/lib/format';
import { cfpIsOpen, getEvent } from '@/lib/queries';

export default async function HomePage() {
  const event = await getEvent();
  const open = cfpIsOpen(event);
  const zone = event.timezone;
  const location = eventCity(zone);

  return (
    <div className="-mx-4 -my-8 flex min-h-[calc(100dvh-7rem)] flex-col justify-center px-4 py-8">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-4 text-xs font-mono uppercase tracking-[0.2em] text-accent">
          {shortDateRange(event.startsOn, event.endsOn, zone)}
          {location ? ` · ${location}` : null}
        </p>
        <h1 className="font-display text-5xl tracking-tight text-ink md:text-7xl lg:text-8xl">
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
          <Card className="border-t-2 border-t-accent">
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted">When</h2>
            <p className="mt-1 font-mono text-sm uppercase tracking-wider text-ink">
              {shortDateRange(event.startsOn, event.endsOn, zone)}
            </p>
          </Card>
          <Card className="border-t-2 border-t-accent">
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted">Call for papers</h2>
            <p className="mt-1 font-mono text-sm uppercase tracking-wider text-ink">
              {open
                ? shortDateRange(event.cfpOpensAt, event.cfpClosesAt, zone)
                : 'Closed'}
            </p>
          </Card>
        </div>

        <div className="mt-6">
          {open ? (
            <Notice tone="accent">
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
