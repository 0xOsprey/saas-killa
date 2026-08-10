import { Notice, PageHeader } from '@/components/ui';
import { duplicateGroups, mergePlan } from '@/lib/contact-import';
import { getEvent } from '@/lib/queries';
import { Duplicates } from './Duplicates';
import { ImportForm } from './ImportForm';

/**
 * Bring a contact list in, then clean up after it.
 *
 * The duplicate panel is on this screen rather than behind a link, because an
 * import is the act that makes duplicates: a list from somebody else's export
 * carries the same person under the address they use at their new employer, and
 * the email is the only thing this app can tell them apart by.
 */
export default async function ImportScreen({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; merged?: string; merge?: string; drop?: string }>;
}) {
  const params = await searchParams;
  const [event, groups] = await Promise.all([getEvent(), duplicateGroups()]);
  const plan = params.merge && params.drop ? await mergePlan(params.merge, params.drop) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Import contacts"
        description="A CSV of people, matched to the directory by email address. Contacts are the organization's, not this event's, so an import is a list of everyone you might ever invite."
      />

      {params.error ? (
        <Notice tone="bad">
          <span data-testid="import-merge-error">{params.error}</span>
        </Notice>
      ) : null}
      {params.merged ? (
        <Notice tone="good">
          <span data-testid="import-merged">{params.merged}</span>
        </Notice>
      ) : null}

      <ImportForm />

      <Duplicates
        groups={groups}
        plan={plan}
        timezone={event.timezone}
        returnTo="/organizer/contacts/import"
      />
    </div>
  );
}
