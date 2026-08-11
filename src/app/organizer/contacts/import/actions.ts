'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import {
  applyImport,
  mergeContacts,
  previewImport,
  MAX_CSV_BYTES,
  type ImportPreview,
  type ImportResult,
} from '@/lib/contact-import';

const IMPORT = '/organizer/contacts/import';

/**
 * What the import screen is holding.
 *
 * `csv` is the file's text, carried back to the browser after the preview and
 * posted again to write. A file input cannot be refilled from the server, so
 * the alternative is asking for the file twice or parking it on the disk
 * between two requests. The text is what was read, so the write is guaranteed
 * to be of the thing that was previewed rather than of whatever is in that path
 * now.
 */
export type ImportState = {
  error?: string;
  fileName?: string;
  csv?: string;
  preview?: ImportPreview;
  result?: ImportResult;
};

function touchContactScreens(): void {
  revalidatePath('/organizer/contacts');
  revalidatePath('/organizer/contacts/pipeline');
  revalidatePath(IMPORT);
}

export async function importContactsAction(
  _previous: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const actor = await requireRole('organizer');
  const intent = formData.get('intent');

  if (intent === 'write') {
    const csv = formData.get('csv');
    if (typeof csv !== 'string' || csv.trim() === '') {
      return { error: 'Nothing to import. Choose a file and preview it first.' };
    }
    const result = await applyImport(csv, actor.id);
    touchContactScreens();
    return { result, fileName: String(formData.get('fileName') ?? '') };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a CSV file first.' };
  }
  if (file.size > MAX_CSV_BYTES) {
    return {
      error: `That file is ${Math.round(file.size / 1024)}KB. The limit is ${MAX_CSV_BYTES / 1024}KB, which is more contacts than a conference has.`,
    };
  }

  const csv = await file.text();
  const preview = await previewImport(csv);
  return { csv, fileName: file.name, preview };
}

/**
 * Fold one contact into another.
 *
 * Two presses, the shape `deletePage` uses: the first lands on a comparison of
 * the two records and what will move, the second carries `confirm=yes`. Checked
 * here and not only on the page, because the button on the page is not the only
 * thing that can post to this.
 *
 * `returnTo` is where the organizer pressed the button. The duplicate panel is
 * on the board as well as on this screen, and sending somebody who merged from
 * the board to the import screen loses their place for no reason.
 */
export async function mergeContactsAction(formData: FormData): Promise<void> {
  await requireRole('organizer');

  const parsed = z
    .object({
      keep: z.string().uuid(),
      drop: z.string().uuid(),
      returnTo: z.enum(['/organizer/contacts/import', '/organizer/contacts/pipeline']),
    })
    .safeParse({
      keep: formData.get('keep'),
      drop: formData.get('drop'),
      returnTo: formData.get('returnTo') ?? IMPORT,
    });
  if (!parsed.success) redirect(`${IMPORT}?error=${encodeURIComponent('That merge made no sense.')}`);

  const { keep, drop, returnTo } = parsed.data;

  if (formData.get('confirm') !== 'yes') {
    redirect(`${returnTo}?merge=${keep}&drop=${drop}`);
  }

  const result = await mergeContacts(keep, drop);
  touchContactScreens();

  if (!result.ok) {
    redirect(`${returnTo}?error=${encodeURIComponent(result.blockers.join(' '))}`);
  }
  redirect(
    `${returnTo}?merged=${encodeURIComponent(`Merged into ${result.kept}. ${result.moved} linked record(s) moved across.`)}`,
  );
}
