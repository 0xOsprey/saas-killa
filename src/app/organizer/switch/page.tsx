'use client';

import { useActionState } from 'react';
import { Button, Card, Field, Notice, PageHeader, Select } from '@/components/ui';
import { impersonateRole } from './actions';

export default function OrganizerSwitchPage() {
  const [state, action, pending] = useActionState(impersonateRole, {});

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader
        title="Preview a portal"
        description="Switch to a demo account for any role. This is useful for testing the reviewer or speaker experience."
      />

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}

      <Card>
        <form action={action} className="space-y-4">
          <Field label="Role to preview">
            <Select name="role" required className="w-full">
              <option value="" disabled>
                Pick a role
              </option>
              <option value="reviewer">Reviewer</option>
              <option value="speaker">Speaker</option>
              <option value="organizer">Organizer</option>
            </Select>
          </Field>

          <Button type="submit" disabled={pending}>
            {pending ? 'Switching…' : 'Switch to demo account'}
          </Button>
        </form>
      </Card>

      <p className="text-xs text-muted">
        You will be signed in as the demo user for that role. Sign out and sign back in as yourself
        to return.
      </p>
    </div>
  );
}
