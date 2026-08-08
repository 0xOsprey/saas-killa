import { Card, Notice, PageHeader } from '@/components/ui';
import { env } from '@/lib/env';
import { allTracks, getEvent } from '@/lib/queries';

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

/**
 * The paste-this-into-your-website page.
 *
 * Everything here is a string an organizer copies, so the base URL is read from
 * `APP_URL` rather than hardcoded: a snippet carrying `127.0.0.1` would look
 * right on this screen and do nothing on their site.
 */
export default async function EmbedPage() {
  const [event, tracks] = await Promise.all([getEvent(), allTracks()]);
  const base = env().APP_URL;

  const script = [
    '<div data-sessionboard="speakers"></div>',
    '<div data-sessionboard="agenda"></div>',
    `<script src="${base}/embed/embed.js" async></script>`,
  ].join('\n');

  const iframe = [
    `<iframe src="${base}/embed/agenda" title="${event.name} schedule"`,
    '        style="width:100%;border:0;height:900px" loading="lazy"></iframe>',
  ].join('\n');

  const resize = [
    '<script>',
    'addEventListener("message", function (e) {',
    '  var h = e.data && e.data.sessionboardHeight;',
    '  if (h) document.querySelector("iframe[src*=\'/embed/\']").style.height = h + "px";',
    '});',
    '</script>',
  ].join('\n');

  const feeds = [
    `${base}/embed/speakers.json`,
    `${base}/embed/agenda.json`,
    `${base}/embed/agenda.json?day=YYYY-MM-DD`,
    tracks[0] ? `${base}/embed/speakers.json?track=${tracks[0].id}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

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
          Both widgets stay closed until the agenda is published, and they say so on the host page
          rather than rendering empty. The embed never reads a sign-in cookie, so this is what you
          will see on the preview too, even as an organizer.
        </Notice>
      )}

      <Card className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Script tag</h2>
          <p className="mt-1 text-sm text-muted">
            One script, one empty div per widget. Drops into any CMS that allows a script tag, and
            inherits nothing from your stylesheet.
          </p>
        </div>
        <Snippet id="snippet-script" code={script} />
      </Card>

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

      <Card className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">JSON feeds</h2>
          <p className="mt-1 text-sm text-muted">
            The same data, readable from any origin, if your site would rather draw it itself. Add{' '}
            <code className="rounded bg-slate-100 px-1">day</code>,{' '}
            <code className="rounded bg-slate-100 px-1">track</code>,{' '}
            <code className="rounded bg-slate-100 px-1">room</code>,{' '}
            <code className="rounded bg-slate-100 px-1">format</code> or{' '}
            <code className="rounded bg-slate-100 px-1">q</code> to narrow either feed; the same
            attributes work on the divs above as{' '}
            <code className="rounded bg-slate-100 px-1">data-track</code> and friends.
          </p>
        </div>
        <Snippet id="snippet-feeds" code={feeds} />
      </Card>
    </div>
  );
}
