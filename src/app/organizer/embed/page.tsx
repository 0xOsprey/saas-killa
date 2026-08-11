import Link from 'next/link';
import { Button, Card, Field, Input, Notice, PageHeader, Select } from '@/components/ui';
import {
  EMPTY_FILTERS,
  agendaDays,
  agendaFilterQuery,
  parseAgendaFilters,
  type AgendaFilters,
} from '@/lib/agenda-filters';
import { AGENDA_FIELDS, EMBED_CSS, SPEAKER_FIELDS, esc, parseFields } from '@/lib/embed';
import { env } from '@/lib/env';
import { FORMAT_LABELS, LEVEL_LABELS } from '@/lib/format';
import { allRooms, allTracks, getEvent } from '@/lib/queries';

/**
 * The paste-this-into-your-website page.
 *
 * Everything here is a string an organizer copies, so the base URL is read from
 * `APP_URL` rather than hardcoded: a snippet carrying `127.0.0.1` would look
 * right on this screen and do nothing on their site.
 *
 * The configurator is a plain GET form, the same shape as the agenda filter bar
 * and for the same reason: the configuration IS the query string, so a
 * half-built embed is a URL an organizer can bookmark, send to whoever owns the
 * website, or reopen next month. There is no client component and no saved
 * "embed" row, because a widget has nothing to save. The div and the URL carry
 * their own settings, and a stored copy would be a second place for them to
 * disagree with what is actually pasted into the CMS.
 */

type Widget = 'agenda' | 'speakers';
type Style = 'script' | 'iframe' | 'json' | 'xml' | 'ics';

const WIDGETS: { value: Widget; label: string }[] = [
  { value: 'agenda', label: 'Schedule itinerary' },
  { value: 'speakers', label: 'Speaker gallery' },
];

/**
 * The delivery styles, and which widget each one exists for.
 *
 * iCal is agenda-only because a speaker is not an event: `/agenda/filtered.ics`
 * reads the same query string as the JSON feed, and there is no equivalent for
 * a person. Offering the choice and then serving a 404 would be worse than not
 * offering it.
 */
const STYLES: { value: Style; label: string; widgets: Widget[] }[] = [
  { value: 'script', label: 'Script tag (styled HTML)', widgets: ['agenda', 'speakers'] },
  { value: 'iframe', label: 'Iframe (whole document)', widgets: ['agenda', 'speakers'] },
  { value: 'json', label: 'JSON feed', widgets: ['agenda', 'speakers'] },
  { value: 'xml', label: 'XML feed', widgets: ['agenda', 'speakers'] },
  { value: 'ics', label: 'Calendar subscription (iCal)', widgets: ['agenda'] },
];

/**
 * The three custom properties `EMBED_CSS` leaves open for a host page.
 *
 * These are the whole of the branding surface, and the limit is deliberate: the
 * widget states every property it relies on so the host stylesheet cannot reach
 * in, which is the same wall that stops an organizer restyling it freely. Three
 * variables that genuinely drive the rendered widget beat a colour picker whose
 * settings mostly do nothing.
 */
const PALETTE = [
  { key: 'ink', variable: '--sb-ink', label: 'Text', fallback: '#0f172a' },
  { key: 'muted', variable: '--sb-muted', label: 'Secondary text', fallback: '#64748b' },
  { key: 'line', variable: '--sb-line', label: 'Card border', fallback: '#e2e8f0' },
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

function one(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * What the widget ships with today, read out of `EMBED_CSS` rather than copied.
 *
 * The baseline decides whether a chosen colour counts as an override, so a
 * hardcoded copy that drifted from the stylesheet would do one of two silent
 * things: emit a style block that changes nothing, or quietly revert a new
 * palette on every embed generated after it landed.
 */
function shippedColour(variable: string, fallback: string): string {
  const match = new RegExp(`${variable}:\\s*(#[0-9a-f]{3,8})`, 'i').exec(EMBED_CSS);
  return (match?.[1] ?? fallback).toLowerCase();
}

function Snippet({ id, code }: { id: string; code: string }) {
  return (
    <pre
      className="overflow-x-auto rounded-md border border-line bg-slate-50 p-3 text-xs leading-relaxed text-ink"
      data-testid={id}
    >
      <code>{code}</code>
    </pre>
  );
}

export default async function EmbedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const event = await getEvent();
  const [tracks, rooms, days] = await Promise.all([
    allTracks(),
    allRooms(),
    agendaDays(event.timezone),
  ]);
  const base = env().APP_URL;

  const widget: Widget = one(params.widget) === 'speakers' ? 'speakers' : 'agenda';

  // A style has to be valid *for this widget*, not merely spelled right: the
  // widget select and the style select submit together, so an organizer who
  // picks the calendar and then switches to the speaker gallery sends a pair
  // that has no route behind it.
  const askedStyle = one(params.style);
  const style: Style =
    STYLES.find((option) => option.value === askedStyle && option.widgets.includes(widget))
      ?.value ?? 'script';

  // Two filter sets, on purpose. `requested` is what the organizer typed and is
  // what the controls show, so switching widget and back does not lose a day
  // they picked. `filters` is what actually reaches the feed: the speaker
  // gallery is a directory of people and reads only `q` and `track`, so
  // carrying a room or a format into its snippet would promise a narrowing that
  // the feed drops on the floor.
  const requested: AgendaFilters = { ...parseAgendaFilters(params), mine: false };
  const filters: AgendaFilters =
    widget === 'speakers'
      ? { ...EMPTY_FILTERS, trackId: requested.trackId, q: requested.q }
      : requested;

  // The field list is the widget's own, and a selection is only worth spelling
  // out when it is a narrowing: all six ticked means the same thing as no
  // `fields=` at all, and the shorter URL is the one worth pasting. Absent is
  // also what every embed generated before this control existed carries, so the
  // two have to keep meaning the same thing.
  const fields = widget === 'agenda' ? AGENDA_FIELDS : SPEAKER_FIELDS;
  const selected = parseFields(params, fields);
  const chosenFields = fields.filter((field) => selected === null || selected.has(field.name));
  const fieldsParam =
    selected === null || chosenFields.length === fields.length
      ? null
      : chosenFields.map((field) => field.name).join(',');

  const filterQuery = agendaFilterQuery(filters);
  const query = [filterQuery, fieldsParam === null ? '' : `fields=${fieldsParam}`]
    .filter(Boolean)
    .join('&');
  const suffix = query ? `?${query}` : '';
  const previewSuffix = suffix ? `${suffix}&preview=1` : '?preview=1';
  const ignored =
    widget === 'speakers' &&
    Boolean(requested.day || requested.roomId || requested.format || requested.level);

  const palette = PALETTE.map((entry) => {
    const shipped = shippedColour(entry.variable, entry.fallback);
    const asked = one(params[entry.key]);
    return { ...entry, shipped, chosen: asked && HEX.test(asked) ? asked.toLowerCase() : shipped };
  });
  const branded = palette.filter((entry) => entry.chosen !== entry.shipped);

  // Specific enough to win wherever the organizer pastes it. The widget injects
  // its own `<style>` into the head at load, so a plain `.sb-embed` override
  // sitting in the head above it would lose the cascade on document order; an
  // element plus an attribute plus a class outranks the one class either way.
  const branding =
    branded.length > 0
      ? `<style>div[data-saas-killa] .sb-embed{${branded
          .map((entry) => `${entry.variable}:${entry.chosen}`)
          .join(';')}}</style>`
      : null;

  // The script embed reads its narrowing off `data-` attributes rather than a
  // URL, so the same filters have to be written twice in two encodings. A
  // search term is the one value here a human typed, and it lands in an HTML
  // attribute on somebody else's page: `esc` is what keeps a quote in it from
  // ending the attribute early.
  const pairs: [string, string | null][] = [
    ['data-day', filters.day],
    ['data-track', filters.trackId],
    ['data-room', filters.roomId],
    ['data-format', filters.format],
    ['data-level', filters.level],
    ['data-q', filters.q],
    ['data-fields', fieldsParam],
  ];
  const attributes = pairs
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .map(([name, value]) => ` ${name}="${esc(value)}"`)
    .join('');

  const script = [
    branding,
    `<div data-saas-killa="${widget}"${attributes}></div>`,
    `<script src="${base}/embed/embed.js" async></script>`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  // `esc` here turns the `&` between two filters into `&amp;`, which is the
  // correct spelling of an ampersand inside an HTML attribute and what the
  // host's browser reads straight back to `&`. The bare feed URLs below are not
  // markup, so they stay literal.
  const title = widget === 'agenda' ? `${event.name} schedule` : `${event.name} speakers`;
  const iframe = [
    `<iframe src="${base}/embed/${widget}${esc(suffix)}" title="${esc(title)}"`,
    '        style="width:100%;border:0;height:900px" loading="lazy"></iframe>',
  ].join('\n');

  const resize = [
    '<script>',
    'addEventListener("message", function (e) {',
    '  var h = e.data && e.data.saasKillaHeight;',
    '  if (h) document.querySelector("iframe[src*=\'/embed/\']").style.height = h + "px";',
    '});',
    '</script>',
  ].join('\n');

  const feed = `${base}/embed/${widget}.json${suffix}`;
  const xml = `${base}/embed/${widget}.xml${suffix}`;

  // The calendar takes the filters and not the fields. A VEVENT has a fixed
  // shape that a calendar client parses, so "hide the room" there would mean
  // emitting a deliberately incomplete event rather than a narrower one. It
  // also has its own stable unfiltered URL, which is the one worth handing
  // someone: `filtered.ics` with an empty query string is the same calendar
  // wearing a URL that looks conditional.
  const calendar = filterQuery
    ? `${base}/agenda/filtered.ics?${filterQuery}`
    : `${base}/agenda/calendar.ics`;

  const cleared = new URLSearchParams({ widget, style });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Embed on your own site"
        description="The speaker gallery and the schedule, on the conference website you already have."
        action={
          <a
            href="/embed/demo"
            target="_blank"
            rel="noopener"
            className="text-sm text-accent underline"
            data-testid="embed-demo-link"
          >
            Open the preview
          </a>
        }
      />

      {event.agendaPublished ? null : (
        <Notice>
          The public widget stays closed until the agenda is published, and it says so on the host
          page rather than rendering empty. The preview below uses your organizer sign-in to show
          the real data anyway, so you can configure it before it goes live. The snippets you copy
          never carry that sign-in, and they will show the closed notice to the public.
        </Notice>
      )}

      <Card className="space-y-4" data-testid="embed-configurator">
        <div>
          <h2 className="text-sm font-semibold text-ink">Build the embed</h2>
          <p className="mt-1 text-sm text-muted">
            Every choice below is in this page&rsquo;s own address bar, so a configured embed is a
            link you can send to whoever owns the website.
          </p>
        </div>

        <form method="get" action="/organizer/embed" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Widget">
              <Select name="widget" defaultValue={widget} data-testid="embed-widget">
                {WIDGETS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Embed style" hint="What the website can accept.">
              <Select name="style" defaultValue={style} data-testid="embed-style">
                {STYLES.filter((option) => option.widgets.includes(widget)).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Search">
              <Input
                type="search"
                name="q"
                placeholder="Title or abstract"
                defaultValue={requested.q ?? ''}
                data-testid="embed-q"
              />
            </Field>

            <Field label="Day">
              <Select name="day" defaultValue={requested.day ?? ''} data-testid="embed-day">
                <option value="">Every day</option>
                {days.map((day) => (
                  <option key={day.key} value={day.key}>
                    {day.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Track">
              <Select name="track" defaultValue={requested.trackId ?? ''} data-testid="embed-track">
                <option value="">Every track</option>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Room">
              <Select name="room" defaultValue={requested.roomId ?? ''} data-testid="embed-room">
                <option value="">Every room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Format">
              <Select name="format" defaultValue={requested.format ?? ''} data-testid="embed-format">
                <option value="">Every format</option>
                {Object.entries(FORMAT_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Level">
              <Select name="level" defaultValue={requested.level ?? ''} data-testid="embed-level">
                <option value="">Every level</option>
                {Object.entries(LEVEL_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {ignored ? (
            <p className="text-xs text-muted" data-testid="embed-ignored-note">
              The speaker gallery lists people, not sittings, so it narrows on search and track
              only. Day, room, format and level are kept here but left out of the snippet.
            </p>
          ) : null}

          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Fields</p>
            <p className="text-xs text-muted">
              What each entry carries. Unticking one drops it from the widget, from the JSON and
              from the XML alike, because all three read the same feed. The identifiers stay: a
              talk keeps its title and its link, a speaker keeps their name.
            </p>
            {/*
              The hidden input is what makes "none of them" expressible. An
              unticked checkbox sends nothing, so with every box clear the form
              would submit no `fields` key at all, and an absent `fields` has to
              go on meaning "send everything" for the sake of embeds generated
              before this control existed. The empty value keeps the key
              present and says the opposite.
            */}
            <input type="hidden" name="fields" value="" />
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {fields.map((field) => (
                <label key={field.name} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="fields"
                    value={field.name}
                    defaultChecked={selected === null || selected.has(field.name)}
                    className="h-4 w-4 rounded border-line"
                    data-testid={`embed-field-${field.name}`}
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Colours</p>
            <p className="text-xs text-muted">
              The widget states every colour it uses so the host stylesheet cannot reach in. These
              three are the ones it leaves open, and they travel with the script tag: an iframe is a
              separate document and a JSON feed has no colours at all.
            </p>
            <div className="flex flex-wrap gap-4">
              {palette.map((entry) => (
                <label key={entry.key} className="space-y-1">
                  <span className="block text-xs font-medium text-muted">{entry.label}</span>
                  <Input
                    type="color"
                    name={entry.key}
                    defaultValue={entry.chosen}
                    className="h-9 w-16 p-1"
                    data-testid={`embed-colour-${entry.key}`}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" data-testid="embed-apply">
              Update snippet
            </Button>
            <Link
              href={`/organizer/embed?${cleared.toString()}`}
              className="text-sm text-muted underline hover:text-ink"
            >
              Reset
            </Link>
          </div>
        </form>
      </Card>

      {style === 'script' ? (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Script tag</h2>
            <p className="mt-1 text-sm text-muted">
              One script, one empty div per widget. Drops into any CMS that allows a script tag, and
              inherits nothing from your stylesheet. Add a second div for the other widget and the
              same script serves both.
            </p>
          </div>
          <Snippet id="snippet-script" code={script} />
        </Card>
      ) : null}

      {style === 'iframe' ? (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Iframe</h2>
            <p className="mt-1 text-sm text-muted">
              For a CMS that refuses third-party scripts. An iframe cannot size itself, so the widget
              posts its height to the parent; the second snippet is what listens for it.
            </p>
          </div>
          <Snippet id="snippet-iframe" code={iframe} />
          <Snippet id="snippet-resize" code={resize} />
        </Card>
      ) : null}

      {style === 'json' ? (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">JSON feed</h2>
            <p className="mt-1 text-sm text-muted">
              The same data, readable from any origin, if your site would rather draw it itself. The
              query string is what the controls above write; hand-editing it works too.
            </p>
          </div>
          <Snippet id="snippet-feeds" code={feed} />
        </Card>
      ) : null}

      {style === 'xml' ? (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">XML feed</h2>
            <p className="mt-1 text-sm text-muted">
              The same feed again, for a CMS whose importer takes XML and not JSON. Element names
              are the JSON field names unchanged, and a field you untick above is missing from both.
            </p>
          </div>
          <Snippet id="snippet-xml" code={xml} />
        </Card>
      ) : null}

      {style === 'ics' ? (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Calendar subscription</h2>
            <p className="mt-1 text-sm text-muted">
              A subscribable calendar of the same narrowing, for a website that would rather publish
              an &ldquo;add to your calendar&rdquo; link than a widget. A subscriber&rsquo;s client
              re-reads it, so a room change reaches them without a new link.
            </p>
          </div>
          <Snippet id="snippet-ics" code={calendar} />
        </Card>
      ) : null}

      <Card className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Preview</h2>
          <p className="mt-1 text-sm text-muted">
            The configured widget with the current filters and fields, shown as it will render once
            the agenda is published. It is framed rather than drawn into this page because the embed
            is deliberately the only markup here that no sanitiser has seen, and it renders in the
            widget&rsquo;s own colours: an iframe cannot take the palette above.
          </p>
        </div>
        <iframe
          src={`/embed/${widget}${previewSuffix}`}
          title={`Preview of the ${widget === 'agenda' ? 'schedule' : 'speaker gallery'} widget`}
          className="h-96 w-full rounded-md border border-line bg-white"
          loading="lazy"
          data-testid="embed-preview"
        />
      </Card>
    </div>
  );
}
