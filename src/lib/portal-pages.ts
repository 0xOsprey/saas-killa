import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { portalPages, type PortalPage } from '@/db/schema';
import { htmlToText, sanitizeHtml } from './sanitize-html';

/**
 * Reading and writing the portal wiki.
 *
 * Every read that reaches a page goes through `renderPage`, so the sanitiser is
 * on one path rather than at each call site. A page component that pulled the
 * row directly and rendered `row.body` would be rendering the organizer's raw
 * input, and that is precisely the mistake this module exists to make hard.
 */

export type RenderedPage = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  published: boolean;
  updatedAt: Date;
  /** Sanitised. The only field safe to put in `dangerouslySetInnerHTML`. */
  html: string;
};

/**
 * A slug from a title. Restricted to lowercase letters, digits and hyphens,
 * which is also what keeps it safe in a URL: no escaping question ever arises
 * because no character needing one survives.
 */
export function toSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function renderPage(row: PortalPage): RenderedPage {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    published: row.published,
    updatedAt: row.updatedAt,
    html: sanitizeHtml(row.body),
  };
}

/** Pages a speaker may read. Draft pages are not among them. */
export async function publishedPages(): Promise<RenderedPage[]> {
  const rows = await db
    .select()
    .from(portalPages)
    .where(eq(portalPages.published, true))
    .orderBy(asc(portalPages.position), asc(portalPages.title));
  return rows.map(renderPage);
}

/** Every page, draft included. Organizer screens only. */
export async function allPages(): Promise<RenderedPage[]> {
  const rows = await db
    .select()
    .from(portalPages)
    .orderBy(asc(portalPages.position), asc(portalPages.title));
  return rows.map(renderPage);
}

/**
 * One page by slug.
 *
 * `includeDrafts` is the caller's assertion that it has already checked the
 * viewer is an organizer. Defaulting it to false means a screen that forgets to
 * pass anything shows a speaker only what a speaker may see.
 */
export async function pageBySlug(
  slug: string,
  includeDrafts = false,
): Promise<RenderedPage | null> {
  const [row] = await db
    .select()
    .from(portalPages)
    .where(
      includeDrafts
        ? eq(portalPages.slug, slug)
        : and(eq(portalPages.slug, slug), eq(portalPages.published, true)),
    )
    .limit(1);
  return row ? renderPage(row) : null;
}

/** The stored row, unsanitised, for the edit form. Organizer screens only. */
export async function pageForEdit(id: string): Promise<PortalPage | null> {
  const [row] = await db.select().from(portalPages).where(eq(portalPages.id, id)).limit(1);
  return row ?? null;
}

/** True when some other page already holds this slug. */
export async function slugTaken(slug: string, exceptId: string | null): Promise<boolean> {
  const [row] = await db
    .select({ id: portalPages.id })
    .from(portalPages)
    .where(exceptId ? and(eq(portalPages.slug, slug), ne(portalPages.id, exceptId)) : eq(portalPages.slug, slug))
    .limit(1);
  return row !== undefined;
}

/** First words of the body, for an index entry the organizer left no summary on. */
export function excerpt(page: RenderedPage, limit = 140): string {
  if (page.summary) return page.summary;
  const text = htmlToText(page.html);
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}
