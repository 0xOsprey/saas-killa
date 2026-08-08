import { Button, LinkButton } from '@/components/ui';
import { toggleBookmark } from './actions';

/**
 * The star. A signed-out visitor sees the same control, pointed at /login
 * rather than at an action that would reject them — the star is what makes an
 * account worth having, so it is never hidden.
 */
export function BookmarkButton({
  submissionId,
  bookmarked,
  signedIn,
}: {
  submissionId: string;
  bookmarked: boolean;
  signedIn: boolean;
}) {
  if (!signedIn) {
    return (
      <LinkButton
        href="/login"
        variant="ghost"
        className="px-2 py-1 text-xs"
        aria-label="Sign in to bookmark this poster"
        title="Sign in to bookmark"
      >
        ☆ Bookmark
      </LinkButton>
    );
  }

  return (
    <form action={toggleBookmark}>
      <input type="hidden" name="submissionId" value={submissionId} />
      <Button
        type="submit"
        variant={bookmarked ? 'secondary' : 'ghost'}
        className="px-2 py-1 text-xs"
        aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this poster'}
        data-testid={`bookmark-${submissionId}`}
      >
        {bookmarked ? '★ Bookmarked' : '☆ Bookmark'}
      </Button>
    </form>
  );
}
