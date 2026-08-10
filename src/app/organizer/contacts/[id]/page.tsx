import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Textarea } from '@/components/ui';
import { Headshot } from '@/app/speakers/Headshot';
import { currentUser } from '@/lib/auth';
import { contactRecord } from '@/lib/contacts';
import { FORMAT_LABELS, STATUS_LABELS, dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { TASK_KIND_LABELS } from '@/lib/speaker-labels';
import { billing } from '@/lib/speakers';
import {
  addContactNoteAction,
  addContactTagAction,
  deleteContactNoteAction,
  removeContactTagAction,
} from '../actions';

/**
 * One contact record.
 *
 * Notes and history sit on the same page rather than behind tabs. The question
 * an organizer opens this record with is almost always both halves at once:
 * "what did we say about them last time, and what have they actually done for
 * us", and a tab hides one of those behind a click nobody makes while they are
 * on the phone.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {children}
    </Card>
  );
}

export default async function ContactRecordPage({ params }: { params: Promise<{ id: string }> }) {
  // Repeated from `organizer/layout.tsx` and run before the record is fetched.
  // A layout renders concurrently with its page, so a layout-only redirect
  // still answers a signed-out request with a 307 whose body holds everything
  // the page managed to render, which here is somebody's address, their bio and
  // the private notes about them.
  const viewer = await currentUser();
  if (!viewer) redirect('/login');
  if (!viewer.roles.includes('organizer')) return <Notice tone="bad">Organizer access only.</Notice>;

  const { id } = await params;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();

  const [event, record] = await Promise.all([getEvent(), contactRecord(parsed.data)]);
  if (!record) notFound();

  const { user, roles, submissions, tasks, tags, notes, stageName, stageMoves } = record;
  const openTasks = tasks.filter((task) => task.completedAt === null);
  const stamp = (at: Date) => `${dayLabel(at, event.timezone)} at ${timeOfDay(at, event.timezone)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={user.name ?? user.email}
        description={[billing(user.title, user.company), user.email, roles.join(', ') || 'no roles']
          .filter((part): part is string => Boolean(part))
          .join(' · ')}
        action={
          <div className="flex items-center gap-2">
            {/* The organizer edit screen is where the identity fields are
                written. Linked rather than duplicated, so a name has one form
                that owns it and this record cannot disagree with the roster. */}
            <Link
              href={`/organizer/speakers/${user.id}`}
              className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
            >
              Edit identity fields
            </Link>
            <Link href="/organizer/contacts" className="px-2 py-2 text-sm text-muted hover:text-ink">
              Back to contacts
            </Link>
          </div>
        }
      />

      <Card className="flex flex-wrap gap-4">
        <Headshot src={user.headshotUrl} name={user.name} size="lg" />
        <div className="min-w-64 flex-1 space-y-2">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Email</dt>
              <dd className="text-ink">{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Job title</dt>
              <dd className="text-ink">{user.title ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Company</dt>
              <dd className="text-ink">{user.company ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Pipeline stage</dt>
              <dd className="text-ink">{stageName ?? 'Not on the board'}</dd>
            </div>
          </dl>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Bio</p>
            <p className="whitespace-pre-wrap text-sm text-ink" data-testid="contact-bio">
              {user.bio ?? 'No bio on file yet.'}
            </p>
          </div>
        </div>
      </Card>

      <Section title="Tags">
        {tags.length === 0 ? (
          <p className="text-sm text-muted">No tags yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="contact-tags">
            {tags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1">
                <Badge tone="accent">{tag}</Badge>
                <form action={removeContactTagAction}>
                  <input type="hidden" name="contactId" value={user.id} />
                  <input type="hidden" name="tag" value={tag} />
                  <Button
                    type="submit"
                    variant="ghost"
                    className="px-1 py-0.5 text-xs"
                    aria-label={`Remove the tag ${tag}`}
                  >
                    ✕
                  </Button>
                </form>
              </span>
            ))}
          </div>
        )}
        <form action={addContactTagAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="contactId" value={user.id} />
          <div className="min-w-48 flex-1">
            <Input
              name="tag"
              placeholder="Add a tag, e.g. AI"
              aria-label="Add a tag"
              maxLength={400}
              data-testid="tag-input"
            />
          </div>
          <Button type="submit" variant="secondary" data-testid="tag-add">
            Add tag
          </Button>
          <p className="basis-full text-xs text-muted">
            Lowercased when saved, so AI and ai are one tag. Commas add several at once. Tags are
            filterable from the directory.
          </p>
        </form>
      </Section>

      <Section title={`Internal notes (${notes.length})`}>
        <form action={addContactNoteAction} className="space-y-2">
          <input type="hidden" name="contactId" value={user.id} />
          <Textarea
            name="body"
            placeholder="What should the next organizer to open this record know?"
            aria-label="Internal note"
            className="min-h-24"
            maxLength={4000}
            data-testid="note-body"
          />
          <div className="flex items-center gap-3">
            <Button type="submit" data-testid="note-save">
              Save note
            </Button>
            <span className="text-xs text-muted">
              Private to organizers. Never shown to the speaker or on any public page.
            </span>
          </div>
        </form>

        {notes.length === 0 ? (
          <Empty>Nothing written down about this person yet.</Empty>
        ) : (
          <ul className="space-y-2" data-testid="note-list">
            {notes.map((note) => (
              <li key={note.id} className="rounded-md border border-line p-3">
                <p className="whitespace-pre-wrap text-sm text-ink">{note.body}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>
                    {note.authorName ?? note.authorEmail} · {stamp(note.createdAt)}
                  </span>
                  <form action={deleteContactNoteAction} className="ml-auto">
                    <input type="hidden" name="noteId" value={note.id} />
                    <input type="hidden" name="contactId" value={user.id} />
                    <Button type="submit" variant="ghost" className="px-2 py-0.5 text-xs">
                      Delete
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Programme history (${submissions.length} submission(s))`}>
        {submissions.length === 0 ? (
          <Empty>Nothing filed under this contact yet.</Empty>
        ) : (
          <ul className="space-y-2" data-testid="contact-submissions">
            {submissions.map((submission) => (
              <li key={submission.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href={`/agenda/${submission.id}`}
                  className="font-medium text-ink hover:underline"
                >
                  {submission.title}
                </Link>
                <Badge>{event.name}</Badge>
                <Badge>{STATUS_LABELS[submission.status]}</Badge>
                <Badge>{FORMAT_LABELS[submission.format]}</Badge>
                {submission.trackName ? <Badge tone="accent">{submission.trackName}</Badge> : null}
                {submission.status === 'accepted' ? (
                  submission.speakerDeclinedAt ? (
                    <Badge tone="bad">declined</Badge>
                  ) : submission.speakerConfirmedAt ? (
                    <Badge tone="good">confirmed</Badge>
                  ) : (
                    <Badge tone="warn">not confirmed</Badge>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Activity">
        {/* Two feeds rather than one merged stream, because a stage move and an
            outstanding task are answers to different questions and interleaving
            them by timestamp buries the short list under the long one. Each
            heading counts what is under it, so neither number describes a list
            the reader is not looking at. */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Pipeline stage changes ({stageMoves.length})
          </h3>
          {stageMoves.length === 0 ? (
            <p className="text-sm text-muted">Never enrolled on the sourcing board.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm" data-testid="contact-stage-history">
              {stageMoves.map((move) => (
                <li key={move.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">
                    {move.fromStage ?? 'Enrolled'} → {move.toStage ?? 'removed'}
                  </span>
                  <span className="text-xs text-muted">
                    {stamp(move.createdAt)}
                    {move.actorName ? ` · ${move.actorName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Speaker tasks ({openTasks.length} of {tasks.length} still open)
          </h3>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted">Nothing on their list.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm" data-testid="contact-tasks">
              {tasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{task.label}</span>
                  <Badge tone="neutral">{TASK_KIND_LABELS[task.kind]}</Badge>
                  {task.completedAt ? (
                    <Badge tone="good">done {stamp(task.completedAt)}</Badge>
                  ) : task.dueAt ? (
                    <Badge tone={task.dueAt < new Date() ? 'bad' : 'warn'}>
                      due {dayLabel(task.dueAt, event.timezone)}
                    </Badge>
                  ) : (
                    <Badge tone="warn">no deadline</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}
