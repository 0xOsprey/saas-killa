import { and, asc, desc, eq, ilike, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import {
  contactNotes,
  contactSegments,
  contactTags,
  pipelineCards,
  pipelineEvents,
  pipelineStages,
  users,
} from '@/db/schema';
import { ROSTER_FILTERS, isRosterFilter, speakerDetail, type RosterFilter } from '@/lib/speakers';
import type { SpeakerDetail } from '@/lib/speakers';

/**
 * The organization's contact directory: every person this organization has
 * worked with, not the roster of one conference.
 *
 * Filtering happens in SQL for the same reason it does in `agenda-filters.ts`:
 * a filtered directory has to be a URL somebody can paste to a colleague, and
 * the server has to be the thing that narrows so what is on screen and what a
 * saved segment re-runs later cannot drift apart. Reading every account and
 * narrowing it in JavaScript would be this page with a worse shape and a
 * segment that answers a different question from the one it was saved with.
 *
 * Bots are excluded everywhere below. The AI evaluator holds a `users` row so
 * its grades attribute like anyone's, which is the same reason
 * `announcementAudience` drops it from a send: nobody is behind the address, so
 * counting it as a contact makes the headline number wrong by one.
 */

/** `%` and `_` are LIKE wildcards; somebody typing one means the character. */
function likeTerm(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A tag is lowercased and trimmed at every boundary it crosses, so "AI", "ai"
 * and " AI " are one tag rather than three. The composite primary key on
 * `contact_tags` is what stops a duplicate, and it compares bytes, so
 * normalising later than here would let the same word onto a person twice.
 */
export function normaliseTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
  return tag === '' ? null : tag;
}

export type ContactFilters = {
  /** Free text, matched against name, email, job title and company. */
  q: string | null;
  company: string | null;
  /** Job title. Named `title` to match `users.title`, never "role", which is a permission here. */
  title: string | null;
  tag: string | null;
  /**
   * The saved views the roster already publishes, reused rather than reinvented.
   * Sharing the vocabulary is what lets the link to the email composer hand over
   * `filter` verbatim instead of translating between two sets of names.
   */
  preset: RosterFilter;
};

export const EMPTY_CONTACT_FILTERS: ContactFilters = {
  q: null,
  company: null,
  title: null,
  tag: null,
  preset: 'all',
};

export { ROSTER_FILTERS as CONTACT_PRESETS };

export type ContactSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Read the filters off the query string, discarding anything malformed rather
 * than throwing. A hand-edited or stale link has to render an unfiltered
 * directory: a saved segment written months ago against a preset that has since
 * been renamed should degrade to "everyone", not to an error page.
 */
export function parseContactFilters(params: ContactSearchParams): ContactFilters {
  const preset = first(params.filter);
  const company = first(params.company);
  const title = first(params.title);
  const tag = first(params.tag);
  const q = first(params.q);

  return {
    q: q ? q.slice(0, 120) : null,
    company: company ? company.slice(0, 120) : null,
    title: title ? title.slice(0, 120) : null,
    tag: tag ? normaliseTag(tag) : null,
    preset: isRosterFilter(preset) ? preset : 'all',
  };
}

/** Rebuild the query string, so every link on the page keeps the current filters. */
export function contactFilterQuery(
  filters: ContactFilters,
  overrides: Partial<ContactFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.q) params.set('q', merged.q);
  if (merged.company) params.set('company', merged.company);
  if (merged.title) params.set('title', merged.title);
  if (merged.tag) params.set('tag', merged.tag);
  if (merged.preset !== 'all') params.set('filter', merged.preset);
  return params.toString();
}

export function hasActiveContactFilters(filters: ContactFilters): boolean {
  return contactFilterQuery(filters) !== '';
}

/** The active criteria as chips, so a screenshot of a filtered list says what it is filtered by. */
export function activeContactCriteria(filters: ContactFilters): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (filters.q) chips.push({ key: 'q', label: `matching "${filters.q}"` });
  if (filters.company) chips.push({ key: 'company', label: `company: ${filters.company}` });
  if (filters.title) chips.push({ key: 'title', label: `job title: ${filters.title}` });
  if (filters.tag) chips.push({ key: 'tag', label: `tag: ${filters.tag}` });
  if (filters.preset !== 'all') {
    chips.push({ key: 'filter', label: ROSTER_FILTERS[filters.preset] });
  }
  return chips;
}

export type ContactRow = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  company: string | null;
  headshotUrl: string | null;
  tags: string[];
  total: number;
  accepted: number;
  unconfirmed: number;
  /** Their column on the invitation board, or null when they are not on it. */
  stageName: string | null;
  noteCount: number;
};

/**
 * The preset views restated in SQL.
 *
 * `matchesFilter` in `lib/speakers.ts` is the original and it runs in
 * JavaScript over already-fetched rows. These clauses are deliberately the same
 * predicates written a second time rather than a second, looser definition: a
 * contact the roster calls "accepted, not confirmed" and a contact this
 * directory calls the same thing have to be the same person, because the link
 * to the email composer hands `filter` straight over and the audience it
 * resolves is the one that gets written to. `coalesce(x, '') = ''` rather than
 * `is null` because the JavaScript original tests falsiness, and an empty bio
 * is missing by that test.
 */
function presetClause(preset: RosterFilter): SQL | null {
  const acceptedExists = sql`exists (
    select 1 from submissions s
    where s.speaker_id = users.id and s.status = 'accepted'
  )`;

  switch (preset) {
    case 'all':
      return null;
    case 'accepted':
      return acceptedExists as SQL;
    case 'confirmed':
      return sql`exists (
        select 1 from submissions s
        where s.speaker_id = users.id and s.speaker_confirmed_at is not null
      )` as SQL;
    // Declines are subtracted as well as confirmations, exactly as the roster
    // does it, so this stays the chase list: somebody who has answered "I
    // cannot present" has not left the question open.
    case 'unconfirmed':
      return sql`(select count(*) from submissions s
                  where s.speaker_id = users.id and s.status = 'accepted')
                 > (select count(*) from submissions s
                    where s.speaker_id = users.id and s.speaker_confirmed_at is not null)
                 + (select count(*) from submissions s
                    where s.speaker_id = users.id and s.speaker_declined_at is not null)` as SQL;
    case 'declined':
      return sql`exists (
        select 1 from submissions s
        where s.speaker_id = users.id and s.speaker_declined_at is not null
      )` as SQL;
    case 'missing_bio':
      return sql`${acceptedExists} and coalesce(users.bio, '') = ''` as SQL;
    case 'missing_headshot':
      return sql`${acceptedExists} and coalesce(users.headshot_url, '') = ''` as SQL;
    case 'outstanding':
      return sql`exists (
        select 1 from speaker_tasks t
        where t.user_id = users.id and t.completed_at is null
      )` as SQL;
    case 'overdue':
      return sql`exists (
        select 1 from speaker_tasks t
        where t.user_id = users.id and t.completed_at is null and t.due_at < now()
      )` as SQL;
    default: {
      // A preset added to ROSTER_FILTERS with no clause written here fails to
      // compile at this line, rather than becoming a saved view that silently
      // matches everybody.
      const unhandled: never = preset;
      return unhandled;
    }
  }
}

/**
 * Every contact the filters admit, with the programme history that makes a row
 * worth reading at a glance.
 *
 * The counts are correlated subqueries rather than joins with a `group by`.
 * Three left joins to submissions, tags and the pipeline board fan out against
 * each other, and the aggregate that survives that is harder to read than five
 * subqueries that each say exactly what they count.
 */
export async function contactDirectory(filters: ContactFilters): Promise<ContactRow[]> {
  const where: SQL[] = [sql`users.is_bot = false`];

  if (filters.q) {
    const term = likeTerm(filters.q);
    where.push(
      or(
        ilike(users.name, term),
        ilike(users.email, term),
        ilike(users.title, term),
        ilike(users.company, term),
      ) as SQL,
    );
  }
  // Exact and case-insensitive, not a substring match. These come from the
  // facet lists, where the value was read out of the column itself, so a
  // substring match here would quietly fold "Engineering" into "Engineering
  // Manager" and report a count the KPI panel disagrees with.
  if (filters.company) where.push(sql`lower(users.company) = ${filters.company.toLowerCase()}`);
  if (filters.title) where.push(sql`lower(users.title) = ${filters.title.toLowerCase()}`);
  if (filters.tag) {
    where.push(
      sql`exists (
        select 1 from contact_tags ct
        where ct.contact_id = users.id and ct.tag = ${filters.tag}
      )`,
    );
  }
  const preset = presetClause(filters.preset);
  if (preset) where.push(preset);

  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      title: users.title,
      company: users.company,
      headshotUrl: users.headshotUrl,
      tags: sql<string[]>`coalesce((
        select array_agg(ct.tag order by ct.tag)
        from contact_tags ct where ct.contact_id = users.id
      ), '{}')`,
      total: sql<number>`(select count(*) from submissions s where s.speaker_id = users.id)::int`,
      accepted: sql<number>`(
        select count(*) from submissions s
        where s.speaker_id = users.id and s.status = 'accepted'
      )::int`,
      unconfirmed: sql<number>`(
        select count(*) from submissions s
        where s.speaker_id = users.id and s.status = 'accepted'
          and s.speaker_confirmed_at is null and s.speaker_declined_at is null
      )::int`,
      stageName: sql<string | null>`(
        select ps.name from pipeline_cards pc
        join pipeline_stages ps on ps.id = pc.stage_id
        where pc.contact_id = users.id
      )`,
      noteCount: sql<number>`(
        select count(*) from contact_notes n where n.contact_id = users.id
      )::int`,
    })
    .from(users)
    .where(and(...where))
    .orderBy(asc(sql`lower(coalesce(users.name, users.email))`));
}

export type ContactFacets = {
  companies: string[];
  titles: string[];
  /** The tag vocabulary with how many people carry each, newest usage last. */
  tags: { tag: string; count: number }[];
};

/**
 * What the filter dropdowns offer.
 *
 * Read out of the data rather than kept in a list somebody has to maintain: a
 * company appears in the filter the moment one contact works there and leaves
 * when the last one stops, with no second place to edit. The ordering is plain
 * `company` rather than `lower(company)` because Postgres requires a SELECT
 * DISTINCT to sort by something in its own select list.
 */
export async function contactFacets(): Promise<ContactFacets> {
  const [companies, titles, tags] = await Promise.all([
    db
      .selectDistinct({ value: users.company })
      .from(users)
      .where(and(eq(users.isBot, false), isNotNull(users.company)))
      .orderBy(asc(users.company)),
    db
      .selectDistinct({ value: users.title })
      .from(users)
      .where(and(eq(users.isBot, false), isNotNull(users.title)))
      .orderBy(asc(users.title)),
    db
      .select({ tag: contactTags.tag, count: sql<number>`count(*)::int` })
      .from(contactTags)
      .groupBy(contactTags.tag)
      .orderBy(desc(sql`count(*)`), asc(contactTags.tag)),
  ]);

  return {
    companies: companies.map((row) => row.value).filter((value): value is string => Boolean(value)),
    titles: titles.map((row) => row.value).filter((value): value is string => Boolean(value)),
    tags,
  };
}

export type ContactKpis = {
  contacts: number;
  withAcceptedTalk: number;
  companies: number;
  tagged: number;
  onBoard: number;
  byStage: { id: string; name: string; count: number }[];
  topCompanies: { company: string; count: number }[];
};

/**
 * Organization-wide numbers, deliberately unfiltered.
 *
 * Every count here spans the whole contact database rather than the event the
 * rest of the organizer screens are scoped to, which is the entire point of the
 * panel: `/organizer` answers "how is this conference going" and there was
 * nowhere that answered "who do we know". `contacts` is the same population the
 * unfiltered directory lists, so the headline number and the row count below it
 * are the same number by construction rather than by coincidence.
 */
export async function contactKpis(): Promise<ContactKpis> {
  const [[totals], byStage, topCompanies] = await Promise.all([
    db
      .select({
        contacts: sql<number>`count(*)::int`,
        withAcceptedTalk: sql<number>`count(*) filter (where exists (
          select 1 from submissions s
          where s.speaker_id = users.id and s.status = 'accepted'
        ))::int`,
        companies: sql<number>`count(distinct users.company)::int`,
        tagged: sql<number>`count(*) filter (where exists (
          select 1 from contact_tags ct where ct.contact_id = users.id
        ))::int`,
      })
      .from(users)
      .where(eq(users.isBot, false)),
    db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        count: sql<number>`count(${pipelineCards.contactId})::int`,
      })
      .from(pipelineStages)
      .leftJoin(pipelineCards, eq(pipelineCards.stageId, pipelineStages.id))
      .groupBy(pipelineStages.id)
      .orderBy(asc(pipelineStages.position)),
    db
      .select({ company: users.company, count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.isBot, false), isNotNull(users.company)))
      .groupBy(users.company)
      .orderBy(desc(sql`count(*)`), asc(users.company))
      .limit(6),
  ]);

  return {
    contacts: totals?.contacts ?? 0,
    withAcceptedTalk: totals?.withAcceptedTalk ?? 0,
    companies: totals?.companies ?? 0,
    tagged: totals?.tagged ?? 0,
    onBoard: byStage.reduce((n, stage) => n + stage.count, 0),
    byStage,
    topCompanies: topCompanies.map((row) => ({ company: row.company ?? '', count: row.count })),
  };
}

export type ContactNoteRow = {
  id: string;
  body: string;
  createdAt: Date;
  authorName: string | null;
  authorEmail: string;
};

export type ContactStageMove = {
  id: string;
  fromStage: string | null;
  toStage: string | null;
  createdAt: Date;
  actorName: string | null;
};

export type ContactRecord = SpeakerDetail & {
  tags: string[];
  notes: ContactNoteRow[];
  stageName: string | null;
  stageMoves: ContactStageMove[];
};

/**
 * One contact record: who they are, what has been written about them and every
 * thing they are attached to.
 *
 * Built on `speakerDetail` rather than beside it. That function already answers
 * "what is this person's programme history" for the roster's edit screen, and a
 * second query returning nearly the same rows is how the two screens end up
 * disagreeing about whether a withdrawn talk counts.
 */
export async function contactRecord(contactId: string): Promise<ContactRecord | null> {
  const detail = await speakerDetail(contactId);
  if (!detail) return null;

  const authors = { name: users.name, email: users.email };
  const [tags, notes, card, moves] = await Promise.all([
    db
      .select({ tag: contactTags.tag })
      .from(contactTags)
      .where(eq(contactTags.contactId, contactId))
      .orderBy(asc(contactTags.tag)),
    db
      .select({
        id: contactNotes.id,
        body: contactNotes.body,
        createdAt: contactNotes.createdAt,
        authorName: authors.name,
        authorEmail: authors.email,
      })
      .from(contactNotes)
      .innerJoin(users, eq(users.id, contactNotes.authorId))
      .where(eq(contactNotes.contactId, contactId))
      // Newest first: the last thing anybody wrote about a person is the thing
      // an organizer opening this record is looking for.
      .orderBy(desc(contactNotes.createdAt)),
    db
      .select({ name: pipelineStages.name })
      .from(pipelineCards)
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCards.stageId))
      .where(eq(pipelineCards.contactId, contactId)),
    db
      .select({
        id: pipelineEvents.id,
        fromStage: sql<string | null>`(
          select ps.name from pipeline_stages ps where ps.id = pipeline_events.from_stage_id
        )`,
        toStage: sql<string | null>`(
          select ps.name from pipeline_stages ps where ps.id = pipeline_events.to_stage_id
        )`,
        createdAt: pipelineEvents.createdAt,
        actorName: sql<string | null>`(
          select coalesce(a.name, a.email) from users a where a.id = pipeline_events.actor_id
        )`,
      })
      .from(pipelineEvents)
      .where(eq(pipelineEvents.contactId, contactId))
      .orderBy(desc(pipelineEvents.createdAt)),
  ]);

  return {
    ...detail,
    tags: tags.map((row) => row.tag),
    notes,
    stageName: card[0]?.name ?? null,
    stageMoves: moves,
  };
}

export type SegmentRow = {
  id: string;
  name: string;
  query: string;
  createdAt: Date;
  authorName: string | null;
};

/**
 * The saved segments, oldest first so the list does not reorder itself under
 * somebody who has just learned where their segment sits.
 */
export async function contactSegmentList(): Promise<SegmentRow[]> {
  return db
    .select({
      id: contactSegments.id,
      name: contactSegments.name,
      query: contactSegments.query,
      createdAt: contactSegments.createdAt,
      authorName: sql<string | null>`(
        select coalesce(a.name, a.email) from users a where a.id = contact_segments.created_by_id
      )`,
    })
    .from(contactSegments)
    .orderBy(asc(contactSegments.createdAt));
}
