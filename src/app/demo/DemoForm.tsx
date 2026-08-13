'use client';

import { useActionState } from 'react';
import { Button, Card, Field, Input, Notice, PageHeader, Select } from '@/components/ui';
import { demoLogin } from './actions';

export function DemoForm({ mode }: { mode: 'open' | 'secret' }) {
  const [state, action, pending] = useActionState(demoLogin, {});

  return (
    <>
      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}

      <Card>
        <form action={action} className="space-y-4">
          <Field label="Role">
            <Select name="role" required className="w-full">
              <option value="" disabled>
                Pick a demo role
              </option>
              <option value="organizer">Organizer</option>
              <option value="reviewer">Reviewer</option>
              <option value="speaker">Speaker</option>
            </Select>
          </Field>

          {mode === 'secret' ? (
            <Field label="Demo secret" hint="Ask the developer for the shared demo secret.">
              <Input
                name="secret"
                type="password"
                required
                autoComplete="off"
                placeholder="Enter the demo secret"
              />
            </Field>
          ) : null}

          <Button type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in to demo'}
          </Button>
        </form>
      </Card>

      <p className="text-xs text-muted">
        Demo accounts are fully interactive. Changes you make are real data on this instance.
      </p>
    </>
  );
}
