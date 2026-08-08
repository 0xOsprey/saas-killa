'use client';

import { useState } from 'react';
import { cn } from '@/components/ui';

const SIZES = {
  sm: 'h-10 w-10 text-xs',
  lg: 'h-20 w-20 text-lg',
} as const;

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const letters = source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/**
 * A headshot that always renders something. An empty URL never reaches the
 * network, and one that 404s falls back on the first error rather than leaving
 * the browser's broken-image glyph on a speaker's own page. The failed URL is
 * remembered rather than a boolean, so saving a corrected URL recovers without
 * a remount.
 *
 * A plain `img`, not `next/image`: headshots are arbitrary third-party URLs and
 * the optimiser would need every speaker's host declared in `remotePatterns`.
 */
export function Headshot({
  url,
  name,
  email,
  size = 'sm',
}: {
  url: string | null;
  name: string | null;
  email: string;
  size?: keyof typeof SIZES;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = url?.trim() ?? '';

  if (!src || failedSrc === src) {
    return (
      <span
        role="img"
        aria-label={name ? `${name}, no headshot` : 'No headshot'}
        data-testid="headshot-fallback"
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent',
          SIZES[size],
        )}
      >
        {initials(name, email)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name ? `${name}'s headshot` : 'Speaker headshot'}
      onError={() => setFailedSrc(src)}
      data-testid="headshot-image"
      className={cn('shrink-0 rounded-full border border-line object-cover', SIZES[size])}
    />
  );
}
