'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-fetch the server component on an interval.
 *
 * `router.refresh()` rather than a websocket or a polling fetch: the page is
 * already a server component reading aggregates, so asking Next to render it
 * again is the whole update, and there is no second copy of the query living in
 * the browser to drift from the first.
 *
 * Paused while the tab is hidden. An organizer leaves this screen open all
 * afternoon, and a background tab hitting the database every fifteen seconds
 * for numbers nobody is looking at is the version of "real-time" that shows up
 * as load. The visibility handler also refreshes on return, so coming back to
 * the tab shows current figures rather than the last ones before it slept.
 */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;

    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = setInterval(tick, seconds * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [live, router, seconds]);

  return (
    <button
      type="button"
      onClick={() => {
        // Off pauses; on refreshes immediately, because a person turning it
        // back on is asking for now, not for fifteen seconds from now.
        if (!live) router.refresh();
        setLive(!live);
      }}
      data-testid="auto-refresh-toggle"
      aria-pressed={live}
      className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-300'}`}
      />
      {live ? `Live, every ${seconds}s` : 'Paused'}
    </button>
  );
}
