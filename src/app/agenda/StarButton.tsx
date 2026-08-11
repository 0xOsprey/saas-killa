import Link from 'next/link';
import { cn } from '@/components/ui';
import { toggleBookmark } from './actions';

const BASE =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/**
 * The star. A signed-out visitor gets a link to /login rather than a control
 * that fails when pressed, which is the difference between an invitation and a
 * dead end.
 */
export function StarButton({
  submissionId,
  starred,
  signedIn,
  count,
}: {
  submissionId: string;
  starred: boolean;
  signedIn: boolean;
  count: number;
}) {
  const label = count > 0 ? String(count) : '';

  if (!signedIn) {
    return (
      <Link
        href="/login"
        title="Sign in to build your own agenda"
        className={cn(BASE, 'text-muted hover:bg-ink/5 hover:text-ink')}
      >
        <span aria-hidden>☆</span>
        <span className="sr-only">Sign in to star this</span>
        <span className="tabular-nums">{label}</span>
      </Link>
    );
  }

  return (
    <form action={toggleBookmark}>
      <input type="hidden" name="submissionId" value={submissionId} />
      <button
        type="submit"
        title={starred ? 'Remove from my agenda' : 'Add to my agenda'}
        data-testid={`star-${submissionId}`}
        aria-pressed={starred}
        className={cn(
          BASE,
          starred ? 'text-amber-400 hover:bg-amber-500/10' : 'text-muted hover:bg-ink/5 hover:text-ink',
        )}
      >
        <span aria-hidden>{starred ? '★' : '☆'}</span>
        <span className="sr-only">{starred ? 'Remove from my agenda' : 'Add to my agenda'}</span>
        <span className="tabular-nums">{label}</span>
      </button>
    </form>
  );
}
