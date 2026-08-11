import { authorDisplayName, authorRoleLabel, authorsForDisplay, type AuthorRow } from '@/lib/abstracts';
import { Badge, cn } from './ui';

/**
 * The credited billing for a submission: every `submission_authors` row in
 * position order, affiliations attached, non-presenting co-authors marked.
 *
 * A submission with no author rows falls back to the speaker who filed it,
 * because `submission_authors` only gains rows when someone edits the list and
 * every submission predating that edit would otherwise render as anonymous.
 */
export async function AuthorList({
  submissionId,
  className,
}: {
  submissionId: string;
  className?: string;
}) {
  const authors = await authorsForDisplay(submissionId);
  if (authors.length === 0) return null;
  return <AuthorListView authors={authors} className={className} />;
}

/** The same rendering over rows already in hand, for pages that batch the query. */
export function AuthorListView({
  authors,
  className,
}: {
  authors: AuthorRow[];
  className?: string;
}) {
  return (
    <ul className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm', className)}>
      {authors.map((author) => (
        <li key={author.userId} className="text-ink">
          <span className="font-medium">{authorDisplayName(author)}</span>
          {/* The role, not just the ordering. `isPresenter` has been collected on
              the co-author form since co-authors existed and rendered nowhere,
              so a credited co-presenter and a credited co-author were the same
              line of text with a different row underneath them. */}
          <Badge
            tone={author.position === 0 ? 'accent' : 'neutral'}
            className="ml-1.5 align-middle"
            data-testid={`author-role-${author.userId}`}
          >
            {authorRoleLabel(author)}
          </Badge>
          {author.affiliation ? (
            <span className="text-muted"> · {author.affiliation}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
