import Link from 'next/link';
import { Badge, Button, Card, Empty, Notice } from '@/components/ui';
import { describeMove, type DuplicateGroup, type MergePlan } from '@/lib/contact-import';
import { inEventZone } from '@/lib/format';
import { billing } from '@/lib/speakers';
import { mergeContactsAction } from './actions';

export type MergeReturn = '/organizer/contacts/import' | '/organizer/contacts/pipeline';

/**
 * Contacts who share a name, and the merge that puts them back together.
 *
 * Rendered on the import screen and on the board, because those are the two
 * places a duplicate is made and the two places somebody notices one. Both
 * pass their own path as `returnTo`, so the merge lands back where it was
 * pressed.
 *
 * A server component with plain forms: the confirm step is a link to the same
 * page with the pair in the query string, so an organizer can read the
 * comparison, leave, and come back to the same screen from the address bar.
 */
export function Duplicates({
  groups,
  plan,
  timezone,
  returnTo,
}: {
  groups: DuplicateGroup[];
  plan: MergePlan | null;
  timezone: string;
  returnTo: MergeReturn;
}) {
  if (plan) return <MergeConfirm plan={plan} returnTo={returnTo} />;

  return (
    <section className="space-y-3" id="duplicates">
      <div>
        <h2 className="text-lg font-semibold text-ink">Possible duplicates</h2>
        <p className="text-sm text-muted">
          Contacts who share a name and do not share an email address. Two different people can
          share a name, so nothing here is merged for you.
        </p>
      </div>

      {groups.length === 0 ? (
        <Empty>
          <span data-testid="no-duplicates">No two contacts share a name.</span>
        </Empty>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <Card key={group.name} className="space-y-3" data-testid="duplicate-group">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-ink">{group.name}</h3>
                <Badge tone="warn">{group.contacts.length} records</Badge>
              </div>

              <ul className="space-y-2">
                {group.contacts.map((contact) => (
                  <li
                    key={contact.id}
                    className="rounded-md border border-line p-3 text-sm"
                    data-testid="duplicate-record"
                  >
                    <p className="font-medium text-ink">{contact.email}</p>
                    <p className="text-muted">
                      {billing(contact.title, contact.company) ?? 'No job title or company'}
                    </p>
                    <p className="text-xs text-muted">
                      Added {inEventZone(contact.createdAt, timezone, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                      {contact.submissions > 0 ? ` · ${contact.submissions} submission(s)` : ''}
                      {contact.onBoard ? ' · on the pipeline board' : ''}
                    </p>

                    <div className="mt-2 flex flex-wrap gap-2">
                      {group.contacts
                        .filter((other) => other.id !== contact.id)
                        .map((other) => (
                          <Link
                            key={other.id}
                            href={`${returnTo}?merge=${contact.id}&drop=${other.id}`}
                            className="text-xs text-accent hover:underline"
                            data-testid="merge-into"
                          >
                            Keep this one, merge {other.email} into it
                          </Link>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The comparison, and the button that cannot be taken back.
 *
 * Everything that will move is counted before the press rather than reported
 * after it. A merge that says "done" and leaves an organizer to work out what
 * happened to four submissions is a merge nobody runs twice.
 */
function MergeConfirm({ plan, returnTo }: { plan: MergePlan; returnTo: MergeReturn }) {
  const moving = describeMove(plan.drop);

  return (
    <section className="space-y-3" id="duplicates">
      <h2 className="text-lg font-semibold text-ink">Merge two contacts</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="space-y-1" data-testid="merge-keep">
          <Badge tone="good">Kept</Badge>
          <p className="font-medium text-ink">{plan.keep.name ?? plan.keep.email}</p>
          <p className="text-sm text-muted">{plan.keep.email}</p>
          <p className="text-sm text-muted">
            {billing(plan.keep.title, plan.keep.company) ?? 'No job title or company'}
          </p>
          <p className="text-xs text-muted">
            {describeMove(plan.keep).join(', ') || 'Nothing linked to it yet'}
          </p>
        </Card>
        <Card className="space-y-1" data-testid="merge-drop">
          <Badge tone="bad">Deleted</Badge>
          <p className="font-medium text-ink">{plan.drop.name ?? plan.drop.email}</p>
          <p className="text-sm text-muted">{plan.drop.email}</p>
          <p className="text-sm text-muted">
            {billing(plan.drop.title, plan.drop.company) ?? 'No job title or company'}
          </p>
          <p className="text-xs text-muted">
            {moving.join(', ') || 'Nothing linked to it yet'}
          </p>
        </Card>
      </div>

      {plan.blockers.length > 0 ? (
        <Notice tone="bad">
          <div className="space-y-1" data-testid="merge-blocked">
            <p className="font-medium">This merge will not run.</p>
            {plan.blockers.map((blocker) => (
              <p key={blocker}>{blocker}</p>
            ))}
          </div>
        </Notice>
      ) : (
        <Notice tone="warn">
          <div className="space-y-2" data-testid="merge-confirm">
            <p>
              {moving.length === 0
                ? `Nothing is linked to ${plan.drop.email}, so only the record itself goes.`
                : `${moving.join(', ')} will move onto ${plan.keep.email}. Then ${plan.drop.email} is deleted.`}{' '}
              Anything the kept record leaves blank is filled in from the one being deleted. This
              cannot be undone.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <form action={mergeContactsAction}>
                <input type="hidden" name="keep" value={plan.keep.id} />
                <input type="hidden" name="drop" value={plan.drop.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="confirm" value="yes" />
                <Button type="submit" variant="danger" data-testid="merge-submit">
                  Merge and delete {plan.drop.email}
                </Button>
              </form>
              <Link href={returnTo} className="text-sm text-accent hover:underline">
                Keep both
              </Link>
            </div>
          </div>
        </Notice>
      )}

      {plan.blockers.length > 0 ? (
        <Link href={returnTo} className="text-sm text-accent hover:underline">
          Back
        </Link>
      ) : null}
    </section>
  );
}
