import type { AgendaSearchParams } from './agenda-filters';
import { agendaSlots, parseAgendaFilters } from './agenda-filters';
import { env } from './env';
import { FORMAT_LABELS, dayKey, dayLabel, timeOfDay } from './format';
import { getEvent } from './queries';
import { speakerDirectory } from './speakers';

/**
 * The embeddable speaker gallery and schedule itinerary.
 *
 * Three surfaces over one pair of feeds, because a conference website is
 * whatever the organizer already has and each of the three is the only one some
 * of them can use:
 *
 *   /embed/speakers.json   the data, CORS-open, for a host that wants to render
 *                          it themselves
 *   /embed/embed.js        a <script> tag that renders into a div on the host
 *                          page, for a CMS that allows script but not iframes
 *   /embed/speakers        a whole document to point an <iframe> at, for a CMS
 *                          that allows neither
 *
 * The iframe route server-renders the same markup the script builds in the
 * browser, against the same class names and the same stylesheet, so the three
 * do not drift apart visually. They are two renderers rather than one because
 * the script must construct nodes (never `innerHTML`: it runs on somebody
 * else's page) while the route must emit a string.
 *
 * The embed is always anonymous. It never reads the session cookie, so a
 * signed-in organizer looking at their own widget sees exactly what a visitor
 * sees, and an unpublished agenda is closed for both.
 */

export type EmbedEvent = { name: string; timezone: string; url: string };

export type SpeakerFeedEntry = {
  id: string;
  name: string | null;
  bio: string | null;
  headshotUrl: string | null;
  url: string;
  tracks: string[];
  keywords: string[];
  talks: number;
};

export type SpeakerFeed = {
  event: EmbedEvent;
  published: boolean;
  speakers: SpeakerFeedEntry[];
};

/** One line of the itinerary. `id` is null for a named break, which links nowhere. */
export type AgendaFeedEntry = {
  id: string | null;
  title: string;
  url: string | null;
  startsAt: string;
  endsAt: string;
  time: string;
  room: string | null;
  track: string | null;
  trackColour: string | null;
  format: string | null;
  speaker: string | null;
};

export type AgendaFeedDay = { key: string; label: string; entries: AgendaFeedEntry[] };

export type AgendaFeed = {
  event: EmbedEvent;
  published: boolean;
  days: AgendaFeedDay[];
};

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The speaker gallery. Empty and flagged `published: false` before the agenda
 * goes out rather than a 404: a widget already pasted into a host page has to
 * say something honest on the morning before publication, and a broken request
 * in the host's console reads as our fault.
 */
export async function speakerFeed(params: AgendaSearchParams = {}): Promise<SpeakerFeed> {
  const event = await getEvent();
  const base = env().APP_URL;
  const meta = { name: event.name, timezone: event.timezone, url: `${base}/speakers` };

  if (!event.agendaPublished) return { event: meta, published: false, speakers: [] };

  const filters = parseAgendaFilters(params);
  const rows = await speakerDirectory({
    q: first(params.q) ?? undefined,
    trackId: filters.trackId ?? undefined,
  });

  return {
    event: meta,
    published: true,
    speakers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      bio: row.bio,
      headshotUrl: row.headshotUrl,
      url: `${base}/speakers/${row.id}`,
      tracks: row.trackNames,
      keywords: row.keywords,
      talks: row.acceptedCount,
    })),
  };
}

/**
 * The itinerary, grouped into days.
 *
 * A venue-wide break arrives as one slot per room. Left alone that renders as
 * "Lunch" three times in a row, so blocks collapse on (start, end, label) and
 * keep a room name only when they really are in one room.
 */
export async function agendaFeed(params: AgendaSearchParams = {}): Promise<AgendaFeed> {
  const event = await getEvent();
  const base = env().APP_URL;
  const meta = { name: event.name, timezone: event.timezone, url: `${base}/agenda` };

  if (!event.agendaPublished) return { event: meta, published: false, days: [] };

  // Anonymous by construction: "my agenda" is a signed-in view and there is no
  // session on a cross-origin fetch, so it would silently return nothing.
  const filters = { ...parseAgendaFilters(params), mine: false };
  const entries = await agendaSlots(filters, event.timezone, null);

  const days = new Map<string, AgendaFeedDay>();
  const blocks = new Map<string, { entry: AgendaFeedEntry; rooms: Set<string> }>();

  for (const slot of entries) {
    const key = dayKey(slot.startsAt, event.timezone);
    let day = days.get(key);
    if (!day) {
      day = { key, label: dayLabel(slot.startsAt, event.timezone), entries: [] };
      days.set(key, day);
    }

    if (slot.submissionId && slot.title) {
      day.entries.push({
        id: slot.submissionId,
        title: slot.title,
        url: `${base}/agenda/${slot.submissionId}`,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        time: timeOfDay(slot.startsAt, event.timezone),
        room: slot.roomName,
        track: slot.trackName,
        trackColour: slot.trackColour,
        format: slot.format ? FORMAT_LABELS[slot.format] : null,
        speaker: slot.speakerName,
      });
      continue;
    }

    if (!slot.label) continue;

    const blockKey = `${slot.startsAt.toISOString()}|${slot.endsAt.toISOString()}|${slot.label}`;
    const seen = blocks.get(blockKey);
    if (seen) {
      seen.rooms.add(slot.roomName);
      seen.entry.room = seen.rooms.size === 1 ? slot.roomName : null;
      continue;
    }
    const entry: AgendaFeedEntry = {
      id: null,
      title: slot.label,
      url: null,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      time: timeOfDay(slot.startsAt, event.timezone),
      room: slot.roomName,
      track: null,
      trackColour: null,
      format: null,
      speaker: null,
    };
    blocks.set(blockKey, { entry, rooms: new Set([slot.roomName]) });
    day.entries.push(entry);
  }

  return { event: meta, published: true, days: [...days.values()] };
}

/**
 * The widget stylesheet, shared by the script and the iframe document.
 *
 * Every rule is namespaced under `.sb-embed` and every property the widget
 * relies on is stated rather than inherited, because the host page's own
 * stylesheet is unknown and will otherwise reach in. It is plain CSS, not
 * Tailwind: the widget cannot ask a host page to load our build.
 */
export const EMBED_CSS = `
.sb-embed{--sb-line:#e2e8f0;--sb-ink:#0f172a;--sb-muted:#64748b;box-sizing:border-box;
 font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;
 line-height:1.45;color:var(--sb-ink);text-align:left}
.sb-embed *,.sb-embed *::before,.sb-embed *::after{box-sizing:inherit}
.sb-grid{display:grid;gap:12px;grid-template-columns:1fr;margin:0;padding:0;list-style:none}
@media (min-width:540px){.sb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:860px){.sb-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.sb-card{display:flex;gap:10px;padding:12px;background:#fff;border:1px solid var(--sb-line);
 border-radius:10px}
.sb-avatar{flex:0 0 44px;width:44px;height:44px;border-radius:999px;object-fit:cover;
 background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:14px;
 font-weight:600;color:var(--sb-muted)}
.sb-body{min-width:0;flex:1}
.sb-name{font-weight:600;color:var(--sb-ink);text-decoration:none}
.sb-name:hover{text-decoration:underline}
.sb-meta{margin:2px 0 0;font-size:12px;color:var(--sb-muted)}
.sb-bio{margin:6px 0 0;font-size:13px;color:var(--sb-muted)}
.sb-tags{margin:8px 0 0;display:flex;flex-wrap:wrap;gap:4px}
.sb-tag{padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#334155;font-size:11px}
.sb-day{margin:16px 0 6px;font-size:12px;font-weight:600;letter-spacing:.05em;
 text-transform:uppercase;color:var(--sb-muted)}
.sb-day:first-child{margin-top:0}
.sb-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--sb-line)}
.sb-item{display:flex;gap:12px;padding:10px 2px;border-bottom:1px solid var(--sb-line)}
.sb-time{flex:0 0 48px;font-size:13px;font-variant-numeric:tabular-nums;color:var(--sb-muted)}
.sb-title{font-weight:500;color:var(--sb-ink);text-decoration:none}
.sb-title:hover{text-decoration:underline}
.sb-break .sb-title{font-weight:400;font-style:italic;color:var(--sb-muted)}
.sb-dot{display:inline-block;width:8px;height:8px;border-radius:999px;margin-right:6px;
 vertical-align:baseline}
.sb-note{padding:18px;border:1px dashed var(--sb-line);border-radius:10px;text-align:center;
 font-size:14px;color:var(--sb-muted)}
.sb-credit{margin:10px 0 0;font-size:11px;color:var(--sb-muted)}
.sb-credit a{color:inherit}
`.trim();

/** HTML-escape a value bound for an attribute or a text node. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name: string | null): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '??';
}

function excerpt(text: string | null, limit = 170): string | null {
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

function credit(url: string, label: string): string {
  return `<p class="sb-credit">Powered by <a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a></p>`;
}

export function renderSpeakersHtml(feed: SpeakerFeed): string {
  if (!feed.published) {
    return `<div class="sb-embed"><p class="sb-note">The speaker line-up for ${esc(feed.event.name)} is not published yet.</p></div>`;
  }
  if (feed.speakers.length === 0) {
    return `<div class="sb-embed"><p class="sb-note">No speaker matches that filter.</p></div>`;
  }

  const cards = feed.speakers
    .map((speaker) => {
      const avatar = speaker.headshotUrl
        ? `<img class="sb-avatar" src="${esc(speaker.headshotUrl)}" alt="" loading="lazy">`
        : `<span class="sb-avatar" aria-hidden="true">${esc(initials(speaker.name))}</span>`;
      const bio = excerpt(speaker.bio);
      const tags = [...speaker.tracks, ...speaker.keywords.slice(0, 4)];
      return [
        '<li class="sb-card">',
        avatar,
        '<div class="sb-body">',
        `<a class="sb-name" href="${esc(speaker.url)}" target="_blank" rel="noopener">${esc(speaker.name ?? 'Unnamed speaker')}</a>`,
        `<p class="sb-meta">${speaker.talks} in the programme</p>`,
        bio ? `<p class="sb-bio">${esc(bio)}</p>` : '',
        tags.length > 0
          ? `<div class="sb-tags">${tags.map((tag) => `<span class="sb-tag">${esc(tag)}</span>`).join('')}</div>`
          : '',
        '</div>',
        '</li>',
      ].join('');
    })
    .join('');

  return `<div class="sb-embed"><ul class="sb-grid">${cards}</ul>${credit(feed.event.url, feed.event.name)}</div>`;
}

export function renderAgendaHtml(feed: AgendaFeed): string {
  if (!feed.published) {
    return `<div class="sb-embed"><p class="sb-note">The schedule for ${esc(feed.event.name)} is not published yet.</p></div>`;
  }
  if (feed.days.length === 0) {
    return `<div class="sb-embed"><p class="sb-note">Nothing scheduled matches that filter.</p></div>`;
  }

  const days = feed.days
    .map((day) => {
      const items = day.entries
        .map((entry) => {
          const dot = entry.trackColour
            ? `<span class="sb-dot" style="background:${esc(entry.trackColour)}"></span>`
            : '';
          const title = entry.url
            ? `<a class="sb-title" href="${esc(entry.url)}" target="_blank" rel="noopener">${esc(entry.title)}</a>`
            : `<span class="sb-title">${esc(entry.title)}</span>`;
          const meta = [entry.speaker, entry.room, entry.track, entry.format]
            .filter((part): part is string => Boolean(part))
            .join(' · ');
          return [
            `<li class="sb-item${entry.id ? '' : ' sb-break'}">`,
            `<span class="sb-time">${esc(entry.time)}</span>`,
            '<span class="sb-body">',
            dot,
            title,
            meta ? `<p class="sb-meta">${esc(meta)}</p>` : '',
            '</span>',
            '</li>',
          ].join('');
        })
        .join('');
      return `<h3 class="sb-day">${esc(day.label)}</h3><ul class="sb-list">${items}</ul>`;
    })
    .join('');

  return `<div class="sb-embed">${days}${credit(feed.event.url, feed.event.name)}</div>`;
}

/**
 * A whole document for an `<iframe>`. `height: auto` is not a thing an iframe
 * does, so the widget posts its own height to the parent and the snippet on
 * `/organizer/embed` carries the four lines that listen for it.
 */
export function embedDocument(title: string, body: string): Response {
  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>html,body{margin:0;padding:0;background:transparent}${EMBED_CSS}</style>`,
    '</head><body>',
    body,
    '<script>',
    'function post(){parent.postMessage({sessionboardHeight:document.documentElement.scrollHeight},"*")}',
    'window.addEventListener("load",post);new ResizeObserver(post).observe(document.body);',
    '</script>',
    '</body></html>',
  ].join('');

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The programme changes up to the morning of the event. A cached widget
      // that outlives a room change is worse than fetching it again.
      'cache-control': 'no-store',
    },
  });
}

/**
 * The CORS headers both feeds answer with.
 *
 * `*` rather than an allowlist because the whole point is that we do not know
 * the host page's origin, and the payload is read-only, anonymous and already
 * public. The private-network header is the one that needs a reason: Chrome
 * treats a fetch from a public website to a private or loopback address as a
 * separate permission and preflights for it, which is exactly the shape of a
 * conference site embedding a widget served from inside the venue's network.
 * Without it that deployment fails with no message the organizer can act on.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-private-network': 'true',
} as const;

/** JSON with the headers that make a feed readable from somebody else's page. */
export function feedResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS,
      'cache-control': 'no-store',
    },
  });
}

/** The preflight answer. Shared by both feeds; neither takes a body or a header. */
export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}
