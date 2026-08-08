'use client';

import { useState } from 'react';
import { cn } from '@/components/ui';

const SIZES = {
  sm: 'h-10 w-10 text-xs',
  md: 'h-16 w-16 text-base',
  lg: 'h-28 w-28 text-2xl',
} as const;

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/**
 * A headshot, or initials.
 *
 * Two different failures land in the same place. A null `headshotUrl` is the
 * common one and could be handled on the server; a URL that 404s or is hotlink
 * blocked can only be detected in the browser, which is why this is a client
 * component and not a conditional in the template. Both end as the same tile,
 * so a missing photo never collapses a row's layout.
 */
export function Headshot({
  src,
  name,
  size = 'md',
  className,
}: {
  src: string | null;
  name: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const shell = cn(
    'shrink-0 overflow-hidden rounded-full border border-line bg-slate-100',
    SIZES[size],
    className,
  );

  if (!src || broken) {
    return (
      <span
        className={cn(shell, 'flex items-center justify-center font-medium text-muted')}
        aria-hidden="true"
      >
        {initials(name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name ? `${name}'s headshot` : 'Speaker headshot'}
      className={cn(shell, 'object-cover')}
      onError={() => setBroken(true)}
    />
  );
}
