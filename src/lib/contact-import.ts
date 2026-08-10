import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  contactNotes,
  contactTags,
  pipelineCards,
  reviews,
  speakerTasks,
  submissions,
  userRoles,
  users,
} from '@/db/schema';

/**
 * Bulk contact import, and the duplicate cleanup that always follows it.
 *
 * The two belong in one module because they are one job. An import is the thing
 * that mints a second row for a person who is already here — a colleague spells
 * the address differently, or somebody moves employer and the new address comes
 * in on a list — so the screen that writes the rows is the screen that has to
 * offer to put them back together.
 */

/** No dependency for this. See the parser below. */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** A CSV bigger than this is a mistake, not a contact list. */
export const MAX_CSV_BYTES = 512 * 1024;

/**
 * Split CSV text into rows of fields, RFC 4180 style.
 *
 * Written here rather than pulled in, because the whole of what this app needs
 * from a CSV library is the quoting rule: a bio with a comma in it is one
 * field, and a quote inside a quoted field is doubled. Both are below, and
 * neither is worth a supply-chain entry.
 *
 * A newline inside quotes is part of the field, which is why this is a
 * character loop and not a `split('\n')`. Rows that are entirely blank are
 * dropped: a trailing newline is not a contact.
 */
export function parseCsv(text: string): string[][] {
  // A file saved by Excel starts with a byte order mark, and left in place it
  // becomes part of the first header cell, so "email" stops being recognised.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let open = false;

  const endField = () => {
    row.push(field);
    field = '';
    open = true;
  };
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    open = false;
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (body.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      open = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      field += ch;
      open = true;
    }
  }
  if (open || field !== '' || row.length > 0) endRow();

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export type ImportField = 'email' | 'name' | 'title' | 'company' | 'bio' | 'tags';

/**
 * The header spellings each field answers to.
 *
 * Compared with punctuation and case stripped, so "Job Title", "job_title" and
 * "JOBTITLE" are one column. `title` means the job title throughout this app,
 * never a talk title, which is why "role" sits beside it and nothing here maps
 * a column called "talk".
 */
const HEADER_SPELLINGS: Record<ImportField, string[]> = {
  email: ['email', 'emailaddress', 'mail', 'contactemail'],
  name: ['name', 'fullname', 'contactname', 'speakername'],
  title: ['title', 'jobtitle', 'jobrole', 'role', 'position'],
  company: ['company', 'organisation', 'organization', 'employer', 'affiliation'],
  bio: ['bio', 'biography', 'about'],
  tags: ['tags', 'tag', 'labels'],
};

const FIELD_LABELS: Record<ImportField, string> = {
  email: 'Email',
  name: 'Name',
  title: 'Job title',
  company: 'Company',
  bio: 'Bio',
  tags: 'Tags',
};

function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

type ColumnMap = { columns: Partial<Record<ImportField, number>>; unmapped: string[] };

function mapHeader(cells: string[]): ColumnMap {
  const columns: Partial<Record<ImportField, number>> = {};
  const unmapped: string[] = [];

  cells.forEach((cell, index) => {
    const key = headerKey(cell);
    const field = (Object.keys(HEADER_SPELLINGS) as ImportField[]).find(
      (candidate) => HEADER_SPELLINGS[candidate].includes(key),
    );
    // First column wins. A file with two columns called "name" is answered by
    // reading the first rather than by silently taking the last one.
    if (field && columns[field] === undefined) columns[field] = index;
    else if (cell.trim() !== '') unmapped.push(cell.trim());
  });

  return { columns, unmapped };
}

export type RowOutcome = 'create' | 'match' | 'reject';

export type PreviewRow = {
  line: number;
  name: string | null;
  email: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  tags: string[];
  outcome: RowOutcome;
  /** Why it was rejected, or who it matched. Always something to read. */
  note: string;
  matchId: string | null;
};

export type ImportPreview = {
  /** Set when the file as a whole cannot be read. Nothing is written. */
  problem: string | null;
  recognised: string[];
  unmapped: string[];
  rows: PreviewRow[];
  counts: { create: number; match: number; reject: number };
};

/**
 * Find the contacts these addresses already belong to.
 *
 * `lower()` on both sides, not a plain equality. Every write path in this app
 * normalises through `normaliseEmail` and `users_email_lower_idx` is what keeps
 * one row per address, so the stored value is lowercase in practice. But the
 * whole job of this query is deciding whether somebody is already here, and
 * getting that wrong mints the duplicate the merge below then has to clean up.
 * A row written in mixed case by any path that ever forgot has to match.
 *
 * `inArray` over the expression, not `= any(...)`. Drizzle expands a JavaScript
 * array in a template into one placeholder per element, so `any(${list})` casts
 * a record rather than an array and Postgres refuses it outright.
 */
async function findByEmails(
  addresses: string[],
): Promise<Map<string, { id: string; name: string | null; email: string }>> {
  const found = new Map<string, { id: string; name: string | null; email: string }>();
  if (addresses.length === 0) return found;

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, addresses));

  for (const row of rows) found.set(row.email.toLowerCase(), row);
  return found;
}

function cellAt(cells: string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (cells[index] ?? '').trim();
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

/**
 * Read the file and say what would happen, without writing anything.
 *
 * The preview and the write share this function so the summary an organizer
 * approves is the summary they get. The one thing that can still move between
 * the two is the database itself, which is why the write re-runs this rather
 * than trusting the row list the browser posts back.
 */
export async function previewImport(text: string): Promise<ImportPreview> {
  const empty = { recognised: [], unmapped: [], rows: [], counts: { create: 0, match: 0, reject: 0 } };

  const grid = parseCsv(text);
  const header = grid[0];
  if (!header) return { problem: 'That file has no rows in it.', ...empty };

  const { columns, unmapped } = mapHeader(header);
  if (columns.email === undefined) {
    return {
      problem:
        `No email column. The header reads: ${header.map((c) => c.trim()).join(', ')}. ` +
        'An email address is how a row is told apart from everybody already here, ' +
        'so a file without one cannot be imported.',
      ...empty,
    };
  }

  const body = grid.slice(1);
  const addresses = body
    .map((cells) => cellAt(cells, columns.email).toLowerCase())
    .filter((address) => EMAIL_SHAPE.test(address));
  const existing = await findByEmails(addresses);

  const seen = new Map<string, number>();
  const rows: PreviewRow[] = body.map((cells, index) => {
    const line = index + 2; // 1-based, and the header is line 1.
    const rawEmail = cellAt(cells, columns.email);
    const email = rawEmail.toLowerCase();
    const base = {
      line,
      name: orNull(cellAt(cells, columns.name)),
      title: orNull(cellAt(cells, columns.title)),
      company: orNull(cellAt(cells, columns.company)),
      bio: orNull(cellAt(cells, columns.bio)),
      tags: cellAt(cells, columns.tags)
        .split(/[;|]/)
        .flatMap((part) => part.split(','))
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag !== ''),
    };

    if (rawEmail === '') {
      return {
        ...base,
        email: null,
        outcome: 'reject' as const,
        note: 'No email address. There is no way to tell this row apart from anybody else, and guessing would create a second copy of somebody.',
        matchId: null,
      };
    }
    if (!EMAIL_SHAPE.test(email)) {
      return {
        ...base,
        email: rawEmail,
        outcome: 'reject' as const,
        note: `"${rawEmail}" is not an email address.`,
        matchId: null,
      };
    }

    const earlier = seen.get(email);
    if (earlier !== undefined) {
      return {
        ...base,
        email,
        outcome: 'reject' as const,
        note: `The same address is already on line ${earlier} of this file.`,
        matchId: null,
      };
    }
    seen.set(email, line);

    const match = existing.get(email);
    if (match) {
      return {
        ...base,
        email,
        outcome: 'match' as const,
        note: `Already a contact: ${match.name ?? match.email}. Blank fields on that record will be filled in; nothing already there is overwritten.`,
        matchId: match.id,
      };
    }
    return { ...base, email, outcome: 'create' as const, note: 'New contact.', matchId: null };
  });

  return {
    problem: null,
    recognised: (Object.keys(columns) as ImportField[]).map((field) => FIELD_LABELS[field]),
    unmapped,
    rows,
    counts: {
      create: rows.filter((row) => row.outcome === 'create').length,
      match: rows.filter((row) => row.outcome === 'match').length,
      reject: rows.filter((row) => row.outcome === 'reject').length,
    },
  };
}

export type ImportResult = ImportPreview & { written: boolean };

/**
 * Write the rows the preview said it would.
 *
 * A matched contact has its blanks filled and nothing else. An organizer who
 * typed a job title into a profile last week has said something the list they
 * downloaded from a conference website has not, and an import that overwrites
 * it is an import nobody dares run twice.
 */
export async function applyImport(text: string, actorId: string): Promise<ImportResult> {
  const preview = await previewImport(text);
  if (preview.problem) return { ...preview, written: false };

  await db.transaction(async (tx) => {
    for (const row of preview.rows) {
      if (row.outcome === 'reject' || row.email === null) continue;

      let contactId = row.matchId;

      if (contactId === null) {
        const [created] = await tx
          .insert(users)
          .values({
            email: row.email,
            name: row.name,
            title: row.title,
            company: row.company,
            bio: row.bio,
          })
          .returning({ id: users.id });
        if (!created) continue;
        contactId = created.id;

        // The same grant `upsertUserByEmail` makes. A contact with no role at
        // all cannot follow a sign-in link into the speaker portal later, and
        // the invitation this import exists to send is the thing that leads
        // there.
        await tx
          .insert(userRoles)
          .values({ userId: contactId, role: 'speaker' })
          .onConflictDoNothing();
      } else if (row.name || row.title || row.company || row.bio) {
        // `coalesce`, so the column keeps whatever is already in it. Drizzle
        // drops the undefined entries, so a field the file does not carry is
        // not named in the UPDATE at all.
        await tx
          .update(users)
          .set({
            name: row.name ? sql`coalesce(${users.name}, ${row.name})` : undefined,
            title: row.title ? sql`coalesce(${users.title}, ${row.title})` : undefined,
            company: row.company ? sql`coalesce(${users.company}, ${row.company})` : undefined,
            bio: row.bio ? sql`coalesce(${users.bio}, ${row.bio})` : undefined,
          })
          .where(eq(users.id, contactId));
      }

      for (const tag of row.tags) {
        await tx.insert(contactTags).values({ contactId, tag }).onConflictDoNothing();
      }

      // One note per imported contact, so the profile says where the row came
      // from. A directory nobody can account for is one nobody trusts.
      if (row.matchId === null) {
        await tx.insert(contactNotes).values({
          contactId,
          authorId: actorId,
          body: `Imported from a CSV on ${new Date().toISOString().slice(0, 10)}.`,
        });
      }
    }
  });

  return { ...preview, written: true };
}

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

export type DuplicateContact = {
  id: string;
  name: string | null;
  email: string;
  title: string | null;
  company: string | null;
  createdAt: Date;
  submissions: number;
  onBoard: boolean;
};

export type DuplicateGroup = { name: string; contacts: DuplicateContact[] };

/**
 * People who share a name and do not share an address.
 *
 * Name, because that is the duplicate an import makes: the address is unique by
 * index, so two rows for one person can only ever differ there. Two genuinely
 * different people called James Smith will also show up, which is why this
 * screen offers a merge and never performs one.
 */
export async function duplicateGroups(): Promise<DuplicateGroup[]> {
  const nameKey = sql<string>`lower(btrim(${users.name}))`;

  const keys = await db
    .select({ key: nameKey })
    .from(users)
    .where(and(isNotNull(users.name), eq(users.isBot, false)))
    .groupBy(nameKey)
    .having(sql`count(*) > 1`);

  if (keys.length === 0) return [];

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      title: users.title,
      company: users.company,
      createdAt: users.createdAt,
      key: nameKey,
      submissions: sql<number>`count(distinct ${submissions.id})::int`,
      onBoard: sql<boolean>`bool_or(${pipelineCards.contactId} is not null)`,
    })
    .from(users)
    .leftJoin(submissions, eq(submissions.speakerId, users.id))
    .leftJoin(pipelineCards, eq(pipelineCards.contactId, users.id))
    .where(
      inArray(
        nameKey,
        keys.map((row) => row.key),
      ),
    )
    .groupBy(users.id)
    .orderBy(asc(users.name), asc(users.createdAt));

  const grouped = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    const group = grouped.get(row.key) ?? { name: row.name ?? row.email, contacts: [] };
    group.contacts.push({
      id: row.id,
      name: row.name,
      email: row.email,
      title: row.title,
      company: row.company,
      createdAt: row.createdAt,
      submissions: row.submissions,
      onBoard: row.onBoard,
    });
    grouped.set(row.key, group);
  }
  return [...grouped.values()];
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Every place a person's id is written down, and what a merge does with it.
 *
 * `unique` names the other columns that, together with the contact, may not
 * repeat. Those rows are deduplicated before the repoint, because moving the
 * duplicate's row onto the primary would otherwise collide with a row the
 * primary already has and abort the whole merge. A collision on a junction
 * table is always the same fact recorded twice under two addresses, which is
 * exactly what the merge is asserting, so dropping the second copy loses
 * nothing.
 *
 * `unique: []` is the contact on its own: one card per person on the board, so
 * a merge of two carded people keeps the card of the record being kept.
 *
 * `unique: null` is a plain repoint with no deduplication. Judged work is all
 * on that setting. The only way to dedupe a review is to delete somebody's
 * grade, so `submissions` and `reviews` are checked by `mergeBlockers` before
 * anything is written and the merge is refused rather than made to fit.
 */
const REPOINT: ReadonlyArray<{ table: string; column: string; unique: string[] | null }> = [
  { table: 'user_roles', column: 'user_id', unique: ['role'] },
  { table: 'submissions', column: 'speaker_id', unique: null },
  { table: 'reviews', column: 'reviewer_id', unique: null },
  { table: 'award_votes', column: 'judge_id', unique: ['award_id', 'channel'] },
  { table: 'review_assignments', column: 'reviewer_id', unique: ['round_id', 'submission_id'] },
  { table: 'submission_revisions', column: 'editor_id', unique: null },
  { table: 'submission_authors', column: 'user_id', unique: ['submission_id'] },
  { table: 'speaker_tasks', column: 'user_id', unique: null },
  { table: 'uploads', column: 'owner_id', unique: null },
  { table: 'upload_comments', column: 'author_id', unique: null },
  { table: 'file_exports', column: 'requested_by_id', unique: null },
  { table: 'bookmarks', column: 'user_id', unique: ['submission_id'] },
  { table: 'evaluator_personas', column: 'user_id', unique: null },
  { table: 'email_log', column: 'user_id', unique: null },
  { table: 'portal_pages', column: 'updated_by_id', unique: null },
  { table: 'integration_runs', column: 'started_by_id', unique: null },
  { table: 'speaker_availability', column: 'user_id', unique: null },
  { table: 'round_reviewers', column: 'reviewer_id', unique: ['round_id'] },
  { table: 'review_conflicts', column: 'reviewer_id', unique: ['round_id', 'submission_id'] },
  { table: 'contact_notes', column: 'contact_id', unique: null },
  { table: 'contact_notes', column: 'author_id', unique: null },
  { table: 'contact_tags', column: 'contact_id', unique: ['tag'] },
  { table: 'contact_segments', column: 'created_by_id', unique: null },
  { table: 'pipeline_cards', column: 'contact_id', unique: [] },
  { table: 'pipeline_events', column: 'contact_id', unique: null },
  { table: 'pipeline_events', column: 'actor_id', unique: null },
];

/**
 * Rows that identify a browser rather than a person. Deleted rather than
 * repointed: a session is a login by one address, and the address is what the
 * merge is retiring.
 */
const DROP: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'auth_sessions', column: 'user_id' },
  { table: 'magic_link_tokens', column: 'user_id' },
];

export type MergeSide = {
  id: string;
  name: string | null;
  email: string;
  title: string | null;
  company: string | null;
  createdAt: Date;
  counts: { submissions: number; reviews: number; tasks: number; notes: number; tags: number };
  onBoard: boolean;
};

async function sideOf(id: string): Promise<MergeSide | null> {
  const [person] = await db.select().from(users).where(eq(users.id, id));
  if (!person) return null;

  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
  const [submissionCount, reviewCount, taskCount, noteCount, tagCount, card] = await Promise.all([
    count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(submissions)
        .where(eq(submissions.speakerId, id)),
    ),
    count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(eq(reviews.reviewerId, id)),
    ),
    count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(speakerTasks)
        .where(eq(speakerTasks.userId, id)),
    ),
    count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(contactNotes)
        .where(eq(contactNotes.contactId, id)),
    ),
    count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(contactTags)
        .where(eq(contactTags.contactId, id)),
    ),
    db.select({ id: pipelineCards.contactId }).from(pipelineCards).where(eq(pipelineCards.contactId, id)),
  ]);

  return {
    id: person.id,
    name: person.name,
    email: person.email,
    title: person.title,
    company: person.company,
    createdAt: person.createdAt,
    counts: {
      submissions: submissionCount,
      reviews: reviewCount,
      tasks: taskCount,
      notes: noteCount,
      tags: tagCount,
    },
    onBoard: card.length > 0,
  };
}

export type MergePlan = {
  keep: MergeSide;
  drop: MergeSide;
  /** Reasons the merge will not run. Empty means it will. */
  blockers: string[];
};

/**
 * Two submissions with the same title under one speaker, or two grades from one
 * reviewer on one submission in one round, are both refused by a unique index.
 * Finding that out halfway through the merge would roll back a transaction that
 * had already been reported as running, so both are checked first and reported
 * as a refusal an organizer can act on.
 */
async function mergeBlockers(keepId: string, dropId: string): Promise<string[]> {
  const blockers: string[] = [];

  const clashingTitles = await db.execute<{ title: string }>(sql`
    select b.title
      from submissions a
      join submissions b on lower(a.title) = lower(b.title)
     where a.speaker_id = ${keepId} and b.speaker_id = ${dropId}
  `);
  for (const row of clashingTitles) {
    blockers.push(
      `Both records carry a submission called "${row.title}". Withdraw or rename one before merging: moving it would collide with the copy already on the record being kept.`,
    );
  }

  const clashingReviews = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from reviews a
      join reviews b
        on a.submission_id = b.submission_id
       and a.round_id is not distinct from b.round_id
     where a.reviewer_id = ${keepId} and b.reviewer_id = ${dropId}
  `);
  const clashes = clashingReviews[0]?.n ?? 0;
  if (clashes > 0) {
    blockers.push(
      `Both records graded the same submission ${clashes} time(s) in the same round. Delete one grade before merging: keeping both is not something the review table allows.`,
    );
  }

  return blockers;
}

export async function mergePlan(keepId: string, dropId: string): Promise<MergePlan | null> {
  if (keepId === dropId) return null;
  const [keep, drop] = await Promise.all([sideOf(keepId), sideOf(dropId)]);
  if (!keep || !drop) return null;
  return { keep, drop, blockers: await mergeBlockers(keepId, dropId) };
}

export type MergeResult =
  | { ok: true; kept: string; moved: number }
  | { ok: false; blockers: string[] };

/**
 * Fold one contact into another and delete the empty one.
 *
 * Destructive and not undoable, so the order matters. Everything that points at
 * the record being dropped is moved first; only then is the row deleted. Doing
 * it the other way round would hand the work to `on delete cascade`, and the
 * cascade's answer for a submission is to delete it — real judged work, gone,
 * with nothing on screen to say it happened.
 *
 * The last step before the delete is an audit rather than a trust exercise: the
 * foreign keys pointing at `users` are read out of the catalogue and every one
 * is checked for a surviving reference. A table added to the schema later, and
 * not added to `REPOINT`, aborts the merge instead of quietly losing its rows.
 */
export async function mergeContacts(keepId: string, dropId: string): Promise<MergeResult> {
  if (keepId === dropId) return { ok: false, blockers: ['Those are the same record.'] };

  const plan = await mergePlan(keepId, dropId);
  if (!plan) return { ok: false, blockers: ['One of those records no longer exists.'] };
  if (plan.blockers.length > 0) return { ok: false, blockers: plan.blockers };

  const moved = plan.drop.counts;
  const total =
    moved.submissions + moved.reviews + moved.tasks + moved.notes + moved.tags + (plan.drop.onBoard ? 1 : 0);

  try {
    await db.transaction(async (tx) => {
      for (const entry of DROP) {
        await tx.execute(
          sql`delete from ${sql.raw(`"${entry.table}"`)} where ${sql.raw(`"${entry.column}"`)} = ${dropId}`,
        );
      }

      for (const entry of REPOINT) {
        const quoted = `"${entry.table}"`;
        const column = `"${entry.column}"`;

        if (entry.unique !== null) {
          // `is not distinct from`, not `=`: a nullable key column such as an
          // assignment's round is null outside a round, and null = null is not
          // true, so an equality test would leave the collision in place for the
          // update below to trip over.
          const sameKey = entry.unique
            .map((col) => `d."${col}" is not distinct from p."${col}"`)
            .join(' and ');
          const condition = sameKey === '' ? '' : ` and ${sameKey}`;

          await tx.execute(
            sql`delete from ${sql.raw(quoted)} d using ${sql.raw(quoted)} p
                 where d.${sql.raw(column)} = ${dropId}
                   and p.${sql.raw(column)} = ${keepId}${sql.raw(condition)}`,
          );
        }

        await tx.execute(
          sql`update ${sql.raw(quoted)} set ${sql.raw(column)} = ${keepId} where ${sql.raw(column)} = ${dropId}`,
        );
      }

      // Fill the surviving record's blanks from the one going away, so a merge
      // keeps the job title somebody typed on the newer row.
      await tx.execute(sql`
        update users k
           set name = coalesce(k.name, d.name),
               title = coalesce(k.title, d.title),
               company = coalesce(k.company, d.company),
               bio = coalesce(k.bio, d.bio),
               headshot_url = coalesce(k.headshot_url, d.headshot_url)
          from users d
         where k.id = ${keepId} and d.id = ${dropId}
      `);

      const references = await tx.execute<{ tbl: string; col: string }>(sql`
        select c.conrelid::regclass::text as tbl, a.attname as col
          from pg_constraint c
          join lateral unnest(c.conkey) as k(attnum) on true
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
         where c.contype = 'f' and c.confrelid = 'users'::regclass
      `);

      const stragglers: string[] = [];
      for (const reference of references) {
        const rows = await tx.execute<{ one: number }>(
          sql`select 1 as one from ${sql.raw(`"${reference.tbl}"`)} where ${sql.raw(`"${reference.col}"`)} = ${dropId} limit 1`,
        );
        if (rows.length > 0) stragglers.push(`${reference.tbl}.${reference.col}`);
      }
      if (stragglers.length > 0) {
        throw new Error(
          `Merge stopped before deleting anything: rows still point at the old record in ${stragglers.join(', ')}.`,
        );
      }

      await tx.delete(users).where(eq(users.id, dropId));
    });
  } catch (error) {
    return { ok: false, blockers: [error instanceof Error ? error.message : 'The merge failed.'] };
  }

  return { ok: true, kept: plan.keep.name ?? plan.keep.email, moved: total };
}

/** Counts for the merge summary, kept out of the page so both screens agree. */
export function describeMove(side: MergeSide): string[] {
  const parts: string[] = [];
  const { counts } = side;
  if (counts.submissions > 0) parts.push(`${counts.submissions} submission(s)`);
  if (counts.reviews > 0) parts.push(`${counts.reviews} review(s)`);
  if (counts.tasks > 0) parts.push(`${counts.tasks} speaker task(s)`);
  if (counts.notes > 0) parts.push(`${counts.notes} note(s)`);
  if (counts.tags > 0) parts.push(`${counts.tags} tag(s)`);
  if (side.onBoard) parts.push('its pipeline card');
  return parts;
}
