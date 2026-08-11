# Missing

Capabilities and guards that the flow tracing behind `FLOWS.md` found absent.
Written 2026-08-08, revised the same day once the list had been worked through.

Every absence was checked against the source before it was written down. That
matters more than it sounds: an absence is the easiest kind of claim to get
wrong, and the pass that produced this list asserted two things the code
contradicted. Both are at the bottom under *Checked and not missing*, rather than
quietly dropped.

Thirteen of the fifteen items are now built. Each is kept with the wall it
described and the thing that removed it, because a list of solved problems is how
the next reader tells a deliberate absence from an unfinished one. **Two walls
remain**, and they are §1 and §2 below.

This is a different list from the one in `SCOPE.md`. That one is measured against
the brief and says what was declined. This one is measured against the app's own
behaviour and says where a person hits a wall.

---

## Still standing

### 1. No video upload

`SNIFFED_TYPES` in `src/lib/uploads.ts` is `application/pdf`, `image/gif`,
`image/jpeg`, `image/png` and `image/webp`. A recording is a pasted URL, and the
poster screen's own hint says so: "A video has to be a link; there is no video
upload."

Deliberate for now. Video is the one upload where storing the bytes on the app
server is the wrong answer, and object storage is out of scope by decision rather
than by oversight — see `SCOPE.md`.

### 2. No speaker or submission delete

Withdrawal is the terminal state, which is the right default for a conference
record: a programme that can lose its own history is not a record. It does leave
no path for a genuine erasure request, which is the case worth revisiting if this
ever holds real personal data.

---

## Built since this list was written

| Was missing | What closed it |
|---|---|
| Deleting an award destroyed every ballot with no confirmation | `?confirmAward=` plus a `confirm=yes` field, the shape `deleteRoom` uses (`src/app/organizer/awards/actions.ts:156`) |
| Every refusal in `submitReview` was silent | `refuse('decided')`, `refuse('own')`, `refuse('no_round')` — a refusal vocabulary, the shape `castCommitteeVote` already had |
| The fallback review queue offered a reviewer their own proposal | `openSubmissionQueue` adds `ne(submissions.speakerId, reviewerId)` (`src/lib/grading.ts:219`) |
| A speaker could not set their own availability | `/speaker/availability`, with `src/app/speaker/availability/actions.ts` writing `speaker_availability` |
| A speaker could not decline | `declineAttendance` (`src/app/speaker/actions.ts:64`), which also clears `speaker_confirmed_at`, so un-confirming is the same control |
| Nothing told a speaker what they had already been told | `mySubmissions` selects `decision_emailed_at` and `schedule_notice_key` |
| A returned content submission never said why | `submissions.content_return_reason`, rendered at `src/app/speaker/content/page.tsx:167` |
| `/login` discarded the errors `/auth/verify` sent it | The page reads `searchParams` and renders `SIGN_IN_ERRORS[params.error]` |
| No error boundary anywhere | `src/app/error.tsx`, `not-found.tsx`, `global-error.tsx`, and `guardRoute` holding one 401/403 split for all three organizer route handlers |
| Nothing ever expired a session or a token row | `sweepExpiredAuth` (`src/lib/auth.ts:116`), called from `startSession`, deleting both tables past their expiry |
| Four destructive actions had no confirmation | All four round-trip now: `?confirmTask=`, `?confirmAward=`, `?confirmDelete=` for a page, and `confirm=yes` on a nomination withdrawal and on `autoNumberBoards` |
| A completed speaker task could not be un-completed | `reopenSpeakerTaskAction` and `data-testid="task-reopen"` on the organizer's speaker page (ORG-106). Still absent from the speaker's own screen |
| A co-author could not touch poster artwork, and was linked to a page that told them they had none | `myPosters` and `writePosterUrl` both take `writableBy` |

The last three of those were built together and are covered by
`e2e/auth.spec.ts`, `e2e/onboarding.spec.ts` and `e2e/posters.spec.ts`
respectively.

---

## Deliberate, not missing

Listed so nobody files them twice.

- **A speaker cannot see their own reviews or scores.** Nothing under
  `/speaker/**` selects from `reviews`. This is the correct default for a blind
  process and should stay unless the committee decides otherwise.
- **`isPresenter` grants nothing.** It renders a badge. `canEdit`, its neighbour
  in the same table, is the real capability.
- **A co-author cannot withdraw the proposal or grant access onward.** Answering
  for the talk and handing out access stay with the person who filed it. Both are
  enforced in the action rather than by hiding the control: `addAuthorByEmail`
  drops a forged `canEdit` from anyone but the filer, and `e2e/features.spec.ts`
  posts one to prove it.
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
- **Blind review is not broken.** `reviewQueue()` was dead code and three
  documents cited it as the enforcement point, which reads like a hole. It has
  been removed, and `/review` runs `assignedQueue()` and `openSubmissionQueue()`
  from `src/lib/grading.ts`, neither of which joins `users` or selects a speaker
  column. The property always held.

---

## No defects left open

`FLOWS.md` keeps the defect register, and all eight entries are now closed. B4
was the last: `addAuthorByEmail` took `canEdit` from its caller and gated only on
`writableBy`, so a hand-built POST from a `can_edit` co-author could credit a
stranger with `can_edit = true`. It now ignores `canEdit` unless the caller is
the filer, which is the rule `setAuthorAccess` already enforced. B6 closed as a
documented decision rather than a code change; the other seven are code.
