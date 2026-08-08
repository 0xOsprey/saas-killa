import { LinkButton, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { dayLabel } from '@/lib/format';
import { allTracks, cfpIsOpen, getEvent } from '@/lib/queries';
import { CfpForm } from './CfpForm';

export default async function CfpPage() {
  const [event, tracks, user] = await Promise.all([getEvent(), allTracks(), currentUser()]);

  if (!cfpIsOpen(event)) {
    return (
      <div className="space-y-4">
        <PageHeader title="Call for papers" />
        <Notice>
          The call closed on {dayLabel(event.cfpClosesAt, event.timezone)}.
        </Notice>
        <LinkButton href="/agenda" variant="secondary">
          See the agenda
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Submit a proposal"
        description={`Open until ${dayLabel(event.cfpClosesAt, event.timezone)}. Reviewers grade abstracts without seeing who wrote them.`}
      />
      <CfpForm
        tracks={tracks}
        knownEmail={user?.email ?? null}
        knownName={user?.name ?? null}
        knownBio={user?.bio ?? null}
      />
    </div>
  );
}
