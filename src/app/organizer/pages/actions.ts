'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db';
import { portalPages } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { slugTaken, toSlug } from '@/lib/portal-pages';

const pageSchema = z.object({
  id: z.string().uuid().nullable(),
  title: z.string().trim().min(3, 'Give the page a title').max(120),
  slug: z.string().trim().max(60),
  summary: z.string().trim().max(300),
  body: z.string().max(60_000),
  position: z.coerce.number().int().min(0).max(999),
});

function revalidatePages(slug?: string): void {
  revalidatePath('/organizer/pages');
  revalidatePath('/speaker/pages');
  if (slug) revalidatePath(`/speaker/pages/${slug}`);
}

function refuse(reason: string, id: string | null): never {
  redirect(
    id
      ? `/organizer/pages?edit=${id}&error=${encodeURIComponent(reason)}`
      : `/organizer/pages?error=${encodeURIComponent(reason)}`,
  );
}

/**
 * Create or update a page.
 *
 * The body is stored exactly as typed. Sanitising here would make a page
 * uneditable back out of a mistake — the author would be handed the sanitiser's
 * output as their draft — and would freeze every saved page against a later
 * tightening of the allowlist. `sanitizeHtml` runs on read instead.
 */
export async function savePage(formData: FormData): Promise<void> {
  const editor = await requireRole('organizer');
  const parsed = pageSchema.safeParse({
    id: (formData.get('id') as string) || null,
    title: formData.get('title'),
    slug: formData.get('slug'),
    summary: formData.get('summary') ?? '',
    body: formData.get('body') ?? '',
    position: formData.get('position') ?? 0,
  });
  if (!parsed.success) {
    refuse(parsed.error.issues[0]?.message ?? 'Check the form and try again.', null);
  }
  const input = parsed.data;

  // An empty slug field means "name it after the title", which is what an
  // organizer writing their first page expects. A slug that reduces to nothing
  // (a title of "***") is refused rather than saved as an unreachable page.
  const slug = toSlug(input.slug || input.title);
  if (slug === '') refuse('That title has no letters or digits to make an address from.', input.id);
  if (await slugTaken(slug, input.id)) refuse(`Another page already uses /${slug}.`, input.id);

  const values = {
    slug,
    title: input.title,
    summary: input.summary === '' ? null : input.summary,
    body: input.body,
    position: input.position,
    updatedById: editor.id,
    updatedAt: new Date(),
  };

  if (input.id) {
    await db.update(portalPages).set(values).where(eq(portalPages.id, input.id));
  } else {
    await db.insert(portalPages).values(values);
  }

  revalidatePages(slug);
  redirect('/organizer/pages?saved=1');
}

export async function setPagePublished(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('id'));
  const published = formData.get('published') === 'true';

  const [row] = await db
    .update(portalPages)
    .set({ published, updatedAt: new Date() })
    .where(eq(portalPages.id, id))
    .returning({ slug: portalPages.slug });

  revalidatePages(row?.slug);
}

/**
 * Delete a page. No confirmation screen, because a page is recoverable from
 * nothing but its author's memory and the honest mitigation is that unpublish
 * is one press away and does what most deletes mean.
 */
export async function deletePage(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const id = z.string().uuid().parse(formData.get('id'));
  const [row] = await db
    .delete(portalPages)
    .where(eq(portalPages.id, id))
    .returning({ slug: portalPages.slug });
  revalidatePages(row?.slug);
  redirect('/organizer/pages');
}
