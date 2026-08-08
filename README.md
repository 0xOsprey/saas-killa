# sessionboard-clone

Conference programme software: a call for papers, blind reviewer grading, an AI
evaluator, accept/reject with speaker notification, a drag-and-drop schedule
grid, awards, an ePoster gallery, and a public agenda.

Next.js 15 (App Router, Server Actions) · Postgres via Drizzle · Tailwind v4 ·
Playwright.

## Run it

```bash
cp .env.example .env.local          # then fill SESSION_SECRET
openssl rand -hex 32                # a value for SESSION_SECRET

pnpm db:up                          # Postgres 17 in Docker, 127.0.0.1:5433
pnpm db:migrate                     # apply drizzle/*.sql
pnpm db:seed                        # one event, 40 submissions, 24 speakers
pnpm dev                            # http://127.0.0.1:9140
```

Sign in at `/login` as `organizer@example.com`. With `RESEND_API_KEY` unset the
app never sends anything: every message is printed to the terminal and written
to `.mail/`, so the sign-in link is in your scrollback. That is also how the
end-to-end test reads its magic links.

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
HMAC over the session id. `SESSION_SECRET` has no default, so a misconfigured
deploy fails at boot instead of shipping a forgeable cookie.

**Sign-out is POST-only.** As a GET route it was a live bug, not a style point:
`next/link` prefetches links in the viewport, so the nav's "Sign out" link fired
the handler seconds after every sign-in and deleted the session the user had
just opened.

**Blind review is enforced in the query, not the template.** `reviewQueue()` in
`src/lib/queries.ts` never selects a speaker column, so the identity cannot leak
through a stray render. The end-to-end test asserts the speaker's name is absent
from the whole reviewer page.

**Deciding and emailing are separate actions.** An organizer flips statuses and
changes their mind freely; nothing leaves the building until they press send.
`decisionEmailedAt` is the idempotency key, written per row right after that
row's send, so a failure halfway through resumes rather than restarting.

**Double-booking is reported, never blocked.** An organizer mid-rearrangement
routinely passes through an invalid grid, and refusing the drop would make the
schedule unusable. The warning persists until it is resolved.

**Times are stored as `timestamptz` and rendered in the event's timezone.** The
schedule form posts a bare wall clock with no offset;
`wallClockToInstant()` reads it as a time in the event's zone rather than the
server's, which is what makes a London schedule come out right on a UTC host and
across a DST boundary.

**The AI evaluator is a reviewer, not a decision-maker.** It holds a `users` row
with the `reviewer` role and writes ordinary `reviews` rows tagged
`source: 'ai'`, so its grade averages with human grades on the same 1-5 scale.
It sees the abstract, format, level and track — never the speaker — and returns
its rubric breakdown through a tool call rather than parseable prose. Without
`ANTHROPIC_API_KEY` it is simply off and the organizer screen says so.

## Tests

```bash
pnpm test          # Playwright; resets the database first
```

Three specs. The first walks one proposal the length of the pipeline —
submit, grade, accept, notify, schedule, publish, then read it as a signed-out
visitor — and checks the acceptance email actually landed. The other two are the
authorisation cases: an undecided proposal 404s for the public even by direct
URL, and the review queue redirects a signed-out visitor to `/login`.

Placement in the test uses click-to-select then click-to-place rather than
dragging, because HTML5 drag events are not reliably synthesisable in a browser
harness. Both paths call the same server action.

## Deploying

Any Postgres connection string works: Supabase, Neon, or your own. Point
`DATABASE_URL` at it, run `pnpm db:migrate`, and set `SESSION_SECRET`, `APP_URL`,
`RESEND_API_KEY` and `MAIL_FROM`. `ANTHROPIC_API_KEY` is optional.

## Not built

Attendee registration, ticketing and check-in; sponsors and exhibitors; an
embeddable widget for an external site; and wiki or resource pages inside the
speaker portal.
