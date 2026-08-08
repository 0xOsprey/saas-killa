# Missing

Capabilities and guards that the flow tracing behind `FLOWS.md` found absent.
Written 2026-08-08.

Every absence below was checked against the source before it was written down.
That matters more than it sounds: an absence is the easiest kind of claim to get
wrong, and the pass that produced this list asserted two things the code
contradicted. Both are recorded at the bottom under *Checked and not missing*,
rather than quietly dropped.

This is a different list from the one in `SCOPE.md`. That one is measured against
the brief and says what was declined. This one is measured against the app's own
behaviour and says where a person hits a wall.

Three defects, as opposed to absences, are already in `FLOWS.md` under *Defects
found while tracing* and are not repeated here.

---

## 1. Deleting an award destroys every ballot, with no confirmation

`deleteAward` in `src/app/organizer/awards/actions.ts` has no confirmation step,
and `award_votes.award_id` carries `onDelete: 'cascade'`. One click removes the
category, its nominees and every committee ballot ever cast in it. There is no
archive column on `awards` and no undo.

The repository holds the opposite principle elsewhere and states it: a retired
form question sets `form_questions.archived_at` and a retired evaluator sets
`evaluator_personas.active`, both so that work the committee already graded
survives. Awards are graded work and are the exception.

Rooms and tracks already show the shape of the fix. Both round-trip through
`?confirmRoom=` / `?confirmTrack=` and a `confirm=yes` field, and the room
confirmation even lists the talks the delete would unplace.

## 2. Every refusal in `submitReview` is silent

`src/app/review/actions.ts` refuses three ways and says nothing in all three:
line 45 for a submission that is no longer `submitted`, line 48 for self-review,
line 54 for no open round. Each is a bare `return` with no message, no redirect
and no `revalidatePath`. The reviewer presses Grade, the page does not change,
and the grade is gone.

Compare `castCommitteeVote` one feature over, which redirects to
`?ballot=closed`, `?ballot=not_nominated`, `?ballot=incomplete` or
`?ballot=unknown` and renders a sentence for each. The award action has a refusal
vocabulary. The review action has none.

## 3. The fallback review queue offers a reviewer their own proposal

`openSubmissionQueue` (`src/lib/grading.ts:188`) selects every
`status = 'submitted'` row and does not exclude the reader's own. `planAssignments`
does exclude `reviewer.id === submission.speakerId` when distributing, so the
gap only opens on a committee that has not run the distributor, which is exactly
a committee early in its first round.

Combined with item 2 this is the worst instance of it: the card most likely to be
pressed is the one whose refusal is silent.

## 4. A speaker cannot set their own availability

`speaker_availability` has exactly one writer, `src/app/organizer/speakers/actions.ts`,
and its own comment says so. There is no speaker-facing route to see, add or
remove a blackout window. The person who knows their flight times has to email
them to somebody who will type them in.

The schedule already reads this table: unavailability is one of the three warning
classes on the grid. The data path exists and only the speaker's end of it is
missing.

## 5. A speaker cannot decline

`/speaker` offers Confirm and nothing else. `speakerConfirmedAt` is written in
`src/app/speaker/actions.ts:22` and never reset, so a speaker cannot un-confirm
either. The only way out is `withdrawSubmission`, which sets
`status = 'withdrawn'`, writes no revision row, mails nobody and cannot be
reversed from the speaker side.

Declining a talk you cannot give is an ordinary thing that happens to every
conference. Right now it is indistinguishable from pulling the proposal.

## 6. Nothing tells a speaker what they have already been told

`/speaker` shows a status badge and a slot line the moment an organizer flips
them. Whether the speaker has been *emailed* lives in `submissions.decision_emailed_at`
and `submissions.schedule_notice_key`, and `mySubmissions` selects neither. So
the app cannot distinguish "accepted and told" from "accepted and not yet told",
and neither can the speaker looking at it.

There is no notification surface, no read state, and no history of what was sent.
`email_log` holds the record and nothing speaker-facing reads it.

## 7. A returned content submission never says why

An organizer sending content back writes a reason into `contentReturnedMail`.
`/speaker/content` shows the status flipped back to Draft and no note. The reason
exists only in the speaker's inbox, so it is lost the moment the mail is.

## 8. `/login` discards the errors `/auth/verify` sends it

`/auth/verify` redirects to `/login?error=missing` and `/login?error=expired`.
`src/app/login/page.tsx` renders `state.error` from its own action state and
never reads `searchParams`. A person clicking a link twice, or clicking one after
the 15-minute expiry, lands on a clean sign-in form with nothing said. They will
assume the link is broken rather than spent.

## 9. There is no error boundary anywhere

No `error.tsx`, `not-found.tsx` or `global-error.tsx` exists under `src/app`. A
server action that throws `NotAuthorised` surfaces as Next's default unhandled
error, which is a raw 500. Two route handlers catch it and answer 403; every
other path does not.

The three organizer route handlers also disagree with each other on the signed-out
answer: `/organizer/abstracts/export` answers 401 then 403, while
`/organizer/speakers/export` and `/organizer/integrations/[id]/bundle` answer 403
for both cases.

## 10. Nothing ever expires a session or a token row

`auth_sessions` rows are deleted only by an explicit sign-out
(`src/lib/auth.ts:121`). `currentUser` refuses an expired session and leaves the
row, with a comment saying it is left for a cleanup that does not exist.
`magic_link_tokens` is the same. Both tables grow without bound, and
`requestMagicLink` mints a `users` row for any address that asks, so `users`
grows on request too.

## 11. Four destructive actions have no confirmation

`deletePage`, `deleteAward`, `deleteSpeakerTaskAction` and `withdrawNomination`
each act on first click. Rooms, tracks and time bands all round-trip through a
confirmation. `autoNumberBoards` is the same shape without being a delete: it
overwrites every hand-set poster board number with no warning.

## 12. Smaller walls, verified and low impact

- A completed speaker task cannot be un-completed. `completeTask` only ever
  writes a timestamp and the button renders only under `!done`.
- No video upload. `SNIFFED_TYPES` in `src/lib/uploads.ts` is `application/pdf`,
  `image/gif`, `image/jpeg`, `image/png`, `image/webp`. A recording is a pasted
  URL, and the poster screen's own hint says so.
- No speaker or submission delete. Withdrawal is the terminal state, which is
  the right default for a conference record but leaves no path for a genuine
  erasure request.
- A co-author cannot withdraw the proposal, edit poster artwork, or be shown the
  poster page they are linked to. `/speaker` renders the poster link for anyone
  with an accepted poster in `mySubmissions`, and `/speaker/posters` scopes on
  `speaker_id`, so a co-author following it is told they have none.

---

## Deliberate, not missing

Listed so nobody files them twice.

- **A speaker cannot see their own reviews or scores.** Nothing under
  `/speaker/**` selects from `reviews`. This is the correct default for a blind
  process and should stay unless the committee decides otherwise.
- **`isPresenter` grants nothing.** It renders a badge. `canEdit`, its neighbour
  in the same table, is the real capability.
- **The embed feeds read without a session.** Stated at `src/lib/embed.ts:29-31`
  and gated on `agenda_published` alone, on purpose.

---

## Checked and not missing

Both of these were reported as gaps by the tracing pass and both are wrong. They
are kept here because a corrected claim is more useful than a deleted one.

- **Room and track deletion do have a confirmation.** The pass named the
  parameters `?confirmDeleteRoom=` and `?confirmDeleteTrack=`, which appear
  nowhere. The real ones are `?confirmRoom=` and `?confirmTrack=` in
  `src/app/organizer/rooms/page.tsx`, with a `confirm=yes` field checked in the
  action. The mechanism was right and the identifiers were not.
- **Blind review is not broken.** `reviewQueue()` is dead code and three
  documents cited it as the enforcement point, which reads like a hole. `/review`
  runs `assignedQueue()` and `openSubmissionQueue()` from `src/lib/grading.ts`,
  and neither joins `users` or selects a speaker column. The citations were
  corrected; the property always held.
