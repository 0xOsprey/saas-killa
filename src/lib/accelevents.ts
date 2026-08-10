import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import {
  integrationRuns,
  rooms,
  slots,
  submissions,
  tracks,
  users,
  type IntegrationRequestLog,
} from '@/db/schema';
import { env } from '@/lib/env';
import { FORMAT_LABELS } from '@/lib/format';
import { allTracks, getEvent } from '@/lib/queries';

/**
 * Pushing the programme to Accelevents.
 *
 * One-way, and one-way is a design constraint rather than a phase. Nothing
 * Accelevents returns is written back into a submission, a slot or a speaker;
 * the only thing kept is the run log, which exists to answer "what did we send
 * them". This app is the source of truth for the programme and their copy is
 * downstream of it. Two-way would mean deciding whose edit wins, and that
 * decision belongs to a conference that has actually been bitten by it.
 *
 * ## The wire format is transcribed, not verified
 *
 * `ACCELEVENTS_PATHS` and the three `to*` builders below are this codebase's
 * reading of the Accelevents public API. Nothing here has ever been checked
 * against a live endpoint, deliberately: a request that leaves the host during
 * development is a request against somebody's real event. If a path or a field
 * name is wrong, it is wrong in exactly one place and correcting it is an edit
 * to this file with no caller to chase.
 *
 * ## Dry run is the default, and it is not a no-op
 *
 * With `ACCELEVENTS_BASE_URL` unset the run goes through `fixtureTransport`,
 * which answers the way the far end is documented to. That exercises the whole
 * path, building every request, checking every response, recording every remote
 * id, and it fails a request that is missing a field the far end requires. A
 * dry run that only printed the payload would tell an organizer their export
 * works right up until the first time it does not.
 */

/** Where each kind of object is written. Correct these here and nowhere else. */
const ACCELEVENTS_PATHS = {
  track: (eventId: string, externalId: string) =>
    `/api/v2/events/${eventId}/tracks/external/${externalId}`,
  speaker: (eventId: string, externalId: string) =>
    `/api/v2/events/${eventId}/speakers/external/${externalId}`,
  session: (eventId: string, externalId: string) =>
    `/api/v2/events/${eventId}/sessions/external/${externalId}`,
} as const;

export type AcceleventsMode = 'dry_run' | 'live';

export type AcceleventsConfig = {
  mode: AcceleventsMode;
  /** Null in a dry run. Never carries the key. */
  baseUrl: string | null;
  eventId: string;
  /** Whether a key is configured. The key itself never leaves this module. */
  hasKey: boolean;
  /** What is stopping a live run, when something is. */
  missing: string[];
};

const DRY_RUN_EVENT_ID = 'dry-run-event';

/**
 * Live needs all three variables. Missing any one is a dry run rather than an
 * error, because the failure mode worth designing against is a half-configured
 * deploy pushing a partial programme into a real event, not an organizer who
 * has not set anything up yet.
 */
export function acceleventsConfig(): AcceleventsConfig {
  const e = env();
  const missing: string[] = [];
  if (!e.ACCELEVENTS_BASE_URL) missing.push('ACCELEVENTS_BASE_URL');
  if (!e.ACCELEVENTS_API_KEY) missing.push('ACCELEVENTS_API_KEY');
  if (!e.ACCELEVENTS_EVENT_ID) missing.push('ACCELEVENTS_EVENT_ID');

  if (missing.length > 0) {
    return {
      mode: 'dry_run',
      baseUrl: null,
      eventId: e.ACCELEVENTS_EVENT_ID ?? DRY_RUN_EVENT_ID,
      hasKey: Boolean(e.ACCELEVENTS_API_KEY),
      missing,
    };
  }

  return {
    mode: 'live',
    baseUrl: e.ACCELEVENTS_BASE_URL!,
    eventId: e.ACCELEVENTS_EVENT_ID!,
    hasKey: true,
    missing: [],
  };
}

export type ExportRequest = {
  method: 'PUT';
  path: string;
  /** Which of our objects this is, for the screen that lists a run. */
  kind: 'track' | 'speaker' | 'session';
  /** Our id for the object, and the key the far end upserts on. */
  externalId: string;
  /** What the request says it is about, so a run reads as more than a list of uuids. */
  label: string;
  body: Record<string, unknown>;
};

export type ExportResponse = {
  status: number;
  remoteId: string | null;
  error: string | null;
};

export type Transport = (request: ExportRequest) => Promise<ExportResponse>;

export type ExportBundle = {
  requests: ExportRequest[];
  trackCount: number;
  speakerCount: number;
  sessionCount: number;
};

/** A relative upload path is useless to a platform that has to fetch it. */
function absolute(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${env().APP_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Accelevents takes a first and last name; we hold one name field, because a
 * conference programme has no business insisting a person's name splits in two.
 * The split is the lossy step and it happens here, at the boundary, so nothing
 * upstream inherits the assumption.
 *
 * No name gives no `firstName`, and the dry run then refuses that speaker by
 * name. Substituting their email address would push a person into the public
 * programme billed as "speaker11@example.com", which is worse than an export
 * that stops and says three profiles are incomplete.
 */
function splitName(name: string | null): { first: string | null; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts.at(-1)! };
}

/**
 * Every request the programme amounts to, in dependency order: tracks, then
 * speakers, then the sessions that name both. A session sent before its track
 * exists is the kind of thing that works on a re-run and fails on a fresh
 * event, which is the worst way for it to fail.
 */
export async function exportBundle(): Promise<ExportBundle> {
  const config = acceleventsConfig();
  const eventId = config.eventId;
  const [event, trackRows, speakerRows, sessionRows] = await Promise.all([
    getEvent(),
    allTracks(),
    exportSpeakers(),
    exportSessions(),
  ]);

  const requests: ExportRequest[] = [];

  for (const track of trackRows) {
    requests.push({
      method: 'PUT',
      path: ACCELEVENTS_PATHS.track(eventId, track.id),
      kind: 'track',
      externalId: track.id,
      label: track.name,
      body: { name: track.name, colour: track.colour, externalId: track.id },
    });
  }

  for (const speaker of speakerRows) {
    const { first, last } = splitName(speaker.name);
    requests.push({
      method: 'PUT',
      path: ACCELEVENTS_PATHS.speaker(eventId, speaker.id),
      kind: 'speaker',
      externalId: speaker.id,
      label: speaker.name ?? speaker.email,
      body: {
        externalId: speaker.id,
        email: speaker.email,
        firstName: first,
        lastName: last,
        // Two more transcribed names, on the same footing as every other name
        // in this file: nobody has seen the far end accept them. They are not
        // in `REQUIRED_FIELDS`, so a wrong guess costs an ignored key rather
        // than a 422, and the byline is now on every other surface the
        // programme reaches. Sending a bare name to the one downstream copy
        // would have made this file the only place a speaker is still just a
        // name.
        jobTitle: speaker.title,
        company: speaker.company,
        biography: speaker.bio,
        headshotUrl: absolute(speaker.headshotUrl),
        profileUrl: `${env().APP_URL}/speakers/${speaker.id}`,
      },
    });
  }

  for (const session of sessionRows) {
    requests.push({
      method: 'PUT',
      path: ACCELEVENTS_PATHS.session(eventId, session.externalId),
      kind: 'session',
      externalId: session.externalId,
      label: session.title,
      body: {
        externalId: session.externalId,
        title: session.title,
        description: session.abstract,
        // ISO 8601 with an offset, not a wall clock. The far end holds its own
        // idea of the event timezone and a naive string would be read in it.
        startTime: session.startsAt.toISOString(),
        endTime: session.endsAt.toISOString(),
        timezone: event.timezone,
        location: session.roomName,
        trackExternalId: session.trackId,
        format: session.format ? FORMAT_LABELS[session.format] : null,
        speakerExternalIds: session.speakerId ? [session.speakerId] : [],
      },
    });
  }

  return {
    requests,
    trackCount: trackRows.length,
    speakerCount: speakerRows.length,
    sessionCount: sessionRows.length,
  };
}

/** Speakers of accepted talks. Nobody else is in the programme. */
async function exportSpeakers() {
  return db
    .selectDistinctOn([users.id], {
      id: users.id,
      email: users.email,
      name: users.name,
      title: users.title,
      company: users.company,
      bio: users.bio,
      headshotUrl: users.headshotUrl,
    })
    .from(users)
    .innerJoin(
      submissions,
      and(eq(submissions.speakerId, users.id), eq(submissions.status, 'accepted')),
    )
    .orderBy(asc(users.id));
}

/**
 * Scheduled programme content. A talk carries its submission id as the external
 * key; a named break carries its slot id, because it has no submission and the
 * slot is the only thing about it that is stable across a re-run.
 *
 * Only accepted submissions reach this, and only ones that are in a slot. An
 * accepted talk nobody has scheduled yet has no time to send.
 */
async function exportSessions() {
  const rows = await db
    .select({
      slotId: slots.id,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      roomName: rooms.name,
      label: slots.label,
      submissionId: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      status: submissions.status,
      trackId: submissions.trackId,
      speakerId: submissions.speakerId,
    })
    .from(slots)
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(submissions, eq(submissions.id, slots.submissionId))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .orderBy(asc(slots.startsAt), asc(rooms.position), asc(rooms.name));

  return rows
    .filter((row) => (row.submissionId ? row.status === 'accepted' : Boolean(row.label)))
    .map((row) => ({
      externalId: row.submissionId ?? row.slotId,
      title: row.title ?? row.label!,
      abstract: row.abstract,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      roomName: row.roomName,
      format: row.format,
      trackId: row.trackId,
      speakerId: row.speakerId,
    }));
}

/** What the far end refuses outright, so a dry run refuses it too. */
const REQUIRED_FIELDS: Record<ExportRequest['kind'], string[]> = {
  track: ['name'],
  speaker: ['email', 'firstName'],
  session: ['title', 'startTime', 'endTime'],
};

/**
 * The dry-run far end.
 *
 * It answers the way Accelevents is documented to: a 200 with an id derived
 * from the external key, so a re-run produces the same id and the log shows the
 * upsert it claims to be. A request missing a field the far end requires comes
 * back 422 with the field named, which is the whole reason this is a fixture
 * and not a stub that always says yes.
 */
export function fixtureTransport(): Transport {
  return async (request) => {
    const missing = REQUIRED_FIELDS[request.kind].filter((field) => {
      const value = request.body[field];
      return value === null || value === undefined || value === '';
    });

    if (missing.length > 0) {
      return {
        status: 422,
        remoteId: null,
        error: `Accelevents requires ${missing.join(', ')} on a ${request.kind}`,
      };
    }

    return {
      status: 200,
      remoteId: `ae_${request.kind}_${request.externalId.slice(0, 8)}`,
      error: null,
    };
  };
}

/**
 * The live far end. Only ever constructed from a config whose mode is 'live',
 * which needs all three variables set, so there is no path from an unconfigured
 * deploy to a socket.
 */
export function httpTransport(config: AcceleventsConfig): Transport {
  if (config.mode !== 'live' || !config.baseUrl) {
    throw new Error('Refusing to build a live transport without a base URL and a key.');
  }
  const key = env().ACCELEVENTS_API_KEY!;

  return async (request) => {
    try {
      const response = await fetch(`${config.baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(request.body),
      });

      const text = await response.text();
      if (!response.ok) {
        return { status: response.status, remoteId: null, error: text.slice(0, 500) };
      }
      const parsed = text ? (JSON.parse(text) as { id?: string | number }) : {};
      return {
        status: response.status,
        remoteId: parsed.id === undefined ? null : String(parsed.id),
        error: null,
      };
    } catch (error) {
      return {
        status: 0,
        remoteId: null,
        error: error instanceof Error ? error.message : 'Request failed',
      };
    }
  };
}

export function transportFor(config: AcceleventsConfig): Transport {
  return config.mode === 'live' ? httpTransport(config) : fixtureTransport();
}

export type ExportResult = {
  runId: string;
  mode: AcceleventsMode;
  sent: number;
  failed: number;
};

/**
 * Run the push and record it.
 *
 * The row is written before the first request and updated after the last, so a
 * run that dies halfway is visible as one that started and never finished
 * rather than as nothing at all. Requests are sequential on purpose: the far
 * end is somebody else's rate limit, and a programme is tens of objects, not
 * thousands.
 */
export async function runExport(options: { actorId?: string; transport?: Transport } = {}): Promise<ExportResult> {
  const config = acceleventsConfig();
  const transport = options.transport ?? transportFor(config);

  const [run] = await db
    .insert(integrationRuns)
    .values({
      target: 'accelevents',
      mode: config.mode,
      status: 'running',
      baseUrl: config.baseUrl,
      startedById: options.actorId ?? null,
    })
    .returning({ id: integrationRuns.id });

  const runId = run!.id;

  try {
    const bundle = await exportBundle();
    const log: IntegrationRequestLog[] = [];

    for (const request of bundle.requests) {
      const response = await transport(request);
      log.push({
        method: request.method,
        path: request.path,
        body: { kind: request.kind, label: request.label, ...request.body },
        status: response.status,
        remoteId: response.remoteId,
        error: response.error,
      });
    }

    const failed = log.filter((entry) => entry.status < 200 || entry.status >= 300);

    await db
      .update(integrationRuns)
      .set({
        status: failed.length > 0 ? 'failed' : 'ok',
        finishedAt: new Date(),
        requests: log,
        trackCount: bundle.trackCount,
        speakerCount: bundle.speakerCount,
        sessionCount: bundle.sessionCount,
        error:
          failed.length > 0
            ? `${failed.length} of ${log.length} rejected: ${failed[0]!.error ?? 'no detail'}`
            : null,
      })
      .where(eq(integrationRuns.id, runId));

    return { runId, mode: config.mode, sent: log.length - failed.length, failed: failed.length };
  } catch (error) {
    await db
      .update(integrationRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : 'Export failed',
      })
      .where(eq(integrationRuns.id, runId));
    throw error;
  }
}

export async function recentRuns(limit = 10) {
  return db
    .select()
    .from(integrationRuns)
    .orderBy(desc(integrationRuns.startedAt))
    .limit(limit);
}

export async function runById(id: string) {
  const [row] = await db.select().from(integrationRuns).where(eq(integrationRuns.id, id));
  return row ?? null;
}

/** The last run that finished, whatever it said. Drives the summary line. */
export async function lastFinishedRun() {
  const [row] = await db
    .select()
    .from(integrationRuns)
    .where(isNotNull(integrationRuns.finishedAt))
    .orderBy(desc(integrationRuns.finishedAt))
    .limit(1);
  return row ?? null;
}
