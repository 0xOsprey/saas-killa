import { z } from 'zod';

/**
 * How a bulk download lays its files out.
 *
 * Its own module for the same reason as `upload-dir.ts`: two very different
 * programs need the same three values. The export dialog is a client component,
 * and `src/lib/uploads.ts` reaches `node:fs`, `node:zlib` and the database, so
 * importing the list from there would pull all of it into the browser bundle and
 * fail the build. Naming the three groupings twice would mean a fourth one added
 * to the dialog that the archive builder has never heard of.
 */

export const EXPORT_GROUPINGS = [
  { value: 'session', label: 'One folder per session' },
  { value: 'speaker', label: 'One folder per speaker' },
  { value: 'flat', label: 'No folders, everything at the top' },
] as const;

export type ExportGrouping = (typeof EXPORT_GROUPINGS)[number]['value'];

export const groupingField = z.enum(['session', 'speaker', 'flat']);
