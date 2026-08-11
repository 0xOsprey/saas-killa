import { and, asc, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db';
import {
  contactNotes,
  pipelineCards,
  pipelineEvents,
  pipelineStages,
  users,
} from '@/db/schema';
import type { PipelineStage } from '@/db/schema';

/**
 * The invitation pipeline: who the committee is chasing, and how far along.
 *
 * Everything here is keyed on the contact rather than on a card id, because
 * `pipeline_cards` makes the contact its own primary key. A person is on the
 * board once or not at all, so "which card" and "which person" are the same
 * question and there is no second identifier to keep in step.
 */

export type BoardCard = {
  contactId: string;
  name: string | null;
  email: string;
  title: string | null;
  company: string | null;
  updatedAt: Date;
};

export type BoardColumn = {
  stage: PipelineStage;
  cards: BoardCard[];
};

/** One line of a card's history: who moved them, from where, to where, when. */
export type StageMove = {
  id: string;
  at: Date;
  from: string | null;
  to: string | null;
  actor: string | null;
};

export type CardNote = {
  id: string;
  body: string;
  at: Date;
  author: string | null;
};

export async function allStages(): Promise<PipelineStage[]> {
  return db.select().from(pipelineStages).orderBy(asc(pipelineStages.position));
}

/**
 * The board, as columns. Empty stages are columns too: a board that hides its
 * empty stages stops being a picture of the process the moment somebody moves
 * the last card out of one, and an organizer cannot drop a card into a column
 * that is not drawn.
 */
export async function loadBoard(): Promise<BoardColumn[]> {
  const stages = await allStages();

  const rows = await db
    .select({
      contactId: pipelineCards.contactId,
      stageId: pipelineCards.stageId,
      position: pipelineCards.position,
      updatedAt: pipelineCards.updatedAt,
      name: users.name,
      email: users.email,
      title: users.title,
      company: users.company,
    })
    .from(pipelineCards)
    .innerJoin(users, eq(users.id, pipelineCards.contactId))
    .orderBy(asc(pipelineCards.position), asc(users.name));

  return stages.map((stage) => ({
    stage,
    cards: rows
      .filter((row) => row.stageId === stage.id)
      .map((row) => ({
        contactId: row.contactId,
        name: row.name,
        email: row.email,
        title: row.title,
        company: row.company,
        updatedAt: row.updatedAt,
      })),
  }));
}

/**
 * Stage history for every card on the board, in one query rather than one per
 * card. The board draws thirty cards on a busy month and each one carries its
 * own history inline, so a query per card is thirty round trips to render a
 * page that has already read the same table once.
 *
 * `pipeline_stages` is joined twice under two aliases because a move names two
 * of them, and a stage deleted later leaves its side of the move null rather
 * than removing the event: how somebody reached Confirmed is still true after
 * the column they passed through has been renamed out of existence.
 */
export async function historyByContact(): Promise<Map<string, StageMove[]>> {
  const fromStage = alias(pipelineStages, 'from_stage');
  const toStage = alias(pipelineStages, 'to_stage');
  const actor = alias(users, 'actor');

  const rows = await db
    .select({
      id: pipelineEvents.id,
      contactId: pipelineEvents.contactId,
      at: pipelineEvents.createdAt,
      from: fromStage.name,
      to: toStage.name,
      actor: actor.name,
      actorEmail: actor.email,
    })
    .from(pipelineEvents)
    .leftJoin(fromStage, eq(fromStage.id, pipelineEvents.fromStageId))
    .leftJoin(toStage, eq(toStage.id, pipelineEvents.toStageId))
    .leftJoin(actor, eq(actor.id, pipelineEvents.actorId))
    .orderBy(asc(pipelineEvents.createdAt));

  const byContact = new Map<string, StageMove[]>();
  for (const row of rows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push({
      id: row.id,
      at: row.at,
      from: row.from,
      to: row.to,
      actor: row.actor ?? row.actorEmail,
    });
    byContact.set(row.contactId, list);
  }
  return byContact;
}

/**
 * Notes for every card, newest first. These are the same rows the contact
 * profile writes: a note is a fact about the person, so an organizer who wrote
 * one on the profile last month should find it on the card today.
 */
export async function notesByContact(): Promise<Map<string, CardNote[]>> {
  const author = alias(users, 'note_author');

  const rows = await db
    .select({
      id: contactNotes.id,
      contactId: contactNotes.contactId,
      body: contactNotes.body,
      at: contactNotes.createdAt,
      author: author.name,
      authorEmail: author.email,
    })
    .from(contactNotes)
    .leftJoin(author, eq(author.id, contactNotes.authorId))
    .orderBy(desc(contactNotes.createdAt));

  const byContact = new Map<string, CardNote[]>();
  for (const row of rows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push({ id: row.id, body: row.body, at: row.at, author: row.author ?? row.authorEmail });
    byContact.set(row.contactId, list);
  }
  return byContact;
}

/**
 * Contacts who are not on the board yet, for the enroll control.
 *
 * Bots are excluded. The AI evaluator owns a user row so its grades attribute
 * like anyone's, and offering to invite it to speak is the kind of thing that
 * makes a demo look unfinished.
 */
export async function contactsOffBoard(): Promise<
  { id: string; name: string | null; email: string; company: string | null }[]
> {
  return db
    .select({ id: users.id, name: users.name, email: users.email, company: users.company })
    .from(users)
    .leftJoin(pipelineCards, eq(pipelineCards.contactId, users.id))
    .where(and(isNull(pipelineCards.contactId), eq(users.isBot, false)))
    .orderBy(asc(users.name), asc(users.email));
}

/** The handle `db.transaction` hands its callback, named so helpers can take it. */
type Tx = Parameters<Parameters<(typeof db)['transaction']>[0]>[0];

/** The next free slot at the bottom of a column. */
async function tailPosition(tx: typeof db | Tx, stageId: string): Promise<number> {
  const [row] = await tx
    .select({ highest: max(pipelineCards.position) })
    .from(pipelineCards)
    .where(eq(pipelineCards.stageId, stageId));
  return (row?.highest ?? -1) + 1;
}

export type EnrollResult =
  | { ok: true; stage: string }
  | { ok: false; reason: 'no-stages' | 'already-on-board' };

/**
 * Put a contact on the board at a chosen stage, or the first one by default.
 *
 * The card and its entry event are written in one transaction because the
 * history is the only record of when somebody entered the pipeline, and a card
 * with no first event reads as having always been there. `onConflictDoNothing`
 * is what makes a double submit land once: the contact is the primary key, so
 * the second insert has nowhere to go and the event is not written either.
 */
export async function addToPipeline(
  contactId: string,
  actorId: string,
  targetStageId?: string,
): Promise<EnrollResult> {
  let stage: PipelineStage | undefined;
  if (targetStageId) {
    [stage] = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.id, targetStageId))
      .limit(1);
  }
  if (!stage) {
    [stage] = await db
      .select()
      .from(pipelineStages)
      .orderBy(asc(pipelineStages.position))
      .limit(1);
  }
  if (!stage) return { ok: false, reason: 'no-stages' };

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pipelineCards)
      .values({
        contactId,
        stageId: stage.id,
        position: await tailPosition(tx, stage.id),
      })
      .onConflictDoNothing()
      .returning({ contactId: pipelineCards.contactId });

    if (inserted.length === 0) return { ok: false, reason: 'already-on-board' as const };

    await tx.insert(pipelineEvents).values({
      contactId,
      fromStageId: null,
      toStageId: stage.id,
      actorId,
    });
    return { ok: true, stage: stage.name };
  });
}

export type MoveResult =
  | { ok: true; from: string | null; to: string }
  | { ok: false; reason: 'not-on-board' | 'unknown-stage' | 'unchanged' };

/**
 * Move a card to another stage, and write down that it happened.
 *
 * A move that changes nothing writes no event. Otherwise a mis-click on the
 * stage the card is already in would file a transition from Invited to Invited,
 * and the history an organizer reads to answer "when did we invite them?" fills
 * up with moves nobody made.
 */
export async function moveCard(
  contactId: string,
  toStageId: string,
  actorId: string,
): Promise<MoveResult> {
  return db.transaction(async (tx) => {
    const [card] = await tx
      .select({ stageId: pipelineCards.stageId })
      .from(pipelineCards)
      .where(eq(pipelineCards.contactId, contactId));
    if (!card) return { ok: false, reason: 'not-on-board' as const };

    const [target] = await tx
      .select({ id: pipelineStages.id, name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.id, toStageId));
    if (!target) return { ok: false, reason: 'unknown-stage' as const };
    if (card.stageId === target.id) return { ok: false, reason: 'unchanged' as const };

    const [origin] = await tx
      .select({ name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.id, card.stageId));

    await tx
      .update(pipelineCards)
      .set({
        stageId: target.id,
        position: await tailPosition(tx, target.id),
        updatedAt: new Date(),
      })
      .where(eq(pipelineCards.contactId, contactId));

    await tx.insert(pipelineEvents).values({
      contactId,
      fromStageId: card.stageId,
      toStageId: target.id,
      actorId,
    });

    return { ok: true, from: origin?.name ?? null, to: target.name };
  });
}

/**
 * Write a note against a contact from their card.
 *
 * The same table the contact profile writes to, on purpose. An organizer on a
 * call with a prospect is looking at the board, not at the directory, and a
 * note that only the profile can take is a note that does not get written.
 */
export async function addCardNote(
  contactId: string,
  authorId: string,
  body: string,
): Promise<void> {
  await db.insert(contactNotes).values({ contactId, authorId, body });
}

/** Take a contact off the board. The history stays; the column entry goes. */
export async function removeFromPipeline(contactId: string): Promise<void> {
  await db.delete(pipelineCards).where(eq(pipelineCards.contactId, contactId));
}

/** How many people are on the board, for the page header. */
export async function boardSize(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pipelineCards);
  return row?.n ?? 0;
}
