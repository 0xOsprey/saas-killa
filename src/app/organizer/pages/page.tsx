import Link from 'next/link';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Textarea } from '@/components/ui';
import { uuidOrNull } from '@/lib/ids';
import { allPages, pageForEdit } from '@/lib/portal-pages';
import { deletePage, savePage, setPagePublished } from './actions';

/**
 * The organizer's side of the speaker wiki: a list on the left of the screen
 * and one editor below it.
 *
 * The editor is the same form for a new page and an existing one, distinguished
 * by a hidden `id`. Two forms would be two places to add a field to, and the
 * only real difference is which values are prefilled.
 */
export default async function OrganizerPagesScreen({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string; saved?: string; confirmDelete?: string }>;
}) {
  const params = await searchParams;
  const pages = await allPages();
  // An `?edit=` naming a page that was since deleted, or a hand-edited one, has
  // to fall back to the blank "new page" form rather than 22P02 the screen —
  // which is what `pageForEdit` returning null already means here.
  const editId = uuidOrNull(params.edit);
  const editing = editId ? await pageForEdit(editId) : null;
  const toDelete = pages.find((page) => page.id === params.confirmDelete);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Speaker information"
        description={`${pages.length} page(s), ${pages.filter((page) => page.published).length} published. Speakers read these at /speaker/pages.`}
        action={
          editing ? (
            <Link href="/organizer/pages" className="text-sm text-accent hover:underline">
              New page
            </Link>
          ) : null
        }
      />

      {params.error ? (
        <Notice tone="bad">
          <span data-testid="page-error">{params.error}</span>
        </Notice>
      ) : null}
      {params.saved ? (
        <Notice tone="good">
          <span data-testid="page-saved">Saved.</span>
        </Notice>
      ) : null}

      {toDelete ? (
        <Notice tone="bad">
          {/* The testid goes on a child. `Notice` takes `tone` and `children`
              and nothing else, and a hyphenated JSX attribute on a component is
              the one kind TypeScript does not check. */}
          <div className="space-y-2" data-testid="confirm-delete-page">
            <p>
              Deleting “{toDelete.title}” removes its text for good. Nobody wrote it down anywhere
              else.{' '}
              {toDelete.published
                ? 'It is published, so speakers can see it now. Unpublishing hides it and keeps it.'
                : 'It is already a draft, so no speaker can see it.'}
            </p>
            <div className="flex items-center gap-3">
              <form action={deletePage}>
                <input type="hidden" name="id" value={toDelete.id} />
                <input type="hidden" name="confirm" value="yes" />
                <Button type="submit" variant="danger" data-testid="confirm-delete-page-submit">
                  Delete “{toDelete.title}”
                </Button>
              </form>
              <Link href="/organizer/pages" className="text-sm text-accent hover:underline">
                Keep it
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      {pages.length === 0 ? (
        <Empty>
          No pages yet.{' '}
          <Link href="#new-page" className="text-accent hover:underline">
            Write the first one
          </Link>
          .
        </Empty>
      ) : (
        <div className="space-y-2" data-testid="organizer-page-list">
          {pages.map((page) => (
            <Card key={page.id} className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Link
                  href={`/organizer/pages?edit=${page.id}`}
                  data-testid={`page-edit-${page.slug}`}
                  className="font-medium text-accent hover:underline"
                >
                  {page.title}
                </Link>
                <p className="text-xs text-muted">
                  /speaker/pages/{page.slug} · position {' '}
                  {pages.indexOf(page) + 1}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={page.published ? 'good' : 'neutral'}>
                  {page.published ? 'Published' : 'Draft'}
                </Badge>
                <form action={setPagePublished}>
                  <input type="hidden" name="id" value={page.id} />
                  <input type="hidden" name="published" value={page.published ? 'false' : 'true'} />
                  <Button
                    type="submit"
                    variant="secondary"
                    data-testid={`page-publish-${page.slug}`}
                  >
                    {page.published ? 'Unpublish' : 'Publish'}
                  </Button>
                </form>
                <form action={deletePage}>
                  <input type="hidden" name="id" value={page.id} />
                  <Button type="submit" variant="secondary" data-testid={`page-delete-${page.slug}`}>
                    Delete
                  </Button>
                </form>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card id="new-page">
        <h2 className="mb-3 font-medium">{editing ? `Editing “${editing.title}”` : 'New page'}</h2>
        <form action={savePage} className="space-y-3" data-testid="page-form">
          {editing ? <input type="hidden" name="id" value={editing.id} /> : null}

          <Field label="Title">
            <Input name="title" defaultValue={editing?.title ?? ''} data-testid="page-title" required />
          </Field>

          <Field label="Address" hint="Left blank, it is made from the title.">
            <Input
              name="slug"
              defaultValue={editing?.slug ?? ''}
              data-testid="page-slug"
              placeholder="venue-and-av"
            />
          </Field>

          <Field label="Summary" hint="One line under the title in the index. Optional.">
            <Input name="summary" defaultValue={editing?.summary ?? ''} data-testid="page-summary" />
          </Field>

          <Field
            label="Body"
            hint="HTML. Headings, lists, tables, links, images and embeds from YouTube, Vimeo, Google, Spotify, SoundCloud, CodePen and CodeSandbox. Script, styles, event handlers and any other embed are removed when the page renders."
          >
            <Textarea
              name="body"
              rows={16}
              defaultValue={editing?.body ?? ''}
              data-testid="page-body"
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Position" hint="Lower sorts first in the index.">
            <Input
              name="position"
              type="number"
              min={0}
              max={999}
              defaultValue={editing?.position ?? 0}
              data-testid="page-position"
            />
          </Field>

          <Button type="submit" data-testid="page-save">
            {editing ? 'Save page' : 'Create page'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
