# Saas Killa

Conference programme software. It runs the whole CFP-to-agenda pipeline:

- Public call for papers
- Blind reviewer grading
- Optional AI-assisted scoring
- Organizer accept/reject with batch email
- Drag-and-drop schedule builder
- Calendar invites that update in place
- Speaker file uploads
- ePoster gallery
- Public agenda and embeddable widgets
- Public API (`/api/v1`) for sessions, speakers and event metadata
- One-way push to Accelevents

**Stack:** Next.js 15 (App Router, Server Actions) · React 19 · TypeScript ·
Postgres · Drizzle ORM · Tailwind v4 · Resend · Playwright.

`SCOPE.md` is the requirement-by-requirement account of what is built, what is
deliberately not, and which test covers each. `FLOWS.md` is every user flow by
role: 175 flows across 796 numbered steps, each with route, preconditions, server
action, and refusal paths.

## Quickstart

### What you need

- Node.js 20+
- pnpm
- Docker (for the local Postgres container)

### Install and run

```bash
pnpm install
cp .env.example .env.local
# Edit .env.local and set SESSION_SECRET to the output of:
openssl rand -hex 32

pnpm db:up       # Postgres 17 on 127.0.0.1:5433
pnpm db:migrate  # apply drizzle/*.sql
pnpm db:seed     # one event, 40 submissions, 24 speakers, 2-day grid
pnpm dev         # http://127.0.0.1:9140
```

### Sign in

The seed creates:

- `organizer@example.com` — organizer screens
- `reviewer1@example.com` — blind review queue
- `speaker1@example.com` .. `speaker24@example.com` — speaker portals

With `RESEND_API_KEY` unset, the app does not send real email; every message is
printed to the terminal and written to `.mail/`. To browse from another machine,
run the dev inbox:

```bash
node scripts/dev-inbox.mjs   # http://127.0.0.1:9141
```

Then the pipeline is: `/cfp` to submit, `/review` to grade,
`/organizer/submissions` to decide, `/organizer/schedule` to place, and
`/organizer/schedule` again to publish.

## The pipeline

| Stage | Route | Who |
| --- | --- | --- |
| Submit | `/cfp` | anyone; an account is created on first submission |
| Grade | `/review` | reviewers, blind |
| Decide | `/organizer/submissions` | organizers |
| Notify | same page, explicit "send" button | organizers |
| Schedule | `/organizer/schedule` | organizers |
| Publish | same page | organizers |
| Read | `/agenda`, `/agenda/[id]`, `/posters` | anyone, once published |

Speakers manage everything of theirs at `/speaker`: confirming they will
present, adding slides, a recording and resources after the event, or
withdrawing.

## Decisions worth knowing

**Auth is magic-link, written in-app.** No password to leak and no auth vendor
in the dependency graph. Tokens are stored as SHA-256 hashes, expire in 15
minutes and are single use; the session cookie is `httpOnly` and carries an
HMAC over the session id. Expired sessions and expired links are deleted by
`sweepExpiredAuth`, hung off signing in rather than off a cron: signing in is
what puts rows in both tables, so the cleanup scales with the traffic that
causes it and an instance nobody uses does none. `SESSION_SECRET` has no default, so a misconfigured
deploy fails at boot instead of shipping a forgeable cookie. "At boot" is
`src/instrumentation.ts`, which reads the environment before the server binds
and exits non-zero when it is wrong. The check used to be lazy, and lazy meant
the process printed `✓ Ready`, took the port, and then returned 500 to every
request with the reason only in its own log — a deploy any port-based health
check calls green.

**Sign-out is POST-only.** As a GET route it was a live bug, not a style point:
`next/link` prefetches links in the viewport, so the nav's "Sign out" link fired
the handler seconds after every sign-in and deleted the session the user had
just opened.

**Blind review is enforced in the query, not the template.** `assignedQueue()`
and `openSubmissionQueue()` in `src/lib/grading.ts` are the two queries `/review`
runs, and neither selects a speaker column or joins `users`, so the identity
cannot leak through a stray render. The end-to-end test asserts the speaker's
name is absent from the whole reviewer page.

**Crediting a co-author and admitting one are two different decisions.**
`writableBy(userId)` in `src/lib/abstracts.ts` is the one predicate that answers
"may this person write to this submission", composed into the WHERE clause of
every query that writes, so a forged submission id updates zero rows rather than
being caught by a check somebody could forget to call. Access itself stays with
the filer: a co-author may add a name to the author list but never `can_edit`
alongside it, and because the checkbox is merely hidden from them, the rule is
enforced in `addAuthorByEmail` and tested by appending the missing field to the
real form and posting it.

**Deciding and emailing are separate actions.** An organizer flips statuses and
changes their mind freely; nothing leaves the building until they press send.
`decisionEmailedAt` is the idempotency key, written per row right after that
row's send, so a failure halfway through resumes rather than restarting.

**The decision board narrows in SQL and pages at 25.** Search, decision, track,
content status and sort are all a `<form method="get">`, so a filtered board is
an address: linkable, reloadable and reachable with the back button. Every sort
ends on the submission id, because a sort without a total order lets Postgres
return tied rows in a different order per query and a tie across a page boundary
is one row on both pages and another on neither. The counts in the header and on
the content chips come from a separate whole-event query rather than from the
rows on screen: "12 undecided" and the send button beside it describe the work
outstanding, not the page. `?per=all` renders everything for the organizer who
wants to scan the lot.

**Double-booking is reported, never blocked.** An organizer mid-rearrangement
routinely passes through an invalid grid, and refusing the drop would make the
schedule unusable. The warning persists until it is resolved.

**Times are stored as `timestamptz` and rendered in the event's timezone.** The
schedule form posts a bare wall clock with no offset;
`wallClockToInstant()` reads it as a time in the event's zone rather than the
server's, which is what makes a London schedule come out right on a UTC host.
It measures the zone's offset twice, because the first measurement is taken at
the wall clock read as UTC and that instant can sit on the far side of a DST
transition from the real one: 03:00 on the March morning New York goes forward
stored as 08:00Z and read back as 04:00 until the second pass was added.

**A re-sent invitation updates the entry the speaker already has.** The UID of
every `.ics` is derived from the submission id and `SEQUENCE` rises with each
notice, which is the pair RFC 5545 clients use to revise an appointment instead
of adding a second one an hour after the first. What gets emailed is decided by
comparing the current placement against the one the speaker was last told about,
so a talk dragged four times sends one mail and a talk moved out and back sends
none. The subscription feeds carry the same counter per event, from the same
column; a break has no submission behind it and stays at 0, which is the one
revision they cannot signal.

**An uploaded file's type comes from its own first bytes.** `src/lib/uploads.ts`
sniffs magic bytes and never trusts the declared `Content-Type`; the name on disk
is `<uuid><sniffed ext>`, so no part of a user's filename reaches the filesystem.
SVG is refused everywhere, being the one image format that runs script. A read
the viewer is not entitled to is a 404 rather than a 403, because a 403 tells an
anonymous prober which document ids exist.

**The Accelevents push rehearses against fixtures unless all three variables are
set.** Missing any one of `ACCELEVENTS_BASE_URL`, `_API_KEY` or `_EVENT_ID` is a
dry run rather than an error, because the failure worth designing against is a
half-configured deploy pushing a partial programme into somebody's live event.
The dry run is not a print statement: it builds every request, checks every
response, records every remote id, and refuses a speaker with no name the way the
far end would.

**The AI evaluator is a reviewer, not a decision-maker.** It holds a `users` row
with the `reviewer` role and writes ordinary `reviews` rows tagged
`source: 'ai'`, so its grade averages with human grades on the same 1-5 scale.
It sees the abstract, format, level and track — never the speaker — and returns
its rubric breakdown through a tool call rather than parseable prose. Without
`ANTHROPIC_API_KEY` it is simply off and the organizer screen says so.

## Public API

A read-only public API is available under `/api/v1`:

- `GET /api/v1/event` — event metadata
- `GET /api/v1/sessions` — paginated list of accepted sessions
- `GET /api/v1/sessions/{id}` — single session
- `GET /api/v1/speakers` — paginated list of accepted speakers
- `GET /api/v1/speakers/{id}` — single speaker with their sessions
- `GET /api/v1/openapi.json` — OpenAPI 3.0 spec

All list endpoints support `page`, `pageSize` and `q`, and sessions additionally
support `track` and `room` filters. Responses use the Sessionboard-style
`{ data: [], pagination: {} }` envelope.

## Tests

```bash
pnpm exec playwright install chromium   # once
pnpm test                               # resets the database first
```

Seventeen specs, 78 tests, no unit runner. `pipeline.spec.ts` walks one proposal the
length of the pipeline: submit, grade, accept, notify, schedule, publish, then
read it as a signed-out visitor, checking the acceptance email actually landed.
`smoke.spec.ts` opens every route the nav leads to, reading the tab list off the
nav rather than from a copy that goes stale. The rest are one file per feature:
uploads, portal pages, the schedule grid and its double-booking warning, calendar
invitations, the decision board's filters, pager and bulk bar, the embeddable
widgets, the Accelevents push, and the speaker onboarding tracker.

One helper, `e2e/db.ts`, opens the database directly, and two tests use it. The
sweep of expired sessions is the only claim in the app no screen can show, since
its subject is a row that has already stopped being usable; and restoring a
content status after the bulk-approve test is a state the screens offer no way
back to. Everything else drives the browser.

They share one database, seeded once in `globalSetup` and never between files,
so they run in a fixed order with a single worker and each file puts back what
it changed. A test that leaves a talk on the grid is a test that breaks four
later files for a reason none of them can see.

Placement in the tests uses click-to-select then click-to-place, and the
no-script form, as well as dragging. All three call the same server action, and
exactly one test is about the drag itself. That one drives the mouse by hand
rather than through `locator.dragTo`, which scrolls the target into view after
the button is down and before Chromium decides a drag has begun: on a grid
taller than the viewport that moves the layout under a stationary cursor, and
the gesture picks up whichever cell arrives at the point.

## Deploying

### One-time host setup

1. **Clone the repo** and install dependencies:
   ```bash
   cd /path/to/saas-killa
   pnpm install
   ```

2. **Create `.env.local`** from the example, then fill in the live values:
   ```bash
   cp .env.example .env.local
   ```
   Required:
   - `DATABASE_URL` — Postgres connection string
   - `SESSION_SECRET` — `openssl rand -hex 32`
   - `APP_URL` — the public URL, e.g. `https://saas-killa.0xosprey.com`
   - `RESEND_API_KEY` and `MAIL_FROM` — for magic links and notifications
   - `BOOTSTRAP_ORGANIZER_EMAIL` — first organizer account

   Optional:
   - `ANTHROPIC_API_KEY` — turns on the AI evaluator
   - `ACCELEVENTS_BASE_URL`, `ACCELEVENTS_API_KEY`, `ACCELEVENTS_EVENT_ID` — live Accelevents push

3. **Migrate the database**:
   ```bash
   pnpm db:migrate
   ```

4. **(Optional) Seed fixture data**:
   ```bash
   pnpm db:seed
   ```

5. **Install a systemd unit** like `saas-killa.service`:
   ```ini
   [Unit]
   Description=Saas Killa, the live hackathon instance
   After=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=/path/to/saas-killa
   ExecStart=/path/to/saas-killa/node_modules/.bin/next start -H 127.0.0.1 -p 9150
   Environment=NODE_ENV=production
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

6. **Start it**:
   ```bash
   systemctl --user enable saas-killa.service saas-killa-tunnel.service
   systemctl --user start saas-killa.service saas-killa-tunnel.service
   ```

### Deploy after a code change

```bash
cd /path/to/saas-killa
git fetch && git reset --hard origin/main
pnpm install        # only if pnpm-lock.yaml changed
pnpm db:migrate     # only if drizzle/ changed
pnpm build
systemctl --user restart saas-killa.service saas-killa-tunnel.service
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" https://saas-killa.0xosprey.com/healthz
```

The `reset --hard` is intentional: `main` is sometimes force-squashed, and `.env.local`, `.mail/`, and `uploads/` are all gitignored, so they stay in place.

### Environment-only change

For a secret like `RESEND_API_KEY`:

```bash
systemctl --user stop saas-killa.service
# edit .env.local
chmod 600 .env.local
systemctl --user start saas-killa.service saas-killa-tunnel.service
```

### Health check

`GET /healthz` returns `200` with `{"status":"ok"}` when the environment parses and the database answers, and `503` naming the failed check otherwise. A bad `SESSION_SECRET` never gets that far — the process exits at boot — so `503` in practice means Postgres.

## Not built

Attendee registration, ticketing and check-in; sponsors and exhibitors;
submission payments and payment gateways; multi-language workflows; and AMS
integrations (iMIS, Personify, Blackbaud, Salesforce). `SCOPE.md` says why for
each.
