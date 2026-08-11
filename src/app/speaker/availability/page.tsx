import { asc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { speakerAvailability } from '@/db/schema';
import { Button, Card, Empty, LinkButton, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { dayLabel, timeOfDay } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { AvailabilityForm } from './AvailabilityForm';
import { removeAvailabilityBlock } from './actions';

/**
 * The speaker's own view of when they cannot be scheduled.
 *
 * `speaker_availability` had exactly one writer before this screen, and it was
 * the organizer's. The conflict checker on the schedule grid has always read the
 * table — it is the point of the table — so the detector worked and the data had
 * no way in except an organizer typing what a speaker told them by email.
 *
 * Every query here is scoped to the session's own id, which is also what makes
 * an organizer-entered block editable: the rows are keyed by the speaker they
 * are about, not by whoever typed them. See the comment in `actions.ts` for why
 * that is the answer rather than an origin column.
 */
export default async function SpeakerAvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ removed?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const [event, blocks, params] = await Promise.all([
    getEvent(),
    db
      .select()
      .from(speakerAvailability)
      .where(eq(speakerAvailability.userId, user.id))
      .orderBy(asc(speakerAvailability.startsAt)),
    searchParams,
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="When you are not available"
        description={`Times the organizers should not schedule you at ${event.name}. All times are ${event.timezone}.`}
        action={
          <LinkButton href="/speaker" variant="secondary">
            My submissions
          </LinkButton>
        }
      />

      {params.removed ? (
        <Notice tone="accent">
          <span data-testid="availability-flash">Block removed.</span>
        </Notice>
      ) : null}

      {/* Said plainly, because the alternative reading is the dangerous one: a
          speaker who thinks this blocks the grid will not check the time they
          are eventually given. */}
      <Notice>
        This is a request, not a lock. The organizers can still place a talk
        inside one of these windows; the grid warns them and they may know
        something a note here does not.
      </Notice>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Your blocks</h2>

        {blocks.length === 0 ? (
          <Empty>
            Nothing recorded.{' '}
            <a href="#add-availability" className="text-accent hover:underline">
              Add a window
            </a>{' '}
            below and the schedule will flag anything placed inside it.
          </Empty>
        ) : (
          <ul className="space-y-2" data-testid="availability-list">
            {blocks.map((block) => (
              <li
                key={block.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3"
                data-testid={`availability-${block.id}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {dayLabel(block.startsAt, event.timezone)} ·{' '}
                    {timeOfDay(block.startsAt, event.timezone)} to{' '}
                    {timeOfDay(block.endsAt, event.timezone)}
                  </p>
                  {block.note ? <p className="text-xs text-muted">{block.note}</p> : null}
                </div>
                <form action={removeAvailabilityBlock}>
                  <input type="hidden" name="availabilityId" value={block.id} />
                  {/*
                    No confirmation. Nothing is lost that the form directly above
                    cannot put back in one press, which is the same rule the
                    destructive organizer actions are held to from the other
                    direction.
                  */}
                  <Button
                    type="submit"
                    variant="ghost"
                    className="text-xs"
                    data-testid={`availability-remove-${block.id}`}
                  >
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line pt-4">
          <AvailabilityForm timezone={event.timezone} />
        </div>
      </Card>
    </div>
  );
}
