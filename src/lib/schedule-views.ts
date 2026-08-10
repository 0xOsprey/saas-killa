import type { AgendaEntry } from './queries';
import { dayKey, dayLabel, timeOfDay } from './format';

/**
 * The ways one schedule can be looked at.
 *
 * `grid` and `day` are the building views: rooms across, time down, empty boxes
 * included, because an empty box is where a talk goes. The other four are
 * reading views over the same rows, they show only what is filled, and they
 * exist because the questions an organizer asks are not all shaped like a grid.
 * "Is anyone double-booked in Studio?" is a room question. "Does the Research
 * track run against itself?" is a track question. Neither is answerable by
 * scanning a wall of cells.
 *
 * Grouping happens here rather than in SQL: it is the same `agenda()` rows
 * arranged six ways, and six queries that differ only by ORDER BY would be six
 * chances for one of them to disagree with the grid about what is scheduled.
 */
export const SCHEDULE_VIEWS = {
  grid: 'Grid',
  list: 'List',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  room: 'Rooms',
  conflicts: 'Conflicts',
} as const;

export type ScheduleView = keyof typeof SCHEDULE_VIEWS;

export function isScheduleView(value: unknown): value is ScheduleView {
  return typeof value === 'string' && value in SCHEDULE_VIEWS;
}

export type BuildingView = Extract<ScheduleView, 'grid' | 'day'>;
export type ReadingView = Exclude<ScheduleView, BuildingView>;

/** The building views draw the grid; the rest read it. */
export function isBuildingView(view: ScheduleView): view is BuildingView {
  return view === 'grid' || view === 'day';
}

export type ScheduleEntry = {
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  dayKey: string;
  dayLabel: string;
  time: string;
  roomId: string;
  roomName: string;
  submissionId: string | null;
  title: string | null;
  label: string | null;
  speakerName: string | null;
  trackName: string | null;
  trackColour: string | null;
  conflicted: boolean;
  /**
   * Two talks are running in this room at once. Kept distinct from `conflicted`,
   * which is the speaker being in two rooms, rather than folded into one
   * "clashing" flag. The room view exists to answer a room question, and a
   * merged flag would leave "is anything colliding in Studio?" answerable only
   * by going back to the grid, which is the view an organizer came here to stop
   * trusting.
   */
  roomConflicted: boolean;
  unavailable: boolean;
  overCapacity: boolean;
};

/**
 * The slot ids carrying each warning, computed once by the schedule page and
 * handed down. Recomputing per view is what this shape exists to prevent: six
 * views each deriving their own conflicts is six chances for one of them to
 * disagree with the grid about what is wrong.
 */
export type Warnings = {
  conflicted: Set<string>;
  roomConflicted: Set<string>;
  unavailable: Set<string>;
  overCapacity: Set<string>;
};

/** One flat, timezone-resolved row per slot, with its warnings already attached. */
export function toScheduleEntries(
  rows: AgendaEntry[],
  labels: Map<string, string>,
  timezone: string,
  warnings: Warnings,
): ScheduleEntry[] {
  return rows.map((row) => ({
    slotId: row.slotId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    dayKey: dayKey(row.startsAt, timezone),
    dayLabel: dayLabel(row.startsAt, timezone),
    time: timeOfDay(row.startsAt, timezone),
    roomId: row.roomId,
    roomName: row.roomName,
    submissionId: row.submissionId,
    title: row.title,
    label: labels.get(row.slotId) ?? null,
    speakerName: row.speakerName,
    trackName: row.trackName,
    trackColour: row.trackColour,
    conflicted: warnings.conflicted.has(row.slotId),
    roomConflicted: warnings.roomConflicted.has(row.slotId),
    unavailable: warnings.unavailable.has(row.slotId),
    overCapacity: warnings.overCapacity.has(row.slotId),
  }));
}

/** A talk in a box, or a named block. An empty box is neither. */
export function isFilled(entry: ScheduleEntry): boolean {
  return entry.submissionId !== null || entry.label !== null;
}

export type Group = { key: string; label: string; colour: string | null; entries: ScheduleEntry[] };

function collect(
  entries: ScheduleEntry[],
  keyOf: (entry: ScheduleEntry) => { key: string; label: string; colour: string | null },
): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const { key, label, colour } = keyOf(entry);
    let group = groups.get(key);
    if (!group) {
      group = { key, label, colour, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

export function byDay(entries: ScheduleEntry[]): Group[] {
  return collect(entries, (entry) => ({
    key: entry.dayKey,
    label: entry.dayLabel,
    colour: null,
  }));
}

export function byRoom(entries: ScheduleEntry[]): Group[] {
  return collect(entries, (entry) => ({
    key: entry.roomId,
    label: entry.roomName,
    colour: null,
  }));
}

/**
 * A break belongs to no track, so it gets its own bucket rather than being
 * dropped: a track view that silently hides lunch reads as a gap in the day.
 */
export function byTrack(entries: ScheduleEntry[]): Group[] {
  const groups = collect(entries, (entry) => {
    if (entry.submissionId === null) {
      return { key: '￿blocks', label: 'Breaks and blocks', colour: null };
    }
    return {
      key: entry.trackName ?? '￾none',
      label: entry.trackName ?? 'No track',
      colour: entry.trackColour,
    };
  });
  // The two synthetic buckets sort last because their keys are above every
  // printable character, which is the whole reason they are spelled that way.
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

export type WeekTable = { days: Group[]; times: string[] };

/**
 * Days across, start times down. Every distinct time in the whole schedule is a
 * row, so a day that does not run at 09:00 shows an empty cell there rather
 * than shifting its afternoon up a row beside another day's morning.
 */
export function asWeek(entries: ScheduleEntry[]): WeekTable {
  const days = byDay(entries);
  const times = [...new Set(entries.map((entry) => entry.time))].sort();
  return { days, times };
}
