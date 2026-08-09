# CLAUDE.md — sessionboard-clone

Anything that names this machine's paths, hostnames or tailnet ports lives in
`CLAUDE.local.md`, which is gitignored. This file is published with the repo, so
keep it portable.

## Commands

```bash
pnpm install
pnpm db:up          # Postgres 17 in Docker on 127.0.0.1:5433
pnpm db:migrate     # apply drizzle/*.sql
pnpm db:reset       # truncate and reseed
pnpm dev            # 127.0.0.1:9140
pnpm typecheck      # tsc --noEmit
pnpm build          # next build
pnpm test           # Playwright; resets the database in globalSetup
pnpm evaluate       # run the AI evaluator from the CLI

node scripts/dev-inbox.mjs   # browse .mail/ at 127.0.0.1:9141, sign-in links clickable
```

`pnpm test` truncates `auth_sessions` in `globalSetup`, so running the suite
signs out anyone currently browsing a dev server against the same database.

`tsconfig.json` excludes `e2e`, so the specs are not covered by `pnpm typecheck`
and cannot use the `@/` alias. Typecheck them standalone:

```bash
pnpm exec tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext \
  --moduleResolution bundler --lib es2023,dom e2e/*.ts
```

`pnpm test` does not build first. Build before testing if source changed.

## What is written down where

| File | Holds |
| --- | --- |
| `SCOPE.md` | the hackathon brief requirement by requirement: what is built, what was declined and why, which test covers each, and the four requirements the brief itself strikes through |
| `FLOWS.md` | every user flow by role, 175 of them over 796 numbered steps, each with its route, preconditions, the server action behind each control, the column it writes, and its refusal paths |
| `MISSING.md` | what tracing those flows found absent, ranked, every absence checked against source; plus a "deliberate, not missing" list and a "checked and not missing" list so a corrected claim is not filed twice |
| `README.md` | the outside view, and the design decisions worth knowing |

Read `SCOPE.md` before re-deriving anything from the brief, and `MISSING.md`
before filing a gap. Both were written 2026-08-08.

## Vocabulary — use these names, never a synonym

| Name | Means |
| --- | --- |
| `submission` | a proposal at any status; a poster is a submission too |
| `review` | one reviewer's score and comment on one submission |
| `track` | a topical grouping |
| `room` | a physical room |
| `slot` | a `(room, start, end)` box on the schedule grid |
| `award` | a prize category accepted submissions are nominated into |
| `authSession` | a logged-in browser session |
| `upload` | a file on this server's disk, addressed by `/files/<id>` |
| `invitation` | the `.ics` a speaker gets for their own talk; UID is the submission id |
| `page` | an organizer-authored wiki page in the speaker portal, addressed by slug |
| `run` | one push of the programme to Accelevents, dry or live, with its request log |

"Session" alone is never used for conference content, because it collides with
the login session. Accepted submissions placed in a slot are what the public
agenda renders; they are still submissions.

## Invariants worth not breaking

- **Sign-out stays POST-only.** As a GET, `next/link` prefetch deleted the
  session moments after every sign-in. See `src/app/auth/logout/route.ts`.
- **A sign-in lands on the home the address has a role for.** `homeForRoles` in
  `src/lib/auth.ts` owns that, ordered most-privileged first because the
  bootstrap organizer holds `reviewer` too. Everything used to land on
  `/speaker`, which opened the organizer's session on their own empty submission
  list.
- **`assignedQueue()` and `openSubmissionQueue()` select no speaker column.**
  Both are in `src/lib/grading.ts` and both are what `/review` actually calls.
  That is what makes review blind. Adding a join to `users` in either one
  silently defeats it, and the end-to-end test is the thing that would catch
  you. `reviewQueue()` in `src/lib/queries.ts` holds the same property and has
  no call site; do not cite it as the enforcement point.
- **Every server action re-checks its own role.** The `organizer/layout.tsx`
  guard does not run for a direct action invocation, so it is defence in depth,
  not the control.
- **Speaker-scoped actions put ownership in the WHERE clause**, not in a check
  before the query. A forged id then updates zero rows.
- **`SESSION_SECRET` has no default** in `src/lib/env.ts`. Do not add one.
- **The AI evaluator never decides.** It writes a `reviews` row like any other
  reviewer and a human accepts or rejects.
- **An uploaded file's type comes from its own first bytes.** `src/lib/uploads.ts`
  sniffs magic bytes and never trusts the declared `Content-Type`; the name on
  disk is `<uuid><sniffed ext>`, so no part of a user's filename reaches the
  filesystem. SVG is refused everywhere, being the one image format that runs
  script.
- **The only string that reaches `dangerouslySetInnerHTML` is `sanitizeHtml`
  output.** `portal_pages.body` holds raw authored HTML on purpose, so the
  sanitiser can be tightened later and a page can be edited back out of a
  mistake. `src/lib/portal-pages.ts` is the seam: it returns `html`, already
  sanitised, and never exports the row's raw body to a screen. A page component
  that queries `portalPages` directly has stepped around the one control here.
- **The sanitiser rebuilds, it does not filter.** Every tag and attribute in the
  output was written by `src/lib/sanitize-html.ts` from its allowlist; text is
  escaped. Adding this app's own hostname to `EMBED_HOSTS` would break the
  reasoning that makes `allow-scripts allow-same-origin` safe on an embed.
- **An invitation's UID is the submission id, and its SEQUENCE always rises.**
  That pair is what makes a re-sent `.ics` update the entry already in a
  speaker's calendar instead of adding a second one. `toVevents` in
  `src/lib/ics.ts` owns the UID; `submissions.schedule_notice_seq` owns the
  counter. Changing either breaks schedule-change mail silently, in the
  speaker's client, where nothing here can see it.
- **What gets emailed is decided by comparing placements, not by watching for
  events.** `schedule_notice_key` holds the `<startsAt>|<roomId>` the last mail
  described. A talk dragged four times and a talk moved out and back are both
  "no change" by that test, which is the point.
- **The Accelevents push is one-way, and one-way is structural.** Nothing the
  far end returns is written into a submission, a slot or a speaker; the remote
  ids live in `integration_runs.requests` and nothing reads them back. This app
  is the source of truth and their copy is downstream. Making it two-way means
  deciding whose edit wins, which is a decision for a conference that has been
  bitten by it.
- **All three `ACCELEVENTS_*` variables set is the only state that reaches the
  network.** Missing any one is a dry run, not an error, because the failure
  worth designing against is a half-configured deploy pushing a partial
  programme into a real event. `transportFor` is the fork, and with no config
  there is no code path that constructs a `fetch`.
- **The dry run is fixture-backed, not a print statement.** It builds every
  request, checks every response and records every remote id, and it refuses a
  speaker with no name the way the far end would. A rehearsal that always says
  yes tells an organizer their export works right up until it does not.
- **The wire format in `src/lib/accelevents.ts` is transcribed, never
  verified.** No request has ever been made against a live Accelevents endpoint
  from this repo, deliberately: during development that endpoint is somebody's
  real event. `ACCELEVENTS_PATHS` and the three body builders are the one place
  to correct a wrong path or field name.
- **The API key is never written to a run.** `integration_runs` holds the base
  URL and the bodies, and the bundle route hands the row over as-is, so there is
  nothing to redact. A credential added to a request body later would be the
  thing that breaks this, not the download.
- **Reads of an upload go through `readableUpload`, and a refusal is a 404.**
  A headshot is public, slides go public with the content status, a poster with
  the gallery gate, and a supporting document never does. A 403 would tell an
  anonymous prober which document ids exist.

## Tests

Seventeen spec files, 78 tests, one worker, no retries, one shared database
seeded once in `globalSetup`. Every file puts back what it changed, so a test
that leaves a talk on the grid breaks four later files for a reason none of them
can see. If you add a test, restore state in a `finally`.

Two exceptions, both deliberate: `pipeline.spec.ts` and `speaker-portal.spec.ts`
each file a proposal through `/cfp` and leave it, so after a run the organizer's
board carries two submissions with an epoch suffix in the title. `pnpm db:reset`
before demonstrating anything.

postgres.js: its `sql(array)` helper demands a non-empty tuple type and fails
strict typecheck. Use `= any(${array}::uuid[])` instead.

## Environment

`.env.local`, gitignored. `SESSION_SECRET` is required and at least 32
characters. `RESEND_API_KEY` unset means every email is written to `.mail/`
instead of sent, which is how the tests read magic links. `ANTHROPIC_API_KEY`
unset means the AI evaluator is off and the organizer screen says so.
`ACCELEVENTS_BASE_URL`, `ACCELEVENTS_API_KEY` and `ACCELEVENTS_EVENT_ID` unset
means every export is a dry run against fixtures. The suite never sets them.

## Scope that was declined

Attendee registration, ticketing and check-in; sponsors and exhibitors;
submission payments and payment gateways; multi-language workflows; AMS
integrations (iMIS, Personify, Blackbaud, Salesforce). Do not add them without
asking.

The embeddable widget, the portal wiki pages and the Accelevents push were on
this list until the hackathon brief named all three as judged requirements. All
three have now shipped. Anything moved off this list moves for a reason written
down somewhere, not because it looked useful.

The AMS integrations above stay declined, and the Accelevents work is not a
precedent for them: it is one direction, one target, and a fixture stands in for
the far end. A two-way sync against a membership system is a different problem
wearing the same word.
