import { Card, LinkButton, Notice, PageHeader } from '@/components/ui';
import { dayLabel } from '@/lib/format';
import { cfpIsOpen, getEvent } from '@/lib/queries';

export default async function HomePage() {
  const event = await getEvent();
  const open = cfpIsOpen(event);
  const zone = event.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title={event.name}
        description={event.tagline ?? undefined}
        action={
          open ? (
            <LinkButton href="/cfp">Submit a proposal</LinkButton>
          ) : (
            <LinkButton href="/agenda" variant="secondary">
              See the agenda
            </LinkButton>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold text-ink">When</h2>
          <p className="mt-1 text-sm text-muted">
            {dayLabel(event.startsOn, zone)} to {dayLabel(event.endsOn, zone)} ({zone})
          </p>
        </Card>
        <Card>
          <h2 className="text-sm font-semibold text-ink">Call for papers</h2>
          <p className="mt-1 text-sm text-muted">
            {dayLabel(event.cfpOpensAt, zone)} to {dayLabel(event.cfpClosesAt, zone)}
          </p>
        </Card>
      </div>

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
  );
}
