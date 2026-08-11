import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select } from '@/components/ui';
import { Headshot } from '@/app/speakers/Headshot';
import {
  CONTACT_PRESETS,
  activeContactCriteria,
  contactDirectory,
  contactFacets,
  contactFilterQuery,
  contactKpis,
  contactSegmentList,
  hasActiveContactFilters,
  parseContactFilters,
  type ContactSearchParams,
} from '@/lib/contacts';
import { currentUser } from '@/lib/auth';
import { getEvent } from '@/lib/queries';
import { deleteContactSegmentAction, saveContactSegmentAction } from './actions';

/**
 * The organization's contact directory.
 *
 * This is not the roster at /organizer/speakers and the copy on the page says
 * so out loud. That screen answers "who is speaking at this conference" and is
 * correctly filed under the event; this one answers "who does this organization
 * know", spans every event the organization has ever run, and includes people
 * who have never submitted anything. Filing the directory under the event's
 * menu would make it the roster again with more columns.
 */

function Kpi({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card className="space-y-1">
      <p className="text-2xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="text-sm font-medium text-ink">{label}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </Card>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </th>
  );
}

export default async function ContactsDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<ContactSearchParams>;
}) {
  // The same guard `organizer/layout.tsx` runs, repeated here and ahead of the
  // queries on purpose. A layout and its page render concurrently, so a layout
  // that redirects still returns a 307 whose body carries whatever the page
  // finished rendering: signed out, `/organizer/speakers` answers with half a
  // megabyte of roster including every speaker's address. Redirecting before
  // the first query means there is no contact data in the response to leak.
  const viewer = await currentUser();
  if (!viewer) redirect('/login');
  if (!viewer.roles.includes('organizer')) return <Notice tone="bad">Organizer access only.</Notice>;

  const filters = parseContactFilters(await searchParams);
  const [event, contacts, facets, kpis, segments] = await Promise.all([
    getEvent(),
    contactDirectory(filters),
    contactFacets(),
    contactKpis(),
    contactSegmentList(),
  ]);

  const query = contactFilterQuery(filters);
  const criteria = activeContactCriteria(filters);
  const filtered = hasActiveContactFilters(filters);
  // A segment is "open" when the URL is exactly what it stored. Comparing the
  // serialized query rather than the parsed object because that is the thing
  // that was saved, so the banner cannot claim a segment is open while showing
  // a list narrowed by something the segment never asked for.
  const openSegment = segments.find((segment) => segment.query === query) ?? null;
  // The bars are proportional to the biggest company rather than to the total,
  // so a directory where no company has more than two people still reads as a
  // ranking instead of seven bars all one pixel wide.
  const topCompanyMax = kpis.topCompanies[0]?.count ?? 1;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contacts"
        description={`The organization's people, across every event. ${kpis.contacts} contact(s) on file; ${event.name} is one of the events they appear in, and this list is not scoped to it.`}
        action={
          <div className="max-w-72 space-y-1 text-right">
            <Link
              href={`/organizer/email${query ? `?${query}` : ''}`}
              className="inline-block rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
              data-testid="contacts-email-link"
            >
              Email these contacts
            </Link>
            {/* No caveat under this link any more. It used to warn that company,
                job title and tag did not reach the composer, which was true when
                the composer knew only `q` and `filter`. It now re-resolves its
                audience through `announcementAudience` → `contactDirectory` over
                the whole of `ContactFilters`, so every filter on this screen
                narrows the send the same way it narrows the list: a `tag=ai`
                directory hands the composer 2 recipients, unfiltered hands it 38.
                Leaving the warning up told an organizer to distrust a number
                that is now correct, which is its own way of causing the bulk
                send to everyone that it was written to prevent. */}
          </div>
        }
      />

      {/* Organization-wide, unlike the Overview screen, which counts one event's
          submissions and deadlines. Both numbers and both widgets read the whole
          contact database, so the total below is the same population the
          unfiltered table lists. */}
      <section className="space-y-3" aria-label="Organization-wide contact metrics">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Contacts"
            value={kpis.contacts}
            hint="Every person on file, across all events"
          />
          <Kpi
            label="With an accepted talk"
            value={kpis.withAcceptedTalk}
            hint="Have spoken or are booked to"
          />
          <Kpi label="Companies represented" value={kpis.companies} />
          <Kpi label="On the sourcing pipeline" value={kpis.onBoard} hint="Enrolled on the board" />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="space-y-2">
            <h2 className="text-sm font-semibold text-ink">Top companies by contact count</h2>
            {kpis.topCompanies.length === 0 ? (
              <Empty>No contact carries a company yet.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {kpis.topCompanies.map((row) => (
                  <li key={row.company} className="flex items-center gap-3 text-sm">
                    {/* Clickable, because the question after "who is our biggest
                        source of speakers" is always "which people". */}
                    <Link
                      href={`/organizer/contacts?${contactFilterQuery({ ...filters, company: row.company })}`}
                      className="w-48 shrink-0 truncate font-medium text-accent hover:underline"
                    >
                      {row.company}
                    </Link>
                    <span
                      className="h-2 rounded-full bg-accent"
                      style={{ width: `${Math.round((row.count / topCompanyMax) * 60)}%` }}
                    />
                    <span className="tabular-nums text-muted">{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-2">
            <h2 className="text-sm font-semibold text-ink">Contacts by pipeline stage</h2>
            {kpis.byStage.length === 0 ? (
              <Empty>
                The sourcing board has no stages yet. Create them on the{' '}
                <Link href="/organizer/contacts/pipeline" className="text-accent hover:underline">
                  pipeline
                </Link>{' '}
                page.
              </Empty>
            ) : (
              <ul className="space-y-1.5">
                {kpis.byStage.map((stage) => (
                  <li key={stage.id} className="flex items-center gap-3 text-sm">
                    <span className="w-48 shrink-0 truncate text-ink">{stage.name}</span>
                    <span
                      className="h-2 rounded-full bg-slate-300"
                      style={{
                        width: `${kpis.onBoard === 0 ? 0 : Math.round((stage.count / kpis.onBoard) * 60)}%`,
                      }}
                    />
                    <span className="tabular-nums text-muted">{stage.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      {/* A GET form: every filter belongs in the URL so a narrowed directory is
          a link somebody can paste, and so a saved segment is nothing more
          exotic than that link kept under a name. */}
      <Card className="space-y-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <Input
              name="q"
              defaultValue={filters.q ?? ''}
              placeholder="Search name, email, job title or company"
              aria-label="Search contacts"
              data-testid="contacts-search"
            />
          </div>
          <Select
            name="company"
            defaultValue={filters.company ?? ''}
            aria-label="Filter by company"
            className="w-auto"
            data-testid="contacts-filter-company"
          >
            <option value="">Any company</option>
            {facets.companies.map((company) => (
              <option key={company} value={company}>
                {company}
              </option>
            ))}
          </Select>
          <Select
            name="title"
            defaultValue={filters.title ?? ''}
            aria-label="Filter by job title"
            className="w-auto"
            data-testid="contacts-filter-title"
          >
            <option value="">Any job title</option>
            {facets.titles.map((title) => (
              <option key={title} value={title}>
                {title}
              </option>
            ))}
          </Select>
          <Select
            name="tag"
            defaultValue={filters.tag ?? ''}
            aria-label="Filter by tag"
            className="w-auto"
            data-testid="contacts-filter-tag"
          >
            <option value="">Any tag</option>
            {facets.tags.map((row) => (
              <option key={row.tag} value={row.tag}>
                {row.tag} ({row.count})
              </option>
            ))}
          </Select>
          <Select
            name="filter"
            defaultValue={filters.preset}
            aria-label="Saved view"
            className="w-auto"
            data-testid="contacts-filter-preset"
          >
            {Object.entries(CONTACT_PRESETS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {filtered ? (
            <Link
              href="/organizer/contacts"
              className="px-2 py-2 text-sm text-muted hover:text-ink"
              data-testid="contacts-clear"
            >
              Clear filters
            </Link>
          ) : null}
        </form>

        {criteria.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Showing {contacts.length} of {kpis.contacts} contacts, filtered by</span>
            {criteria.map((chip) => (
              <Badge key={chip.key} tone="accent" data-testid={`contacts-criterion-${chip.key}`}>
                {chip.label}
              </Badge>
            ))}
          </p>
        ) : null}

        {/* Save sits with the filters rather than in the segments list, because
            what is being saved is the state of this form and a control anywhere
            else would have to explain that. */}
        <form action={saveContactSegmentAction} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <input type="hidden" name="query" value={query} />
          <div className="min-w-48 flex-1">
            <Input
              name="name"
              placeholder="Name this segment, e.g. AI Experts"
              aria-label="Segment name"
              maxLength={80}
              data-testid="segment-name"
            />
          </div>
          <Button type="submit" variant="secondary" data-testid="segment-save">
            Save this segment
          </Button>
          <p className="basis-full text-xs text-muted">
            Segments are dynamic: what is stored is the filter, not the list of people it matches
            today, so a segment keeps answering its question as contacts are added and tagged.
          </p>
        </form>
      </Card>

      {segments.length > 0 ? (
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Saved segments</h2>
          <ul className="space-y-1.5" data-testid="segment-list">
            {segments.map((segment) => (
              <li key={segment.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href={`/organizer/contacts${segment.query ? `?${segment.query}` : ''}`}
                  className="font-medium text-accent hover:underline"
                  data-testid={`segment-open-${segment.id}`}
                >
                  {segment.name}
                </Link>
                <Badge tone="neutral">dynamic</Badge>
                {segment.id === openSegment?.id ? <Badge tone="good">open</Badge> : null}
                <span className="text-xs text-muted">
                  {segment.query || 'everyone'}
                  {segment.authorName ? ` · saved by ${segment.authorName}` : ''}
                </span>
                <form action={deleteContactSegmentAction} className="ml-auto">
                  <input type="hidden" name="segmentId" value={segment.id} />
                  <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                    Delete
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* The tag vocabulary, read back out of the tags themselves rather than
          kept in a second list an organizer has to curate. It is both the answer
          to "what do we tag people with" and the fastest way to apply one. */}
      {facets.tags.length > 0 ? (
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Tags in use</h2>
          <div className="flex flex-wrap gap-2">
            {facets.tags.map((row) => (
              <Link
                key={row.tag}
                href={`/organizer/contacts?${contactFilterQuery({ ...filters, tag: row.tag })}`}
                data-testid={`tag-chip-${row.tag}`}
              >
                <Badge tone={filters.tag === row.tag ? 'accent' : 'neutral'}>
                  {row.tag} · {row.count}
                </Badge>
              </Link>
            ))}
          </div>
          <p className="text-xs text-muted">
            Tags are added on a contact record. Removing the last one takes the tag out of this
            vocabulary, so there is no second place it has to be deleted from.
          </p>
        </Card>
      ) : null}

      {openSegment ? (
        <Notice tone="accent">
          <span data-testid="segment-open-banner">
            Viewing the saved segment “{openSegment.name}”: {contacts.length} contact(s) match it
            right now.
          </span>
        </Notice>
      ) : null}

      {contacts.length === 0 ? (
        <Empty>
          Nobody matches those filters.{' '}
          <Link href="/organizer/contacts" className="text-accent hover:underline">
            Clear the filters
          </Link>
          .
        </Empty>
      ) : (
        <>
          <p className="text-xs text-muted">Scroll to see more columns.</p>
          <Card className="overflow-x-auto p-0">
            <table className="w-full border-collapse text-sm">
            <thead className="border-b border-line bg-slate-50">
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Job title</Th>
                <Th>Company</Th>
                <Th>Tags</Th>
                <Th>Programme history</Th>
                <Th>Pipeline</Th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr
                  key={contact.id}
                  className="border-b border-line last:border-0 align-top hover:bg-slate-50"
                  data-testid={`contact-row-${contact.id}`}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Headshot src={contact.headshotUrl} name={contact.name} size="sm" />
                      <div className="min-w-0">
                        <Link
                          href={`/organizer/contacts/${contact.id}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {contact.name ?? 'Unnamed'}
                        </Link>
                        {contact.noteCount > 0 ? (
                          <p className="text-xs text-muted">{contact.noteCount} note(s)</p>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted">{contact.email}</td>
                  <td className="px-3 py-2 text-ink">{contact.title ?? '—'}</td>
                  <td className="px-3 py-2 text-ink">{contact.company ?? '—'}</td>
                  <td className="px-3 py-2">
                    {contact.tags.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {contact.tags.map((tag) => (
                          <Badge key={tag} tone="accent">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {contact.total === 0 ? (
                      'No submissions yet'
                    ) : (
                      <>
                        {contact.total} submitted · {contact.accepted} accepted
                        {contact.unconfirmed > 0 ? (
                          <>
                            {' '}
                            <Link
                              href={`/organizer/speakers/${contact.id}`}
                              className="inline-flex"
                              data-testid={`contact-unconfirmed-${contact.id}`}
                            >
                              <Badge tone="warn">{contact.unconfirmed} unconfirmed</Badge>
                            </Link>
                          </>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {contact.stageName ? (
                      <Badge tone="neutral">{contact.stageName}</Badge>
                    ) : (
                      <span className="text-muted">Not on the board</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </Card>
        </>
      )}
    </div>
  );
}
