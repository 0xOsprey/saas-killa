/**
 * One UUID-shape guard for every id that arrives from the address bar.
 *
 * Postgres raises `22P02 invalid input syntax for type uuid` the moment a
 * non-uuid string reaches a uuid column, and an unhandled 22P02 inside a server
 * component is a 500 rather than a missing page. Every id in this app arrives
 * either as a path segment or as a query parameter, and both are hand-editable,
 * crawlable and linkable — so the shape has to be checked before the value
 * reaches a query, never after.
 *
 * The two callers want opposite failure modes, and both live here so that
 * neither gets re-derived (and re-argued) per route:
 *
 *   - A bad *segment* is a page that does not exist. `/organizer/files/exports`
 *     is a URL someone typed or a crawler guessed, so `isUuid` returning false
 *     means `notFound()` — the same 404 the route already returns for a
 *     well-formed id with no row behind it.
 *   - A bad *filter* is a stale bookmark or a renamed preset, which has to
 *     degrade to the unfiltered list. 404-ing a directory because one query
 *     parameter rotted would lose the page a reader could still use, so
 *     `uuidOrNull` gives back "no filter" instead.
 *
 * The regex, not `z.string().uuid()`: this is a shape check on untrusted text
 * on the read path of every list page, and the two forms disagree on nothing
 * that matters here. Existing zod call sites are fine as they are.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether this string can be handed to a uuid column without raising 22P02. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * A usable uuid from one query parameter, or null when there is not one.
 *
 * Takes `string[]` as well because Next hands back an array whenever a key is
 * repeated in the query string, and `?track=a&track=b` is exactly the sort of
 * hand-edited URL this guard exists for. First value wins, matching the `first`
 * helpers in `agenda-filters.ts` and `contacts.ts`.
 */
export function uuidOrNull(value: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return isUuid(trimmed) ? trimmed : null;
}

/** The uuids from a list, dropping anything that would not survive the cast. */
export function uuidsOnly(values: readonly string[]): string[] {
  return values.filter(isUuid);
}
