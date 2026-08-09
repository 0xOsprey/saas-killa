'use client';

/**
 * The last boundary. `error.tsx` sits inside the root layout, so it cannot
 * catch the root layout itself throwing; this replaces the whole document when
 * that happens, which is why it renders its own <html> and <body>.
 *
 * No imports from @/components and no Tailwind classes on purpose. If the
 * layout failed, the component tree or the stylesheet is a candidate for why,
 * and a fallback that depends on the thing that broke is not a fallback.
 * Inline styles always render.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '3rem 1.5rem' }}>
        <div style={{ margin: '0 auto', maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Saas Killa is down</h1>
          <p style={{ color: '#475569', lineHeight: 1.6 }} data-testid="global-error">
            The site failed to start rendering, so this is all there is. Try again shortly, and
            tell an organizer if it persists.
          </p>
          {error.digest ? (
            <p style={{ color: '#64748b', fontSize: '0.8rem' }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 0.9rem',
              border: '1px solid #cbd5e1',
              borderRadius: '0.375rem',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
