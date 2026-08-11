'use client';

import { useEffect } from 'react';
import { Button, Card, PageHeader } from '@/components/ui';

/**
 * The boundary for a page that threw. Without one, Next renders its own blank
 * "Application error: a server-side exception has occurred" and the reader is
 * left with no idea whether the conference site is down or they did something
 * wrong.
 *
 * The message is deliberately not shown. Next replaces a server error's message
 * with an opaque digest before it reaches the browser precisely so a stack trace
 * cannot leak, and the digest is what correlates this screen with the line in
 * the server log, so that is what is offered to quote.
 *
 * `reset` re-renders the segment without a full reload, which is the right
 * first try: most of what throws here is a database blip rather than a bad page.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server has already logged this; the browser has not. Without it a
    // client-side throw leaves no trace anywhere.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="That page did not load"
        description="Something failed on our side, not yours."
      />

      <Card className="space-y-4">
        <p className="text-sm text-ink" data-testid="error-boundary">
          Try again. If it keeps happening, tell an organizer and quote the reference below.
        </p>

        {error.digest ? (
          <p className="text-xs text-muted">
            Reference: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}

        <Button onClick={reset}>Try again</Button>
      </Card>
    </div>
  );
}
