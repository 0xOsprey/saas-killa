import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { submissions, uploads, users } from '@/db/schema';
import type { Upload, UploadKind } from '@/db/schema';
import { writableBy } from '@/lib/abstracts';
import { posterGalleryGate } from '@/lib/poster';
import { getEvent } from '@/lib/queries';
import { UPLOAD_DIR } from '@/lib/upload-dir';
import type { CurrentUser } from '@/lib/auth';

/**
 * Files on this server's disk.
 *
 * The whole feature is one directory and one route handler. No S3, no signed
 * URLs, no CDN: this app runs on one machine, and a blob store would add an
 * outage mode and a credential for a conference's worth of headshots and PDFs.
 *
 * Three rules hold the security here, and each one exists because the obvious
 * implementation gets it wrong:
 *
 *   1. The type is sniffed from the file's own first bytes, and the declared
 *      `Content-Type` is never trusted. A browser will happily label anything
 *      `image/png`; serving an attacker's HTML back from our own origin under
 *      that label is stored XSS with a session cookie attached.
 *   2. The name on disk is `<uuid><ext>` with the extension taken from the
 *      sniffed type. No byte of the user's filename reaches the filesystem, so
 *      `../../.env` is not a path, it is just a caption.
 *   3. Reads go through `readableUpload`, which answers per kind. A supporting
 *      document is private even though it lives next to a public headshot, and
 *      a missing file and a forbidden one both answer 404 — a 403 would confirm
 *      to an anonymous prober that a given id exists.
 *
 * SVG is not an accepted image type anywhere here. It is the one raster-looking
 * format that carries script, and an `<img>` tag is not a sandbox.
 */

export { UPLOAD_DIR };

const MB = 1024 * 1024;

type SniffedType = {
  mime: string;
  ext: string;
  /** True when `head` starts with this format's signature. */
  matches: (head: Uint8Array) => boolean;
};

function startsWith(head: Uint8Array, signature: number[], offset = 0): boolean {
  if (head.length < offset + signature.length) return false;
  return signature.every((byte, i) => head[offset + i] === byte);
}

function ascii(head: Uint8Array, offset: number, length: number): string {
  if (head.length < offset + length) return '';
  return String.fromCharCode(...head.subarray(offset, offset + length));
}

/**
 * Magic-byte signatures, checked in order. Deliberately short: this list is the
 * set of formats a conference actually receives, and every format not on it is
 * refused with its name rather than stored and hoped over.
 */
const SNIFFED_TYPES: SniffedType[] = [
  {
    mime: 'image/png',
    ext: '.png',
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: 'image/jpeg', ext: '.jpg', matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  {
    mime: 'image/gif',
    ext: '.gif',
    matches: (h) => ascii(h, 0, 6) === 'GIF87a' || ascii(h, 0, 6) === 'GIF89a',
  },
  {
    // RIFF container with a WEBP fourcc at byte 8. The four bytes between are
    // the file length, which is not a constant, so this cannot be one prefix.
    mime: 'image/webp',
    ext: '.webp',
    matches: (h) => ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WEBP',
  },
  { mime: 'application/pdf', ext: '.pdf', matches: (h) => ascii(h, 0, 5) === '%PDF-' },
];

const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PDF = ['application/pdf'];

type KindConfig = {
  /** Used in refusal messages, so it reads as a noun in a sentence. */
  noun: string;
  maxBytes: number;
  accepts: string[];
};

export const UPLOAD_KINDS: Record<UploadKind, KindConfig> = {
  headshot: { noun: 'headshot', maxBytes: 5 * MB, accepts: IMAGES },
  slides: { noun: 'slide deck', maxBytes: 25 * MB, accepts: [...PDF, ...IMAGES] },
  poster: { noun: 'poster', maxBytes: 25 * MB, accepts: [...PDF, ...IMAGES] },
  document: { noun: 'document', maxBytes: 15 * MB, accepts: [...PDF, ...IMAGES] },
};

/** The `accept` attribute for a file input of this kind. */
export function acceptAttribute(kind: UploadKind): string {
  return UPLOAD_KINDS[kind].accepts.join(',');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** "a PDF", "an image" — one file's type, for the middle of a sentence. */
function describeType(mime: string): string {
  return mime === 'application/pdf' ? 'a PDF' : 'an image';
}

/** "an image", "a PDF or an image" — what a kind will take. */
function acceptedTypes(mimes: string[]): string {
  const seen = new Set(mimes.map(describeType));
  return [...seen].join(' or ');
}

/**
 * The original filename, made safe to print and to put in a header. Directory
 * separators go first — a browser on Windows sends `C:\fakepath\me.png` — then
 * anything outside a conservative set, because this string ends up inside
 * quotes in `content-disposition` and a stray `"` there splits the header.
 *
 * The extension is replaced with the sniffed one rather than kept: a PDF named
 * `.png` should download as a PDF.
 */
export function displayName(raw: string | undefined, ext: string): string {
  const base = (raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 80);
  return `${base || 'file'}${ext}`;
}

/**
 * A link column that may hold either an uploaded file or somebody else's URL.
 *
 * `headshotUrl`, `slidesUrl` and `posterUrl` predate uploads and are still
 * offered as text fields, so both shapes are legal in the same column. An
 * uploaded file is stored as its own app-relative path; without this, saving a
 * profile after uploading a headshot would fail validation on the value the
 * upload itself had just written.
 */
export const linkField = z
  .string()
  .trim()
  .transform((value) => value || null)
  .refine((value) => value === null || /^(https?:\/\/|\/files\/)/i.test(value), {
    message: 'Paste a full URL starting http:// or https://, or upload a file.',
  });

export type SaveResult =
  | { ok: true; upload: Upload }
  | { ok: false; reason: string };

/**
 * Take one file off a form and put it on disk.
 *
 * Refusals are strings a speaker can act on, not booleans: someone who picked
 * the wrong file needs to know which rule they hit, and "upload failed" sends
 * them round the same loop with the same file.
 */
export async function saveUpload(opts: {
  file: FormDataEntryValue | null;
  kind: UploadKind;
  ownerId: string;
  submissionId?: string | null;
}): Promise<SaveResult> {
  const config = UPLOAD_KINDS[opts.kind];
  const file = opts.file;

  // An empty file input still posts, as a zero-byte File with an empty name.
  // That is "the speaker did not pick one", not an error worth a message.
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: `Choose a ${config.noun} file first.` };
  }
  if (file.size > config.maxBytes) {
    return {
      ok: false,
      reason: `That ${config.noun} is ${formatBytes(file.size)}. The limit is ${formatBytes(
        config.maxBytes,
      )}.`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = SNIFFED_TYPES.find((type) => type.matches(bytes.subarray(0, 16)));
  if (!sniffed) {
    return {
      ok: false,
      reason: `That file is not ${acceptedTypes(config.accepts)}, whatever it is named. A ${config.noun} has to be ${acceptedTypes(config.accepts)}.`,
    };
  }
  if (!config.accepts.includes(sniffed.mime)) {
    return {
      ok: false,
      reason: `A ${config.noun} has to be ${acceptedTypes(config.accepts)}. That file is ${describeType(sniffed.mime)}.`,
    };
  }

  const id = randomUUID();
  const storedName = `${id}${sniffed.ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, storedName), bytes);

  const [row] = await db
    .insert(uploads)
    .values({
      id,
      ownerId: opts.ownerId,
      submissionId: opts.submissionId ?? null,
      kind: opts.kind,
      filename: displayName(file.name, sniffed.ext),
      storedName,
      contentType: sniffed.mime,
      bytes: bytes.byteLength,
    })
    .returning();

  return { ok: true, upload: row! };
}

/**
 * Where an upload is served from. The trailing name is decorative — the id
 * alone identifies the row — but it carries the extension, which is what lets
 * `classifyPosterUrl` tell a PDF poster from an image one, and what a browser
 * uses to name the file on "save as".
 */
export function uploadHref(row: Pick<Upload, 'id' | 'filename'>): string {
  return `/files/${row.id}/${encodeURIComponent(row.filename)}`;
}

/** Every supporting document on a set of submissions, oldest first. */
export async function documentsFor(submissionIds: string[]): Promise<Map<string, Upload[]>> {
  const byId = new Map<string, Upload[]>();
  if (submissionIds.length === 0) return byId;

  const rows = await db
    .select()
    .from(uploads)
    .where(and(inArray(uploads.submissionId, submissionIds), eq(uploads.kind, 'document')))
    .orderBy(asc(uploads.createdAt));

  for (const row of rows) {
    const list = byId.get(row.submissionId!) ?? [];
    list.push(row);
    byId.set(row.submissionId!, list);
  }
  return byId;
}

/**
 * Drop a file the caller owns.
 *
 * The row goes first and the bytes second. If the unlink fails the file is
 * orphaned on disk, which is a wasted megabyte; if the order were reversed a
 * failed delete would leave a row pointing at nothing, which is a 404 on a link
 * the speaker can still see.
 */
export async function deleteUpload(id: string, ownerId: string): Promise<boolean> {
  const [row] = await db
    .delete(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.ownerId, ownerId)))
    .returning();
  if (!row) return false;

  await unlink(join(UPLOAD_DIR, row.storedName)).catch(() => {});
  return true;
}

/** The bytes, or null when the row outlived the file. */
export async function readUploadBytes(row: Upload): Promise<Uint8Array<ArrayBuffer> | null> {
  // Read rather than stream: the cap is 25MB and these are served to one
  // organizer at a time, so the streaming machinery would buy nothing.
  const buffer = await readFile(join(UPLOAD_DIR, row.storedName)).catch(() => null);
  if (!buffer) return null;

  // A Buffer's backing store is typed `ArrayBufferLike` so the SharedArrayBuffer
  // case stays expressible; `readFile` never produces one. Re-viewing the exact
  // extent of this read is what `Response` will accept, and it copies nothing.
  return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * The upload this viewer may read, or null.
 *
 * One function for every kind, because the alternative is an access rule per
 * call site and no way to see them side by side:
 *
 *   headshot   public. It is already on the public speaker gallery.
 *   slides     public once the organizers approved the content, matching
 *              `contentIsPublic`, which is what the agenda page gates on.
 *   poster     public once the submission is accepted and the poster hall is
 *              open, matching `posterGalleryGate`.
 *   document   never public. Supporting material is what a speaker sends the
 *              organizers, and it routinely carries a draft, a dataset or a
 *              phone number nobody agreed to publish.
 *
 * The owner and any organizer read anything. A co-author with write access
 * reads their submission's documents, because they can already edit the talk.
 */
export async function readableUpload(id: string, viewer: CurrentUser | null): Promise<Upload | null> {
  const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
  if (!row) return null;

  if (viewer?.roles.includes('organizer')) return row;
  if (viewer && row.ownerId === viewer.id) return row;
  if (row.kind === 'headshot') return row;

  if (!row.submissionId) return null;

  const [submission] = await db
    .select({
      status: submissions.status,
      contentStatus: submissions.contentStatus,
    })
    .from(submissions)
    .where(eq(submissions.id, row.submissionId))
    .limit(1);
  if (!submission) return null;

  if (row.kind === 'slides') {
    return submission.status === 'accepted' && submission.contentStatus === 'approved'
      ? row
      : null;
  }

  if (row.kind === 'poster') {
    if (submission.status !== 'accepted') return null;
    const event = await getEvent();
    return posterGalleryGate(event, false).open ? row : null;
  }

  // A document, for someone who is neither the owner nor an organizer. The only
  // remaining door is co-authorship with write access.
  if (!viewer) return null;
  const [writable] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.id, row.submissionId), writableBy(viewer.id)))
    .limit(1);
  return writable ? row : null;
}

/** The headshot file this person uploaded, if they uploaded one. */
export async function headshotUpload(ownerId: string): Promise<Upload | null> {
  const [row] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.ownerId, ownerId), eq(uploads.kind, 'headshot')))
    .orderBy(asc(uploads.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Point a speaker's profile at an uploaded headshot. Their old one is dropped
 * in the same breath: a headshot is replaced, never collected, and leaving the
 * previous file readable at its old URL would mean a speaker who swapped an
 * unflattering photo could not actually take it down. The one gap is the
 * minute of browser cache `/files/<id>` allows on a headshot; the bytes are
 * gone from this server immediately.
 */
export async function replaceHeadshot(ownerId: string, next: Upload): Promise<void> {
  const stale = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.ownerId, ownerId), eq(uploads.kind, 'headshot')));

  await db.update(users).set({ headshotUrl: uploadHref(next) }).where(eq(users.id, ownerId));

  for (const row of stale) {
    if (row.id !== next.id) await deleteUpload(row.id, ownerId);
  }
}
