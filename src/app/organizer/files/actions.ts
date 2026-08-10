'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { groupingField } from '@/lib/export-grouping';
import { runFileExport } from '@/lib/uploads';

/**
 * Building an archive of speaker files.
 *
 * The selection arrives as chain ids rather than upload ids, because what an
 * organizer picked was a file, not a particular copy of it, and the archive is
 * always the latest version of each. Sending upload ids would freeze the export
 * to whatever the screen happened to be showing when it rendered.
 */

const exportSchema = z.object({
  seriesIds: z.array(z.string().uuid()).min(1).max(500),
  grouping: groupingField,
});

export async function generateFileExport(formData: FormData): Promise<void> {
  const organizer = await requireRole('organizer');
  const input = exportSchema.parse({
    seriesIds: formData.getAll('seriesIds').map(String),
    grouping: formData.get('grouping'),
  });

  const job = await runFileExport({
    requestedById: organizer.id,
    seriesIds: input.seriesIds,
    grouping: input.grouping,
  });

  revalidatePath('/organizer/files');
  // The job id in the address, so the confirmation survives a reload and can be
  // linked to. An export is the sort of thing somebody sends a colleague.
  redirect(`/organizer/files?export=${job.id}`);
}
