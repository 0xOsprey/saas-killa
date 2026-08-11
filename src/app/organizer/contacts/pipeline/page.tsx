import { Badge, Button, Card, Empty, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { duplicateGroups, mergePlan } from '@/lib/contact-import';
import {
  allStages,
  boardSize,
  contactsOffBoard,
  historyByContact,
  loadBoard,
  notesByContact,
  type BoardCard,
  type CardNote,
  type StageMove,
} from '@/lib/contact-pipeline';
import type { PipelineStage } from '@/db/schema';
import { inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { billing } from '@/lib/speakers';
import { Duplicates } from '../import/Duplicates';
import { addCardNoteAction, enrollContactAction, moveCardAction, removeCardAction } from './actions';

/**
 * The sourcing board: who the committee is chasing, in columns.
 *
 * The whole screen is server-rendered and every control is a form post, so what
 * comes back after a move is what the database holds rather than anything the
 * browser kept. That is the property the board is judged on, and it is also the
 * one that makes the board survive a reload on a venue's wifi.
 */
export default async function PipelineScreen({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    moved?: string;
    merged?: string;
    merge?: string;
    drop?: string;
  }>;
}) {
  const params = await searchParams;

  const [event, columns, stages, offBoard, history, notes, groups] = await Promise.all([
    getEvent(),
    loadBoard(),
    allStages(),
    contactsOffBoard(),
    historyByContact(),
    notesByContact(),
    duplicateGroups(),
  ]);
  const onBoard = await boardSize();
  const plan =
    params.merge && params.drop ? await mergePlan(params.merge, params.drop) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sourcing pipeline"
        description={`${onBoard} contact(s) across ${stages.length} stages. Moving a card is recorded with who moved it and when.`}
      />

      {params.error ? (
        <Notice tone="bad">
          <span data-testid="pipeline-error">{params.error}</span>
        </Notice>
      ) : null}
      {params.moved ? (
        <Notice tone="good">
          <span data-testid="pipeline-moved">{params.moved}</span>
        </Notice>
      ) : null}
      {params.merged ? (
        <Notice tone="good">
          <span data-testid="pipeline-merged">{params.merged}</span>
        </Notice>
      ) : null}

      <Card>
        <form action={enrollContactAction} className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 space-y-1.5">
            <span className="block text-sm font-medium text-ink">Add a contact to the pipeline</span>
            <Select name="contactId" defaultValue="" data-testid="enroll-contact">
              <option value="">Pick a contact</option>
              {offBoard.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name ?? contact.email}
                  {contact.company ? ` — ${contact.company}` : ''} ({contact.email})
                </option>
              ))}
            </Select>
          </label>
          <label className="block flex-1 space-y-1.5">
            <span className="block text-sm font-medium text-ink">Starting stage</span>
            <Select
              name="stageId"
              defaultValue={stages[0]?.id ?? ''}
              data-testid="enroll-stage"
            >
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" data-testid="enroll-submit">
            Add to pipeline
          </Button>
        </form>
        {offBoard.length === 0 ? (
          <p className="mt-2 text-xs text-muted">Every contact is already on the board.</p>
        ) : null}
      </Card>

      {stages.length === 0 ? (
        <Empty>The board has no stages yet.</Empty>
      ) : (
        // Columns scroll sideways rather than wrapping. A stage that has wrapped
        // onto a second row stops reading as a later step in the process, which
        // is the only thing the left-to-right order is carrying.
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <section
              key={column.stage.id}
              className="w-72 shrink-0 space-y-2 rounded-lg border border-line bg-slate-50 p-3"
              data-testid="stage-column"
            >
              <header className="flex items-center justify-between gap-2">
                <h2
                  className="text-xs font-semibold uppercase tracking-wide text-ink"
                  data-testid="stage-name"
                >
                  {column.stage.name}
                </h2>
                <Badge>{column.cards.length}</Badge>
              </header>

              {column.cards.length === 0 ? (
                <p className="text-xs text-muted">Nobody at this stage.</p>
              ) : (
                column.cards.map((card) => (
                  <PipelineCardView
                    key={card.contactId}
                    card={card}
                    stageId={column.stage.id}
                    stages={stages}
                    history={history.get(card.contactId) ?? []}
                    notes={notes.get(card.contactId) ?? []}
                    timezone={event.timezone}
                  />
                ))
              )}
            </section>
          ))}
        </div>
      )}

      <Duplicates
        groups={groups}
        plan={plan}
        timezone={event.timezone}
        returnTo="/organizer/contacts/pipeline"
      />
    </div>
  );
}

function when(at: Date, timezone: string): string {
  return inEventZone(at, timezone, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * One person's card.
 *
 * The stage control sits outside the disclosure and the history inside it. A
 * move is the thing this screen is for and has to be one press away; the record
 * of every move is what you go looking for, and it is long.
 */
function PipelineCardView({
  card,
  stageId,
  stages,
  history,
  notes,
  timezone,
}: {
  card: BoardCard;
  stageId: string;
  stages: PipelineStage[];
  history: StageMove[];
  notes: CardNote[];
  timezone: string;
}) {
  const billed = billing(card.title, card.company);

  return (
    <article
      className="space-y-2 rounded-md border border-line bg-white p-3 shadow-sm"
      data-testid="pipeline-card"
    >
      <div>
        <p className="font-medium text-ink" data-testid="card-name">
          {card.name ?? card.email}
        </p>
        {billed ? <p className="text-xs text-muted">{billed}</p> : null}
        <p className="text-xs text-muted wrap-anywhere">{card.email}</p>
      </div>

      <form action={moveCardAction} className="flex items-center gap-2">
        <input type="hidden" name="contactId" value={card.contactId} />
        <Select
          name="stageId"
          defaultValue={stageId}
          className="px-2 py-1 text-xs"
          aria-label={`Stage for ${card.name ?? card.email}`}
          data-testid="card-stage"
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" className="px-2 py-1 text-xs" data-testid="card-move">
          Move
        </Button>
      </form>

      <details className="group">
        <summary className="cursor-pointer list-none text-xs font-medium text-accent">
          <span className="group-open:hidden">
            Details, {history.length} stage change(s), {notes.length} note(s)
          </span>
          <span className="hidden group-open:inline">Hide details</span>
        </summary>

        <div className="mt-2 space-y-3 border-t border-line pt-2">
          <div className="space-y-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Stage history
            </h3>
            {history.length === 0 ? (
              <p className="text-xs text-muted">Nothing recorded yet.</p>
            ) : (
              <ol className="space-y-1" data-testid="card-history">
                {history.map((move) => (
                  <li key={move.id} className="text-xs text-ink">
                    <span className="tabular-nums text-muted">{when(move.at, timezone)}</span>{' '}
                    {move.from === null
                      ? `added to ${move.to ?? 'the board'}`
                      : `${move.from} → ${move.to ?? 'off the board'}`}
                    {move.actor ? <span className="text-muted"> by {move.actor}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Notes</h3>
            {notes.length === 0 ? (
              <p className="text-xs text-muted">No notes yet.</p>
            ) : (
              <ul className="space-y-1" data-testid="card-notes">
                {notes.map((note) => (
                  <li key={note.id} className="text-xs text-ink">
                    <span className="whitespace-pre-wrap">{note.body}</span>
                    <span className="block text-[11px] text-muted">
                      {note.author ?? 'Somebody'} · {when(note.at, timezone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <form action={addCardNoteAction} className="space-y-1 pt-1">
              <input type="hidden" name="contactId" value={card.contactId} />
              <Textarea
                name="body"
                required
                maxLength={4000}
                placeholder="Left voicemail; follow up next week."
                className="min-h-16 text-xs"
                data-testid="card-note-body"
              />
              <Button
                type="submit"
                variant="secondary"
                className="px-2 py-1 text-xs"
                data-testid="card-note-save"
              >
                Save note
              </Button>
            </form>
          </div>

          <form action={removeCardAction}>
            <input type="hidden" name="contactId" value={card.contactId} />
            <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
              Take off the board
            </Button>
          </form>
        </div>
      </details>
    </article>
  );
}
