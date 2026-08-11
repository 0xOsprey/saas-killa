import Link from 'next/link';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select } from '@/components/ui';
import {
  activeContactCriteria,
  contactFilterQuery,
  parseContactFilters,
  type ContactSearchParams,
} from '@/lib/contacts';
import { recentEmails } from '@/lib/email';
import { mailMode } from '@/lib/env';
import { inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { ROSTER_FILTERS } from '@/lib/speakers';
import { ComposeForm } from './ComposeForm';
import { announcementAudience } from './recipients';

/**
 * Every message this app has sent, newest first.
 *
 * Dynamic because the question it answers is "did that go out", asked seconds
 * after pressing send, and a cached copy answers it wrong.
 */
export const dynamic = 'force-dynamic';

/**
 * Slug to sentence. The slug is what the reminder and award actions dedupe on
 * and what a `kind = '...'` query needs, so it stays on the row beside its
 * gloss rather than being replaced by it. A kind with no entry here shows as
 * itself, which is what a new template should look like until someone names it.
 */
const KIND_LABELS: Record<string, string> = {
  attendance_declined: 'Speaker declined',
  award_winner: 'Award won',
  bulk_announcement: 'Announcement',
  content_returned: 'Slides returned',
  decision_accepted: 'Accepted',
  decision_rejected: 'Rejected',
  reviewer_reminder: 'Reviewer nudged',
  schedule_cancelled: 'Taken off the grid',
  schedule_moved: 'Moved',
  schedule_scheduled: 'Scheduled',
  speaker_invite: 'Invited to speak',
  submission_alert: 'New proposal (to organizers)',
  submission_received: 'Proposal received',
  submission_withdrawn: 'Withdrawn',
  task_reminder: 'Task due',
};

export default async function EmailLogScreen({
  searchParams,
}: {
  searchParams: Promise<ContactSearchParams>;
}) {
  // The same parser the contact directory uses, because "Email these people" is
  // a link off that screen and it carries all five filters. Reading only `q` and
  // `filter` here meant a directory narrowed to one tag handed the composer an
  // audience wider than the list the organizer had just been looking at.
  const filters = parseContactFilters(await searchParams);
  const q = filters.q ?? '';
  const filter = filters.preset;
  const narrowedBeyondTheForm = activeContactCriteria(filters).filter(
    (chip) => chip.key !== 'q' && chip.key !== 'filter',
  );

  const [event, sent, audience] = await Promise.all([
    getEvent(),
    recentEmails(),
    announcementAudience(filters),
  ]);
  const mode = mailMode();
  const delivered = sent.filter((row) => row.delivered).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Email"
        description="Write to the speakers, and read back every message this app has sent but the sign-in link."
      />

      {/* Which of the two reasons, named exactly, because the fix is a
          different line of `.env.local` for each and a notice that guesses
          sends its reader to edit the wrong one. */}
      {mode === 'live' ? null : (
        <Notice tone="warn">
          <span data-testid="mail-not-live">
            {mode === 'no-key' ? (
              <>
                <code className="rounded bg-amber-100 px-1">RESEND_API_KEY</code> is unset, so
                nothing has left this machine and every row below reads as undelivered.
              </>
            ) : (
              <>
                <code className="rounded bg-amber-100 px-1">MAIL_NOTIFICATIONS=off</code>, so
                notifications are being written to disk instead of sent and every row below reads as
                undelivered. Sign-in links are exempt and still go out.
              </>
            )}{' '}
            The messages are in <code className="rounded bg-amber-100 px-1">.mail/</code>, one file
            each.
          </span>
        </Notice>
      )}

      {/* Open rather than behind a `<details>`, unlike the panels on the roster
          screen. This is the only way to write to speakers in bulk, and a
          disclosure triangle is a control somebody has to already know is worth
          pressing. */}
      <Card id="compose" className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Compose</h2>
          <p className="mt-1 text-sm text-muted">
            One message, one personalized copy per speaker. Choose who with the saved views and the
            search box, then narrow further by unticking anyone below.
          </p>
        </div>

        {/* A GET form, so a chosen audience is a linkable URL and so the compose
            form beneath it can post the same two values back for the action to
            re-resolve. The same bargain the roster screen makes. */}
        <form method="get" className="flex flex-wrap items-end gap-2">
          {/* Whatever the directory narrowed by and this form has no control
              for, carried so that pressing Apply keeps it. Dropping them here
              would widen the audience on the organizer's next keystroke, which
              is the same defect as never having read them. They are listed
              under the form so the narrowing is visible, and each chip is a
              link that takes only itself away. */}
          {narrowedBeyondTheForm.map((chip) => {
            const value = filters[chip.key as 'company' | 'title' | 'tag'];
            return value ? (
              <input key={chip.key} type="hidden" name={chip.key} value={value} />
            ) : null;
          })}
          <div className="min-w-56 flex-1">
            <Input
              name="q"
              defaultValue={q}
              placeholder="Search name, email, job title or company"
              aria-label="Search speakers"
              data-testid="audience-search"
            />
          </div>
          <Select
            name="filter"
            defaultValue={filter}
            aria-label="Recipient filter"
            className="w-auto"
            data-testid="audience-filter"
          >
            {Object.entries(ROSTER_FILTERS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {contactFilterQuery(filters) ? (
            <Link href="/organizer/email" className="px-2 py-2 text-sm text-muted hover:text-ink">
              Clear
            </Link>
          ) : null}
        </form>

        {narrowedBeyondTheForm.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 text-xs text-muted"
            data-testid="audience-inherited-filters"
          >
            <span>Narrowed from the contact directory by</span>
            {narrowedBeyondTheForm.map((chip) => (
              <Link
                key={chip.key}
                href={`/organizer/email?${contactFilterQuery(filters, { [chip.key]: null })}`}
                className="rounded-full border border-line px-2 py-0.5 text-ink hover:bg-slate-50"
                data-testid={`audience-chip-${chip.key}`}
              >
                {chip.label} ×
              </Link>
            ))}
          </div>
        ) : null}

        {/* Keyed on the scope. The tick boxes start as a copy of whoever the
            filter resolved to, and `useState` keeps its first value across a
            prop change, so without this a new filter would leave the old
            selection sitting underneath a new list. */}
        <ComposeForm
          key={contactFilterQuery(filters)}
          filters={filters}
          recipients={audience}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-ink">History</h2>
        <p className="mb-3 text-sm text-muted">
          <span data-testid="email-count">{sent.length}</span> message(s), {delivered} delivered.
          The most recent 200.
        </p>

        {sent.length === 0 ? (
          <Empty>
            Nothing has been sent yet.{' '}
            <Link href="#compose" className="text-accent hover:underline">
              Compose a message
            </Link>
            .
          </Empty>
        ) : (
          <ul className="space-y-2" data-testid="email-list">
            {sent.map((row) => (
              <li
                key={row.id}
                data-testid={`email-row-${row.id}`}
                className="flex flex-wrap items-start justify-between gap-2 border-b border-line/60 pb-2 text-sm last:border-0"
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink" data-testid="email-subject">
                    {row.subject}
                  </p>
                  <p className="text-xs text-muted">
                    {row.recipientName ? `${row.recipientName} · ` : ''}
                    <span data-testid="email-recipient">{row.recipientEmail}</span>
                    {' · '}
                    {inEventZone(row.sentAt, event.timezone, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {row.submissionId && row.submissionTitle ? (
                      <>
                        {' · '}
                        <Link
                          href={`/organizer/abstracts/${row.submissionId}`}
                          className="text-accent hover:underline"
                        >
                          {row.submissionTitle}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <code className="text-xs text-muted" data-testid="email-kind">
                    {row.kind}
                  </code>
                  <Badge tone="neutral">{KIND_LABELS[row.kind] ?? row.kind}</Badge>
                  <Badge tone={row.delivered ? 'good' : 'warn'}>
                    {row.delivered ? 'delivered' : 'not sent'}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
