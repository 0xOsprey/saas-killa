import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { demoMode } from '@/lib/demo';
import { DemoForm } from './DemoForm';

export default function DemoPage() {
  const mode = demoMode();
  if (mode === 'off') redirect('/');

  return (
    <div className="mx-auto max-w-md space-y-4 pt-8">
      <PageHeader
        title="Demo sign-in"
        description="Explore the organizer, reviewer and speaker portals with a demo account."
      />
      <DemoForm mode={mode} />
    </div>
  );
}
