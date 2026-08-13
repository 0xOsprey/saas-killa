# Saas Killa

Conference programme software: public CFP, blind reviewer grading, organizer
accept/reject, drag-and-drop scheduling, ePosters, agenda publishing, calendar
invites, public API, and one-way Accelevents push.

Built by **Joe ([@0x_Osprey](https://x.com/0x_Osprey))**.  
Live demo: **https://saas-killa.0xosprey.com/** ·
Source: **https://github.com/0xOsprey/saas-killa**

## For the judge

The live demo already has a finished conference loaded. Start here:

- **Agenda:** https://saas-killa.0xosprey.com/agenda
- **Posters:** https://saas-killa.0xosprey.com/posters
- **Speakers:** https://saas-killa.0xosprey.com/speakers
- **Awards:** https://saas-killa.0xosprey.com/awards

To try the private organizer, reviewer and speaker flows on the public
deployment, go to **https://saas-killa.0xosprey.com/demo** and enter the demo
secret (shared with judges separately). Pick any role to sign in as a fully
interactive demo user.

To run the same thing locally, set `DEMO_MODE=open` in `.env.local` and visit
`http://127.0.0.1:9140/demo` for one-click role buttons. Keep `DEMO_MODE=off` on
any real production instance.

**Stack:** Next.js 15 (App Router, Server Actions) · React 19 · TypeScript ·
Postgres · Drizzle ORM · Tailwind v4 · Resend · Playwright.

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

**Auth is magic-link, in-app.** Tokens are SHA-256 hashed, expire in 15 minutes
and are single-use; the session cookie is `httpOnly` and HMAC-signed. Cleanup
runs on sign-in via `sweepExpiredAuth`. `SESSION_SECRET` has no default and is
validated in `src/instrumentation.ts` before the server binds, so a
misconfigured deploy exits at boot instead of returning forgeable cookies.

**Sign-out is POST-only.** `next/link` prefetches GET links, so a GET "Sign out"
link in the nav deleted freshly opened sessions.

**Blind review is enforced in SQL.** `assignedQueue()` and `openSubmissionQueue()`
in `src/lib/grading.ts` never select a speaker column or join `users`; the e2e
test asserts the speaker's name is absent from the reviewer page.

**Co-authors may add names, not edit.** `writableBy(userId)` in
`src/lib/abstracts.ts` is the WHERE clause for every write, so a forged
submission id updates zero rows. The `can_edit` checkbox is hidden from them
and the rule is tested by posting the form without it.

**Deciding and emailing are separate.** `decisionEmailedAt` is the per-row
idempotency key; a failed bulk send resumes from the row it left off.

**The decision board narrows in SQL and pages at 25.** Sorts end on `id` for a
stable total order. Counts come from a whole-event query, so "12 undecided"
describes the work, not the page. `?per=all` renders the whole board.

**Double-booking is reported, never blocked.** The organizer may pass through an
invalid grid while rearranging; the warning persists until resolved.

**Times are `timestamptz` in the event's timezone.** `wallClockToInstant()` reads
the wall-clock form in the event zone, not the server's, and double-checks the
DST offset so a London schedule is right on a UTC host.

**A re-sent invitation updates the existing entry.** Each `.ics` UID is the
submission id and `SEQUENCE` increments, so clients revise rather than
duplicate. Mail is sent only when placement changed.

**File types are sniffed from magic bytes.** User filenames never reach disk;
SVG is refused. Unauthorized reads return 404 to avoid leaking document ids.

**The Accelevents push is dry-run by default.** Missing any of the three config
variables forces a fixture-backed rehearsal, not a half-configured live push.

**The AI evaluator is a reviewer, not a decision-maker.** It writes `reviews`
rows tagged `source: 'ai'` on the same 1-5 scale, sees only abstract/format/level/track,
and is off when `ANTHROPIC_API_KEY` is unset.

## Public API

A read-only public API is available under `/api/v1`:

- `GET /api/v1/event` — event metadata
- `GET /api/v1/sessions` — paginated list of accepted sessions
- `GET /api/v1/sessions/{id}` — single session
- `GET /api/v1/speakers` — paginated list of accepted speakers
- `GET /api/v1/speakers/{id}` — single speaker with their sessions

All list endpoints support `page`, `pageSize` and `q`. Sessions additionally
support `track` and `room` filters, and speakers support `track`. Responses use
the Sessionboard-style `{ data: [], pagination: {} }` envelope.

## Tests

```bash
pnpm exec playwright install chromium   # once
pnpm test                               # resets the database first
```

Eighteen specs, 84 tests, no unit runner. `pipeline.spec.ts` walks one proposal the
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

5. **Install a systemd unit** like `<your-service>.service`:
   ```ini
   [Unit]
   Description=Saas Killa
   After=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=/path/to/saas-killa
   ExecStart=/path/to/saas-killa/node_modules/.bin/next start -H 127.0.0.1 -p ${PORT}
   Environment="NODE_ENV=production"
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   Live host-specific ports, unit names and tunnel commands belong in
   `CLAUDE.local.md` (gitignored) rather than the public repo.

6. **Start it**:
   ```bash
   systemctl --user enable <your-service>.service
   systemctl --user start <your-service>.service
   ```

### Deploy after a code change

```bash
cd /path/to/saas-killa
git fetch && git reset --hard origin/main
pnpm install        # only if pnpm-lock.yaml changed
pnpm db:migrate     # only if drizzle/ changed
pnpm build
systemctl --user restart <your-service>.service
curl -s -o /dev/null -w "%{http_code}\n" https://<your-domain>/healthz
```

The `reset --hard` is intentional: `main` is sometimes force-squashed, and `.env.local`, `.mail/`, and `uploads/` are all gitignored, so they stay in place.

### Environment-only change

For a secret like `RESEND_API_KEY`:

```bash
systemctl --user stop <your-service>.service
# edit .env.local
chmod 600 .env.local
systemctl --user start <your-service>.service <your-tunnel>.service
```

### Demo / admin mode

Set `DEMO_MODE=secret` and a long `DEMO_SECRET` to show a public `/demo` page
where judges can sign in as any demo role. Set `DEMO_MODE=open` for local
one-click role buttons. `DEMO_MODE=off` hides the page entirely.

Signed-in organizers can also use **Configure → Role preview** in the organizer
portal to switch to a demo account for any role.

### Health check

`GET /healthz` returns `200` with `{"status":"ok"}` when the environment parses and the database answers, and `503` naming the failed check otherwise. A bad `SESSION_SECRET` never gets that far — the process exits at boot — so `503` in practice means Postgres.

## Not built

Attendee registration, ticketing and check-in; sponsors and exhibitors;
submission payments and payment gateways; multi-language workflows; and AMS
integrations (iMIS, Personify, Blackbaud, Salesforce). These were left out
intentionally to keep the scope to the CFP-to-agenda pipeline.
