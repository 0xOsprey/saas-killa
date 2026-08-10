import Link from 'next/link';
import { Button, Card, Input, Select, cn } from '@/components/ui';
import type { AgendaFacets, AgendaFilters as Filters } from '@/lib/agenda-filters';
import { agendaFilterQuery, hasActiveFilters } from '@/lib/agenda-filters';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';

function href(filters: Filters, overrides: Partial<Filters>): string {
  const query = agendaFilterQuery(filters, overrides);
  return query ? `/agenda?${query}` : '/agenda';
}

/**
 * A plain GET form. Every narrowing is in the query string and every narrowing
 * is done in SQL, so what an attendee sees is what they can send someone: the
 * URL is the filter.
 */
export function AgendaFilterBar({
  filters,
  facets,
  signedIn,
  matchCount,
}: {
  filters: Filters;
  /**
   * Only values with a session behind them. Every list here used to be the
   * whole table or the whole enum, so four of the twenty-five options on the
   * deployed page led to an empty agenda. See `agendaFacets`.
   */
  facets: AgendaFacets;
  signedIn: boolean;
  matchCount: number;
}) {
  const narrowed = hasActiveFilters(filters);
  const { days, tracks, rooms, formats, levels } = facets;

  return (
    <Card className="space-y-3">
      <form method="get" action="/agenda" className="flex flex-wrap items-end gap-2">
        {/* Switching filters must not drop you out of "My agenda". */}
        {filters.mine ? <input type="hidden" name="view" value="mine" /> : null}

        <label className="min-w-56 flex-1 space-y-1">
          <span className="block text-xs font-medium text-muted">Search</span>
          <Input
            type="search"
            name="q"
            placeholder="Title, abstract or speaker"
            defaultValue={filters.q ?? ''}
            data-testid="agenda-search"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted">Day</span>
          <Select name="day" defaultValue={filters.day ?? ''} className="w-44">
            <option value="">Any day</option>
            {days.map((day) => (
              <option key={day.key} value={day.key}>
                {day.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted">Track</span>
          <Select name="track" defaultValue={filters.trackId ?? ''} className="w-44">
            <option value="">Any track</option>
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </Select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted">Room</span>
          <Select name="room" defaultValue={filters.roomId ?? ''} className="w-40">
            <option value="">Any room</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </Select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted">Format</span>
          <Select name="format" defaultValue={filters.format ?? ''} className="w-48">
            <option value="">Any format</option>
            {formats.map((value) => (
              <option key={value} value={value}>
                {FORMAT_LABELS[value]}
              </option>
            ))}
          </Select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted">Level</span>
          <Select name="level" defaultValue={filters.level ?? ''} className="w-36">
            <option value="">Any level</option>
            {levels.map((value) => (
              <option key={value} value={value}>
                {LEVEL_LABELS[value]}
              </option>
            ))}
          </Select>
        </label>

        <Button type="submit" variant="secondary" data-testid="agenda-filter-apply">
          Filter
        </Button>
        {narrowed ? (
          <Link
            href={href(filters, {
              trackId: null,
              roomId: null,
              day: null,
              format: null,
              level: null,
              q: null,
            })}
            className="px-1 py-2 text-sm text-muted underline hover:text-ink"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
        <div className="flex overflow-hidden rounded-md border border-line">
          {[
            { mine: false, label: 'Full programme' },
            { mine: true, label: 'My agenda' },
          ].map((view) => (
            <Link
              key={view.label}
              href={href(filters, { mine: view.mine })}
              data-testid={view.mine ? 'view-mine' : 'view-all'}
              className={cn(
                'px-3 py-1.5 text-sm',
                filters.mine === view.mine
                  ? 'bg-accent text-white'
                  : 'bg-white text-muted hover:bg-slate-50 hover:text-ink',
              )}
            >
              {view.label}
            </Link>
          ))}
        </div>

        <span className="text-xs text-muted">{matchCount} session(s)</span>

        <span className="ml-auto flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted">Subscribe:</span>
          <a href="/agenda/calendar.ics" className="text-accent underline">
            Whole programme
          </a>
          {narrowed || filters.mine ? (
            <a
              href={`/agenda/filtered.ics?${agendaFilterQuery(filters)}`}
              className="text-accent underline"
              data-testid="export-filtered"
            >
              This view
            </a>
          ) : null}
          {signedIn ? (
            <a href="/agenda/my.ics" className="text-accent underline" data-testid="export-mine">
              My agenda
            </a>
          ) : null}
        </span>
      </div>
    </Card>
  );
}
