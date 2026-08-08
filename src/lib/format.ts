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

export function dayLabel(date: Date, timezone: string): string {
  return inEventZone(date, timezone, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Stable key for grouping slots into days, computed in the event's timezone. */
export function dayKey(date: Date, timezone: string): string {
  return inEventZone(date, timezone, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * Turn a `datetime-local` value into the instant it names in the event's
 * timezone.
 *
 * `new Date('2026-11-06T09:00')` parses as the *server's* local time, which for
 * an organizer in London filling in a London schedule on a UTC host is an hour
 * out for half the year. Rather than depend on a timezone library, the string
 * is read as UTC, formatted back into the target zone, and the difference is
 * the offset to subtract. Formatting the actual instant is what makes this
 * correct across a DST boundary: the offset is the one in force on that date,
 * not today's.
 */
export function wallClockToInstant(wallClock: string, timezone: string): Date {
  const asUtc = new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`);
  if (Number.isNaN(asUtc.getTime())) throw new Error(`unparseable date: ${wallClock}`);

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
    .formatToParts(asUtc)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const roundTripped = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return new Date(asUtc.getTime() - (roundTripped - asUtc.getTime()));
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
