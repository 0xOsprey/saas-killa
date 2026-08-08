/**
 * How a poster should be rendered, and who is allowed to see the hall.
 *
 * `posterUrl` points at something on someone else's server — there is no upload
 * and no blob store — so the URL itself is the only signal available. Every
 * consumer asks this module instead of sniffing an extension inline, so the
 * gallery card, the full view and the speaker's own preview cannot disagree
 * about what a given URL is.
 *
 * Pure. No database, no fetch, no clock except the one passed in.
 */

export type PosterKind = 'pdf' | 'video' | 'image' | 'unknown';

export const POSTER_KIND_LABELS: Record<PosterKind, string> = {
  pdf: 'PDF',
  video: 'Video',
  image: 'Image',
  unknown: 'Link',
};

const KIND_BY_TOKEN: Record<string, PosterKind> = {
  pdf: 'pdf',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  mp4: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  m4v: 'video',
};

const VIDEO_HOSTS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com']);

/**
 * A base is supplied so a relative or malformed-but-recoverable value still
 * parses into a pathname; the placeholder host matches nothing below, so a
 * relative URL is classified on its extension alone.
 */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url.trim(), 'https://poster.invalid');
  } catch {
    return null;
  }
}

function bareHost(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^(www|m)\./, '');
}

/**
 * The type token of the last path segment. `poster.pdf` gives `pdf`. A segment
 * with no dot is taken whole, which is what makes a hosted placeholder like
 * `placehold.co/900x1200/png` classify as an image — the seeded gallery carries
 * no file extensions at all, and treating those as unknown would turn every
 * seeded poster into a bare link.
 */
function typeToken(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return '';
  const dot = last.lastIndexOf('.');
  return (dot === -1 ? last : last.slice(dot + 1)).toLowerCase();
}

export function classifyPosterUrl(url: string | null | undefined): PosterKind {
  if (!url || !url.trim()) return 'unknown';
  const parsed = parseUrl(url);
  if (!parsed) return 'unknown';

  const host = bareHost(parsed);
  if (VIDEO_HOSTS.has(host)) return 'video';
  // arXiv serves the PDF itself from /pdf/<id>, with no extension to read.
  if (host === 'arxiv.org' && parsed.pathname.startsWith('/pdf/')) return 'pdf';

  return KIND_BY_TOKEN[typeToken(parsed.pathname)] ?? 'unknown';
}

/**
 * The embeddable form of a video URL, or null when the URL is a media file the
 * browser can play directly. A watch page is not a media file: `<video>` given
 * `youtube.com/watch?v=…` renders a black box, so the caller needs to know to
 * reach for an iframe instead.
 */
export function videoEmbedUrl(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = bareHost(parsed);
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    const id = segments[0];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }

  if (host === 'youtube.com') {
    const watchId = parsed.searchParams.get('v');
    if (watchId) return `https://www.youtube.com/embed/${watchId}`;
    const [prefix, id] = segments;
    if ((prefix === 'embed' || prefix === 'shorts') && id) {
      return `https://www.youtube.com/embed/${id}`;
    }
    return null;
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = segments[segments.length - 1];
    return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
  }

  return null;
}

/** The host, for labelling a link whose kind could not be determined. */
export function posterHost(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname === 'poster.invalid') return 'external link';
  return parsed.hostname.replace(/^www\./, '');
}

export type PosterGate =
  | { open: true }
  | { open: false; reason: 'embargo'; opensAt: Date }
  | { open: false; reason: 'unpublished' };

/**
 * Who may see the hall.
 *
 * The embargo is checked before the agenda's publish flag because it is the
 * more specific control and the one with something to say: posters are
 * routinely under a journal embargo the rest of the programme is not, so the
 * notice has to name a date rather than repeat "not published yet". Organizers
 * are never gated, which is what lets them proof the hall before it opens.
 *
 * `posterEmbargoUntil` is written by the organizer settings screen, which is
 * another agent's surface. This module only reads it.
 */
export function posterGalleryGate(
  event: { agendaPublished: boolean; posterEmbargoUntil: Date | null },
  isOrganizer: boolean,
  now: Date = new Date(),
): PosterGate {
  if (isOrganizer) return { open: true };
  if (event.posterEmbargoUntil && event.posterEmbargoUntil.getTime() > now.getTime()) {
    return { open: false, reason: 'embargo', opensAt: event.posterEmbargoUntil };
  }
  if (!event.agendaPublished) return { open: false, reason: 'unpublished' };
  return { open: true };
}
