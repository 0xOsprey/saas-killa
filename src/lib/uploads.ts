import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@/db';
import { fileExports, submissions, uploadComments, uploads, users } from '@/db/schema';
import type { FileExport, Upload, UploadKind } from '@/db/schema';
import { writableBy } from '@/lib/abstracts';
import { contentIsPublic } from '@/lib/content';
import { posterGalleryGate } from '@/lib/poster';
import { getEvent } from '@/lib/queries';
import { UPLOAD_DIR } from '@/lib/upload-dir';
import type { ExportGrouping } from '@/lib/export-grouping';
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
 *
 * A fourth rule joined them when versioning arrived: nothing here overwrites.
 * Sending a newer deck writes a new row into the same chain, and the file it
 * replaces keeps its own id, its own bytes and its own address. See
 * `seriesForSlot` for what counts as the same chain, and `uploads.seriesId` in
 * the schema for why the column is nullable.
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

/** What a file is called on a screen, as a heading rather than mid-sentence. */
export const UPLOAD_KIND_LABELS: Record<UploadKind, string> = {
  headshot: 'Headshot',
  slides: 'Slide deck',
  poster: 'Poster artwork',
  document: 'Supporting document',
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

/** The chain a row belongs to. Null `seriesId` is a chain of one. */
export function seriesOf(row: Pick<Upload, 'id' | 'seriesId'>): string {
  return row.seriesId ?? row.id;
}

/**
 * The version chain a new upload joins, or null when it starts one.
 *
 * A slot is whatever a re-upload is understood to replace, and it is not the
 * same shape for every kind:
 *
 *   slides, poster   one per submission. A talk has one deck, so uploading
 *                    again is the speaker sending a newer one.
 *   document         one per submission and filename. A talk carries any number
 *                    of handouts at once, so the file's own name is the only
 *                    thing that says which of them is being replaced.
 *   headshot         never chained. `replaceHeadshot` deletes the old bytes on
 *                    purpose, so that somebody who swaps an unflattering photo
 *                    can actually take it down; a version list would keep it
 *                    readable at its old address for good.
 *
 * The lookup takes the most recent row in the slot rather than one flagged as
 * current, so there is no "is latest" column to get out of step with the rows.
 */
async function seriesForSlot(opts: {
  kind: UploadKind;
  ownerId: string;
  submissionId: string | null;
  filename: string;
}): Promise<string | null> {
  if (opts.kind === 'headshot') return null;

  const [previous] = await db
    .select({ id: uploads.id, seriesId: uploads.seriesId })
    .from(uploads)
    .where(
      and(
        eq(uploads.kind, opts.kind),
        // An account-level file belongs to the person; everything else belongs
        // to the talk, whichever co-author sent it.
        opts.submissionId
          ? eq(uploads.submissionId, opts.submissionId)
          : and(isNull(uploads.submissionId), eq(uploads.ownerId, opts.ownerId)),
        ...(opts.kind === 'document' ? [eq(uploads.filename, opts.filename)] : []),
      ),
    )
    .orderBy(desc(uploads.createdAt))
    .limit(1);

  return previous ? seriesOf(previous) : null;
}

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
  const filename = displayName(file.name, sniffed.ext);

  // Resolved here rather than at each call site, so every route that accepts a
  // file versions it the same way. A caller that had to remember to ask for
  // versioning is a caller that eventually forgets, and the forgetting looks
  // exactly like the destructive overwrite this replaced.
  const seriesId = await seriesForSlot({
    kind: opts.kind,
    ownerId: opts.ownerId,
    submissionId: opts.submissionId ?? null,
    filename,
  });

  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, storedName), bytes);

  const [row] = await db
    .insert(uploads)
    .values({
      id,
      ownerId: opts.ownerId,
      submissionId: opts.submissionId ?? null,
      kind: opts.kind,
      filename,
      storedName,
      contentType: sniffed.mime,
      bytes: bytes.byteLength,
      seriesId,
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

// ---------------------------------------------------------------------------
// Version chains
// ---------------------------------------------------------------------------

export type FileVersion = {
  id: string;
  /** 1 for the oldest. Derived from upload order, never stored. */
  version: number;
  filename: string;
  contentType: string;
  bytes: number;
  createdAt: Date;
  href: string;
  isLatest: boolean;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
};

export type FileSeries = {
  seriesId: string;
  kind: UploadKind;
  submissionId: string | null;
  submissionTitle: string | null;
  /** The talk's speaker, or the uploader when the file belongs to no talk. */
  speakerName: string | null;
  speakerEmail: string;
  /** Newest first, which is the order both screens read them in. */
  versions: FileVersion[];
  latest: FileVersion;
  firstUploadedAt: Date;
  updatedAt: Date;
  commentCount: number;
};

/**
 * Version numbers are an ordinal over upload order, not a column.
 *
 * A stored counter has to be right at every writer and stays wrong once it is
 * not; an ordinal is recomputed from the rows every time it is read, so
 * deleting v2 of a three-version chain renumbers rather than leaving a gap
 * nobody can explain. `createdAt` ties break on id, because two uploads in the
 * same millisecond still have to come out in a fixed order.
 */
function orderVersions(rows: Upload[]): Upload[] {
  return [...rows].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

const speakers = alias(users, 'series_speaker');

/**
 * Every upload the filters admit, folded into its version chain.
 *
 * One query and a fold in memory rather than a window function: a conference's
 * whole upload table is hundreds of rows, and the grouping key is
 * `coalesce(series_id, id)`, which every consumer would otherwise have to spell
 * out identically or silently split a chain in half.
 *
 * With no filters this reads the lot, which is what the files library wants and
 * nothing else should.
 */
export async function fileSeriesList(
  opts: { submissionIds?: string[]; kinds?: UploadKind[]; seriesIds?: string[] } = {},
): Promise<FileSeries[]> {
  if (opts.submissionIds?.length === 0) return [];
  if (opts.seriesIds?.length === 0) return [];

  const rows = await db
    .select({
      upload: uploads,
      ownerName: users.name,
      ownerEmail: users.email,
      submissionTitle: submissions.title,
      speakerName: speakers.name,
      speakerEmail: speakers.email,
    })
    .from(uploads)
    .innerJoin(users, eq(users.id, uploads.ownerId))
    .leftJoin(submissions, eq(submissions.id, uploads.submissionId))
    .leftJoin(speakers, eq(speakers.id, submissions.speakerId))
    .where(
      and(
        opts.submissionIds ? inArray(uploads.submissionId, opts.submissionIds) : undefined,
        opts.kinds ? inArray(uploads.kind, opts.kinds) : undefined,
        // Two `in` clauses rather than `coalesce(series_id, id) in (…)`, which
        // is the same predicate and reads better, but cannot be written here: an
        // array interpolated into drizzle's `sql` template expands to one
        // parameter per element, so `= any($1::uuid[])` reaches Postgres with a
        // bare uuid where an array literal was promised and the whole page 500s
        // on `malformed array literal`.
        //
        // A chain id is always the head upload's own id, so a row belongs to it
        // either by carrying it in `series_id` or by being it.
        opts.seriesIds
          ? or(inArray(uploads.seriesId, opts.seriesIds), inArray(uploads.id, opts.seriesIds))
          : undefined,
      ),
    );

  type Bucket = { rows: typeof rows };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const key = seriesOf(row.upload);
    const bucket = buckets.get(key) ?? { rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }

  const counts = await commentCounts([...buckets.keys()]);

  const series: FileSeries[] = [];
  for (const [seriesId, bucket] of buckets) {
    const ordered = orderVersions(bucket.rows.map((row) => row.upload));
    const meta = new Map(bucket.rows.map((row) => [row.upload.id, row]));

    const versions = ordered.map((row, index) => {
      const extra = meta.get(row.id)!;
      return {
        id: row.id,
        version: index + 1,
        filename: row.filename,
        contentType: row.contentType,
        bytes: row.bytes,
        createdAt: row.createdAt,
        href: uploadHref(row),
        isLatest: index === ordered.length - 1,
        ownerId: row.ownerId,
        ownerName: extra.ownerName,
        ownerEmail: extra.ownerEmail,
      } satisfies FileVersion;
    });

    const latest = versions[versions.length - 1]!;
    const head = meta.get(ordered[0]!.id)!;
    series.push({
      seriesId,
      kind: head.upload.kind,
      submissionId: head.upload.submissionId,
      submissionTitle: head.submissionTitle,
      speakerName: head.speakerName ?? latest.ownerName,
      speakerEmail: head.speakerEmail ?? latest.ownerEmail,
      versions: [...versions].reverse(),
      latest,
      firstUploadedAt: versions[0]!.createdAt,
      updatedAt: latest.createdAt,
      commentCount: counts.get(seriesId) ?? 0,
    });
  }

  // Most recently touched first: the library is read to find what just arrived.
  return series.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** One chain, or null when nothing has ever been uploaded under that id. */
export async function fileSeriesById(seriesId: string): Promise<FileSeries | null> {
  const [row] = await fileSeriesList({ seriesIds: [seriesId] });
  return row ?? null;
}

/**
 * The chains on each of a set of submissions, oldest first inside each.
 *
 * `documentsFor` used to live here and returned raw rows of one kind. Both
 * screens that called it now want every kind and want them chained, and two
 * folds of the same table would eventually disagree about what a version is.
 */
export async function fileSeriesBySubmission(
  submissionIds: string[],
  kinds?: UploadKind[],
): Promise<Map<string, FileSeries[]>> {
  const byId = new Map<string, FileSeries[]>();
  const series = await fileSeriesList({ submissionIds, ...(kinds ? { kinds } : {}) });

  for (const row of series) {
    if (!row.submissionId) continue;
    const list = byId.get(row.submissionId) ?? [];
    list.push(row);
    byId.set(row.submissionId, list);
  }
  for (const list of byId.values()) {
    list.sort((a, b) => a.firstUploadedAt.getTime() - b.firstUploadedAt.getTime());
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
    // `contentIsPublic`, not a hand-written `contentStatus === 'approved'`.
    // The stricter local copy is what made `/agenda/<id>` offer a Slides button
    // that answered 404: that page publishes on 'draft' too, deliberately, so
    // the seeded back catalogue did not vanish the day moderation shipped, and
    // this branch had never been told. The upload row existing is the "field is
    // filled in" the rule asks about.
    return submission.status === 'accepted' && contentIsPublic(submission.contentStatus, row.id)
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

// ---------------------------------------------------------------------------
// The thread on a file
// ---------------------------------------------------------------------------

export type FileComment = {
  id: string;
  seriesId: string;
  body: string;
  createdAt: Date;
  authorId: string;
  authorName: string | null;
  authorEmail: string;
};

async function commentCounts(seriesIds: string[]): Promise<Map<string, number>> {
  if (seriesIds.length === 0) return new Map();
  const rows = await db
    .select({ seriesId: uploadComments.seriesId, n: sql<number>`count(*)::int` })
    .from(uploadComments)
    .where(inArray(uploadComments.seriesId, seriesIds))
    .groupBy(uploadComments.seriesId);
  return new Map(rows.map((row) => [row.seriesId, row.n]));
}

/** Every note on a set of chains, oldest first, which is how a thread reads. */
export async function commentsForSeries(seriesIds: string[]): Promise<Map<string, FileComment[]>> {
  const byId = new Map<string, FileComment[]>();
  if (seriesIds.length === 0) return byId;

  const rows = await db
    .select({
      id: uploadComments.id,
      seriesId: uploadComments.seriesId,
      body: uploadComments.body,
      createdAt: uploadComments.createdAt,
      authorId: uploadComments.authorId,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(uploadComments)
    .innerJoin(users, eq(users.id, uploadComments.authorId))
    .where(inArray(uploadComments.seriesId, seriesIds))
    .orderBy(asc(uploadComments.createdAt));

  for (const row of rows) {
    const list = byId.get(row.seriesId) ?? [];
    list.push(row);
    byId.set(row.seriesId, list);
  }
  return byId;
}

/**
 * Whether this viewer may join the thread on a file, and the chain to write to.
 *
 * Deliberately narrower than `readableUpload`. Reading an approved deck is a
 * public act, and anyone signed in can do it; the thread beside it is a
 * conversation between the speaker who owes the file and the organizers who
 * asked for it. An attendee who can open the slides has no business in it.
 *
 * The chain is resolved from a row rather than trusted from the caller, so a
 * hand-posted series id that names nothing writes nowhere.
 */
export async function commentableSeries(
  seriesId: string,
  viewer: CurrentUser | null,
): Promise<string | null> {
  if (!viewer) return null;

  const rows = await db
    .select({ ownerId: uploads.ownerId, submissionId: uploads.submissionId })
    .from(uploads)
    .where(or(eq(uploads.seriesId, seriesId), eq(uploads.id, seriesId)));
  if (rows.length === 0) return null;

  if (viewer.roles.includes('organizer')) return seriesId;
  if (rows.some((row) => row.ownerId === viewer.id)) return seriesId;

  const submissionId = rows.find((row) => row.submissionId)?.submissionId;
  if (!submissionId) return null;

  const [writable] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.id, submissionId), writableBy(viewer.id)))
    .limit(1);
  return writable ? seriesId : null;
}

export const commentField = z.string().trim().min(1).max(2000);

export async function addFileComment(opts: {
  seriesId: string;
  authorId: string;
  body: string;
}): Promise<void> {
  await db.insert(uploadComments).values({
    seriesId: opts.seriesId,
    authorId: opts.authorId,
    body: opts.body,
  });
}

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------

/**
 * A ZIP writer, in about a hundred lines, because the alternative was a
 * dependency.
 *
 * The format is old enough that the useful half of it is four fixed-layout
 * structs: a local header and the bytes for each entry, a central directory
 * repeating those headers, and an end record pointing at the directory. Nothing
 * here needs zip64 — the cap on a single upload is 25MB and an export is a
 * handful of them — so every size field is the plain 32-bit one.
 *
 * `deflateRawSync` comes from `node:zlib`, so the compression is real rather
 * than a stored-only archive pretending. Entries that deflate no smaller are
 * written with method 0 instead: a PDF and a PNG are already compressed, and
 * paying two percent to say "deflate" on the label helps nobody.
 */
export type ZipEntry = { path: string; bytes: Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time and date, which is the only clock the format has. */
function dosStamp(when: Date): { time: number; date: number } {
  const time =
    ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const date =
    (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  return { time, date };
}

export function buildZip(entries: ZipEntry[], when = new Date()): Buffer {
  const stamp = dosStamp(when);
  const body: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.from(entry.bytes);
    const deflated = deflateRawSync(raw);
    const stored = deflated.byteLength >= raw.byteLength;
    const payload = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // Bit 11 says the name is UTF-8. Without it a reader falls back to CP437
    // and a speaker called Müller gets a folder nobody can type.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const header = Buffer.alloc(46 + name.byteLength);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.byteLength, 20);
    header.writeUInt32LE(raw.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);

    body.push(local, payload);
    directory.push(header);
    offset += local.byteLength + payload.byteLength;
  }

  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...body, central, end]);
}

/** A path component a ZIP reader will not have to fight with. */
function pathSafe(value: string): string {
  const cleaned = value
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 60);
  return cleaned || 'file';
}

/**
 * Where one file goes inside the archive.
 *
 * The folder is the organizer's choice; the name is the file's own. Duplicates
 * are numbered rather than allowed to collide, because two speakers both calling
 * their deck `slides.pdf` is the normal case, and a ZIP with two entries at one
 * path unpacks to whichever the reader happened to write last.
 */
function entryPath(series: FileSeries, grouping: ExportGrouping, taken: Set<string>): string {
  const folder =
    grouping === 'session'
      ? pathSafe(series.submissionTitle ?? 'Account files')
      : grouping === 'speaker'
        ? pathSafe(series.speakerName ?? series.speakerEmail)
        : null;

  const name = pathSafe(series.latest.filename);
  const base = folder ? `${folder}/${name}` : name;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  const dot = base.lastIndexOf('.');
  const stem = dot > base.lastIndexOf('/') ? base.slice(0, dot) : base;
  const ext = dot > base.lastIndexOf('/') ? base.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Build an archive of the latest version of every chain asked for.
 *
 * The latest and only the latest: an AV team asked for the decks that are going
 * on the screens, and handing them four files called `slides.pdf` and leaving
 * them to work out which is current is how the wrong one gets projected.
 *
 * The row is written before the work starts and moved through 'generating' to
 * 'ready', so a build that dies leaves a row saying so rather than nothing at
 * all. The build itself is synchronous — a conference's files are megabytes, not
 * gigabytes — so 'ready' is usually what the organizer's next page load sees.
 * The states are still distinct, because 'failed' has to be tellable from
 * 'nobody pressed the button'.
 */
export async function runFileExport(opts: {
  requestedById: string;
  seriesIds: string[];
  grouping: ExportGrouping;
}): Promise<FileExport> {
  const [queued] = await db
    .insert(fileExports)
    .values({
      requestedById: opts.requestedById,
      grouping: opts.grouping,
      status: 'queued',
    })
    .returning();
  const job = queued!;

  async function finish(patch: Partial<typeof fileExports.$inferInsert>): Promise<FileExport> {
    const [row] = await db
      .update(fileExports)
      .set({ ...patch, finishedAt: new Date() })
      .where(eq(fileExports.id, job.id))
      .returning();
    return row!;
  }

  await db.update(fileExports).set({ status: 'generating' }).where(eq(fileExports.id, job.id));

  try {
    const series = await fileSeriesList({ seriesIds: opts.seriesIds });
    // The disk name deliberately never reaches a `FileVersion`, so the rows are
    // re-read here by id rather than carried through the view model.
    const latestIds = series.map((item) => item.latest.id);
    const rows =
      latestIds.length === 0
        ? []
        : await db.select().from(uploads).where(inArray(uploads.id, latestIds));
    const onDisk = new Map(rows.map((row) => [row.id, row]));

    const taken = new Set<string>();
    const entries: ZipEntry[] = [];
    const included: string[] = [];

    for (const item of series) {
      const row = onDisk.get(item.latest.id);
      const bytes = row ? await readUploadBytes(row) : null;
      if (!bytes) continue;
      entries.push({ path: entryPath(item, opts.grouping, taken), bytes });
      included.push(item.latest.id);
    }

    if (entries.length === 0) {
      return finish({
        status: 'failed',
        error: 'None of the selected files are still on this server.',
      });
    }

    const archive = buildZip(entries);
    const storedName = `export-${randomUUID()}.zip`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(join(UPLOAD_DIR, storedName), archive);

    return finish({
      status: 'ready',
      storedName,
      fileCount: entries.length,
      bytes: archive.byteLength,
      uploadIds: included,
    });
  } catch (error) {
    return finish({
      status: 'failed',
      error: error instanceof Error ? error.message : 'The archive could not be built.',
    });
  }
}

export async function fileExportById(id: string): Promise<FileExport | null> {
  const [row] = await db.select().from(fileExports).where(eq(fileExports.id, id)).limit(1);
  return row ?? null;
}

/** The most recent exports, newest first, for the confirmation panel. */
export async function recentFileExports(limit = 5): Promise<FileExport[]> {
  return db.select().from(fileExports).orderBy(desc(fileExports.createdAt)).limit(limit);
}

/** The archive's bytes, or null once the file has been cleared off disk. */
export async function readExportBytes(row: FileExport): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!row.storedName) return null;
  const buffer = await readFile(join(UPLOAD_DIR, row.storedName)).catch(() => null);
  if (!buffer) return null;
  return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}
