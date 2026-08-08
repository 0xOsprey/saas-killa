import { Badge } from '@/components/ui';
import {
  POSTER_KIND_LABELS,
  classifyPosterUrl,
  posterHost,
  videoEmbedUrl,
} from '@/lib/poster';

/**
 * One poster, rendered as whatever it actually is.
 *
 * v1 put every `posterUrl` in an `<img className="object-cover">`, which turned
 * a PDF into a broken thumbnail and silently cropped anything that was not 3:4.
 * The kind decision lives in `src/lib/poster.ts`; this component only knows how
 * to draw each of the four answers.
 *
 * `card` is the gallery tile, height-capped so a tall poster cannot push the
 * grid around. `full` is the detail page, where the poster is the page.
 */
export function PosterMedia({
  url,
  title,
  variant,
}: {
  url: string;
  title: string;
  variant: 'card' | 'full';
}) {
  const kind = classifyPosterUrl(url);
  const frame = variant === 'card' ? 'h-64' : 'h-[min(80vh,900px)]';

  if (kind === 'image') {
    return (
      // Sized by width with height auto: the aspect ratio is whatever the file
      // is, and a card that is short or tall stays uncropped.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`Poster: ${title}`}
        className={
          variant === 'card'
            ? 'mx-auto max-h-64 w-auto max-w-full rounded-md border border-line bg-white'
            : 'mx-auto h-auto w-full rounded-md border border-line bg-white'
        }
      />
    );
  }

  if (kind === 'pdf') {
    return (
      <div className="space-y-2">
        <object
          data={url}
          type="application/pdf"
          aria-label={`Poster PDF: ${title}`}
          className={`w-full rounded-md border border-line bg-white ${frame}`}
        >
          {/* Shown by the browser when it will not render a PDF inline, which is
              most mobile browsers. */}
          <p className="p-4 text-sm text-muted">
            This browser will not display the PDF inline.{' '}
            <a className="underline" href={url} target="_blank" rel="noreferrer">
              Open it in a new tab
            </a>
            .
          </p>
        </object>
        <a
          className="inline-block text-xs text-muted underline hover:text-ink"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open the PDF in a new tab ↗
        </a>
      </div>
    );
  }

  if (kind === 'video') {
    const embed = videoEmbedUrl(url);
    return embed ? (
      <iframe
        src={embed}
        title={`Poster video: ${title}`}
        allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
        allowFullScreen
        className="aspect-video w-full rounded-md border border-line bg-black"
      />
    ) : (
      <video
        controls
        preload="metadata"
        src={url}
        className={`w-full rounded-md border border-line bg-black ${
          variant === 'card' ? 'max-h-64' : ''
        }`}
      >
        <a className="underline" href={url} target="_blank" rel="noreferrer">
          Open the video in a new tab
        </a>
      </video>
    );
  }

  // Unknown: a labelled link, never a thumbnail that will not load. The host is
  // shown so the reader can decide whether to follow it.
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line bg-slate-50 p-6 text-center hover:bg-slate-100 ${
        variant === 'card' ? 'h-40' : 'h-56'
      }`}
    >
      <span className="text-sm font-medium text-ink">Open poster ↗</span>
      <span className="text-xs text-muted">{posterHost(url)}</span>
    </a>
  );
}

export function PosterKindBadge({ url }: { url: string }) {
  const kind = classifyPosterUrl(url);
  return <Badge tone={kind === 'unknown' ? 'warn' : 'neutral'}>{POSTER_KIND_LABELS[kind]}</Badge>;
}
