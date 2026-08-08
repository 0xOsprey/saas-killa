import { AuthorListView } from '@/components/AuthorList';
import { Empty, LinkButton, PageHeader } from '@/components/ui';
import { acceptedForBook, authorsForMany, withSpeakerFallback, type BookRow } from '@/lib/abstracts';
import { FORMAT_LABELS } from '@/lib/format';
import { getEvent } from '@/lib/queries';

/**
 * Print rules rather than a separate stylesheet: the book is the same DOM as the
 * screen page, minus the chrome. Sections break onto a fresh page and an entry
 * is kept whole, because an abstract split across a page turn is the one thing
 * that makes a printed programme unusable.
 */
const PRINT_CSS = `
@media print {
  header, nav, .no-print { display: none !important; }
  body { background: #fff; }
  .book-track { break-before: page; page-break-before: always; }
  .book-track:first-of-type { break-before: auto; page-break-before: auto; }
  .book-entry { break-inside: avoid; page-break-inside: avoid; }
}
`;

function groupByTrack(rows: BookRow[]): { track: string; rows: BookRow[] }[] {
  const groups: { track: string; rows: BookRow[] }[] = [];
  for (const row of rows) {
    const track = row.trackName ?? 'Unassigned';
    const last = groups.at(-1);
    if (last && last.track === track) last.rows.push(row);
    else groups.push({ track, rows: [row] });
  }
  return groups;
}

export default async function AbstractBookPage() {
  const [event, rows] = await Promise.all([getEvent(), acceptedForBook()]);
  const authors = await authorsForMany(rows.map((row) => row.id));
  const groups = groupByTrack(rows);

  return (
    <div className="space-y-6">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print">
        <PageHeader
          title="Abstract book"
          description={`${rows.length} accepted submission(s) across ${groups.length} track(s). Print from your browser.`}
          action={
            <LinkButton href="/organizer/abstracts" variant="secondary">
              All abstracts
            </LinkButton>
          }
        />
      </div>

      <header className="border-b border-line pb-4">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{event.name}</h1>
        {event.tagline ? <p className="mt-1 text-sm text-muted">{event.tagline}</p> : null}
      </header>

      {rows.length === 0 ? <Empty>Nothing has been accepted yet.</Empty> : null}

      {groups.map((group) => (
        <section key={group.track} className="book-track space-y-5 pt-2">
          <h2 className="border-b border-line pb-1 text-lg font-semibold text-ink">
            {group.track}
          </h2>

          {group.rows.map((row) => (
            <article key={row.id} className="book-entry space-y-2">
              <h3 className="text-base font-medium text-ink">{row.title}</h3>
              <AuthorListView
                authors={withSpeakerFallback(authors.get(row.id) ?? [], {
                  userId: row.speakerId,
                  name: row.speakerName,
                  email: row.speakerEmail,
                })}
              />
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                {row.abstract}
              </p>
              <p className="text-xs text-muted">
                {FORMAT_LABELS[row.format]}
                {row.keywords.length > 0 ? ` · ${row.keywords.join(', ')}` : ''}
              </p>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
