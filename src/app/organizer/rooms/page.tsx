import Link from 'next/link';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader } from '@/components/ui';
import {
  createRoom,
  createTrack,
  deleteRoom,
  deleteTrack,
  moveRoom,
  updateRoom,
  updateTrack,
} from './actions';
import { roomPlacements, roomsWithUsage, tracksWithUsage } from './queries';

/**
 * Rooms and tracks, the two lists the schedule grid is drawn from. Before this
 * page they were seed data an organizer had to reach into the database to
 * change, which is not a thing you ask someone to do the morning of an event.
 */
export default async function RoomsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [rooms, tracks] = await Promise.all([roomsWithUsage(), tracksWithUsage()]);

  const confirmRoomId = typeof params.confirmRoom === 'string' ? params.confirmRoom : null;
  const confirmTrackId = typeof params.confirmTrack === 'string' ? params.confirmTrack : null;
  const roomToDelete = rooms.find((room) => room.id === confirmRoomId);
  const trackToDelete = tracks.find((track) => track.id === confirmTrackId);
  const doomedTalks = roomToDelete ? await roomPlacements(roomToDelete.id) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rooms &amp; tracks"
        description="The grid's columns and the programme's colours."
        action={
          <Link href="/organizer/schedule" className="text-sm text-muted underline">
            Back to the schedule
          </Link>
        }
      />

      {roomToDelete ? (
        <Notice tone="bad">
          <div className="space-y-2" data-testid="confirm-delete-room">
            <p>
              Deleting {roomToDelete.name} destroys its {roomToDelete.slotCount} slot(s) and
              unplaces {roomToDelete.placedCount} talk(s)
              {doomedTalks.length > 0 ? `: ${doomedTalks.join(', ')}` : ''}. The talks return to the
              unscheduled pool; the slots do not come back.
            </p>
            <div className="flex items-center gap-3">
              <form action={deleteRoom}>
                <input type="hidden" name="id" value={roomToDelete.id} />
                <input type="hidden" name="confirm" value="yes" />
                <Button type="submit" variant="danger" data-testid="confirm-delete-room-submit">
                  Delete {roomToDelete.name}
                </Button>
              </form>
              <Link href="/organizer/rooms" className="text-sm text-muted underline">
                Keep it
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      {trackToDelete ? (
        <Notice tone="bad">
          <div className="space-y-2" data-testid="confirm-delete-track">
            <p>
              Deleting {trackToDelete.name} leaves {trackToDelete.submissionCount} submission(s)
              with no track. Nothing is rejected and nothing is unscheduled, but the grouping is
              gone and re-tagging them is by hand.
            </p>
            <div className="flex items-center gap-3">
              <form action={deleteTrack}>
                <input type="hidden" name="id" value={trackToDelete.id} />
                <input type="hidden" name="confirm" value="yes" />
                <Button type="submit" variant="danger" data-testid="confirm-delete-track-submit">
                  Delete {trackToDelete.name}
                </Button>
              </form>
              <Link href="/organizer/rooms" className="text-sm text-muted underline">
                Keep it
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Rooms ({rooms.length})</h2>

        {rooms.length === 0 ? <Empty>No rooms yet. Add the first one below.</Empty> : null}

        {rooms.map((room, index) => (
          <Card key={room.id} className="flex flex-wrap items-end gap-3">
            <form action={updateRoom} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={room.id} />
              <Field label="Name">
                <Input
                  name="name"
                  defaultValue={room.name}
                  required
                  maxLength={80}
                  className="w-56"
                  data-testid={`room-name-${room.id}`}
                />
              </Field>
              <Field label="Capacity" hint="Blank if you have not counted the seats.">
                <Input
                  name="capacity"
                  type="number"
                  min={1}
                  defaultValue={room.capacity ?? ''}
                  className="w-32"
                  data-testid={`room-capacity-${room.id}`}
                />
              </Field>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </form>

            <div className="flex items-end gap-1">
              <form action={moveRoom}>
                <input type="hidden" name="id" value={room.id} />
                <input type="hidden" name="direction" value="up" />
                <Button type="submit" variant="ghost" disabled={index === 0} title="Move left">
                  ←
                </Button>
              </form>
              <form action={moveRoom}>
                <input type="hidden" name="id" value={room.id} />
                <input type="hidden" name="direction" value="down" />
                <Button
                  type="submit"
                  variant="ghost"
                  disabled={index === rooms.length - 1}
                  title="Move right"
                >
                  →
                </Button>
              </form>
            </div>

            <span className="pb-2 text-xs text-muted">
              {room.slotCount} slot(s), {room.placedCount} placed
            </span>

            <form action={deleteRoom} className="ml-auto">
              <input type="hidden" name="id" value={room.id} />
              <Button type="submit" variant="danger" data-testid={`delete-room-${room.id}`}>
                Delete
              </Button>
            </form>
          </Card>
        ))}

        <Card className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Add a room</h3>
          <form action={createRoom} className="flex flex-wrap items-end gap-3">
            <Field label="Name">
              <Input name="name" required maxLength={80} className="w-56" data-testid="new-room-name" />
            </Field>
            <Field label="Capacity">
              <Input name="capacity" type="number" min={1} className="w-32" />
            </Field>
            <Button type="submit" variant="secondary" data-testid="add-room">
              Add room
            </Button>
          </form>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Tracks ({tracks.length})</h2>

        {tracks.length === 0 ? <Empty>No tracks yet. Add the first one below.</Empty> : null}

        {tracks.map((track) => (
          <Card key={track.id} className="flex flex-wrap items-end gap-3">
            <form action={updateTrack} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={track.id} />
              <Field label="Name">
                <Input
                  name="name"
                  defaultValue={track.name}
                  required
                  maxLength={80}
                  className="w-56"
                  data-testid={`track-name-${track.id}`}
                />
              </Field>
              <Field label="Colour">
                <Input
                  name="colour"
                  type="color"
                  defaultValue={track.colour}
                  className="h-10 w-20 p-1"
                  data-testid={`track-colour-${track.id}`}
                />
              </Field>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </form>

            <Badge className="mb-2" style={{ backgroundColor: `${track.colour}22`, color: track.colour }}>
              {track.submissionCount} submission(s)
            </Badge>

            <form action={deleteTrack} className="ml-auto">
              <input type="hidden" name="id" value={track.id} />
              <Button type="submit" variant="danger" data-testid={`delete-track-${track.id}`}>
                Delete
              </Button>
            </form>
          </Card>
        ))}

        <Card className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Add a track</h3>
          <form action={createTrack} className="flex flex-wrap items-end gap-3">
            <Field label="Name">
              <Input
                name="name"
                required
                maxLength={80}
                className="w-56"
                data-testid="new-track-name"
              />
            </Field>
            <Field label="Colour">
              <Input name="colour" type="color" defaultValue="#64748b" className="h-10 w-20 p-1" />
            </Field>
            <Button type="submit" variant="secondary" data-testid="add-track">
              Add track
            </Button>
          </form>
        </Card>
      </section>
    </div>
  );
}
