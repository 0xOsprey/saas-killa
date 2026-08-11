import { Card, LinkButton, PageHeader } from '@/components/ui';

/**
 * What a reader sees for an address that is not a page, and for anything that
 * calls `notFound()`. Several pages use `notFound()` as an access check rather
 * than a truth claim — a draft portal page, a submission that is not yours —
 * so this copy has to work when the thing does exist and is simply not for
 * them. Saying so any more precisely would turn the 404 into a way of asking
 * whether a proposal exists.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Nothing here"
        description="That address does not lead anywhere you can reach."
      />

      <Card className="space-y-4">
        <p className="text-sm text-ink" data-testid="not-found">
          The link may be old, or the page may not be published yet. If somebody sent it to you,
          ask them to check it, and sign in first if you have not.
        </p>

        <div className="flex flex-wrap gap-2">
          <LinkButton href="/agenda">The agenda</LinkButton>
          <LinkButton href="/login" variant="secondary">
            Sign in
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
