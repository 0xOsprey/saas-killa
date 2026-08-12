import { Button, Card, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { SUPPORTED_TIMEZONES } from '@/lib/content';
import { dayLabel, instantToWallClock, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { saveEventSettings } from './actions';

/**
 * Event settings. The one screen that writes the `events` row, minus the CFP
 * window: `cfpOpensAt` and `cfpClosesAt` are edited at /organizer/cfp, which is
 * where the rest of the call-for-papers controls live.
 */
export default async function EventSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const [params, event] = await Promise.all([searchParams, getEvent()]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Event settings"
        description="The name, dates and timezone every other screen renders against."
      />

      {params.error === 'event-order' ? (
        <Notice tone="bad">The event cannot end before it starts.</Notice>
      ) : null}

      {params.saved === 'settings' ? (
        <Notice tone="good">Settings saved.</Notice>
      ) : null}

      <form action={saveEventSettings} className="space-y-5">
        <input type="hidden" name="renderedTimezone" value={event.timezone} />

        <Card className="space-y-4">
          <Field label="Event name">
            <Input name="name" defaultValue={event.name} required data-testid="event-name" />
          </Field>

          <Field label="Tagline" hint="One line, shown under the name on the public pages.">
            <Textarea
              name="tagline"
              className="min-h-16"
              defaultValue={event.tagline ?? ''}
              maxLength={240}
            />
          </Field>
        </Card>

        <Card className="space-y-4">
          <Field
            label="Timezone"
            hint={`Times below are read as ${event.timezone} wall clock, the zone this form was drawn in.`}
          >
            <Select name="timezone" defaultValue={event.timezone} data-testid="event-timezone">
              {SUPPORTED_TIMEZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>

          <Notice tone="accent">
            Changing the timezone changes how times are <strong>displayed</strong>, never what is
            stored. Every scheduled slot is an instant, so a talk at{' '}
            {timeOfDay(event.startsOn, event.timezone)} in {event.timezone} stays at that same
            moment and simply reads as a different clock time in the new zone. Nothing on the
            schedule grid moves.
          </Notice>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" hint={dayLabel(event.startsOn, event.timezone)}>
              <Input
                type="datetime-local"
                name="startsOn"
                defaultValue={instantToWallClock(event.startsOn, event.timezone)}
                required
                data-testid="event-starts-on"
              />
            </Field>
            <Field label="Ends" hint={dayLabel(event.endsOn, event.timezone)}>
              <Input
                type="datetime-local"
                name="endsOn"
                defaultValue={instantToWallClock(event.endsOn, event.timezone)}
                required
                data-testid="event-ends-on"
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4">
          <Field
            label="Poster embargo lifts"
            hint="Leave empty for no embargo, in which case the gallery follows the agenda's publish flag."
          >
            <Input
              type="datetime-local"
              name="posterEmbargoUntil"
              defaultValue={
                event.posterEmbargoUntil
                  ? instantToWallClock(event.posterEmbargoUntil, event.timezone)
                  : ''
              }
              data-testid="poster-embargo"
            />
          </Field>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              name="agendaPublished"
              defaultChecked={event.agendaPublished}
              className="mt-0.5 h-4 w-4 rounded border-line"
              data-testid="agenda-published"
            />
            <span className="text-sm">
              <span className="block font-medium text-ink">Agenda published</span>
              <span className="block text-xs text-muted">
                Off keeps /agenda to organizers while the grid is still moving.
              </span>
            </span>
          </label>
        </Card>

        <Button type="submit" data-testid="save-settings">
          Save settings
        </Button>
      </form>
    </div>
  );
}
