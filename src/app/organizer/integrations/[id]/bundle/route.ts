import { runById } from '@/lib/accelevents';
import { NotAuthorised, requireRole } from '@/lib/auth';

/**
 * One run as JSON: every request it made, with the response.
 *
 * A route handler runs no layout, so the organizer gate that wraps the rest of
 * /organizer does not apply and the check is made explicitly. This is the door
 * a layout does not stand in front of.
 *
 * The bundle is what an organizer hands to Accelevents support when the two
 * systems disagree, which is why it is a file rather than a screen.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRole('organizer');
  } catch (error) {
    if (error instanceof NotAuthorised) {
      return new Response('Organizer access only.\n', { status: 403 });
    }
    throw error;
  }

  const { id } = await params;
  const run = await runById(id);
  if (!run) return new Response('No such run.\n', { status: 404 });

  // `baseUrl` is in here and the key is not, because the key was never written
  // to the row in the first place. There is nothing to redact at this end.
  const body = {
    id: run.id,
    target: run.target,
    mode: run.mode,
    status: run.status,
    baseUrl: run.baseUrl,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts: {
      tracks: run.trackCount,
      speakers: run.speakerCount,
      sessions: run.sessionCount,
    },
    error: run.error,
    requests: run.requests,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="accelevents-${run.id}.json"`,
      'cache-control': 'no-store',
    },
  });
}
