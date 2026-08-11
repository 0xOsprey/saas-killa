'use client';

import { useActionState } from 'react';
import { Button, Card, Field, Input, Notice } from '@/components/ui';
import { requestMagicLink, type LoginState } from './actions';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(requestMagicLink, {});

  return (
    <>
      {state.sent ? (
        <Notice tone="good">
          <span data-testid="magic-link-sent">
            If {state.sent} is a valid address, a sign-in link is on its way. It works once and
            expires in 15 minutes.
          </span>
        </Notice>
      ) : null}

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}

      <Card>
        <form action={action} className="space-y-4">
          <Field label="Email">
            <Input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              data-testid="login-email"
            />
          </Field>
          <Button type="submit" disabled={pending} data-testid="login-submit">
            {pending ? 'Sending…' : 'Email me a link'}
          </Button>
        </form>
      </Card>
    </>
  );
}
