import type { AgendaSlot } from '@/lib/agenda-filters';
import { FORMAT_LABELS } from '@/lib/format';

/**
 * iCalendar serialisation, RFC 5545.
 *
 * Written here rather than pulled in: the subset an agenda needs is one VEVENT
 * shape, and the two rules that actually break calendar clients — escaping in
 * TEXT values and folding at 75 octets — are a dozen lines each. A dependency
 * would be more surface than substance.
 */

const PRODID = '-//sessionboard-clone//agenda//EN';
const UID_DOMAIN = 'sessionboard-clone';

/**
 * Escape a TEXT value. Backslash goes first, or it would double-escape the
 * backslashes the later replacements introduce. A lone CR is dropped rather
 * than turned into a second newline.
 */
export function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/** `20261106T090000Z`. Every DTSTART and DTEND is emitted in UTC. */
export function icsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Fold at 75 octets, continuation lines prefixed with one space. The limit is
 * bytes, not characters, so the accumulator measures UTF-8 length; iterating by
 * code point keeps a multi-byte character from being split down the middle.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;

  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  // The first line may use all 75; a continuation spends one on its leading space.
  let limit = 75;

  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (currentBytes + size > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += size;
  }
  if (current) parts.push(current);

  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n');
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'block'
  );
}

type Vevent = {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  location: string | null;
  description: string | null;
};

function describe(entry: AgendaSlot): string {
  const lines: string[] = [];
  if (entry.speakerName) lines.push(entry.speakerName);
  const tags = [
    entry.trackName,
    entry.format ? FORMAT_LABELS[entry.format] : null,
  ].filter((tag): tag is string => tag !== null);
  if (tags.length > 0) lines.push(tags.join(' · '));
  if (entry.abstract) lines.push('', entry.abstract);
  return lines.join('\n');
}

/**
 * Turn agenda rows into VEVENTs.
 *
 * A submission's UID is its submission id, so re-importing a corrected calendar
 * updates the event an attendee already has rather than duplicating it. That
 * survives the talk being moved to another room or time, which is exactly the
 * case the stability is for.
 *
 * A venue-wide break is one labelled slot per room. Exported room by room it
 * would land as three identical "Lunch" entries, so blocks collapse on
 * (time, label) and keep a LOCATION only when they really are in one room.
 */
export function toVevents(entries: AgendaSlot[], includeBlocks: boolean): Vevent[] {
  const events: Vevent[] = [];
  const blocks = new Map<string, { event: Vevent; rooms: Set<string> }>();

  for (const entry of entries) {
    if (entry.submissionId && entry.title) {
      events.push({
        uid: `${entry.submissionId}@${UID_DOMAIN}`,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        summary: entry.title,
        location: entry.roomName,
        description: describe(entry),
      });
      continue;
    }

    if (!includeBlocks || !entry.label) continue;

    const key = `${entry.startsAt.toISOString()}|${entry.endsAt.toISOString()}|${entry.label}`;
    const existing = blocks.get(key);
    if (existing) {
      existing.rooms.add(entry.roomName);
      existing.event.location = existing.rooms.size === 1 ? entry.roomName : null;
      continue;
    }
    blocks.set(key, {
      rooms: new Set([entry.roomName]),
      event: {
        uid: `block-${slug(entry.label)}-${icsUtc(entry.startsAt)}@${UID_DOMAIN}`,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        summary: entry.label,
        location: entry.roomName,
        description: null,
      },
    });
  }

  return [...events, ...[...blocks.values()].map((block) => block.event)].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

export function buildCalendar(
  entries: AgendaSlot[],
  options: { calendarName: string; includeBlocks?: boolean; now?: Date },
): string {
  const stamp = icsUtc(options.now ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(options.calendarName)}`,
  ];

  for (const event of toVevents(entries, options.includeBlocks ?? true)) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsUtc(event.startsAt)}`,
      `DTEND:${icsUtc(event.endsAt)}`,
      `SUMMARY:${icsEscape(event.summary)}`,
    );
    if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export function calendarResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // The agenda changes up to the morning of the event; a cached copy that
      // outlives a room change is worse than fetching it again.
      'cache-control': 'no-store',
    },
  });
}
