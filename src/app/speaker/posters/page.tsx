import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Notice,
  PageHeader,
} from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { STATUS_LABELS } from '@/lib/format';
import { myPosters } from '@/lib/poster-queries';
import { getEvent } from '@/lib/queries';
import { PosterKindBadge, PosterMedia } from '../../posters/PosterMedia';
import { savePosterUrl } from './actions';

const ERRORS: Record<string, string> = {
  url: 'That is not a URL we can link to. Paste the full address, including https://.',
  refused:
    'That poster was not updated. It is either not yours, not a poster, or its artwork has been frozen by an organizer.',
};

/**
 * Where a speaker points their own poster at its artwork.
 *
 * The preview is the same component the public gallery uses, so what a speaker
 * sees here is what the hall will show — a PDF that renders as a broken image
 * is a problem they can only fix if they are shown it before the conference.
 */
export default async function SpeakerPostersPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const [event, mine, params] = await Promise.all([
    getEvent(),
    myPosters(user.id),
    searchParams,
  ]);

  const error = params.error ? ERRORS[params.error] : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="My posters"
        description={`${user.email} · ${event.name}`}
        action={
          <Link href="/speaker" className="pt-2 text-sm text-muted hover:text-ink">
            All my submissions →
          </Link>
        }
      />

      {params.saved ? <Notice tone="good">Poster saved.</Notice> : null}
      {error ? (
        <Notice tone="bad">
          <span data-testid="poster-error">{error}</span>
        </Notice>
      ) : null}

      {mine.length === 0 ? (
        <Empty>
          You have no poster submissions. Only a submission filed as a poster can carry artwork.
        </Empty>
      ) : null}

      {mine.map((row) => {
        const locked = row.lockedFields.includes('posterUrl');
        return (
          <Card key={row.id} className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium text-ink">{row.title}</h2>
                <p className="mt-0.5 text-xs text-muted">
                  {STATUS_LABELS[row.status]}
                  {row.trackName ? ` · ${row.trackName}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {row.boardNumber ? (
                  <Badge tone="accent">Board {row.boardNumber}</Badge>
                ) : (
                  <Badge>Board not assigned</Badge>
                )}
                {row.posterUrl ? <PosterKindBadge url={row.posterUrl} /> : null}
              </div>
            </div>

            {row.posterUrl ? (
              <div className="space-y-1">
                <p className="text-xs text-muted">How the gallery will show it:</p>
                <PosterMedia url={row.posterUrl} title={row.title} variant="card" />
              </div>
            ) : (
              <p className="text-sm text-muted">No artwork yet.</p>
            )}

            {locked ? (
              <Notice>
                An organizer has frozen this poster&rsquo;s artwork. Ask them if it needs to
                change.
              </Notice>
            ) : (
              <form action={savePosterUrl} className="space-y-3">
                <input type="hidden" name="submissionId" value={row.id} />
                <Field
                  label="Poster URL"
                  hint="A PDF, an image or a video, hosted anywhere you can link to. Leave it empty to remove the artwork."
                >
                  <Input
                    name="posterUrl"
                    type="url"
                    defaultValue={row.posterUrl ?? ''}
                    placeholder="https://example.org/my-poster.pdf"
                    data-testid={`poster-url-${row.id}`}
                  />
                </Field>
                <Button type="submit" variant="secondary">
                  Save poster
                </Button>
              </form>
            )}

            {row.status === 'accepted' && row.posterUrl ? (
              <Link href={`/posters/${row.id}`} className="text-xs text-muted hover:text-ink">
                See it in the gallery →
              </Link>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
