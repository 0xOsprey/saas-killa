import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { submissions, userRoles, users } from '@/db/schema';
import { Badge, Button, Card, Empty, PageHeader } from '@/components/ui';
import { grantRoleAction, revokeRoleAction } from './actions';

export default async function SpeakersPage() {
  const people = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      bio: users.bio,
      isBot: users.isBot,
      roles: sql<string[]>`coalesce(array_agg(distinct ${userRoles.role}) filter (where ${userRoles.role} is not null), '{}')`,
      total: sql<number>`count(distinct ${submissions.id})::int`,
      accepted: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.status} = 'accepted')::int`,
      confirmed: sql<number>`count(distinct ${submissions.id}) filter (where ${submissions.speakerConfirmedAt} is not null)::int`,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(submissions, eq(submissions.speakerId, users.id))
    .groupBy(users.id)
    .orderBy(asc(users.email));

  const withAccepted = people.filter((p) => p.accepted > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Speakers"
        description={`${people.length} account(s) · ${withAccepted.length} with an accepted talk`}
      />

      {people.length === 0 ? <Empty>No accounts yet.</Empty> : null}

      <div className="space-y-2">
        {people.map((person) => {
          const missingBio = person.accepted > 0 && !person.bio;
          const unconfirmed = person.accepted > person.confirmed;
          return (
            <Card key={person.id} className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">
                  {person.name ?? 'Unnamed'}{' '}
                  {person.isBot ? <Badge tone="accent">bot</Badge> : null}
                </p>
                <p className="text-xs text-muted">{person.email}</p>
                <p className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                  <span>
                    {person.total} submitted · {person.accepted} accepted
                  </span>
                  {missingBio ? <Badge tone="warn">bio missing</Badge> : null}
                  {unconfirmed ? <Badge tone="warn">not confirmed</Badge> : null}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {person.roles.map((role) => (
                  <form action={revokeRoleAction} key={role}>
                    <input type="hidden" name="userId" value={person.id} />
                    <input type="hidden" name="role" value={role} />
                    <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                      {role} ✕
                    </Button>
                  </form>
                ))}
                {(['reviewer', 'organizer'] as const)
                  .filter((role) => !person.roles.includes(role))
                  .map((role) => (
                    <form action={grantRoleAction} key={role}>
                      <input type="hidden" name="userId" value={person.id} />
                      <input type="hidden" name="role" value={role} />
                      <Button
                        type="submit"
                        variant="secondary"
                        className="px-2 py-1 text-xs"
                        data-testid={`grant-${role}-${person.email}`}
                      >
                        + {role}
                      </Button>
                    </form>
                  ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
