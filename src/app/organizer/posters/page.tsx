import Link from 'next/link';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader } from '@/components/ui';
import { posterGalleryGate } from '@/lib/poster';
import { organizerPosters } from '@/lib/poster-queries';
import { inEventZone } from '@/lib/format';
import { getEvent } from '@/lib/queries';
import { autoNumberBoards, setBoardNumber } from './actions';

/**
 * Board numbers and what the hall is actually getting looked at.
 *
 * Bookmarks are the engagement figure. There is no view counter and no table to
 * put one in, and a number invented from page renders would be worse than
 * honest silence — a bookmark is a deliberate act by a named account, so it
 * carries a meaning a hit count does not.
 */
export default async function OrganizerPostersPage() {
  const [event, rows] = await Promise.all([getEvent(), organizerPosters()]);

  const numbered = rows.filter((row) => row.boardNumber).length;
  const withoutArtwork = rows.filter((row) => !row.posterUrl).length;
  const hidden = rows.filter((row) => row.contentStatus === 'pending').length;
  const mostBookmarked = [...rows]
    .filter((row) => row.bookmarkCount > 0)
    .sort((a, b) => b.bookmarkCount - a.bookmarkCount)
    .slice(0, 10);

  const gate = posterGalleryGate(event, false);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Posters"
        description={`${rows.length} accepted poster(s) · ${numbered} numbered`}
        action={
          <form action={autoNumberBoards}>
            <Button type="submit" variant="secondary" data-testid="auto-number-boards">
              Auto-number in track order
            </Button>
          </form>
        }
      />

      {!gate.open ? (
        <Notice>
          {gate.reason === 'embargo'
            ? `The public gallery is embargoed until ${inEventZone(gate.opensAt, event.timezone, {
                dateStyle: 'long',
                timeStyle: 'short',
              })}. You can see it; nobody else can.`
            : 'The public gallery opens when the programme is published. You can see it; nobody else can.'}
        </Notice>
      ) : null}

      {withoutArtwork > 0 ? (
        <Notice>
          {withoutArtwork} accepted poster(s) have no artwork yet, so they do not appear in the
          gallery. They still need a board.
        </Notice>
      ) : null}

      {hidden > 0 ? (
        <Notice>
          {hidden} poster(s) are pending content moderation and are hidden from the public
          gallery.
        </Notice>
      ) : null}

      {rows.length === 0 ? <Empty>No accepted posters yet.</Empty> : null}

      {mostBookmarked.length > 0 ? (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Most bookmarked</h2>
            <p className="text-xs text-muted">
              Attendee stars, highest first. The table below stays in numbering order.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="pb-1 font-medium">Board</th>
                <th className="pb-1 font-medium">Poster</th>
                <th className="pb-1 text-right font-medium">Bookmarks</th>
              </tr>
            </thead>
            <tbody>
              {mostBookmarked.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="py-1.5 tabular-nums text-muted">{row.boardNumber ?? '—'}</td>
                  <td className="py-1.5">
                    <Link href={`/posters/${row.id}`} className="text-ink hover:underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-ink">
                    {row.bookmarkCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <div className="space-y-2">
        {rows.map((row) => (
          <Card
            key={row.id}
            className="flex flex-wrap items-center gap-3"
            style={{ borderLeft: `3px solid ${row.trackColour ?? '#cbd5e1'}` }}
          >
            <form
              action={setBoardNumber}
              className="flex items-center gap-1.5"
              data-testid={`board-form-${row.id}`}
            >
              <input type="hidden" name="submissionId" value={row.id} />
              <Input
                name="boardNumber"
                defaultValue={row.boardNumber ?? ''}
                placeholder="Board"
                maxLength={16}
                className="w-24"
                aria-label={`Board number for ${row.title}`}
              />
              <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                Save
              </Button>
            </form>

            <div className="min-w-0 flex-1">
              <Link href={`/posters/${row.id}`} className="font-medium text-ink hover:underline">
                {row.title}
              </Link>
              <p className="text-xs text-muted">
                {row.speakerName ?? 'Unnamed'}
                {row.trackName ? ` · ${row.trackName}` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {row.posterUrl ? null : <Badge tone="warn">no artwork</Badge>}
              {row.contentStatus === 'pending' ? <Badge tone="warn">awaiting moderation</Badge> : null}
              <Badge tone={row.bookmarkCount > 0 ? 'good' : 'neutral'}>
                {row.bookmarkCount} bookmark(s)
              </Badge>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
