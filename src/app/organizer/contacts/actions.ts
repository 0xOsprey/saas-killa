'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { contactNotes, contactSegments, contactTags } from '@/db/schema';
import { requireRole } from '@/lib/auth';
import { normaliseTag } from '@/lib/contacts';

/**
 * Every action here re-checks the organizer role itself. The guard in
 * `organizer/layout.tsx` does not run when an action is invoked directly, so it
 * is defence in depth and this line is the control. Notes in particular are
 * private organizer commentary about a named person and nothing outside
 * /organizer ever renders them.
 */

function refreshContactScreens(contactId?: string): void {
  revalidatePath('/organizer/contacts');
  if (contactId) revalidatePath(`/organizer/contacts/${contactId}`);
}

const noteSchema = z.object({
  contactId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

/** File an internal note against a person. The author is the signed-in organizer, never a form field. */
export async function addContactNoteAction(formData: FormData): Promise<void> {
  const actor = await requireRole('organizer');
  const input = noteSchema.safeParse({
    contactId: formData.get('contactId'),
    body: formData.get('body'),
  });
  // An empty composer is a mis-click, not an error worth a screen of its own.
  if (!input.success) return;

  await db.insert(contactNotes).values({
    contactId: input.data.contactId,
    authorId: actor.id,
    body: input.data.body,
  });
  refreshContactScreens(input.data.contactId);
}

const deleteNoteSchema = z.object({
  noteId: z.string().uuid(),
  contactId: z.string().uuid(),
});

/**
 * Remove a note. Any organizer can remove any organizer's note rather than only
 * their own, because the thing being protected is the person the note is about:
 * a colleague who writes something unfair about a speaker should not be the
 * only account able to take it back.
 */
export async function deleteContactNoteAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = deleteNoteSchema.safeParse({
    noteId: formData.get('noteId'),
    contactId: formData.get('contactId'),
  });
  if (!input.success) return;

  await db.delete(contactNotes).where(eq(contactNotes.id, input.data.noteId));
  refreshContactScreens(input.data.contactId);
}

const tagSchema = z.object({
  contactId: z.string().uuid(),
  tag: z.string().min(1).max(400),
});

/**
 * Add one or more tags to a person.
 *
 * Commas split, because "ai, keynote" is what somebody types when they mean two
 * tags and a single tag called "ai, keynote" is a vocabulary nobody can filter
 * on afterwards. Every value goes through `normaliseTag`, so the tag stored is
 * the tag the filter looks for.
 */
export async function addContactTagAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = tagSchema.safeParse({
    contactId: formData.get('contactId'),
    tag: formData.get('tag'),
  });
  if (!input.success) return;

  const tags = [
    ...new Set(
      input.data.tag
        .split(',')
        .map((part) => normaliseTag(part))
        .filter((tag): tag is string => tag !== null),
    ),
  ];
  if (tags.length === 0) return;

  await db
    .insert(contactTags)
    .values(tags.map((tag) => ({ contactId: input.data.contactId, tag })))
    // The composite primary key already refuses a duplicate. Saying so here
    // turns re-adding a tag somebody already has into a no-op instead of a 500.
    .onConflictDoNothing();
  refreshContactScreens(input.data.contactId);
}

export async function removeContactTagAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = tagSchema.safeParse({
    contactId: formData.get('contactId'),
    tag: formData.get('tag'),
  });
  if (!input.success) return;

  const tag = normaliseTag(input.data.tag);
  if (!tag) return;

  await db
    .delete(contactTags)
    .where(and(eq(contactTags.contactId, input.data.contactId), eq(contactTags.tag, tag)));
  refreshContactScreens(input.data.contactId);
}

const segmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** The serialized filters, exactly as `contactFilterQuery` wrote them. */
  query: z.string().max(600),
});

/**
 * Save the current filters as a named segment.
 *
 * What is stored is the query string, never the ids it currently matches. A
 * segment is a question and it has to keep answering it: freezing the members
 * would turn "AI Experts" into whoever happened to carry the tag on the
 * afternoon it was saved, and the next person tagged would silently not be in
 * it. Saving over an existing name updates that segment rather than failing,
 * which is what re-pressing Save after adjusting a filter means; the unique
 * index on `lower(name)` is the backstop underneath this.
 */
export async function saveContactSegmentAction(formData: FormData): Promise<void> {
  const actor = await requireRole('organizer');
  const input = segmentSchema.safeParse({
    name: formData.get('name'),
    query: formData.get('query'),
  });
  if (!input.success) return;

  const [existing] = await db
    .select({ id: contactSegments.id })
    .from(contactSegments)
    .where(sql`lower(contact_segments.name) = ${input.data.name.toLowerCase()}`);

  if (existing) {
    await db
      .update(contactSegments)
      .set({ query: input.data.query, createdById: actor.id })
      .where(eq(contactSegments.id, existing.id));
  } else {
    await db.insert(contactSegments).values({
      name: input.data.name,
      query: input.data.query,
      createdById: actor.id,
    });
  }
  revalidatePath('/organizer/contacts');
}

export async function deleteContactSegmentAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = z.string().uuid().safeParse(formData.get('segmentId'));
  if (!input.success) return;

  await db.delete(contactSegments).where(eq(contactSegments.id, input.data));
  revalidatePath('/organizer/contacts');
}
