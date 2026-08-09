# Scope

What is built, what is deliberately not, and which test covers each. Written
2026-08-08, revised the same day against commit `73f4c00`.

The spec this is measured against is the "Kill My SaaS" brief, not the
sessionboard.com marketing pages. An earlier gap audit in this repository's
history was built the second way and is superseded.

## Four of the nine requirements are struck through in the brief

Read from the document's own HTML export rather than from the PDF, because a
PDF export drops the formatting that carries this:

```
curl -sL -o brief.html ".../export?format=html"   # then: grep line-through
```

One CSS class carries `text-decoration:line-through` and it wraps exactly four
spans:

| Item | Struck |
| --- | --- |
| 4 | the clause "including optional AI-assisted review across multiple rounds" only; "Submission evaluation and scoring workflows" stands |
| 7 | Accelevents integration, in full |
| 8 | Portal resource and wiki pages, in full |
| 9 | Embeddable speaker gallery and schedule, in full |

Reading a strike as "descoped" is an inference, not something the brief states.
It is the only reading consistent with the "NOT NEEDED" annotation on payments
being written a different way, but it is an inference.

**All four were built anyway, before this was noticed, and all four stay.**
Removing working, tested surface to match a strike would cost work and gain
nothing; the brief's own tiebreaker is "whoever has made subjective judgment
calls for the product that we would actually use/buy". What changes is where
further effort goes: requirements 1 to 6 are the judged list.

## Verification

Run from the project root, in this order, on 2026-08-08:

```
pnpm typecheck     clean
pnpm build         clean, 58 routes
pnpm test          76 passed (1.9m)
```

`pnpm test` is Playwright and there is no unit runner. Seventeen spec files, one
worker, no retries, a single database reset once in `globalSetup` and shared
across the whole run. Every file puts back what it changed. Two of them reach the
database directly through `e2e/db.ts`, one to prove a row that has already expired
is deleted and one to restore a content status the screens offer no way back to;
everything else drives the browser.

## The nine requirements

Numbered as the brief numbers them. 1 to 6 are the judged list; 7, 8 and 9 are
struck there and built here.

### 1. CFP forms with conditional logic and category routing

Built.

- Organizer authors the form at `/organizer/cfp/questions`; submitters fill it
  at `/cfp`.
- Branch rules live in `src/lib/questions.ts`, which is imported by a client
  component and therefore holds no database import.
- Category routing is `planAssignments`: a proposal's track decides which
  reviewers see it.
- A retired question is archived rather than deleted, so answers the committee
  already graded survive.
- Tests: `features.spec.ts` — "an organizer adds, retires and restores a form
  question", "the submission form shows and hides questions as the speaker
  answers".

### 2. Speaker portal: bios, headshots, slides, supporting documents

Built.

- `/speaker/profile` takes a bio and a headshot; `/speaker/content` takes
  slides, a recording link and supporting documents.
- Files land on local disk under a gitignored `uploads/` and are read back
  through `/files/[...path]`. No S3 and no external storage, on purpose: this
  has to run on a laptop with a Postgres container and nothing else.
- The stored type comes from the file's own first bytes, never from the
  declared `Content-Type`. The name on disk is `<uuid><sniffed ext>`, so no part
  of a user's filename reaches the filesystem. SVG is refused everywhere.
- A read the viewer is not entitled to is a 404, not a 403, so an anonymous
  prober cannot enumerate document ids.
- Tests: `uploads.spec.ts` — all three.

### 3. Templated speaker comms, including calendar invites

Built.

- Every template is in `src/lib/email.ts`, and every send but one leaves an
  `email_log` row that `/organizer/email` lists newest first. The exception is
  the magic link, which is authentication rather than correspondence. The
  decision mail writes its receipt after `decisionEmailedAt` rather than through
  `sendAndLog`, because that column is its idempotency key and a receipt failing
  must not cost a speaker a second acceptance mail on the retry.
- Deciding and emailing are separate presses. An organizer flips statuses and
  changes their mind freely and nothing leaves the building until they send.
- The acceptance mail carries an `.ics` when the talk already has a slot. When
  it does not, the invitation follows from `/organizer/schedule` once it is
  placed.
- A re-sent invitation revises the entry the speaker already holds rather than
  adding a second one: the UID is derived from the submission id and `SEQUENCE`
  rises with each notice. The subscription feeds carry the same per-talk counter;
  a break has no submission behind it and stays at 0.
- What gets emailed is decided by comparing the current placement against the
  one the speaker was last told about (`schedule_notice_key`), not by watching
  for events. A talk dragged four times sends one mail; a talk moved out and
  back sends none.
- Taking a talk off the grid sends a `METHOD:CANCEL` built from the placement
  the speaker was last given, because a cancellation with no DTSTART leaves the
  stale entry in place.
- Tests: `speaker-calendar.spec.ts` — both. The first walks first
  invitation → time change → cancellation and asserts the UID, the rising
  SEQUENCE and the changed start across three separate mails.

### 4. Evaluation and scoring, multi-round

Built. Not extended during this pass, deliberately. The AI-assisted clause is the
part of this requirement the brief strikes; the evaluator below was built before
that was noticed and is left in place, off by default.

- Reviewers grade at `/review` against four criteria. Blind review is a
  query-level property: `assignedQueue()` and `openSubmissionQueue()` in
  `src/lib/grading.ts` are what `/review` runs, and neither selects a speaker
  column or joins `users`, so the identity cannot leak through a stray render.
- The AI evaluator holds a `users` row with the `reviewer` role and writes
  ordinary `reviews` rows tagged `source: 'ai'`. It never decides. Without
  `ANTHROPIC_API_KEY` it is off and the organizer screen says so.
- Rounds open and close at `/organizer/evaluators`, with an audit at
  `/organizer/evaluators/audit`.
- Tests: `features.spec.ts` — "a round opened by an organizer becomes the queue
  a reviewer grades in"; `pipeline.spec.ts` — "the review queue refuses a
  signed-out visitor".

### 5. Drag-and-drop schedule with conflict detection, six ways to read it

Built.

- `/organizer/schedule` is a band-by-room grid. A placed talk drags into
  another box; the same action is reachable by click-to-select then
  click-to-place, which is the path that works with scripting off.
- Six views, all on the same data: grid, day, week, list, track, room
  (`src/lib/schedule-views.ts`).
- Three conflict classes in `src/lib/conflicts.ts`: speaker double-booking,
  speaker unavailability, room over-capacity against starred interest. All
  three are reported and none of them blocks the drop, because an organizer
  mid-rearrangement passes through an invalid grid routinely.
- A view name or a day the schedule does not have falls back rather than
  erroring.
- Tests: `schedule.spec.ts` — all four.

### 6. Real-time dashboard of speakers with outstanding onboarding tasks

Built.

- `/organizer/onboarding` shows four figures — clear, outstanding, overdue,
  completed this week — a breakdown by task kind, and the people furthest
  behind.
- "Real-time" here means a 15-second self-refresh that pauses when the tab is
  hidden, with a toggle to stop it. It is not a websocket, and the page says
  when it was last read.
- Each tile links to the roster filter it counts, and the counts are computed
  over the same population as that filter, so the tile and the list it opens
  agree by construction rather than by seed coincidence.
- Below the tiles, how many accepted speakers have confirmed they are coming.
  A different question from tasks and kept visually apart for that reason: a
  speaker can owe nothing and still not have answered, and every tile above
  counts that person as fine. `unconfirmed` is the figure counted in SQL and
  `confirmed` is derived from it, because the roster's own filter is
  `accepted > confirmed` and deriving it the other way would have made the card
  disagree with the list it links to.
- Tests: `onboarding.spec.ts` — all three, each written relative to a baseline
  read at the start rather than against a fixed number.

### 7. Accelevents one-way integration — struck in the brief

Built as a dry run. **No request has ever left this machine.**

- `/organizer/integrations` pushes tracks, then speakers, then sessions, and
  keeps every run with its full request log. `/organizer/integrations/<id>/bundle`
  downloads that log as JSON.
- All three of `ACCELEVENTS_BASE_URL`, `ACCELEVENTS_API_KEY` and
  `ACCELEVENTS_EVENT_ID` set is the only state that reaches the network.
  Missing any one is a dry run, not an error: the failure worth designing
  against is a half-configured deploy pushing a partial programme into a real
  event. With no config there is no code path that constructs a `fetch`.
- The dry run is fixture-backed rather than a print statement. It builds every
  request, checks every response, records every remote id, and refuses a speaker
  with no name the way the far end would.
- One-way is structural. Nothing the far end returns is written back into a
  submission, a slot or a speaker.
- The API key is never written to a run, so the downloadable bundle has nothing
  to redact.
- **The wire format is transcribed from public documentation and has never been
  verified against a live endpoint.** `ACCELEVENTS_PATHS` and the three body
  builders in `src/lib/accelevents.ts` are the one place to correct a wrong path
  or field name. Treat this requirement as "the adapter and its rehearsal are
  real; the far end's schema is unconfirmed".
- Tests: `integrations.spec.ts` — all three, every one of them a dry run.

### 8. Portal resource and wiki pages with HTML embed support — struck in the brief

Built.

- Organizers author at `/organizer/pages`; speakers read at `/speaker/pages`
  and `/speaker/pages/<slug>`. A draft is invisible to speakers and readable by
  its author.
- `portal_pages.body` holds the raw authored HTML on purpose, so the sanitiser
  can be tightened later and a page edited back out of a mistake.
  `src/lib/portal-pages.ts` is the seam: it returns already-sanitised `html` and
  never exports the raw body to a screen.
- The sanitiser rebuilds rather than filters. Every tag and attribute in the
  output was written by `src/lib/sanitize-html.ts` from its allowlist, and text
  is escaped. Iframes are allowed only from an allowlist of hosts and only
  sandboxed.
- Tests: `portal-pages.spec.ts` — all three, including one that asserts script
  tags, event handlers and unlisted embed hosts do not survive the page.

### 9. Embeddable, mobile-friendly speaker gallery and schedule itinerary — struck in the brief

Built.

- One script tag and a `<div data-sessionboard="speakers">` or
  `="agenda"` renders into any page. `/embed/demo` is the copy-paste screen;
  `/organizer/embed` is where an organizer gets the snippet. `/embed/speakers`
  and `/embed/agenda` are the iframe fallback for a CMS that allows one and not
  the other.
- The feeds are `/embed/speakers.json` and `/embed/agenda.json`, CORS-enabled
  and readable signed out. Nothing about the widget depends on a session cookie.
- Before the agenda is published, both widgets say so rather than rendering
  nothing, and the feed returns an empty list. Who got in is the committee's
  announcement to make.
- An unknown widget name or a malformed filter fails soft. A 500 on somebody
  else's website reads as our outage.
- Tests: `embed.spec.ts` — all three, driven from a real one-file HTTP server on
  a different origin rather than an intercepted route, so the CORS headers are
  genuinely under test.

## The organizer's margin notes on the brief

| Note | Marked | Where it is satisfied |
| --- | --- | --- |
| Submission payments and fees | "NOT NEEDED" | Out of scope, below |
| Form close date | "kinda impt" | `events.cfp_closes_at`; `/cfp` says "Open until" and refuses after; editable at `/organizer/cfp` |
| Auto-redirect to the portal after submitting, plus the success message | "make sure this works" | `/cfp` redirects to `/speaker?submitted=1` and shows `submitted-confirmation`; asserted in `speaker-calendar.spec.ts` |
| Submission confirmation email to the submitter | "must have" | `submissionReceivedMail`; asserted in the same test |
| Admin alert on a new submission | "nice to have" | Mailed to the organizer; asserted in the same test |

## Deliberately not built

Each of these is a decision, not a gap.

- **Attendee registration, ticketing, check-in, sponsors and exhibitors.** This
  is programme software. Those are the other half of an events platform and
  they share almost no data model with this half.
- **Submission payments and payment gateways.** The brief's own annotation says
  "NOT NEEDED".
- **Multi-language workflows.** A real one is a content model change, not a
  string table, and doing it badly is worse than not doing it.
- **AMS integrations (iMIS, Personify, Blackbaud, Salesforce).** The Accelevents
  work is not a precedent: it is one direction, one target, and a fixture stands
  in for the far end. A two-way sync against a membership system means deciding
  whose edit wins, which is a decision for a conference that has been bitten by
  it.
- **SOC 2 and GDPR posture.** A compliance claim needs an auditor, not a commit.
- **Natural-language report building.** The exports are CSV and JSON, which is
  what someone actually loads into a spreadsheet.

## What an evaluator should not assume works

Stated plainly, because every one of these is easy to mistake for a feature.

- **Nothing here has been user-tested.** The bar this was built to is "every
  requirement is reachable from a route and covered by an end-to-end test", not
  "someone ran a conference on it".
- **The Accelevents wire format is unverified.** See requirement 7.
- **The AI evaluator has never been run against the live API in this repository.**
  It is off unless `ANTHROPIC_API_KEY` is set.
- **There is no deployment and no public git remote.** Both are hackathon
  submission requirements and both are outstanding as of 2026-08-08.
- **Mail goes to `.mail/` unless `RESEND_API_KEY` is set.** That is how the tests
  read magic links, and it means a fresh deploy sends nothing until the key is
  there.
- **The drag is asserted with hand-driven mouse events, not `dragTo`.** On a
  grid taller than the viewport `dragTo` scrolls the target into view after the
  mouse button is down and before Chromium starts the drag, so `dragstart` fires
  on whichever cell slid under a stationary cursor. Measured, and it moved a talk
  the test had never named. `schedule.spec.ts` now presses, moves and releases by
  hand inside a viewport tall enough that nothing scrolls mid-gesture.

## Subfeature sweep, 2026-08-08

Every clause of requirements 1 to 6 read back against the code, one at a time:

| Clause | Where |
| --- | --- |
| 1 · conditional logic | `showIfQuestionId` / `showIfValue` on `form_questions` |
| 1 · category-based routing | `planAssignments({ matchTrack })`, plus per-question narrowing by `formats` and `trackIds` |
| 2 · bios, headshots | `/speaker/profile` |
| 2 · slides, supporting documents | `/speaker/content`, files on local disk |
| 3 · templated | every template in `src/lib/email.ts` |
| 3 · reminders | task reminders at `/organizer/speakers`, CFP reminders at `/organizer/cfp`, both deduplicated at 24 hours |
| 3 · calendar invites to the speaker's own calendar | `.ics` with `METHOD:REQUEST`, rising `SEQUENCE`, stable UID |
| 4 · scoring workflows | `/review`, four criteria, blind at query level |
| 4 · multiple rounds | `review_rounds`, `/organizer/evaluators` |
| 5 · drag and drop | `ScheduleGrid`, with a no-script form behind it |
| 5 · conflict detection across rooms and tracks | `src/lib/conflicts.ts`, three classes |
| 5 · list, day, week, track, room | all five, plus grid, in `SCHEDULE_VIEWS` |
| 6 · real-time | 15-second self-refresh, pauses on a hidden tab |
| 6 · outstanding onboarding tasks | four tiles, a per-kind table, and a chase list |

Nothing in the wording of 1 to 6 is unbuilt.

The features visible in the brief's annotated screenshots but absent from its
requirement sentences are not built, and are listed here so nobody mistakes the
sweep above for a claim about the screenshots: pronouns, honorific and social
links on a speaker profile; saved drafts and a per-user submission cap;
participant roles with minimum and maximum counts; cross-field character limits;
XLSX export (CSV and JSON are built), session import, and a bulk file bundle;
Month and Conflicts as named schedule views; an organizer-side manual "Add
Abstract".
