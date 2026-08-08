import { redirect } from 'next/navigation';
import { LinkButton, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { ProfileForm } from './ProfileForm';

/**
 * The speaker's own profile. Anyone signed in may edit theirs, whatever roles
 * they hold; the action writes the session's own user id and no other.
 */
export default async function SpeakerProfilePage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="Your profile"
        description="Shown beside your talk on the public agenda."
        action={
          <LinkButton href="/speaker" variant="secondary">
            My submissions
          </LinkButton>
        }
      />
      <ProfileForm
        email={user.email}
        name={user.name}
        bio={user.bio}
        headshotUrl={user.headshotUrl}
      />
    </div>
  );
}
