import { NotAuthorised, requireRole } from '@/lib/auth';
import { isRosterFilter, rosterCsv, speakerRoster } from '@/lib/speakers';

/**
 * The roster as a spreadsheet. A route handler runs no layout, so the organizer
 * gate that wraps the rest of /organizer does not apply here and the check is
 * made explicitly — this is the one door on the feature that a layout does not
 * stand in front of.
 *
 * It reads the same `q` and `filter` the roster page uses, so "export what I am
 * looking at" is the link on that page and needs no second set of controls.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireRole('organizer');
  } catch (error) {
    if (error instanceof NotAuthorised) {
      return new Response('Organizer access only.\n', { status: 403 });
    }
    throw error;
  }

  const params = new URL(request.url).searchParams;
  const filterParam = params.get('filter');
  const rows = await speakerRoster({
    q: params.get('q') ?? undefined,
    filter: isRosterFilter(filterParam) ? filterParam : 'all',
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(rosterCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="speaker-roster-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
