import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { inEventZone } from '@/lib/format';
import { pageBySlug } from '@/lib/portal-pages';
import { getEvent } from '@/lib/queries';

/**
 * One wiki page.
 *
 * An organizer sees drafts, a speaker does not, and the difference is passed to
 * `pageBySlug` rather than applied afterwards: a draft a speaker cannot read is
 * a page that does not exist, and returning it and then hiding it is how the
 * title ends up in a 403 body.
 *
 * `page.html` is the only value on this screen that reaches
 * `dangerouslySetInnerHTML`, and it is the sanitiser's output, never the
 * organizer's input. `src/lib/portal-pages.ts` is what guarantees that: the row
 * is not exported in a shape that carries the raw body.
 */
export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { slug } = await params;
  const isOrganizer = user.roles.includes('organizer');
  const [event, page] = await Promise.all([getEvent(), pageBySlug(slug, isOrganizer)]);
  if (!page) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title={page.title}
        description={`Updated ${inEventZone(page.updatedAt, event.timezone, {
          dateStyle: 'medium',
        })}`}
        action={
          <Link href="/speaker/pages" className="text-sm text-accent hover:underline">
            All speaker information
          </Link>
        }
      />

      {page.published ? null : (
        <Notice tone="accent">
          <span data-testid="portal-page-draft">
            This page is a draft. Speakers cannot see it until you publish it.
          </span>
        </Notice>
      )}

      <article
        data-testid="portal-page-body"
        className="prose-portal space-y-3 rounded-lg border border-line bg-white p-5 text-sm leading-6"
        dangerouslySetInnerHTML={{ __html: page.html }}
      />
    </div>
  );
}
