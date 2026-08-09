import Link from 'next/link';
import { Badge, Card, Empty, Notice, PageHeader } from '@/components/ui';
import { mailIsLive, recentEmails } from '@/lib/email';
import { inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';

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

export default async function EmailLogScreen() {
  const [event, sent] = await Promise.all([getEvent(), recentEmails()]);
  const live = mailIsLive();
  const delivered = sent.filter((row) => row.delivered).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Email log"
        description="Every message but the sign-in link, which is authentication rather than correspondence."
      />

      {live ? null : (
        <Notice tone="warn">
          <span data-testid="mail-not-live">
            <code className="rounded bg-amber-100 px-1">RESEND_API_KEY</code> is unset, so nothing
            has left this machine and every row below reads as undelivered. The messages are in{' '}
            <code className="rounded bg-amber-100 px-1">.mail/</code>, one file each.
          </span>
        </Notice>
      )}

      <Card>
        <p className="mb-3 text-sm text-muted">
          <span data-testid="email-count">{sent.length}</span> message(s), {delivered} delivered.
          The most recent 200.
        </p>

        {sent.length === 0 ? (
          <Empty>Nothing has been sent yet.</Empty>
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
