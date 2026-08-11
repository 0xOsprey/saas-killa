import { Notice, PageHeader } from '@/components/ui';
import { LoginForm } from './LoginForm';

/**
 * Why the last sign-in attempt did not work. `/auth/verify` cannot render, it
 * can only redirect, so it hands the reason over on the query string. Before
 * this existed the page read only its own form state and threw both codes away:
 * a speaker whose link had expired landed on a login form that looked exactly
 * like a fresh one and had no idea the link was the problem.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  missing:
    'That sign-in link arrived without its token, so there was nothing to check. Some mail clients cut long links in half. Ask for a fresh one below and click it rather than retyping it.',
  expired:
    'That sign-in link has expired or has already been used. Links last 15 minutes and work once. Ask for another below.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? SIGN_IN_ERRORS[params.error] : undefined;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader
        title="Sign in"
        description="We email you a link. There is no password to remember or lose."
      />

      {error ? (
        <Notice tone="bad">
          <span data-testid="login-error">{error}</span>
        </Notice>
      ) : null}

      <LoginForm />
    </div>
  );
}
