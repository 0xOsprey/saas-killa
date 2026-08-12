import type { AudienceLevel, SubmissionFormat, SubmissionStatus } from '@/db/schema';

export const FORMAT_LABELS: Record<SubmissionFormat, string> = {
  lightning_10: 'Lightning talk (10 min)',
  talk_25: 'Talk (25 min)',
  talk_45: 'Talk (45 min)',
  workshop_90: 'Workshop (90 min)',
  poster: 'Poster / ePoster',
};

export const FORMAT_MINUTES: Record<SubmissionFormat, number> = {
  lightning_10: 10,
  talk_25: 25,
  talk_45: 45,
  workshop_90: 90,
  // Posters are displayed for the duration of the event rather than presented
  // in a slot, so they carry no scheduling length.
  poster: 0,
};

export const LEVEL_LABELS: Record<AudienceLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  submitted: 'Under review',
  accepted: 'Accepted',
  rejected: 'Not accepted',
  withdrawn: 'Withdrawn',
};

/**
 * Render a timestamp in the event's timezone. Every time in this app is stored
 * as `timestamptz` and formatted here, so a schedule built by an organizer in
 * one timezone reads identically to an attendee in another.
 */
export function inEventZone(date: Date, timezone: string, opts: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...opts }).format(date);
}

export function timeOfDay(date: Date, timezone: string): string {
  return inEventZone(date, timezone, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * A day, spelled out. The year is not decoration: the CFP page renders its
 * window with this, and a call open until 30 April 2027 read as "Friday 30
 * April" on a page loaded in August 2026, which is a closed call to anyone
 * skimming it.
 */
export function dayLabel(date: Date, timezone: string): string {
  return inEventZone(date, timezone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * A compact, poster-style date range: "NOV 10-11, 2026" or "JUL 29 – SEP 11, 2026".
 * Used on the hero and public landing cards where the full day name is noise.
 */
export function shortDateRange(start: Date, end: Date, timezone: string): string {
  const day = (date: Date) =>
    inEventZone(date, timezone, { day: 'numeric' });
  const month = (date: Date) =>
    inEventZone(date, timezone, { month: 'short' }).toUpperCase();
  const year = (date: Date) =>
    inEventZone(date, timezone, { year: 'numeric' });

  const startMonth = month(start);
  const endMonth = month(end);
  const startDay = day(start);
  const endDay = day(end);
  const startYear = year(start);
  const endYear = year(end);

  if (startYear !== endYear) {
    return `${startMonth} ${startDay}, ${startYear} – ${endMonth} ${endDay}, ${endYear}`;
  }
  if (startMonth !== endMonth) {
    return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${endYear}`;
  }
  return `${startMonth} ${startDay}-${endDay}, ${endYear}`;
}

/**
 * A best-effort city label for a timezone, in the all-caps style the AI Engineer
 * site uses on its event cards.
 */
export function eventCity(timezone: string): string | null {
  const map: Record<string, string> = {
    'Europe/London': 'LONDON, UK',
    'America/Los_Angeles': 'SAN FRANCISCO, CA',
    'America/New_York': 'NEW YORK, NY',
    'Europe/Paris': 'PARIS, FRANCE',
    'Asia/Singapore': 'SINGAPORE',
  };
  if (map[timezone]) return map[timezone];
  const tail = timezone.split('/').pop();
  return tail ? tail.replace(/_/g, ' ').toUpperCase() : null;
}

/**
 * Stable key for one day, computed in the event's timezone.
 *
 * `en-CA` rather than this module's usual `en-GB`, because the key is not only a
 * grouping key: the day filter puts it in the query string, and
 * `parseAgendaFilters` keeps `YYYY-MM-DD` and discards anything else. Under
 * `en-GB` this formatted as `06/11/2026`, so every day the filter offered was
 * thrown away on arrival and the agenda came back unfiltered.
 */
export function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The wall clock a zone is showing at an instant, as a UTC-based number.
 *
 * Subtracting the instant from it gives that zone's offset then, which is the
 * only thing this file needs and the reason there is no timezone dependency in
 * the graph.
 */
function zoneWallClock(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * Turn a `datetime-local` value into the instant it names in the event's
 * timezone.
 *
 * `new Date('2026-11-06T09:00')` parses as the *server's* local time, which for
 * an organizer in London filling in a London schedule on a UTC host is an hour
 * out for half the year. Rather than depend on a timezone library, the string
 * is read as UTC, the zone's offset is measured, and the offset is subtracted.
 *
 * Twice, not once. The first measurement is taken at the wrong instant by
 * construction — the wall clock read as UTC — and when that instant sits on the
 * far side of a DST transition from the real one, it reports the wrong offset.
 * New York on 2026-03-08, the morning the clocks go forward at 02:00 local:
 * 03:00 read as UTC is still 22:00 EST the previous evening, so the first pass
 * subtracts -5 and lands on 08:00Z, which is 04:00 EDT. An hour late, on the
 * one day of the year an organizer is most likely to be checking. The second
 * pass measures the offset at the candidate instant and re-subtracts, which
 * converges because the offset either side of a transition is constant.
 *
 * A wall clock inside the skipped hour names no instant at all. It resolves to
 * the one an hour either side rather than throwing, on the grounds that a form
 * refusing 02:30 with an explanation of civil time is worse than a schedule
 * with a time in it an organizer can see and move.
 */
export function wallClockToInstant(wallClock: string, timezone: string): Date {
  const asUtc = new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`);
  if (Number.isNaN(asUtc.getTime())) throw new Error(`unparseable date: ${wallClock}`);

  const target = asUtc.getTime();
  const firstPass = target - (zoneWallClock(asUtc, timezone) - target);
  const offset = zoneWallClock(new Date(firstPass), timezone) - firstPass;
  return new Date(target - offset);
}

/** Render an instant as a `datetime-local` value in the event's timezone. */
export function instantToWallClock(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
