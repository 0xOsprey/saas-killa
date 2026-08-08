import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, Empty, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { inEventZone } from '@/lib/format';
import { excerpt, publishedPages } from '@/lib/portal-pages';
import { getEvent } from '@/lib/queries';

/**
 * The index of everything the organizers have written for speakers.
 *
 * Published only. `publishedPages` is the query that enforces that rather than
 * a filter here, so a draft cannot reach a speaker by way of a screen that
 * forgot to check.
 */
export default async function PortalPagesIndex() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const [event, pages] = await Promise.all([getEvent(), publishedPages()]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Speaker information"
        description={`Everything the ${event.name} organizers have written for speakers.`}
      />

      {pages.length === 0 ? (
        <Empty>Nothing published yet.</Empty>
      ) : (
        <div className="space-y-3" data-testid="portal-page-index">
          {pages.map((page) => (
            <Card key={page.id}>
              <Link
                href={`/speaker/pages/${page.slug}`}
                data-testid={`portal-page-link-${page.slug}`}
                className="font-medium text-accent hover:underline"
              >
                {page.title}
              </Link>
              <p className="mt-1 text-sm text-muted">{excerpt(page)}</p>
              <p className="mt-2 text-xs text-muted">
                Updated {inEventZone(page.updatedAt, event.timezone, { dateStyle: 'medium' })}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
