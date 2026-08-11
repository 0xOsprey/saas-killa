# User roles and every user flow

What each kind of person can do in this app, screen by screen, control by control.
176 flows and 799 numbered steps across four roles, written 2026-08-08 by reading
the code rather than by clicking around.

`SCOPE.md` answers "is the requirement built". This answers "what does a person
actually do", which is the question a walkthrough has to survive.

## How to read it

Every flow carries its route, what must already be true before it is reachable,
its numbered steps, its refusal paths, and the state it leaves behind. A step
names the control, its `data-testid` where the code gives it one, the server
action or route handler it calls with the file it lives in, the table and column
it writes, and what the person sees next. Identifiers are verbatim from the
source. Nothing was renamed to read better, because a renamed symbol is a symbol
you cannot grep for.

Flow ids are prefixed by part: `ORG-1` to `ORG-106`, `SPK-1` to `SPK-25`,
`REV-1` to `REV-45`. Cross-references inside a part use the same ids.

## The role model in one paragraph

Three roles live in the `role` enum as rows in `user_roles`: `organizer`,
`reviewer`, `speaker`. One person may hold several, and the seeded bootstrap
organizer holds two. Four more capabilities are real without being rows. The
anonymous visitor reads whatever the publication gates allow. The co-author is
reached through `submission_authors` rather than `submissions.speakerId`, and
what they may change hangs on the `canEdit` column. The AI evaluator holds a
genuine `reviewer` row and is kept out of human-facing lists by `users.isBot`
rather than by role. And a signed-in person holding no role at all is a valid
state, because asking for a sign-in link creates the account.

Two things about that model are worth knowing before you read Part 1. The
`speaker` role gates nothing: `requireRole('speaker')` has zero call sites, and
every speaker capability is row ownership enforced in a WHERE clause. And an
organizer without an explicit `reviewer` row can grade but never appears in the
completion dashboard, because `reviewerCompletion` and `distributionInputs`
inner-join `user_roles` on `reviewer`.

## Defects found while tracing, and what closed them

The tracing pass was read-only and changed no application code. Everything below
was found by following a flow, and the first three were reproduced or traced
rather than taken on trust. All three were fixed the same day. This section is
now the record of what each one was and where its fix lives: a defect list that
argues against working code is worse than no list.

1. **`/awards` published the acceptance list before the agenda was published.**
   `src/app/awards/page.tsx` had no `events.agenda_published` gate and no role
   check, while `/agenda`, `/agenda/[id]`, `/speakers`, `/speakers/[id]`,
   `/posters` and the embed feeds all had one. Reproduced against the seeded
   fixture, signed out, with `agenda_published = false`: `/agenda` said "not
   published" and `/awards` listed eight accepted titles each paired with its
   speaker name. Closed at `src/app/awards/page.tsx:41`, which gates on
   `!event.agendaPublished && !isOrganizer` and renders "Nominees and results
   open when the programme is published."
2. **A co-author's content edit was discarded and reported as saved.**
   `/speaker/content` admits a co-author with `can_edit = true` at every gate,
   because `myContent` and `loadOwned` scope with `writableBy`. `applyTextEdit`
   then scoped with `eq(submissions.speakerId, opts.ownerId)`, which matches zero
   rows for a co-author, and the action still redirected to `?saved=1`. Closed at
   `src/lib/content.ts:245`, which uses `writableBy` — the predicate its sibling
   `applyAbstractEdit` always used. Covered by `e2e/content.spec.ts`.
3. **Editing approved content did not send it back for moderation.**
   `saveContentDraft` called `applyTextEdit` and redirected without ever calling
   `setContentStatus`, so live slide and recording URLs were rewritten while
   `content_status` stayed `approved`. Closed at
   `src/app/speaker/content/actions.ts:205`, which calls
   `setContentStatus(row, user.id, 'draft')` on the same path.

Five more were reported by the pass without being verified. Four are closed and
one still stands:

- **Closed.** A "Slides" button on `/agenda/[id]` rendering for an accepted talk
  in `draft` state: every material now goes through `showMaterial`
  (`src/app/agenda/[id]/page.tsx:92`).
- **Closed.** `/login` discarding `?error=missing` and `?error=expired`: it reads
  `searchParams` and renders `SIGN_IN_ERRORS[params.error]` into
  `data-testid="login-error"`. Covered by `e2e/auth.spec.ts`.
- **Closed.** The public People's Choice tally rendering unsealed while the
  committee tally was sealed: `src/app/awards/page.tsx:204` passes
  `sealed={open}`.
- **Closed, as a decision rather than a fix.** The two flash messages that say
  "removed" whether or not a row matched now say in their own comments that this
  is deliberate, and a third joined them
  (`src/app/speaker/content/actions.ts:295`,
  `src/app/speaker/profile/actions.ts:104`,
  `src/app/speaker/availability/actions.ts:85`). The scope is the caller's own
  rows, so a miss means the row was already gone, and "removed" is what the
  person wanted either way.
- **Closed.** `addAuthorByEmail` used to take `canEdit` from its caller and gate
  only on `ownedSubmission(..., writableBy)`, which admits a co-author, so a
  hand-built POST from a `can_edit` co-author added a fourth person with
  `can_edit = true` through the door `setAuthorAccess` guards. It now computes
  `mayGrantAccess` (`src/lib/abstracts.ts:491`) and forces `canEdit` to `false`
  for anyone but the filer, and leaves `can_edit` out of the conflict update in
  that case rather than overwriting it. Covered by `e2e/features.spec.ts`, which
  appends the omitted field to the real form so the request carries a genuine
  action id and session cookie. See B4.

`reviewQueue()` deserves its own line because it is not a defect and reads like
one. It was dead code with no call site, three documents named it as the
blind-review enforcement point, and it has since been removed. Blind review holds:
`/review` runs `assignedQueue()` and `openSubmissionQueue()` from
`src/lib/grading.ts`, and neither joins `users` or selects a speaker column. The
citations were corrected in the same commit as this file.

---

## Part 1 — Roles, and how each one is granted and enforced

Derived from the source. Read-only pass;
nothing was executed against the database. Every identifier, path, table and column name below is
verbatim from the code.

---

#### 1. The `role` enum and the `user_roles` table

`src/db/schema.ts:41`

```ts
export const roleEnum = pgEnum('role', ['organizer', 'reviewer', 'speaker']);
```

Three values, exactly: `organizer`, `reviewer`, `speaker`. Exported as a type at
`src/db/schema.ts:855`:

```ts
export type Role = (typeof roleEnum.enumValues)[number];
```

`src/db/schema.ts:162-172`

```ts
/** A user may hold more than one role; organizers are usually reviewers too. */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);
```

Two columns, `user_id` and `role`, composite primary key on both. A user therefore holds a *set* of
roles, not one. `onDelete: 'cascade'` means deleting a `users` row removes its roles.

There is no `role` column on `users`. The only role-adjacent column on `users` is
`isBot: boolean('is_bot').notNull().default(false)` (`src/db/schema.ts:156`), which is orthogonal to
`user_roles` — see §4.

`currentUser()` materialises the set onto the session object (`src/lib/auth.ts:151-152`):

```ts
const held = await db.select().from(userRoles).where(eq(userRoles.userId, user.id));
return { ...user, roles: held.map((r) => r.role) };
```

The resulting type is `export type CurrentUser = User & { roles: Role[] }` (`src/lib/auth.ts:124`).

---

#### 2. How each role is granted

There are exactly two functions that write to `user_roles` outside the seed:
`upsertUserByEmail` and `grantRole`, both in `src/lib/auth.ts`. Plus one server action,
`grantRoleAction`, which writes the table directly.

##### `speaker`

**Self-service, on account creation.** `upsertUserByEmail` — `src/lib/auth.ts:39-59`:

```ts
const [created] = await db.insert(users).values({ email, name: name ?? null }).returning();
if (!created) throw new Error(`failed to create user for ${email}`);
// Anyone who arrives through the CFP is a speaker. Reviewer and organizer are
// granted by an organizer, never self-assigned.
await db.insert(userRoles).values({ userId: created.id, role: 'speaker' }).onConflictDoNothing();
```

The grant is inside the *create* branch. An account that already exists gets no role from this
function. Callers of `upsertUserByEmail`, i.e. every path that can mint a user row:

| Caller | File |
|---|---|
| `requestMagicLink` | `src/app/login/actions.ts:29` |
| `submitProposal` | `src/app/cfp/actions.ts:150` (only when `signedIn` is null) |
| `inviteSpeakerAction` | `src/app/organizer/speakers/actions.ts:382` |
| `addAuthorByEmail` | `src/lib/abstracts.ts:402` |

**Explicitly, by an organizer.** `inviteSpeakerAction` (`src/app/organizer/speakers/actions.ts:383`)
calls `await grantRole(speaker.id, 'speaker')` after the upsert, so an invited speaker who already
had an account still gets the role.

**Revocation is guarded.** `revokeRoleAction` (`src/app/organizer/speakers/actions.ts:54-76`)
refuses to strip `speaker` from anyone with submissions:

```ts
if (input.role === 'speaker' && (await hasSubmissions(input.userId))) return;
```

##### `reviewer`

Granted only by an organizer through `grantRoleAction`
(`src/app/organizer/speakers/actions.ts:44-52`), posted from the roster page at
`src/app/organizer/speakers/page.tsx:182`:

```ts
/** Grant a role. Reviewer and organizer are given here and never self-assigned. */
export async function grantRoleAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = roleSchema.parse({ userId: formData.get('userId'), role: formData.get('role') });
  await db.insert(userRoles).values(input).onConflictDoNothing();
  revalidatePath('/organizer/speakers');
}
```

`roleSchema` is `z.enum(roleEnum.enumValues)`, so this one action can grant any of the three.

Also granted automatically to every AI evaluator bot user — see §4.

##### `organizer`

Same single door: `grantRoleAction`. There is no other writer.

**Bootstrap** is the seed, `src/db/seed.ts:237-253`:

```ts
const organizerEmail = process.env.BOOTSTRAP_ORGANIZER_EMAIL ?? 'organizer@example.com';
...
await db.insert(userRoles).values([
  { userId: organizer.id, role: 'organizer' as const },
  { userId: organizer.id, role: 'reviewer' as const },
]);
```

The seeded organizer holds **both** `organizer` and `reviewer`.

**Self-demotion is refused** (`src/app/organizer/speakers/actions.ts:64`):

```ts
if (input.userId === actor.id && input.role === 'organizer') return;
```

##### Everything the seed grants

`src/db/seed.ts`

| Rows | Role(s) | Line |
|---|---|---|
| 1 `Programme chair`, `BOOTSTRAP_ORGANIZER_EMAIL` | `organizer` + `reviewer` | 248-253 |
| 3 `reviewer{n}@example.com` | `reviewer` | 265-267 |
| 24 `speaker{n}@example.com` | `speaker` | 281-283 |
| 1 `ai-evaluator@saas-killa.local` (`isBot: true`) | `reviewer` | 397-402 |

---

#### 3. How each role is enforced

##### The primitives

`src/lib/auth.ts:155-176`

```ts
export class NotAuthorised extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthorised';
  }
}

/** Throw unless the signed-in user holds at least one of `allowed`. */
export async function requireRole(...allowed: Role[]): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) throw new NotAuthorised('not signed in');
  if (!allowed.some((role) => user.roles.includes(role))) {
    throw new NotAuthorised(`requires one of: ${allowed.join(', ')}`);
  }
  return user;
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) throw new NotAuthorised('not signed in');
  return user;
}
```

`requireRole` is OR, not AND. `requireUser` asserts a session and nothing about roles.

There is no `middleware.ts` anywhere in the project. Every gate is in a page, a layout, a route
handler or a server action.

##### Route-level gates (pages and layouts)

| Route | Gate | File:line | Signed-out | Wrong role |
|---|---|---|---|---|
| `/organizer/**` (all pages) | layout, `roles.includes('organizer')` | `src/app/organizer/layout.tsx:36-40` | `redirect('/login')` | renders `<Notice tone="bad">Organizer access only.</Notice>`, HTTP 200 |
| `/review` | `roles.includes('reviewer') \|\| roles.includes('organizer')` | `src/app/review/page.tsx:45-53` | `redirect('/login')` | `<Notice tone="bad">This page is for programme-committee reviewers. Ask an organizer to add you.</Notice>` |
| `/awards/judge` | `roles.some(r => r === 'organizer' \|\| r === 'reviewer')` | `src/app/awards/judge/page.tsx:42-46` | `redirect('/login')` | `<Notice tone="bad">Committee access only.</Notice>` |
| `/speaker` | **session only**, no role check | `src/app/speaker/page.tsx:39-40` | `redirect('/login')` | n/a |
| `/speaker/profile` | session only | `src/app/speaker/profile/page.tsx:24-25` | `redirect('/login')` | n/a |
| `/speaker/content` | session only | `src/app/speaker/content/page.tsx:80-81` | `redirect('/login')` | n/a |
| `/speaker/posters` | session only | `src/app/speaker/posters/page.tsx:39-40` | `redirect('/login')` | n/a |
| `/speaker/pages` | session only | `src/app/speaker/pages/page.tsx:17-18` | `redirect('/login')` | n/a |
| `/speaker/pages/[slug]` | session; `isOrganizer` decides drafts | `src/app/speaker/pages/[slug]/page.tsx:23-29` | `redirect('/login')` | `notFound()` on an unpublished page |
| `/speaker/submissions/[id]/edit` | session + `canWriteSubmission(id, user.id)` | `src/app/speaker/submissions/[id]/edit/page.tsx:26-36` | `redirect('/login')` | `notFound()` |

The organizer layout states plainly that it is not the control
(`src/app/organizer/layout.tsx:30-34`):

> The organizer gate. This is defence in depth, not the control: every server action under this
> route calls `requireRole('organizer')` itself, because a layout guard does not run for a direct
> action invocation.

##### Route handlers (no layout runs)

| Route | Gate | Signed-out | Wrong role |
|---|---|---|---|
| `/organizer/abstracts/export` | `currentUser()` + `roles.includes('organizer')` (`src/app/organizer/abstracts/export/route.ts:35-39`) | **401** `Sign in first.` | **403** `Organizer access only.` |
| `/organizer/speakers/export` | `requireRole('organizer')` in try/catch (`src/app/organizer/speakers/export/route.ts:14-21`) | **403** `Organizer access only.\n` | **403**, same body |
| `/organizer/integrations/[id]/bundle` | `requireRole('organizer')` in try/catch (`src/app/organizer/integrations/[id]/bundle/route.ts:19-25`) | **403** `Organizer access only.\n` | **403**, same body |
| `/files/[...path]` | `readableUpload(id, viewer)` (`src/app/files/[...path]/route.ts:41-43`) | **404** `Not found` | **404**, same body |
| `/agenda/my.ics` | `currentUser()` (`src/app/agenda/my.ics/route.ts:15`) | **401** `Sign in to export your agenda` | — |
| `/agenda/calendar.ics` | anonymous; `agendaPublished \|\| isOrganizer` (`:16-17`) | **404** `Not found` when unpublished | — |
| `/agenda/filtered.ics` | anonymous; `agendaPublished \|\| isOrganizer` (`:14-15`) | **404** `Not found` when unpublished | — |
| `/auth/verify` | none (token *is* the credential) | `redirect /login?error=missing` / `?error=expired` | — |
| `/auth/logout` | none, POST only | 303 to `/` | — |

`src/app/organizer/abstracts/export/route.ts:31-33` explains why the two styles differ:

> `requireRole` is not used here: it throws, and a thrown authorisation error in a route handler is
> a 500 that reads like an outage. A 403 is the answer.

##### Action-level gates

Every `requireRole` call site in the codebase, by role set.

**`requireRole('organizer')` — 58 call sites across 13 action files and 2 route handlers:**

| File | Actions |
|---|---|
| `src/app/organizer/abstracts/actions.ts` | `saveAbstract`, `addAuthorAction`, `removeAuthorAction` |
| `src/app/organizer/awards/actions.ts` | `createAward`, `editAward`, `deleteAward`, `nominate`, `withdrawNomination`, `setFinalist`, `closeVoting`, `reopenVoting`, `clearWinner`, `overrideWinner`, `notifyWinners` |
| `src/app/organizer/cfp/actions.ts` | `updateCfpWindow`, `extendCfp`, `closeCfpNow`, `autoDistribute`, `addAssignment`, `removeAssignment`, `openRound`, `closeRound`, `shortlistIntoRound`, `remindReviewers` |
| `src/app/organizer/cfp/questions/actions.ts` | `addQuestion`, `updateQuestion`, `setBranch`, `moveQuestion`, `archiveQuestion`, `restoreQuestion` |
| `src/app/organizer/evaluators/actions.ts` | `createPersona`, `updatePersona`, `retirePersona`, `restorePersona`, `runPersonaEvaluation` |
| `src/app/organizer/integrations/actions.ts` | `runAcceleventsExport` |
| `src/app/organizer/pages/actions.ts` | `savePage`, `setPagePublished`, `deletePage` |
| `src/app/organizer/posters/actions.ts` | `setBoardNumber`, `autoNumberBoards` |
| `src/app/organizer/rooms/actions.ts` | `createRoom`, `updateRoom`, `moveRoom`, `deleteRoom`, `createTrack`, `updateTrack`, `deleteTrack` |
| `src/app/organizer/schedule/actions.ts` | `placeSubmission`, `clearSlot`, `addTimeBand`, `addBreakBand`, `clearBreakBand`, `deleteTimeBand`, `setAgendaPublished` |
| `src/app/organizer/settings/actions.ts` | `saveEventSettings` |
| `src/app/organizer/speakers/actions.ts` | `grantRoleAction`, `revokeRoleAction`, `updateSpeakerProfileAction`, `createSpeakerTaskAction`, `completeSpeakerTaskAction`, `deleteSpeakerTaskAction`, `bulkCreateTasksAction`, `sendTaskRemindersAction`, `inviteSpeakerAction`, `createAvailabilityAction`, `deleteAvailabilityAction` |
| `src/app/organizer/submissions/actions.ts` | `setDecision`, `notifyDecided`, `notifySchedule`, `gradePending`, `editSubmissionText`, `approveContent`, `returnContent`, `setFieldLock`, `bulkSetStatus`, `bulkSetTrack`, `bulkApproveContent`, `bulkSetLock` |

**`requireRole('reviewer', 'organizer')` — 1 call site:**
`submitReview`, `src/app/review/actions.ts:29`.

**`requireRole('organizer', 'reviewer')` — 1 call site:**
`castCommitteeVote`, `src/app/awards/judge/actions.ts:22`. The comment at
`src/app/awards/judge/actions.ts:12-20` records why the action lives outside `/organizer`:

> This action lives under `/awards/judge` rather than `/organizer/awards` because a reviewer holds
> no organizer role: under the organizer layout the page answered "Organizer access only.", so the
> reviewer half of this check was unreachable through the UI and committee judging was
> organizer-only in practice.

**`requireRole('speaker')` — zero call sites. The `speaker` role gates nothing anywhere in the app.**

**`requireUser()` — session only, no role, 17 call sites:**

| File | Actions |
|---|---|
| `src/app/awards/actions.ts` | `castCommunityVote` |
| `src/app/speaker/actions.ts` | `confirmAttendance`, `withdrawSubmission`, `completeTask` |
| `src/app/speaker/content/actions.ts` | `saveContentDraft`, `submitContentForReview`, `uploadDocument`, `removeDocument`, `withdrawContentFromReview` |
| `src/app/speaker/posters/actions.ts` | `savePosterUrl`, `uploadPoster` |
| `src/app/speaker/profile/actions.ts` | `saveProfile`, `uploadHeadshot`, `removeHeadshot` |
| `src/app/speaker/submissions/actions.ts` | `saveMyAbstract`, `addMyAuthor`, `removeMyAuthor`, `setMyAuthorAccess` |

These are gated by *row ownership in the WHERE clause*, not by role. `src/app/speaker/actions.ts:10-14`:

> Every action here scopes its WHERE clause to the caller's own speaker id. Ownership is a query
> condition, not a check before the query, so a forged submission id updates zero rows instead of
> someone else's talk.

**Bare `currentUser()` in a server action — 3 call sites, all deliberate:**

- `toggleBookmark`, `src/app/agenda/actions.ts:22` — `if (!user) redirect('/login')`
- `toggleBookmark`, `src/app/posters/actions.ts:20` — `if (!user) redirect('/login')`
- `submitProposal`, `src/app/cfp/actions.ts:105` — anonymous submission is the feature; a signed-in
  submitter has the form's `email` field ignored (`src/app/cfp/actions.ts:110`).

##### Routes with no gate at all

Public by design, gated on data state rather than identity:

- `/` (`src/app/page.tsx`) — no auth import whatsoever.
- `/login`, `/cfp` — anonymous entry points.
- `/agenda` — `event.agendaPublished || isOrganizer` (`src/app/agenda/page.tsx:30-32`).
- `/agenda/[id]` — `notFound()` unless `status === 'accepted'` **and** `agendaPublished`, either
  bypassed by `isOrganizer` (`src/app/agenda/[id]/page.tsx:54-57`).
- `/posters`, `/posters/[id]` — `posterGalleryGate(event, isOrganizer)` (`src/lib/poster.ts:148-159`).
- `/speakers` — `agendaPublished || isOrganizer` (`src/app/speakers/page.tsx:30-33`).
- `/speakers/[id]` — same, then `notFound()` (`src/app/speakers/[id]/page.tsx:22-24`).
- `/awards` — **fully public, no gate**. Nominees, finalists, tallies and declared winners are
  visible to an anonymous visitor (`src/app/awards/page.tsx`). Only the "Judge awards" link is
  role-conditional (`:49`).
- `/embed/agenda`, `/embed/agenda.json`, `/embed/speakers`, `/embed/speakers.json`,
  `/embed/embed.js`, `/embed/demo` — **no session read at all**, CORS
  `access-control-allow-origin: *` (`src/lib/embed.ts:378-381`). Gated only on
  `event.agendaPublished` inside `speakerFeed` (`src/lib/embed.ts:92`) and `agendaFeed`
  (`src/lib/embed.ts:128`). `src/lib/embed.ts:29-31`:

  > The embed is always anonymous. It never reads the session cookie, so a signed-in organizer
  > looking at their own widget sees exactly what a visitor sees, and an unpublished agenda is
  > closed for both.

##### What a thrown `NotAuthorised` does

There is no `error.tsx`, `global-error.tsx` or `not-found.tsx` anywhere under `src/app`. A server
action that throws `NotAuthorised` surfaces as Next's default unhandled error, i.e. a 500. Only
`src/app/organizer/speakers/export/route.ts` and
`src/app/organizer/integrations/[id]/bundle/route.ts` catch it and convert it to a 403.

---

#### 4. Real capabilities that are not rows in `user_roles`

##### 4a. The anonymous visitor

No session, no `user_roles` row, and a real set of capabilities:

- Read `/`, `/login`, `/cfp`, `/awards`.
- Read `/agenda`, `/agenda/[id]`, `/posters`, `/posters/[id]`, `/speakers`, `/speakers/[id]` once
  `agendaPublished` is true (posters additionally after `posterEmbargoUntil`).
- **File a proposal.** `submitProposal` requires no session (`src/app/cfp/actions.ts:99-202`). It
  creates the account, grants `speaker`, mails a magic link *and* opens a session directly
  (`startSession(speaker.id)`, `src/app/cfp/actions.ts:179`).
- Read every `/embed/*` feed cross-origin.
- Read any `kind: 'headshot'` upload — `if (row.kind === 'headshot') return row;`
  (`src/lib/uploads.ts:322`), before any session check.
- Read an approved `slides` upload and an open-hall `poster` upload
  (`src/lib/uploads.ts:336-346`).
- Download `/agenda/calendar.ics` and `/agenda/filtered.ics` once published.

Cannot: star anything (`redirect('/login')`), vote, read a `document` upload
(`src/lib/uploads.ts:350` — `if (!viewer) return null;`).

##### 4b. The signed-in attendee

Not a role name in the enum. In practice every account created through `upsertUserByEmail` carries
`speaker`, so this is a `speaker` row that has never submitted. Nothing gates on the role; the
capabilities come from `requireUser`:

- `toggleBookmark` on `/agenda` and `/posters` — same `bookmarks` row from either surface
  (`src/db/schema.ts:587-590`).
- `castCommunityVote` (`src/app/awards/actions.ts:19`) — a `'community'` channel ballot on an award
  with `publicVoting` true, inside `communityWindow`.
- `/agenda/my.ics`.
- The whole `/speaker/**` portal, since none of those pages checks the role.

##### 4c. The co-author on `submission_authors`

`src/db/schema.ts:494-519`. The two columns that matter:

```ts
/** False for a credited co-author who will not be in the room. */
isPresenter: boolean('is_presenter').notNull().default(true),
/**
 * Whether this author may act on the submission, not merely be named on it.
 * Off by default: crediting somebody is the common case, and handing them
 * write access to a proposal should be a thing the filer chose. The owner's
 * own access never reads this column, so nobody can lock themselves out.
 */
canEdit: boolean('can_edit').notNull().default(false),
```

**`canEdit` is a real capability.** It is read by exactly one predicate,
`writableBy(userId)` at `src/lib/abstracts.ts:172-188`:

```ts
export function writableBy(userId: string): SQL {
  return or(
    eq(submissions.speakerId, userId),
    exists(
      db.select({ one: sql`1` })
        .from(submissionAuthors)
        .where(and(
          eq(submissionAuthors.submissionId, submissions.id),
          eq(submissionAuthors.userId, userId),
          eq(submissionAuthors.canEdit, true),
        )),
    ),
  )!;
}
```

Consumers of `writableBy` / `canWriteSubmission`:

| Consumer | File:line | Effect |
|---|---|---|
| `mySubmissions` | `src/lib/queries.ts:213` | a `canEdit` co-author's talks appear on `/speaker` |
| `canWriteSubmission` | `src/lib/abstracts.ts:191-198` | gates `/speaker/submissions/[id]/edit` |
| `applyAbstractEdit` | `src/lib/abstracts.ts:207` | title/abstract/keywords/format/audienceLevel |
| `ownedSubmission` | `src/lib/abstracts.ts:382` | backs `addAuthorByEmail`, `removeAuthor` |
| `contentRow` / `applyTextEdit` | `src/app/speaker/content/actions.ts:65`, `:144` | slides, recording, resources, `contentStatus` |
| `readableUpload` | `src/lib/uploads.ts:354` | reads a submission's private `document` uploads |

`mySubmissions` distinguishes the two with a computed column
(`src/lib/queries.ts:207`): `isOwner: sql<boolean>\`${submissions.speakerId} = ${speakerId}\``.

**What a `canEdit` co-author cannot do**, because these compare against `submissions.speakerId`
directly rather than going through `writableBy`:

- `confirmAttendance` and `declineAttendance` (`src/app/speaker/actions.ts:25`, `:64`)
- `withdrawSubmission` (`src/app/speaker/actions.ts:135`)
- `setAuthorAccess` — hand out or take back `canEdit` (`src/lib/abstracts.ts:492`). The comment at
  `src/lib/abstracts.ts:478-481`: *"Only the filer may call this … a co-author who could grant
  access could grant it to anyone."*
- Being removed from the submission: `removeAuthor` refuses when
  `opts.userId === owned.speakerId` (`src/lib/abstracts.ts:452`)

`writePosterUrl` used to be on that list and is not any more. `myPosters` and
`writePosterUrl` both take `writableBy` now
(`src/lib/poster-queries.ts:275`, `src/app/speaker/posters/actions.ts:48`), which
is the same shape as the content fix: `/speaker` offered a co-author the poster
link and `/speaker/posters` then told them they had no posters at all.

The UI states the split at `src/app/speaker/page.tsx:182-187`:

> You are a co-author here. You can edit the proposal; withdrawing it and confirming attendance stay
> with the speaker who filed it.

**`isPresenter` is not a capability.** Every use is display or form-binding:
`src/components/AuthorList.tsx:40`, `src/app/organizer/abstracts/AuthorEditor.tsx:73` and `:121`,
`src/lib/poster-queries.ts:184`, plus the two writers
(`src/app/organizer/abstracts/actions.ts:117`, `src/app/speaker/submissions/actions.ts:179`). No
query filters on it and no gate reads it. It renders a `not presenting` badge.

An empty author list means one author, the filer — `withSpeakerFallback`
(`src/lib/abstracts.ts:297-314`) synthesises a row with `canEdit: true` and `isPresenter: true`.
`ensureFilerIsAuthorZero` (`src/lib/abstracts.ts:361-366`) materialises it with `canEdit: true` the
first time anyone touches the list.

##### 4d. The AI evaluator bot (`users.isBot`)

A bot **is** a `user_roles` row: it holds `reviewer`. Two creation paths, both granting it:

`src/lib/ai-evaluator.ts:104-114` (`evaluatorUser`, the legacy singleton at
`ai-evaluator@saas-killa.local`):

```ts
const [created] = await db.insert(users)
  .values({ email: EVALUATOR_EMAIL, name: DEFAULT_PERSONA_NAME, isBot: true }).returning();
if (!created) throw new Error('failed to create evaluator user');
await db.insert(userRoles).values({ userId: created.id, role: 'reviewer' }).onConflictDoNothing();
```

`src/lib/ai-evaluator.ts:153-158` (`createPersonaWithBotUser`, one bot per `evaluator_personas`
row, address from `personaEmail(name)` → `<slug>@saas-killa.local`).

What makes it a distinct role in practice is where it is *excluded*:

| Exclusion | File:line |
|---|---|
| `reviewerCompletion` — the completion dashboard | `.where(eq(users.isBot, false))`, `src/lib/grading.ts:100` |
| `distributionInputs` — the assignment planner's roster | `.where(eq(users.isBot, false))`, `src/lib/grading.ts:520` |
| `bulkCreateTasksAction` targets | `.filter((row) => !row.isBot)`, `src/app/organizer/speakers/actions.ts:232` |
| `sendTaskRemindersAction` roster | `.filter((row) => !row.isBot)`, `src/app/organizer/speakers/actions.ts:293-295` |

It writes through `runPersona` (`src/lib/ai-evaluator.ts:375-487`) with `source: 'ai'`,
`personaId`, `model: EVALUATOR_MODEL` (`'claude-sonnet-5'`), never through `submitReview`. Its
grades share the `reviews` table with humans; `reviewSourceEnum` (`src/db/schema.ts:65`) is the
discriminator. It has no session and no way to obtain one: nothing issues a magic link to a bot
address, and no bot address is deliverable.

Triggered by `runPersonaEvaluation` (`requireRole('organizer')`,
`src/app/organizer/evaluators/actions.ts:156`), by `gradePending`
(`src/app/organizer/submissions/actions.ts:167`), or by the CLI `pnpm evaluate`
(`src/scripts/evaluate.ts`), which runs with **no auth at all** — it is a shell entry point.

##### 4e. The organizer-is-also-reviewer overlap

Two shapes, and they disagree:

**Shape 1, the `requireRole` OR.** `submitReview` accepts `requireRole('reviewer', 'organizer')` and
`/review`'s page gate accepts either. So an organizer holding *no* `reviewer` row can grade. Same
for `castCommitteeVote` and `/awards/judge`.

**Shape 2, the `INNER JOIN`.** Two queries define "reviewer" as a `user_roles` row and nothing else:

`src/lib/grading.ts:86` (`reviewerCompletion`):
```ts
.innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, 'reviewer')))
```

`src/lib/grading.ts:519` (`distributionInputs`): the identical join.

An organizer without the `reviewer` row can therefore grade every submission, but never appears in
the completion dashboard, never receives an assignment from `autoDistribute`, and never receives a
reviewer reminder from `remindReviewers`. The seed hides this by granting the bootstrap organizer
both roles (`src/db/seed.ts:248-253`).

A third overlap is deliberate and documented: `awardVotes` has
`primaryKey({ columns: [t.awardId, t.judgeId, t.channel] })` (`src/db/schema.ts:434`), so one person
can cast one `'committee'` ballot and one `'community'` ballot on the same award. `src/db/schema.ts:409-413`:

> One vote per person per award per channel; re-voting moves the vote. The channel is in the key so
> a judge who also votes as an attendee casts two ballots that are counted in two different
> tallies, never summed.

---

#### 5. What each role can see that the others cannot

##### Blind review

The property is enforced in the query, not the template: no reviewer-facing select reaches `users`
through `submissions.speakerId`.

`src/lib/grading.ts:15-28` states the rule for the whole module:

> Queries behind the call for papers and its grading. They live here rather than in `queries.ts` so
> the blind-review rule has one place to be checked: every reviewer-facing select below joins
> `review_assignments` to `submissions` and stops there. None of them reaches `users` through
> `submissions.speakerId`.

The functions `/review` actually calls (`src/app/review/page.tsx:71-99`):

| Function | File:line | Speaker columns |
|---|---|---|
| `assignmentCount` | `src/lib/grading.ts:214` | none |
| `assignedQueue` | `src/lib/grading.ts:146` | none — `id, title, abstract, format, audienceLevel, trackName, dueAt` + `MY_GRADE` |
| `openSubmissionQueue` | `src/lib/grading.ts:188` | none, same shape, `dueAt` literal null |
| `myCompletedReviews` | `src/lib/grading.ts:248` | none. `src/lib/grading.ts:246`: *"Still no speaker column: a reviewer's own history is not a hole in blind review."* |
| the AI-notes select | `src/app/review/page.tsx:86-94` | `submissionId, score, comment, rubric` only |
| `answersByQuestion` | `src/lib/question-queries.ts` | `src/app/review/page.tsx:97-98`: *"Nothing in it joins `users`, so it does not open a hole in the blind read."* |

`reviewQueue(reviewerId)` (now removed) was the function named in `CLAUDE.md`,
`README.md` and `SCOPE.md` as the enforcement point. It did hold the property, and it had
**no callers** — see §7.

The reviewer's own grade is read out of the same aggregate via
`MY_GRADE` (`src/lib/grading.ts:127-138`), which is `max(...) filter (where reviewer = me)`. A
reviewer therefore sees `reviewCount` — how many people have graded — but not who they are and not
what they wrote. Other reviewers' comments never enter the payload.

Two further blind-review facts:

- `submitReview` refuses self-grading: `if (target.speakerId === reviewer.id) return;`
  (`src/app/review/actions.ts:48`). `planAssignments` refuses to create the assignment in the first
  place: `reviewer.id !== submission.speakerId` (`src/lib/grading.ts:457`).
- The AI evaluator is blind by type. `src/lib/ai-evaluator.ts:42-53`:

  > Exactly the columns the model is allowed to see. Blind review is a property of this type: there
  > is no speaker name, email or bio to leak, so adding one is a visible edit to a named type rather
  > than an accident inside a prompt string.

  ```ts
  export type BlindSubmission = {
    title: string; abstract: string; format: SubmissionFormat;
    audienceLevel: AudienceLevel; trackName: string | null;
  };
  ```

  and the system prompt ends `'You are not told who submitted this. Do not speculate about the
  speaker.'` (`src/lib/ai-evaluator.ts:295`).

##### What only an organizer sees

- `organizerSubmissions()` (`src/lib/queries.ts:86-110`) — the same pool *with* `speakerName` and
  `speakerEmail` beside `averageScore`. `src/lib/queries.ts:81-85`: *"Unlike the review queue this
  one carries speaker identity and average score, because deciding is exactly where both are
  needed."*
- `assignmentRoster(roundId)` (`src/lib/grading.ts:322-345`) — who is holding which submission.
  `src/lib/grading.ts:317-321`: *"the join is to the reviewer, never to the speaker."*
- `reviewerCompletion(roundId)` (`src/lib/grading.ts:60`) — per-reviewer names, emails, assigned /
  graded / outstanding / overdue counts.
- `exportRows()` → `/organizer/abstracts/export` — speaker identity, mean human score and mean AI
  score in one CSV.
- `speakerRoster()` → `/organizer/speakers` and `/organizer/speakers/export` — every account with
  its roles array, submission tallies and open tasks.
- Draft `portal_pages`: `allPages()` vs `publishedPages()` (`src/lib/portal-pages.ts:52-68`), and
  `pageBySlug(slug, includeDrafts)` whose default is `false` — *"Defaulting it to false means a
  screen that forgets to pass anything shows a speaker only what a speaker may see"*
  (`src/lib/portal-pages.ts:70-76`).
- Unpublished agenda, unpublished speaker directory and embargoed poster hall — `isOrganizer`
  short-circuits all three (`src/lib/poster.ts:153`, `src/app/agenda/page.tsx:30`,
  `src/app/speakers/page.tsx:31`).
- Unaccepted submission detail pages (`src/app/agenda/[id]/page.tsx:55`).
- Any upload of any kind: `if (viewer?.roles.includes('organizer')) return row;` is the first branch
  of `readableUpload` (`src/lib/uploads.ts:320`).
- `integration_runs` bundles, including `baseUrl` (`/organizer/integrations/[id]/bundle`).
- `submission_revisions` history at `/organizer/abstracts/[id]/history`.

##### What only a reviewer (or organizer) sees

The `/review` queue and `/awards/judge` ballot, and nothing else. A reviewer has no access to
speaker identity, to any organizer screen, or to another reviewer's grade.

##### What only the filing speaker sees

`mySubmissions` (`src/lib/queries.ts:189`) — their own and their `canEdit` co-authored rows, with
status, slot placement and materials. Their own `speaker_tasks`. Their own uploads. Published
`portal_pages`.

---

#### 6. The auth mechanism

All in `src/lib/auth.ts` unless noted.

##### Constants

```ts
export const SESSION_COOKIE = 'sb_session';               // :9
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;                 // :11  — 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;          // :12  — 30 days
```

##### Magic link

`issueMagicLink(userId)` (`:66-74`) mints `randomBytes(32).toString('base64url')`, stores **only**
`sha256(token)` in `magic_link_tokens.tokenHash`, sets `expiresAt = now + 15 min`, returns the raw
token to the caller for the email. `src/db/schema.ts:174-178`:

> Magic-link tokens. Only the SHA-256 hash is stored, so a database read does not yield a usable
> login link. Single use: `consumedAt` is set on redemption and a second redemption is rejected.

`consumeMagicLink(token)` (`:81-96`) redeems with a conditional UPDATE, not a read-then-write:

```ts
.where(and(
  eq(magicLinkTokens.tokenHash, sha256(token)),
  isNull(magicLinkTokens.consumedAt),
  gt(magicLinkTokens.expiresAt, now),
))
```

> Single use: the update is conditional on `consumedAt IS NULL`, so two concurrent redemptions of
> the same link race on the row and exactly one wins.

`requestMagicLink` (`src/app/login/actions.ts:19-34`) always reports success for a well-formed
address: *"Reporting 'no such user' would turn the login form into an oracle for who has submitted
to this conference."* Note that it calls `upsertUserByEmail`, so requesting a link for an unknown
address **creates the account and grants `speaker`**.

##### Session cookie

`startSession(userId)` (`:98-113`):

```ts
jar.set(SESSION_COOKIE, `${session.id}.${sign(session.id)}`, {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  expires: session.expiresAt,
});
```

- **Name:** `sb_session`
- **Value:** `<auth_sessions.id>.<HMAC-SHA256(id, SESSION_SECRET)>`
- **`httpOnly`:** true
- **`sameSite`:** `'lax'`
- **`secure`:** only when `NODE_ENV === 'production'`
- **`path`:** `/`
- **`expires`:** the row's `expiresAt`, i.e. now + 30 days
- No `maxAge`, no `domain`, no `partitioned`.

`sign` is `createHmac('sha256', env().SESSION_SECRET).update(sessionId).digest('hex')` (`:18-20`).

##### Verification

`currentUser()` (`:132-153`) requires every one of these to pass:

1. Cookie present.
2. `raw.lastIndexOf('.') > 0` — split id from signature on the **last** dot.
3. `signatureMatches` — `timingSafeEqual`, with an explicit length pre-check because
   *"`timingSafeEqual` throws on a length mismatch, so the lengths are checked first rather than
   letting a forged cookie of the wrong size produce an exception instead of a clean rejection"*
   (`:22-26`).
4. `auth_sessions` row exists.
5. `session.expiresAt.getTime() > Date.now()`.
6. `users` row still exists.

An expired row is *not* deleted here — *"this runs during render and Next forbids writes from a
render pass"* (`:130-131`). There is no cleanup job for `auth_sessions` or `magic_link_tokens`
anywhere in the codebase.

##### Redemption and sign-out

`/auth/verify` (`src/app/auth/verify/route.ts`) is a **GET**, deliberately:

> A GET is correct here despite being a state change: the link arrives by email and email clients
> only issue GETs. The token is single use, so a scanner that prefetches the link burns it and the
> user simply asks for another rather than gaining access.

No token → `redirect /login?error=missing`. Bad/expired/consumed → `redirect /login?error=expired`.
Success → `startSession` then `redirect /speaker`.

`/auth/logout` is **POST only** (`src/app/auth/logout/route.ts:5-13`):

> As a GET this was a live bug rather than a style point: `next/link` prefetches every link in the
> viewport, so the "Sign out" link in the nav fired this handler seconds after each sign-in and
> deleted the session the user had just opened. The same shape is also the classic CSRF hole, where
> any third-party page can log a visitor out with an `<img>` tag.

`endSession` (`:115-122`) deletes the cookie and the `auth_sessions` row.

##### A signed-out visitor hitting a gated route

Verbatim behaviours, by surface:

| Surface | Behaviour |
|---|---|
| `/organizer/**` page | `redirect('/login')` — 307 |
| `/review` | `redirect('/login')` |
| `/awards/judge` | `redirect('/login')` |
| `/speaker/**` page | `redirect('/login')` |
| `toggleBookmark` action (either) | `redirect('/login')` |
| any `requireUser` / `requireRole` action | throws `NotAuthorised('not signed in')`; no error boundary exists, so Next's default 500 |
| `/organizer/abstracts/export` | `401` body `Sign in first.` |
| `/organizer/speakers/export` | `403` body `Organizer access only.\n` |
| `/organizer/integrations/[id]/bundle` | `403` body `Organizer access only.\n` |
| `/agenda/my.ics` | `401` body `Sign in to export your agenda` |
| `/agenda/calendar.ics`, `/agenda/filtered.ics` (unpublished) | `404` body `Not found` |
| `/files/<id>` (not readable) | `404` body `Not found` |
| `/agenda/[id]` (not accepted / unpublished) | `notFound()` — Next 404 |
| `/speakers/[id]` (unpublished) | `notFound()` |

Signed-in-but-wrong-role never 403s at the page level — it renders a `Notice` inside a 200. The
`/files` route collapses 404 and 403 on purpose (`src/app/files/[...path]/route.ts:21-25`):

> One answer for "no such file" and for "not yours". Splitting them into 404 and 403 would let an
> anonymous prober walk the id space and learn which documents exist, which is most of what the
> access rule is protecting.

---

#### 7. Role capability matrix

`✓` = permitted, `—` = not permitted, `▲` = permitted with a row-level condition named in the notes.

| Capability | Anonymous | Signed-in (no role that matters) | `speaker` | co-author `canEdit` | `reviewer` | `organizer` | bot (`isBot`) |
|---|---|---|---|---|---|---|---|
| Read `/`, `/login`, `/cfp` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Read `/agenda`, `/speakers`, `/posters` once published | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Read the same **before** publication | — | — | — | — | — | ✓ | — |
| Read `/awards` (nominees, tallies, winners) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Read `/embed/*` cross-origin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| File a proposal at `/cfp` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Star / unstar (`toggleBookmark`) | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Cast a `'community'` award ballot | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `/agenda/my.ics` | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Reach `/speaker/**` | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Edit own profile, headshot | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Edit a submission's text | — | — | ▲ own | ▲ `canEdit` | — | ✓ any | — |
| Add / remove co-authors | — | — | ▲ own | ▲ `canEdit` | — | ✓ any | — |
| Grant / revoke `canEdit` (`setAuthorAccess`) | — | — | ▲ own only | — | — | — | — |
| Save / submit materials, upload documents | — | — | ▲ own | ▲ `canEdit` | — | ✓ approve | — |
| Set poster artwork (`writePosterUrl`) | — | — | ▲ own | — | — | — | — |
| Withdraw a submission | — | — | ▲ own | — | — | ✓ via `bulkSetStatus` | — |
| Confirm attendance | — | — | ▲ own | — | — | — | — |
| Complete a `speaker_tasks` row | — | — | ▲ own | — | — | ✓ any | — |
| Read a private `document` upload | — | — | ▲ owner | ▲ `canEdit` | — | ✓ any | — |
| See the blind review queue `/review` | — | — | — | — | ✓ | ✓ | — |
| File a grade (`submitReview`) | — | — | — | — | ✓ | ✓ | via `runPersona` |
| Appear in `reviewerCompletion` / get assignments | — | — | — | — | ✓ | ▲ only with a `reviewer` row | — |
| Cast a `'committee'` ballot | — | — | — | — | ✓ | ✓ | — |
| See speaker identity beside scores | — | — | — | — | — | ✓ | — |
| Decide (accept/reject), send decision mail | — | — | — | — | — | ✓ | — |
| Build the schedule, publish the agenda | — | — | — | — | — | ✓ | — |
| Configure CFP window, rounds, questions, rubric personas | — | — | — | — | — | ✓ | — |
| Grant / revoke roles | — | — | — | — | — | ✓ | — |
| Invite a speaker (bypasses `cfpIsOpen`) | — | — | — | — | — | ✓ | — |
| Freeze fields (`lockedFields`) | — | — | — | — | — | ✓ | — |
| Read / write `portal_pages` drafts | — | — | — | — | — | ✓ | — |
| CSV exports, Accelevents bundles | — | — | — | — | — | ✓ | — |
| Read any upload of any kind | — | — | — | — | — | ✓ | — |
| Sign in at all | — | ✓ | ✓ | ✓ | ✓ | ✓ | **—** |

---

#### 8. Findings worth flagging

1. **`reviewQueue()` was dead code, and it was the symbol three documents named as the blind-review
   enforcement point.** It has been removed from `src/lib/queries.ts`; `CLAUDE.md`, `README.md`
   and `SCOPE.md` no longer cite it. `/review` calls `assignedQueue` and
   `openSubmissionQueue` from `src/lib/grading.ts` instead. Both hold the property, so behaviour is
   correct; the documentation points at functions the app actually runs.

2. **No `/speaker/**` route checks the `speaker` role.** All seven pages check only
   `if (!user) redirect('/login')`. The two comments that used to assert otherwise
   (`src/app/organizer/speakers/actions.ts` and `src/lib/speakers.ts`) have been corrected to say
   the actual gate is row ownership. The `speaker` role is a roster label.

3. **The `speaker` role gates nothing.** Zero `requireRole('speaker')` call sites in the codebase.
   Every capability attributed to a speaker is row ownership (`submissions.speakerId`) or
   `writableBy`. The role is a label the roster page filters on.

4. **First-submission self-service has a hole — closed.** `submitProposal` used to grant `speaker`
   only through `upsertUserByEmail`, which it called only when `signedIn` was null, and that helper
   granted only on *create*. A signed-in user without the role who filed through `/cfp` never
   regained it. `submitProposal` now calls `grantRole(speaker.id, 'speaker')` for every filing.

5. **Organizer-without-`reviewer` is a half-reviewer — closed.** `submitReview` and `/review` still
   accept the organizer role, but `grantRoleAction` now grants `reviewer` alongside `organizer`, so
   the split can no longer be created from the UI. `reviewerCompletion` and `distributionInputs` still
   join on `role = 'reviewer'`; the fix is to stop creating organizers without it.

6. **`isPresenter` is not an access control.** It renders a `not presenting` badge and nothing else.
   Its neighbour `canEdit` in the same table is a genuine capability.

7. **Three `/organizer/*` route handlers sit outside the layout gate, and they disagree on the
   signed-out answer.** `/organizer/abstracts/export` answers 401 then 403;
   `/organizer/speakers/export` and `/organizer/integrations/[id]/bundle` answer 403 for both cases,
   because `NotAuthorised` does not distinguish them at the catch site. All three are gated; the
   status codes are inconsistent.

8. **`/embed/*` is seven unauthenticated, CORS-`*` routes.** They never read the session cookie
   (documented at `src/lib/embed.ts:29-31`) and are gated solely on `event.agendaPublished`. This is
   deliberate and stated, but it means the speaker directory and full agenda are readable by anyone
   with the URL once the agenda is published, with no rate limit and `cache-control: no-store`.

9. **`requestMagicLink` creates accounts.** Asking for a sign-in link at an address that has never
   been seen mints a `users` row and a `user_roles` row with `speaker`
   (`src/app/login/actions.ts:29` → `src/lib/auth.ts:57`). The non-enumeration property is real; the
   side effect is that `users` grows on request.

10. **Nothing expires `auth_sessions` or `magic_link_tokens`.** `currentUser` refuses an expired
    session but leaves the row, with the reason given at `src/lib/auth.ts:130-131`. There is no
    sweeper anywhere in the codebase.

11. **The AI evaluator bot holds a real `reviewer` row** and is filtered out of four human-facing
    reviewer surfaces by `isBot`, not by role. Any query that forgets the `isBot` filter counts a bot
    as a committee member.

12. **`secure` is off outside production** (`src/lib/auth.ts:109`), so the session cookie travels
    over plaintext HTTP on any non-production deployment. Expected for local development; worth
    knowing for the 127.0.0.1:9140 instance.

---

## Part 2 — Organizer flows (ORG-1 to ORG-106)

Exhaustive enumeration of every organizer flow.

#### Standing preconditions (apply to every flow below)

`src/app/organizer/layout.tsx` gates the whole
subtree: `currentUser()` null → `redirect('/login')`; a signed-in user without `organizer` in
`user.roles` gets the rendered `<Notice tone="bad">Organizer access only.</Notice>` instead of the
page. The layout comment states this is defence in depth, not the control — **every server action
under `/organizer` calls `requireRole('organizer')` itself**, because a layout guard does not run for
a direct action invocation. `requireRole` throws `NotAuthorised` (`src/lib/auth.ts`), which in a
server action surfaces as an error, not a redirect.

The two organizer route handlers (`/organizer/speakers/export`, `/organizer/abstracts/export`,
`/organizer/integrations/[id]/bundle`) run no layout at all and each re-checks the role explicitly —
see ORG-22, ORG-67, ORG-101.

The nav in `layout.tsx` `TABS` is ordered by the shape of the job, not alphabetically:
Overview · Call for papers · Submissions · Abstracts · Evaluators · Schedule · Rooms & tracks ·
Posters · Speakers · Onboarding · Awards · Speaker info · Embed · Accelevents · Settings.

Times typed into any `datetime-local` are bare wall clock, read via
`wallClockToInstant(value, event.timezone)` — never the server's zone.

---

### A. Overview

##### ORG-1. Read the overview and route to the tab that needs work
- **Route:** `/organizer`
- **Precondition:** an `events` row exists (the app is single-event per deploy).
- **Steps:**
  1. Page loads. `organizerOverview()` (`src/lib/portal.ts`) returns `{ event, statusCounts, grading, acceptedUnscheduled, tasks, cfp }`. No writes.
  2. Six `Tile` links render, each with `data-testid="tile-<label kebab>"` derived from `label.toLowerCase().replace(/[^a-z]+/g, '-')`:
     - `tile-awaiting-a-decision` → `/organizer/submissions`. Value `statusCounts.submitted`; tone `warn` when > 0. Hint counts decided/accepted/rejected/withdrawn.
     - `tile-review-completion` → `/organizer/submissions`. Shows `graded/assigned` when `grading.assigned > 0`, otherwise the bare `grading.reviewsFiled` — the code comments that before anyone is assigned there is no denominator, so it refuses to report a misleading 0%.
     - `tile-accepted-unscheduled` → `/organizer/schedule`.
     - `tile-speaker-tasks-outstanding` → `/organizer/speakers`; tone `warn` keys off `tasks.overdue`, not `tasks.outstanding`.
     - `tile-call-for-papers` → `/organizer/cfp`. Value is `cfpValue(cfp)`: `"N days left"` / `"Opens in N days"` / `"Closed"`.
     - `tile-agenda` → `/organizer/schedule`. Value `Published` or `Draft` off `event.agendaPublished`.
  3. Clicking a tile navigates. Nothing here writes.
- **Error and refusal paths:** none — the page is pure read. A missing event row would fail inside `getEvent()` upstream.
- **Ends:** unchanged state; the organizer is on another tab.

---

### B. Submissions (the decision board)

Screen: `src/app/organizer/submissions/page.tsx`
Client board: `.../SubmissionsBoard.tsx` · Actions: `.../actions.ts` · Mail: `.../mail.ts`

Board rows come from `organizerSubmissions(options)` (`src/lib/queries.ts`), which filters,
sorts and pages in SQL; the screen renders 25 of them. `organizerSubmissionCount()` runs the
same WHERE for the pager total and `organizerTotals()` counts the whole event for the header.
`LOCKABLE_FIELDS` (`src/lib/content.ts`) is `title`, `abstract`, `keywords`, `format`,
`audienceLevel`, `slidesUrl`, `recordingUrl`, `resourcesNote`.

##### ORG-2. Filter the board by content status
- **Route:** `/organizer/submissions?content=<draft|pending|approved>`
- **Precondition:** none.
- **Steps:**
  1. Click one of four filter links: `data-testid="filter-all"`, `filter-pending`, `filter-approved`, `filter-draft` (`CONTENT_FILTERS`, labels All / Awaiting review / Approved / Draft, each with its count from `organizerTotals()` — the whole event, not the page).
  2. GET navigation only. `params.content` is validated against `contentStatusEnum.enumValues`; anything else falls back to `null` (no filter).
  3. The chip href is `submissionsHref({ ...current, content, page: 1 })`, so it carries `q`, `status`, `track`, `sort` and `per` through and drops the page number.
  4. `eq(submissions.contentStatus, filters.content)` joins the WHERE in `organizerConditions()`. It used to be a `rows.filter()` in the page over every submission in the event.
  5. When `totals.pending > 0` a `<Notice tone="accent">` renders with `data-testid="content-queue"`: "N submission(s) have content awaiting review."
- **Error and refusal paths:** an unrecognised `?content=` value is silently treated as no filter. With no submissions at all: `<Empty>No submissions yet.</Empty>`. With submissions but none matching: `<Empty>Nothing matches.</Empty>` and `pager-range` reads "No submissions match these filters."
- **Ends:** no DB change. The moderation queue is this filter, not a separate screen.

##### ORG-105. Search, filter, sort and page the board
- **Route:** `/organizer/submissions?q=&status=&track=&content=&sort=&page=&per=`
- **Precondition:** none.
- **Steps:**
  1. The filter card is a `<form method="get">` with `board-search` (name `q`), `board-status` (name `status`), `board-track` (name `track`), `board-sort` (name `sort`) and `board-apply`. `content` and `per` ride along as hidden inputs when set. It carries no `page`, which is what makes narrowing the filters land on the first page of the new result.
  2. `q` matches `submissions.title`, `submissions.abstract`, `users.name` and `users.email` with `ilike '%q%'`. A `q` that matches the uuid shape is `eq(submissions.id, q)` instead, so an id from the CSV export or an organizer URL is a way back to one row.
  3. `status` is validated against `submissionStatusEnum.enumValues`, `track` against `z.string().uuid()`, `content` against `contentStatusEnum.enumValues`, `sort` against `ORGANIZER_SORTS` (`grade` · `newest` · `title`). Every unrecognised value is the default rather than an error.
  4. `organizerSubmissions()` applies all of it with `limit 25 offset (page - 1) * 25`. Every entry in `ORGANIZER_ORDER` ends on `asc(submissions.id)`: without a total order Postgres may return tied rows in a different order per query, which is a row rendered on both pages and another on neither.
  5. The pager (`data-testid="pager"`) carries `pager-range` ("Showing 1–25 of 40"), `page-prev`, `page-of`, `page-next`, and `page-all` when the result is longer than one page. `?per=all` renders the whole result under `pager-range` "Showing all N" and offers `page-paged` back.
  6. `page` is clamped to `[1, ceil(matching / 25)]`, so `?page=99` is the last page rather than an empty screen with the pager scrolled off it.
  7. Every link back to this screen is built by `submissionsHref()`, which omits defaults, so the unfiltered board stays `/organizer/submissions`.
  8. `contentRowsById()`, `recentRevisions()`, `lastEditBySubmission()` and `documentsFor()` are each scoped to the ids on the page. They used to read every submission, every document and the whole revision log on every render.
- **Error and refusal paths:** a `?track=` that is not a uuid is no filter, because an unparseable uuid reaching Postgres is a 22P02 cast error and a 500. Nothing matching: `<Empty>Nothing matches. Try a shorter search than “…”.</Empty>`. No submissions at all: `<Empty>No submissions yet.</Empty>`.
- **Ends:** no DB change. The address is the whole state, so a filtered board is linkable, reloadable and reachable with the back button.

##### ORG-3. Decide one submission (accept / reject / undecide)
- **Route:** `/organizer/submissions`
- **Precondition:** the row exists.
- **Steps:**
  1. Press **Accept** (`data-testid="accept-<submissionId>"`), **Reject**, or — shown only when `row.status !== 'submitted'` — **Undecide**. Each is a separate `<form action={setDecision}>` carrying hidden `submissionId` and `status` (`accepted` / `rejected` / `submitted`).
  2. `setDecision` (`submissions/actions.ts`) → `requireRole('organizer')` → `decisionSchema.parse` (`submissionId` uuid, `status` in `submissionStatusEnum`).
  3. Writes `submissions.status` and `submissions.updatedAt`.
  4. `revalidateDashboard()` revalidates `/organizer/submissions` and `/organizer/schedule`.
  5. The `Badge` flips and the Accept/Reject button variant changes to `primary`/`danger` to mark the current state. The right-hand caption still reads `not notified`.
- **Error and refusal paths:** a malformed id or status throws out of `z.parse` (uncaught — surfaces as a server-action error, no friendly message). **No email is sent.** The doc comment is explicit: an organizer works through the list changing their mind and nothing leaves the building until `notifyDecided`.
- **Ends:** status changed, `decisionEmailedAt` still null, so the row now counts toward the notify button's total.

##### ORG-4. Edit a title and abstract inline
- **Route:** `/organizer/submissions`
- **Precondition:** none. Locks are irrelevant here — see refusals.
- **Steps:**
  1. Click **Edit title and abstract** (`data-testid="edit-<submissionId>"`). Row text is replaced by two controls; the code comments that a page of forty always-open inputs is slower to scan and invisible to text matching.
  2. Type into `data-testid="edit-title-<id>"` (`aria-label="Title"`) and `data-testid="edit-abstract-<id>"` (`aria-label="Abstract"`).
  3. Press **Save** (`data-testid="save-<id>"`) → `editSubmissionText(formData)` inside a `useTransition`. **Cancel** discards local state, no call.
  4. `editSubmissionText` → `requireRole('organizer')` → `inlineEditSchema.parse`: `title` trim 4–200, `abstract` trim 20–8000.
  5. Calls `applyTextEdit({ submissionId, editorId, next })` (`src/lib/content.ts`), which runs a transaction: `SELECT … FOR UPDATE`, diffs against `REVISABLE_FIELDS`, returns early when nothing changed, otherwise updates `submissions` and inserts one `submission_revisions` row per changed field (`submission_id`, `editor_id`, `field`, `old_value`, `new_value`).
  6. `revalidateDashboard()` plus `revalidatePath('/agenda/<id>')`. The editor closes (`setDraft(null)`), the card un-dims.
- **Error and refusal paths:** a title under 4 or abstract under 20 characters throws from `z.parse`; there is no inline message on this board — the transition simply fails. **Locks do not apply:** the comment states an organizer edits *through* the lock, `lockedFields` freezes the speaker only, and nothing in this action consults it.
- **Ends:** text updated, revision history extended, "Last edit" line refreshed.

##### ORG-5. Approve one submission's content
- **Route:** `/organizer/submissions` → the `<details>` panel "Content and locks"
- **Precondition:** `row.contentStatus !== 'approved'` (the button is not rendered otherwise).
- **Steps:**
  1. Open the row's **Content and locks** disclosure.
  2. Press **Approve content** (`data-testid="content-approve-<id>"`) → `approveContent({submissionId})`.
  3. `requireRole('organizer')`, `z.string().uuid().parse`, then `moveContent([id], 'approved', editor.id)`: reads the prior `submissions.contentStatus`, writes the new one plus `updatedAt`, then `logRevisions` inserts a `submission_revisions` row with `field: 'contentStatus'`.
  4. `revalidateContent([id])` revalidates `/organizer/submissions`, `/speaker/content`, `/posters` and `/agenda/<id>`.
- **Error and refusal paths:** none beyond the uuid parse. Publishing follows from the status alone — nothing else gates it.
- **Ends:** `contentStatus = 'approved'`; slides/recording/resources become visible on the public detail page.

##### ORG-6. Send content back for changes
- **Route:** `/organizer/submissions` → "Content and locks"
- **Precondition:** `row.contentStatus !== 'draft'` (the reason field and button are hidden when it is already draft).
- **Steps:**
  1. Type into **Why it is going back** (`data-testid="return-reason-<id>"`, `aria-label="Reason for sending content back"`).
  2. Press **Send back** (`data-testid="content-return-<id>"`). The button is `disabled` client-side until `reason.trim().length >= 4`.
  3. `returnContent` → `requireRole` → `returnSchema.parse` (`reason` trim 4–2000).
  4. `contentRecipient(submissionId)` resolves `{speakerEmail, speakerId, title, submissionId}`; **if it returns nothing the action returns silently**.
  5. `moveContent([id], 'draft', editor.id)` runs *before* the mail is built — the comment: a send that fails leaves the speaker able to edit rather than stuck in a queue nobody is watching.
  6. `sendAndLog(contentReturnedMail({to, title, eventName, reason}), { userId, kind: 'content_returned', submissionId })` writes an `email_log` row (`user_id`, `submission_id`, `kind`, `subject`, `delivered`, `sent_at`). The mail quotes the reason verbatim and links `${APP_URL}/speaker/content`.
  7. `revalidateContent([id])`; the local `reason` is cleared.
- **Error and refusal paths:** reason under 4 chars — blocked client-side by `disabled`, and rejected server-side by the schema. Unknown submission → silent no-op.
- **Ends:** `contentStatus = 'draft'`, one revision logged, one `email_log` row.

##### ORG-7. Freeze or release one field against the speaker
- **Route:** `/organizer/submissions` → "Content and locks" → "Fields the speaker may not edit"
- **Precondition:** none.
- **Steps:**
  1. Click a field chip: `data-testid="lock-<submissionId>-<field>"`, `aria-pressed={locked}`, label from `fieldLabel(field)` with `" · locked"` appended when set.
  2. Calls `setFieldLock({submissionId, field, locked: locked ? 'false' : 'true'})` — the chip is a toggle, sending the opposite of the current state.
  3. `lockSchema.parse` constrains `field` to `LOCKABLE_FIELDS` and `locked` to the strings `'true'`/`'false'`.
  4. Runs in `db.transaction`: `SELECT lockedFields … FOR UPDATE`, then writes `submissions.locked_fields = withLock(current, field, locked)` plus `updatedAt`. The comment names the reason for the row lock: two organizers toggling two different fields would otherwise each write an array missing the other's lock. A missing row returns silently.
  5. Revalidates `/organizer/submissions`, `/speaker`, `/speaker/content`.
  6. A summary line "Locked to the speaker: …" renders above with a `warn` Badge per locked field (`knownLocks` filters to locks this build understands).
- **Error and refusal paths:** a field outside `LOCKABLE_FIELDS` fails the parse. `withLock`/`isLocked` compare on `lockKey` (underscores stripped, lower-cased), so `audienceLevel` and `audience_level` are the same lock — the comment: a lock that silently does not hold is worse than no lock.
- **Ends:** `locked_fields` updated. The speaker-facing edit action refuses the field; the organizer's own editors ignore it entirely.

##### ORG-8. Open a speaker's supporting document
- **Route:** `/organizer/submissions` → "Content and locks"
- **Precondition:** `documentsFor()` returned at least one upload for the row.
- **Steps:**
  1. Under `data-testid="organizer-documents-<id>"`, click a filename link. `href` is `uploadHref(document)` → `/files/<uploads.id>`; the size is `formatBytes(document.bytes)`.
  2. The route handler serves the bytes from `uploads.stored_name` with the human `uploads.filename` in `content-disposition`.
- **Error and refusal paths:** none on this screen. The page comment flags why this panel exists: a supporting document is private, and without it the speaker's upload would be write-only — stored, access-controlled and unreachable by the people it was sent to.
- **Ends:** no DB change.

##### ORG-9. Read a row's edit history
- **Route:** `/organizer/submissions`
- **Precondition:** at least one `submission_revisions` row (otherwise the footer reads "No edits logged yet.").
- **Steps:**
  1. Click the summary `data-testid="last-edit-<id>"` — "Last edit: {field} by {who}, {when} · N change(s) logged".
  2. The `<details>` lists `recentRevisions()` entries: field label, editor name or email, timestamp already formatted server-side in `event.timezone` (the comment: the browser's locale would disagree with the server's and fail hydration), then `"old" → "new"` or `cleared`. Values are truncated at 120 chars with an ellipsis.
- **Error and refusal paths:** none. `submission_revisions` is append-only — never updated, never deleted.
- **Ends:** no DB change.

##### ORG-10. Bulk-set status on a selection
- **Route:** `/organizer/submissions`
- **Precondition:** at least one row selected.
- **Steps:**
  1. Tick per-row `data-testid="select-<id>"` (`aria-label="Select <title>"`), or the header checkbox `data-testid="select-all"` (`aria-label="Select every submission"`), which toggles between all rows and none. Its caption reads "Select all N" / "Clear selection".
  2. The sticky `data-testid="bulk-bar"` appears at the bottom showing "N selected".
  3. Choose a status in `data-testid="bulk-status"` (`aria-label="Status to apply"`, options from `submissionStatusEnum` with `STATUS_LABELS`).
  4. Press **Set status** (`data-testid="bulk-status-apply"`) → `bulkSetStatus`. `ids` are appended as repeated `ids` fields and validated by `idsSchema` — an array of uuids, **min 1, max 500**.
  5. Reads prior values via `currentStatuses(ids)`, updates `submissions.status` + `updatedAt` for `inArray(ids)`, then `logRevisions` writes one `submission_revisions` row per id with `field: 'status'`.
  6. `revalidateDashboard()`; `onDone()` clears the selection and the bulk bar disappears.
- **Error and refusal paths:** an empty or >500 selection fails `idsSchema`. **Bulk deciding still mails nobody** — the comment: a hundred rows flipped by mistake cost an undo rather than a hundred apologies.
- **Ends:** statuses changed, revisions logged, selection cleared.

##### ORG-11. Bulk-set track
- **Route:** `/organizer/submissions`
- **Precondition:** a selection.
- **Steps:**
  1. Choose in `data-testid="bulk-track"` (`aria-label="Track to apply"`). The first option is `"No track"` with value `""`.
  2. Press **Set track** (`data-testid="bulk-track-apply"`) → `bulkSetTrack`.
  3. `trackId` is `null` when the raw value is `''`, otherwise `z.string().uuid().parse`.
  4. Updates `submissions.track_id` + `updatedAt`; logs one revision per id with `field: 'trackId'`.
- **Error and refusal paths:** a non-uuid, non-empty track fails the parse. Choosing "No track" moves the selection *out* of every track rather than being a no-op.
- **Ends:** tracks reassigned, revisions logged, selection cleared.

##### ORG-12. Bulk-approve content
- **Route:** `/organizer/submissions`
- **Precondition:** a selection.
- **Steps:**
  1. Press **Approve content** (`data-testid="bulk-approve-content"`) → `bulkApproveContent`.
  2. `moveContent(ids, 'approved', editor.id)` — same writer as ORG-5, so the same `contentStatus` revision is logged per row.
  3. `revalidateContent(ids)` revalidates `/organizer/submissions`, `/speaker/content`, `/posters` and `/agenda/<id>` for every id.
- **Error and refusal paths:** `idsSchema` bounds (1–500). Rows already approved are rewritten rather than skipped, so each gets a revision row.
- **Ends:** every selected row `approved`.

##### ORG-13. Bulk lock or unlock a field
- **Route:** `/organizer/submissions`
- **Precondition:** a selection.
- **Steps:**
  1. Choose the field in `data-testid="bulk-lock-field"` (`aria-label="Field to lock or unlock"`).
  2. Press **Lock** (`data-testid="bulk-lock"`) or **Unlock** (`data-testid="bulk-unlock"`) → `bulkSetLock` with `locked: 'true'` / `'false'`.
  3. One `db.transaction`: `SELECT id, lockedFields … WHERE inArray(ids) FOR UPDATE`, then per row — **rows already in the wanted state are skipped** (`if (isLocked(row.lockedFields, field) === locked) continue`), the comment being that `updatedAt` should still mean "this submission changed".
  4. Revalidates `/organizer/submissions`, `/speaker`, `/speaker/content`.
- **Error and refusal paths:** `bulkLockSchema` restricts `field` to `LOCKABLE_FIELDS` and `locked` to `'true'`/`'false'`. No revision is logged for a lock change (unlike a content-status change).
- **Ends:** `locked_fields` updated on the rows that needed it.

##### ORG-14. Run the AI evaluator from the board
- **Route:** `/organizer/submissions`
- **Precondition:** `evaluatorConfigured()` is true — otherwise the button is not rendered and a `<Notice>` reads "The AI evaluator is off. Set `ANTHROPIC_API_KEY` … Human grading works without it."
- **Steps:**
  1. Press **Run AI evaluator** (`<form action={gradePending}>`, no testid).
  2. `gradePending` → `requireRole('organizer')`.
  3. `if (!evaluatorConfigured()) return;` then `const round = await activeRound(); if (!round) return;`
  4. `evaluatePending(event.name, round.id)` grades everything the evaluator has not seen, with the default persona and no options.
  5. Revalidates `/organizer/submissions` and `/review`.
- **Error and refusal paths:** **both refusals are silent** — no key, or no open review round, and the page simply re-renders unchanged with no message. The named alternative is `runPersonaEvaluation` on `/organizer/evaluators` (ORG-64), which picks a persona, takes a limit and returns a report; the comment records that both were called `runEvaluator` until the two pages were read side by side.
- **Ends:** `reviews` rows with `source = 'ai'` inserted against the active round, or nothing at all.

##### ORG-15. Send the decision emails
- **Route:** `/organizer/submissions`
- **Precondition:** at least one submission that is `accepted` or `rejected` with `decision_emailed_at IS NULL` — the button is `disabled` when `awaitingEmail === 0`.
- **Steps:**
  1. Press **Send N decision email(s)** (`data-testid="notify-decided"`) → `notifyDecided()`.
  2. Selects `id, title, status, email` joining `users` on `submissions.speakerId`, `WHERE status IN ('accepted','rejected') AND decision_emailed_at IS NULL`.
  3. For accepted rows it loads `placements(accepted)` (`src/lib/speaker-calendar.ts`) so it knows which already sit in a slot.
  4. Per row, in order:
     - rejected → `rejectionMail(email, title, eventName)`.
     - accepted **and placed** → `acceptanceMail(...)` carrying `when` (`dayLabel`, `timeOfDay`–`timeOfDay`) and `room`, plus a `calendarAttachment(ics)` built by `inviteFor(placement, {eventName, organizer, sequence})` where `sequence = (placement.noticeSeq ?? 0) + 1`.
     - accepted, unplaced → plain `acceptanceMail(email, title, eventName)`.
  5. `sendMail(mail)`, then **immediately** `UPDATE submissions SET decision_emailed_at = now()` for that row, and — only when placed — also `schedule_notice_key = placement.key` and `schedule_notice_seq = sequence`.
  6. `logEmail({ userId: speakerId, submissionId, kind: 'decision_accepted' | 'decision_rejected', subject, delivered })` writes the `email_log` row ORG-16 reads. **After** the idempotency write rather than through `sendAndLog`, so a receipt that fails costs the log a row instead of costing the speaker a second acceptance mail on the retry.
  7. Revalidates `/organizer/submissions` and `/speaker`.
- **Error and refusal paths:** `decision_emailed_at` is the idempotency key, so a second press finds nothing to send. The per-row write is deliberate: a failure halfway leaves the already-sent speakers marked and a retry resumes rather than restarting. The `scheduleNoticeKey` write matters — without it `notifySchedule` (ORG-52) would read the talk as newly placed and send a second invitation minutes later for a time nothing had changed about.
- **Ends:** speakers told; the row caption flips to "speaker notified"; the button becomes disabled.

---

### C. Abstracts

Index: `.../organizer/abstracts/page.tsx` · Detail: `.../abstracts/[id]/page.tsx` ·
History: `.../abstracts/[id]/history/page.tsx` · Book: `.../abstracts/book/page.tsx` ·
Export: `.../abstracts/export/route.ts` · Actions: `.../abstracts/actions.ts`

`EDITABLE_FIELDS` (`src/lib/abstracts.ts`) is `title`, `abstract`, `keywords`, `format`,
`audienceLevel`.

##### ORG-16. Search and filter the abstract index
- **Route:** `/organizer/abstracts?q=&track=&status=`
- **Precondition:** none.
- **Steps:**
  1. Type into **Search** (`data-testid="abstract-search"`, hint "Title, abstract text and keywords"), choose **Track** and **Status**, press **Apply**. It is a `method="get"` form.
  2. `status` is matched against `submissionStatusEnum.enumValues`, else `null`. `track` is `z.string().uuid().safeParse(filters.track).data ?? null` — the comment: a hand-edited non-uuid `?track=` would reach Postgres as a cast error and 500 the page, so an unparseable filter is simply no filter.
  3. `abstractIndex({q, trackId, status})` returns the rows. The header reads "N submission(s) shown · M edited since filing".
  4. Each card links to `/organizer/abstracts/<id>`; a row with `revisionCount > 0` shows a `warn` Badge linking to the history page, `data-testid="edited-<id>"`. Otherwise the card reads "unedited".
- **Error and refusal paths:** no matches → `<Empty>Nothing matches. Try a shorter search than "<q>".</Empty>`, or "Clear the filters." when `q` is empty.
- **Ends:** no DB change.

##### ORG-17. Edit one abstract as an organizer
- **Route:** `/organizer/abstracts/<id>`
- **Precondition:** `<id>` parses as a uuid and `submissionForEdit` finds it — otherwise `notFound()`.
- **Steps:**
  1. The page shows a status `Badge`; if any of `EDITABLE_FIELDS` is locked it also shows a `warn` Badge "frozen against the speaker: …" and a `<Notice>`: "Locked fields stop the *speaker* editing them. An organizer can always fix copy, so every field below is editable here."
  2. `AbstractEditor` renders `AbstractFields` with `locked={[]}` — five inputs: Title (max 200), Abstract (`minLength=120`), Keywords (comma separated), Format `<Select>`, Audience level `<Select>`.
  3. Press **Save changes** (`data-testid="save-abstract"`) → `saveAbstract` via `useActionState`.
  4. `requireRole('organizer')`; `submissionId` uuid-parsed; `submissionForEdit` re-read. **A field the form did not send keeps its stored value rather than blanking** (`text(...) ?? current.title`, etc.).
  5. `editSchema`: title 6–200, abstract 120–5000, format/audienceLevel from their enums. Keywords go through `parseKeywords` — comma split, whitespace collapsed, case-insensitive dedupe.
  6. `applyAbstractEdit` writes the changed columns on `submissions` and one `submission_revisions` row per changed field.
  7. `revalidateAbstract(id)` hits `/organizer/abstracts`, `/organizer/abstracts/<id>`, `/organizer/abstracts/<id>/history`, `/organizer/abstracts/book`, `/organizer/submissions`, `/agenda/<id>` and `/speaker`.
  8. Result renders in place: `Notice tone="good"` "Saved. N field(s) added to the revision history.", or "No changes to save." when `changed.length === 0`.
- **Error and refusal paths:** `'Unknown submission.'` for a bad uuid or a missing row. A validation failure returns the first Zod issue message — `'Give the talk a title'` (under 6) or `'Abstracts under 120 characters are too thin to review'`. No CFP-window check and **no lock check**: the comment states locks exist to stop a speaker rewriting a proposal under review, and an organizer fixing a typo is the case they were built for.
- **Ends:** submission updated, revisions appended.

##### ORG-18. Add a co-author
- **Route:** `/organizer/abstracts/<id>` → Authors card
- **Precondition:** the submission exists.
- **Steps:**
  1. Fill **Co-author email** (required, hint "An account is created if there is none."), **Name** (max 120), **Affiliation** (max 200).
  2. Tick or clear **Will be in the room** (`name="isPresenter"`, checked by default). The organizer's `AuthorEditor` is rendered **without** `accessAction`, so the "Can edit this proposal" checkbox and the per-author "Let them edit / Revoke editing" button do not appear — the comment: only the speaker who filed a proposal may hand out write access, and the organizer sees a `can edit` badge instead.
  3. Press **Add co-author** → `addAuthorAction`.
  4. `authorSchema` validates the email (`'Enter a valid email address'`). `addAuthorByEmail` then: resolves or creates the person via `upsertUserByEmail` (a new account is granted the `speaker` role), calls `ensureFilerIsAuthorZero` to materialise the filer at `position 0` with `canEdit: true`, computes the next `position` as `coalesce(max(position),0)+1`, and inserts into `submission_authors` (`affiliation`, `is_presenter`, `can_edit` — `canEdit` defaults to `false` here since the organizer form sends nothing).
  5. Re-adding someone already credited hits `onConflictDoUpdate` on `(submission_id, user_id)` and edits their affiliation/presenter/access — **their position is theirs and is not reshuffled**.
  6. `logAuthorChange` inserts a `submission_revisions` row with `field: 'authors'`, old and new being the comma-joined email lists; identical lists log nothing.
  7. Notice: "<email> is credited on this submission."
- **Error and refusal paths:** `'Submission not found.'` when `ownedSubmission` returns nothing; `'Unknown submission.'` for a bad id; the Zod email message otherwise.
- **Ends:** author row present, one `authors` revision.

##### ORG-19. Remove a co-author
- **Route:** `/organizer/abstracts/<id>` → Authors card
- **Precondition:** the author is **not** the filer — the Remove form is not rendered for `author.userId === speakerId`, who instead carries a `filed this` badge.
- **Steps:**
  1. Press **Remove** on the author's row → `removeAuthorAction` with `submissionId` and `userId`.
  2. `removeAuthor` deletes from `submission_authors` on `(submission_id, user_id)` and logs the `authors` revision.
  3. Notice: "Co-author removed."
- **Error and refusal paths:** `'Unknown author.'` when either id fails to parse; `'Submission not found.'`; and the server-side backstop `'The speaker who filed the submission cannot be removed from it.'` even though the UI hides that button.
- **Ends:** author removed, revision logged.

##### ORG-20. Read the revision history for one abstract
- **Route:** `/organizer/abstracts/<id>/history`
- **Precondition:** valid uuid; `submissionForEdit` finds the row, else `notFound()`.
- **Steps:**
  1. Arrive from **Revision history** on the detail page, or the `edited-<id>` badge on the index.
  2. Newest first. Each `data-testid="revision-<revisionId>"` card shows an accent Badge with `fieldLabel(field)`, the editor name or email, and the timestamp in `event.timezone` (`dateStyle: 'medium'`, `timeStyle: 'short'`), then a Was/Now pair.
  3. `readable()` maps stored enum values back to labels for `format` and `audienceLevel`; `null` or `''` renders as `—`.
- **Error and refusal paths:** no revisions → `<Empty>Nothing has been edited since this was filed.</Empty>`.
- **Ends:** no DB change.

##### ORG-21. Produce the abstract book
- **Route:** `/organizer/abstracts/book`
- **Precondition:** something accepted, else `<Empty>Nothing has been accepted yet.</Empty>`.
- **Steps:**
  1. Press **Abstract book** on the index (a `LinkButton`).
  2. `acceptedForBook()` supplies rows; `authorsForMany` the billing; `groupByTrack` folds consecutive rows into sections, with `'Unassigned'` for a null track.
  3. Each entry renders title, `AuthorListView` (falling back to the filer via `withSpeakerFallback`), the abstract with preserved whitespace, then format label and keywords.
  4. Print from the browser. The inline `PRINT_CSS` hides `header, nav, .no-print`, sets `.book-track { break-before: page }` (except the first) and `.book-entry { break-inside: avoid }` — the comment: an abstract split across a page turn is the one thing that makes a printed programme unusable.
- **Error and refusal paths:** none; read-only.
- **Ends:** no DB change.

##### ORG-22. Export the scoring CSV
- **Route:** `GET /organizer/abstracts/export`
- **Precondition:** signed in as an organizer.
- **Steps:**
  1. Click **Export CSV** (`data-testid="export-csv"`). It is a plain `<a>`, not a `LinkButton` — the comment: a route handler, not a page, because this must download rather than navigate.
  2. The handler uses `currentUser()` rather than `requireRole` — the comment: `requireRole` throws, and a thrown authorisation error in a route handler is a 500 that reads like an outage; a 403 is the answer.
  3. Fixed `HEADER`: `id, title, abstract, speaker_name, speaker_email, track, format, level, status, keywords, review_count, mean_human_score, mean_ai_score`. Scores render via `toFixed(2)` or empty.
  4. Then one extra column per organizer-configured question, in form order, **retired ones included** — the comment: a retired question that was answered is data somebody decided on, and dropping the column would silently shorten the record. Every row gets every column so the file stays rectangular; an unasked question leaves the cell empty. Values pass through `displayAnswer(question, value)`.
  5. Response: `text/csv; charset=utf-8`, `content-disposition: attachment; filename="abstracts-<YYYY-MM-DD>.csv"`, `cache-control: no-store`.
- **Error and refusal paths:** not signed in → **401** `Sign in first.` Signed in without the organizer role → **403** `Organizer access only.`
- **Ends:** file downloaded; no DB change.

---

### D. Call for papers, review rounds and reviewer assignment

Screen: `.../organizer/cfp/page.tsx` · Actions: `.../organizer/cfp/actions.ts`

The page renders outcomes from the query string. `ERRORS` and `SAVED` are maps read on load, so
every refusal below is a redirect back to `/organizer/cfp?error=<key>`, not a thrown error. Verbatim
messages:

| key | message |
|---|---|
| `window` | `The call cannot close before it opens.` |
| `order` | `A round cannot be due before it opens.` |
| `distribute` | `Reviews per submission and the cap must both be at least one.` |
| `no-reviewers` | `Nobody holds the reviewer role yet. Grant it on the Speakers tab first.` |
| `assign` | `Pick a submission and a reviewer.` |
| `not-reviewer` | `That person does not hold the reviewer role.` |
| `decided` | `That submission has already been decided.` |
| `self-review` | `A reviewer cannot be assigned their own proposal.` |
| `no-round` | `No review round is open. Open one before assigning or reminding.` |
| `round-name` | `Give the round a name.` |
| `no-previous-round` | `There is no earlier round to carry forward from.` |
| `nothing-shortlisted` | `Nothing was shortlisted, so nothing was carried forward.` |

`SAVED` keys: `window` → `Call window saved.`, `extended` → `Deadline extended.`,
`closed` → `The call is closed.`, `distributed`, `assigned`, `unassigned`, `reminded`,
`round-opened`, `round-closed`, `carried`.

##### ORG-23. Move the call-for-papers window
- **Route:** `/organizer/cfp`
- **Precondition:** none.
- **Steps:**
  1. Fill **Opens** (`data-testid="cfp-opens-at"`) and **Closes** (`data-testid="cfp-closes-at"`), both `datetime-local`, prefilled by `toLocalInput(event.cfpOpensAt, event.timezone)`.
  2. Press **Save window** (`data-testid="save-cfp-window"`) → `updateCfpWindow`.
  3. `requireRole('organizer')`; both values go through `wallClockToInstant(raw, event.timezone)` — the comment: `datetime-local` posts a bare wall clock, and reading it in the server's zone would move the deadline by the offset between them.
  4. Guard: `if (opensAt && closesAt && closesAt <= opensAt) redirect('/organizer/cfp?error=window')`.
  5. Writes `events.cfp_opens_at` and `events.cfp_closes_at`; `revalidatePath('/organizer/cfp')`, `revalidatePath('/submit')`, then `redirect('/organizer/cfp?saved=window')`.
- **Error and refusal paths:** `?error=window` for a close at or before the open. A blank field stores `null` (that side of the window is unbounded).
- **Ends:** the window moved; `/submit` re-gated on the next request.

##### ORG-24. Extend the deadline by a week
- **Route:** `/organizer/cfp`
- **Precondition:** the button is only rendered when `event.cfpClosesAt` is set.
- **Steps:**
  1. Press **Extend 7 days** (`data-testid="extend-cfp"`). The form carries `<input type="hidden" name="days" value="7">`.
  2. `extendCfp` → `z.coerce.number().int().min(1).max(90).parse(days)`.
  3. Reads the current `cfpClosesAt`; **returns silently if it is null** — the comment: extending an open-ended call is not a thing.
  4. Writes `cfp_closes_at = new Date(current.getTime() + days * 86_400_000)` — arithmetic on the instant, not on the wall clock, so a DST boundary inside the seven days does not shift the deadline's local time by an hour.
  5. Revalidates `/organizer/cfp` and `/submit`, then `?saved=extended`.
- **Error and refusal paths:** `days` outside 1–90 throws from the parse (the UI only ever sends 7). No close date → silent no-op.
- **Ends:** deadline seven days later.

##### ORG-25. Close the call now
- **Route:** `/organizer/cfp`
- **Precondition:** `closesAt` is absent or in the future — the button carries `disabled={closed}`, where `closed = Boolean(closesAt && closesAt <= now)`.
- **Steps:**
  1. Press **Close now** (`data-testid="close-cfp"`, `variant="danger"`) → `closeCfpNow`.
  2. Writes `events.cfp_closes_at = new Date()`.
  3. Revalidates `/organizer/cfp` and `/submit`, then `?saved=closed`.
- **Error and refusal paths:** none. The header Badge flips to `Closed`. Note this closes *submissions*, not review; and `inviteSpeakerAction` (ORG-68) deliberately ignores it.
- **Ends:** `/submit` refuses new proposals.

##### ORG-26. Open a review round
- **Route:** `/organizer/cfp` → "Open a new round"
- **Precondition:** the form is only rendered when there is no open round (`!round`).
- **Steps:**
  1. Fill **Round name** (`data-testid="round-name"`, e.g. "Second pass") and optionally **Due** (`data-testid="round-due-at"`, `datetime-local`).
  2. Press **Open round** (`data-testid="open-round"`) → `openRound`.
  3. Name is trimmed; empty → `?error=round-name`. `dueAt` via `wallClockToInstant`.
  4. `position` = `max(review_rounds.position) + 1` (`nextPosition()`); insert with `opens_at: new Date()`, `due_at`, `closed_at` null.
  5. Guard after computing: `if (dueAt && dueAt <= opensAt) redirect('?error=order')`.
  6. Revalidates `/organizer/cfp` and `/review`, then `?saved=round-opened`.
- **Error and refusal paths:** `round-name`, `order`. The rounds card renders `<Empty>No review rounds yet. Open one to start assigning.</Empty>` before the first.
- **Ends:** exactly one open round; `activeRound()` now resolves, unblocking ORG-14, ORG-29, ORG-30, ORG-32, ORG-64.

##### ORG-27. Close a review round
- **Route:** `/organizer/cfp` → the rounds list
- **Precondition:** the round has `closedAt === null` (the button renders only then).
- **Steps:**
  1. Press **Close** (`data-testid="close-round-<roundId>"`) beside the row (`data-testid="round-<roundId>"`, showing name, `Open`/`Closed` Badge and `submissions/assignments` counts).
  2. `closeRound` → `roundId` uuid-parsed → `UPDATE review_rounds SET closed_at = now() WHERE id = ? AND closed_at IS NULL`.
  3. Revalidates `/organizer/cfp` and `/review`, then `?saved=round-closed`.
- **Error and refusal paths:** the `isNull(closedAt)` predicate makes a double-press a no-op rather than overwriting the original close time. **A round is never deleted** — the comment: assignments and reviews hang off it and the history is the record of how the programme was chosen.
- **Ends:** no open round. Assignment, reminders and evaluator runs all refuse with `no-round` until ORG-26 runs again.

##### ORG-28. Shortlist into a new round
- **Route:** `/organizer/cfp` → "Carry forward into a new round"
- **Precondition:** at least one earlier round exists and something in it scored above the shortlist bar.
- **Steps:**
  1. Tick the submissions to carry: `data-testid="shortlist-<submissionId>"`, one checkbox per candidate row (title plus mean score).
  2. Optionally set **Due** (`data-testid="shortlist-due-at"`).
  3. Press **Carry forward** (`data-testid="carry-forward"`) → `shortlistIntoRound`.
  4. The action reads every `submissionIds` value, resolves the previous round, and calls `carryForward` (`src/lib/rounds.ts`) which opens the next round and inserts `review_assignments` rows for the carried set.
  5. Revalidates and redirects `?saved=carried`.
- **Error and refusal paths:** `?error=no-previous-round` when there is nothing to carry from; `?error=nothing-shortlisted` when the tick list is empty.
- **Ends:** a new round open, populated with the shortlist only.

##### ORG-29. Auto-distribute reviewer assignments
- **Route:** `/organizer/cfp` → "Distribute"
- **Precondition:** a round is open **and** at least one person holds `reviewer`.
- **Steps:**
  1. Set **Reviews per submission** (`data-testid="reviews-per-submission"`, `type=number`, min 1 max 10, default **3**).
  2. Set **Cap per reviewer** (`data-testid="max-per-reviewer"`, min 1 max 500, default **20**).
  3. Optionally set **Due** (`data-testid="distribute-due-at"`).
  4. Optionally tick **Prefer a matching track** (`data-testid="match-track"`).
  5. Press **Distribute** (`data-testid="auto-distribute"`) → `autoDistribute`.
  6. Guards in order: `activeRound()` null → `?error=no-round`; `perSubmission < 1 || maxPer < 1` → `?error=distribute`; no reviewers → `?error=no-reviewers`.
  7. Builds pairs across `submitted` submissions, skipping any reviewer who is the submission's own speaker, honouring the cap and the optional track preference, then bulk-inserts into `review_assignments` (`round_id`, `submission_id`, `reviewer_id`, `due_at`) with **`onConflictDoNothing`** on the three-column primary key — the comment: pressing distribute twice must not double anyone's pile.
  8. Redirects to `?saved=distributed&assigned=<n>&short=<m>`. The page then renders `Notice tone="good"`: "N assignment(s) added." and, when `short > 0`, `Notice tone="warn"`: "M submission(s) are still short of the target."
- **Error and refusal paths:** the three redirects above. Existing assignments survive untouched.
- **Ends:** `review_assignments` filled; the coverage table reflects it.

##### ORG-30. Assign one reviewer by hand
- **Route:** `/organizer/cfp` → "Assign by hand"
- **Precondition:** a round is open.
- **Steps:**
  1. Pick **Submission** (`data-testid="manual-submission"`), **Reviewer** (`data-testid="manual-reviewer"`), optionally **Due** (`data-testid="manual-due-at"`).
  2. Press **Assign** (`data-testid="manual-assign"`) → `addAssignment`.
  3. Guards, in this order, each its own redirect:
     - either id missing → `?error=assign`
     - no open round → `?error=no-round`
     - the reviewer row must exist, hold the `reviewer` role **and have `is_bot = false`** → `?error=not-reviewer`
     - the submission must exist and be `status = 'submitted'` → `?error=decided`
     - `submission.speakerId === reviewerId` → `?error=self-review`
  4. Insert into `review_assignments` with `onConflictDoNothing`.
  5. Revalidates `/organizer/cfp` and `/review`, then `?saved=assigned`.
- **Error and refusal paths:** the five above, verbatim in the table at the head of this section. The bot exclusion matters: the AI evaluator is a `users` row and would otherwise appear in the dropdown as an assignable human.
- **Ends:** one assignment added, or nothing.

##### ORG-31. Remove an assignment
- **Route:** `/organizer/cfp` → the coverage table
- **Precondition:** the assignment exists in the **open** round.
- **Steps:**
  1. In the row `data-testid="coverage-<submissionId>"`, press the reviewer's **×** (`data-testid="unassign-<submissionId>-<reviewerId>"`, `aria-label="Unassign <name>"`).
  2. `removeAssignment` → both ids uuid-parsed → `activeRound()`; null → `?error=no-round`.
  3. `DELETE FROM review_assignments WHERE round_id = <active> AND submission_id = ? AND reviewer_id = ?` — scoped to the active round, so a closed round's record is never disturbed.
  4. Revalidates, then `?saved=unassigned`.
- **Error and refusal paths:** `no-round`. Deleting the assignment does not delete any `reviews` row already filed.
- **Ends:** the pairing is gone from the open round.

##### ORG-32. Remind the reviewers who have not finished
- **Route:** `/organizer/cfp` → "Reviewer completion"
- **Precondition:** `outstanding.length > 0` — the button is `disabled` otherwise.
- **Steps:**
  1. Press **Remind N reviewer(s)** (`data-testid="remind-reviewers"`) → `remindReviewers`.
  2. `activeRound()` null → `?error=no-round`.
  3. For each reviewer with unfinished assignments, it reads `email_log` for `kind = 'reviewer_reminder'` (`REVIEWER_REMINDER_KIND`) and **skips anyone reminded inside 24 hours**.
  4. Sends `reviewerReminderMail` and writes an `email_log` row per send.
  5. Redirects `?saved=reminded&sent=<n>&skipped=<m>`; the page renders "Reminded N reviewer(s)." and, when `skipped > 0`, appends " M were reminded in the last day and were skipped."
- **Error and refusal paths:** `no-round`; the cooldown, which is reported rather than hidden.
- **Ends:** reminders out, `email_log` extended.

##### ORG-33. Read reviewer completion and coverage
- **Route:** `/organizer/cfp`
- **Precondition:** none.
- **Steps:**
  1. The completion table lists one row per reviewer, `data-testid="completion-<reviewerId>"`: name, `done/assigned`, and a `warn`/`good` Badge.
  2. The coverage table lists one row per submission, `data-testid="coverage-<submissionId>"`: title, the assigned reviewers as removable chips, and reviews filed against the target.
- **Error and refusal paths:** none; read-only.
- **Ends:** no DB change.

---

### E. Form questions (CFP form authoring)

Screen: `.../organizer/cfp/questions/page.tsx` · `QuestionForm.tsx` · `BranchForm.tsx` ·
Actions: `.../cfp/questions/actions.ts`

`ERRORS`: `question` → `Give the question a prompt of at least three characters.`;
`options` → `A choose-one question needs at least two choices.`;
`branch-self` → `A question cannot depend on itself.`;
`branch-value` → `Pick the answer that reveals this question.`;
`branch-missing` → `That parent question no longer exists.`;
`branch-order` → `A question can only depend on one above it.`;
`move` → `That question cannot move any further.`
`SAVED`: `added`, `updated`, `moved`, `archived`, `restored`, `branch-set`, `branch-cleared`.

##### ORG-34. Add a question to the submission form
- **Route:** `/organizer/cfp/questions`
- **Precondition:** none.
- **Steps:**
  1. Fill the new-question `QuestionForm`: **Prompt** (3–300), **Help text** (≤500), **Type** (`question_kind`: `short_text`, `long_text`, `select`, `checkbox`, `url`), **Required** checkbox, **Choices** (one per line, only meaningful for `select`), and the scoping controls — **Formats** and **Tracks** — which limit which submitters see it.
  2. Press the submit button → `addQuestion`.
  3. `requireRole('organizer')`; prompt trimmed, length checked → `?error=question`.
  4. `parseOptions(raw)` splits on newlines, trims, drops blanks, dedupes case-insensitively and **caps at 25**. For `kind === 'select'`, fewer than two survivors → `?error=options`.
  5. `position` = `max(form_questions.position) + 1`. Insert into `form_questions`: `prompt`, `help_text`, `kind`, `required`, `position`, `options`, `formats`, `track_ids`, with `show_if_question_id`/`show_if_value` null and `archived_at` null.
  6. Revalidates `/organizer/cfp/questions` and `/submit`, then `?saved=added`.
- **Error and refusal paths:** `question`, `options`.
- **Ends:** the question is live at the end of the form on `/submit`.

##### ORG-35. Edit a question
- **Route:** `/organizer/cfp/questions`
- **Precondition:** the question exists.
- **Steps:**
  1. Open the question's row form (same `QuestionForm` component, prefilled) and change prompt, help text, type, required, choices, formats or tracks.
  2. Submit → `updateQuestion`.
  3. Same prompt and options validation as ORG-34.
  4. Writes the columns on `form_questions`.
  5. **Side effect:** changing `kind` away from `select`/`checkbox` unhooks any child question branching off it — `show_if_question_id` and `show_if_value` are nulled on the children, because a branch pointing at a free-text parent can never fire and would silently hide the child forever.
  6. Revalidates, `?saved=updated`.
- **Error and refusal paths:** `question`, `options`. Existing `submission_answers` are not migrated when the type changes — old answers stay as stored text.
- **Ends:** the question updated, dependent branches possibly cleared.

##### ORG-36. Set or clear a branch rule
- **Route:** `/organizer/cfp/questions` → `BranchForm` on the child question
- **Precondition:** at least one question above it whose `kind` is `select` or `checkbox`.
- **Steps:**
  1. In the child's **Only show when** control, pick a parent question and the answer value that reveals it. Submit → `setBranch`.
  2. Guards, each a redirect:
     - parent id equals the child's own id → `?error=branch-self`
     - the parent row is missing or archived → `?error=branch-missing`
     - the parent's `position` is not strictly less than the child's → `?error=branch-order`
     - the value is empty, or not one of the parent's `options` → `?error=branch-value`
  3. Writes `form_questions.show_if_question_id` and `show_if_value` on the child.
  4. Revalidates, `?saved=branch-set`.
  5. To clear, submit the same form with the parent set to none — writes both columns to null, `?saved=branch-cleared`.
- **Error and refusal paths:** the four above. The ordering rule is what makes the form renderable in one pass on `/submit`.
- **Ends:** the child is conditional, or unconditional again.

##### ORG-37. Reorder a question
- **Route:** `/organizer/cfp/questions`
- **Precondition:** there is a neighbour in the chosen direction.
- **Steps:**
  1. Press the row's **↑** or **↓** → `moveQuestion` with the id and direction.
  2. Runs in `db.transaction`: reads the question and its immediate neighbour by `position`; **no neighbour → `?error=move`**.
  3. Swaps the two `form_questions.position` values.
  4. **Then repairs branches:** any branch the swap would have inverted (a child now sorting above its parent) is cleared — `show_if_question_id`/`show_if_value` nulled — rather than left pointing backwards. The comment's reasoning: an invisible-forever question is worse than a question that lost its condition.
  5. Revalidates `/organizer/cfp/questions` and `/submit`, `?saved=moved`.
- **Error and refusal paths:** `?error=move` at either end of the list.
- **Ends:** order changed; some branches may have been dropped as a consequence.

##### ORG-38. Retire a question
- **Route:** `/organizer/cfp/questions`
- **Precondition:** the question is live (`archived_at IS NULL`).
- **Steps:**
  1. Press **Archive** on the row → `archiveQuestion`.
  2. Writes `form_questions.archived_at = now()`. The row is **never deleted** — the comment: answers already given are data somebody decided on.
  3. Any child branching off it is unhooked (`show_if_question_id`/`show_if_value` nulled) so the child does not become permanently unreachable.
  4. Revalidates, `?saved=archived`.
- **Error and refusal paths:** none beyond the uuid parse.
- **Ends:** the question disappears from `/submit`, keeps its answers, and **still gets a column in the abstracts export** (ORG-22).

##### ORG-39. Restore a retired question
- **Route:** `/organizer/cfp/questions` → the archived list
- **Precondition:** `archived_at IS NOT NULL`.
- **Steps:**
  1. Press **Restore** → `restoreQuestion`.
  2. Writes `archived_at = null` **and** a fresh `position` of `max + 1` — it returns to the end of the form, not to where it used to sit, because the positions around it have moved on.
  3. Revalidates, `?saved=restored`.
- **Error and refusal paths:** none. Its old branch rule is not restored (ORG-38 cleared the children, and its own parent link survived only if the parent is still live and still above it).
- **Ends:** the question asks again, at the bottom of the form.

---

### F. The schedule

Screen: `.../organizer/schedule/page.tsx` · Grid: `.../schedule/ScheduleGrid.tsx` ·
No-script form: `.../schedule/ScheduleFallback.tsx` · Reading views: `.../schedule/ScheduleViews.tsx` ·
Actions: `.../schedule/actions.ts` · Views table: `src/lib/schedule-views.ts` ·
Warnings: `src/lib/conflicts.ts` · Notices: `src/lib/schedule-notices.ts`

Six views come from `SCHEDULE_VIEWS`. Two are **building** views (`isBuildingView`): `grid` and
`day` — these render the drag targets and the placement forms. Four are **reading** views: `week`,
`list`, `track`, `room` — server-rendered and, per the file comment, links-free and non-interactive.

The grid's structure is `slots` rows. A time band is one `slots` row per room sharing a `starts_at`.
A slot with `submission_id` null and `label` set is a break; with `submission_id` set it is a talk.

##### ORG-40. Add a time band
- **Route:** `/organizer/schedule` (a building view)
- **Precondition:** at least one `rooms` row — a band is created per room and with no rooms there is nothing to create.
- **Steps:**
  1. Fill **Start** (`data-testid="band-start"`, `datetime-local`).
  2. Press **Add band** (`data-testid="add-band"`) → `addTimeBand`.
  3. `requireRole('organizer')`; the value passes through `wallClockToInstant(raw, event.timezone)`.
  4. Inserts **one `slots` row per room** at that `starts_at` with the computed `ends_at`, `submission_id` null and `label` null, using `onConflictDoNothing` against the unique index `slots_room_start_idx` on `(room_id, starts_at)` — so adding a band that already exists in some rooms fills only the gaps.
  5. `revalidatePath('/organizer/schedule')` and the public agenda.
- **Error and refusal paths:** a blank or unparseable start yields no instant and the action does nothing. No duplicate error is ever raised; the conflict clause absorbs it.
- **Ends:** a new empty row across every room.

##### ORG-41. Add a break band
- **Route:** `/organizer/schedule` (a building view)
- **Precondition:** at least one room.
- **Steps:**
  1. Fill **Label** (`data-testid="block-label"`, e.g. "Lunch") and **Start** (`data-testid="block-start"`).
  2. Press **Add block** (`data-testid="add-block"`) → `addBreakBand`.
  3. Inserts one `slots` row per room with `label` set and `submission_id` null, using **`onConflictDoUpdate`** on `[slots.room_id, slots.starts_at]` that sets **only `label`**, with `setWhere: isNull(slots.submissionId)`.
  4. That `setWhere` is the guard: labelling a band where a talk is already placed leaves the talk alone. A break never evicts a session.
  5. Revalidates the schedule and the agenda.
- **Error and refusal paths:** no explicit refusal message — a room already holding a talk at that time silently keeps it, unlabelled.
- **Ends:** a labelled band across the free rooms at that time.

##### ORG-42. Unname a break band
- **Route:** `/organizer/schedule` (a building view)
- **Precondition:** a band carrying a label.
- **Steps:**
  1. Press the band's clear-label control → `clearBreakBand` with the band's `startsAt` key.
  2. `z.coerce.date()` parses the key (the band key is the ISO instant, so it round-trips exactly).
  3. Writes `slots.label = null` for every row at that `starts_at`.
  4. Revalidates.
- **Error and refusal paths:** an unparseable date throws from the coercion. The slots themselves survive — this removes the name, not the band.
- **Ends:** the band is a plain empty band again, still available for placement.

##### ORG-43. Delete a time band
- **Route:** `/organizer/schedule` → `/organizer/schedule?confirmDelete=<isoStart>`
- **Precondition:** the band exists.
- **Steps:**
  1. Press the band's **Delete** control → `deleteTimeBand` with `startsAt` and no `confirm`.
  2. The action sees `confirm !== 'yes'` and **redirects to `/organizer/schedule?confirmDelete=<startsAt>`** rather than deleting.
  3. The page renders the confirmation panel `data-testid="confirm-delete-band"`, naming what will be lost (the band and everything placed in it).
  4. Press **confirm** (`data-testid="confirm-delete-band-submit"`), which re-submits with `confirm=yes`.
  5. `DELETE FROM slots WHERE starts_at = ?` across every room. Placed submissions are not deleted — they return to the unplaced pool because their `slots` row is gone.
  6. Revalidates the schedule and the agenda.
- **Error and refusal paths:** the query-string round trip is the entire guard; there is no other check. Cancelling is navigating away — the `?confirmDelete=` screen has no destructive default.
- **Ends:** the band and its placements removed; the talks are unplaced.

##### ORG-44. Place a talk by dragging it
- **Route:** `/organizer/schedule` (grid or day view)
- **Precondition:** the submission is `status = 'accepted'`; an empty cell exists.
- **Steps:**
  1. The unplaced pool lists accepted-but-unscheduled talks, each `data-testid="pool-<submissionId>"` and `draggable`.
  2. Drag one onto a grid cell `data-testid="slot-<slotId>"` and drop.
  3. `onDrop` calls `placeSubmission({slotId, submissionId})` inside a transition; the cell shows its pending state.
  4. `placeSubmission` → `requireRole('organizer')` → both ids uuid-parsed → reads the submission.
  5. **Refusal:** `if (target.status !== 'accepted') return;` — nothing else may be scheduled.
  6. In a `db.transaction`: first clear the submission's existing slot (`UPDATE slots SET submission_id = null, label = null WHERE submission_id = ?`), then fill the target (`UPDATE slots SET submission_id = ?, label = null WHERE id = ?`). Clearing first is what keeps the unique index `slots_submission_idx` satisfied — a talk exists in exactly one slot.
  7. Setting `label: null` on the target is deliberate: dropping a talk into a break band converts the band cell into a session cell rather than leaving "Lunch" printed over a talk.
  8. Revalidates the schedule and the public agenda; the grid re-renders with the talk in place and the pool one shorter.
- **Error and refusal paths:** a non-accepted submission is a **silent** no-op. Conflicts, unavailability and over-capacity are computed and shown (ORG-50) but **never block the drop** — the grid always accepts it.
- **Ends:** `slots.submission_id` set; the talk moves out of the pool; if `agendaPublished` and the speaker was already notified, this creates pending schedule notice work for ORG-52.

##### ORG-45. Place a talk by clicking
- **Route:** `/organizer/schedule` (grid or day view)
- **Precondition:** as ORG-44. This is the pointer-free path for a keyboard or touch user.
- **Steps:**
  1. Click a pool item `data-testid="pool-<submissionId>"` to pick it up; the grid holds it as the selected talk and the cells become click targets.
  2. Click an empty cell `data-testid="slot-<slotId>"`.
  3. Same `placeSubmission` call, same writes as ORG-44 step 6.
  4. The selection clears after the placement resolves.
- **Error and refusal paths:** identical to ORG-44.
- **Ends:** identical to ORG-44.

##### ORG-46. Place or clear with the no-script form
- **Route:** `/organizer/schedule` → `data-testid="schedule-fallback"`
- **Precondition:** as ORG-44. This form is server-driven and works with JavaScript off.
- **Steps:**
  1. Choose a talk in **Talk** (`data-testid="fallback-talk"`). The list includes talks already placed as well as the pool, so this form can also *move* a talk.
  2. Choose a destination in **Slot** (`data-testid="fallback-slot"`) — every slot, labelled with room and time.
  3. Press **Place** (`data-testid="fallback-place"`) → the same `placeSubmission` server action.
  4. To empty a cell instead: choose it in `data-testid="fallback-clear-slot"` and press **Clear** (`data-testid="fallback-clear"`) → `clearSlot`.
- **Error and refusal paths:** same silent refusal for a non-accepted talk. Choosing an occupied destination overwrites its occupant, which is then unplaced.
- **Ends:** as ORG-44 / ORG-47.

##### ORG-47. Clear a slot
- **Route:** `/organizer/schedule` (building views, or the fallback form)
- **Precondition:** the slot holds a talk.
- **Steps:**
  1. Press the cell's **×** (`data-testid="clear-<slotId>"`, `aria-label` naming the talk) → `clearSlot({slotId})`.
  2. `UPDATE slots SET submission_id = null, label = null WHERE id = ?` — the band row survives as an empty cell.
  3. Revalidates the schedule and the agenda.
- **Error and refusal paths:** none. `submissions.schedule_notice_key` is **not** reset here, so a speaker who was told about the old time counts as pending again once the talk lands somewhere new (ORG-52).
- **Ends:** the cell is empty; the talk is back in the unplaced pool.

##### ORG-48. Switch between the six schedule views
- **Route:** `/organizer/schedule?view=<grid|day|week|list|track|room>`
- **Precondition:** none.
- **Steps:**
  1. In `data-testid="schedule-views"`, click a view link `data-testid="view-<key>"`.
  2. `view` is validated against `SCHEDULE_VIEWS`; an unknown value falls back to the default.
  3. `grid` and `day` (`isBuildingView`) render the pool, the drop targets, the band forms and the fallback form. The other four render `data-testid="schedule-<view>"` with grouped read-only entries: `data-testid="view-group-<groupKey>"` per group heading and `data-testid="view-entry-<slotId>"` per session.
     - `week` is the exception in markup: `data-testid="schedule-week"` with cells `data-testid="week-<dayKey>-<time>"`.
     - `list` groups chronologically, `track` by `tracks.name`, `room` by `rooms.name`.
- **Error and refusal paths:** none. The reading views expose no controls at all — placing requires switching back to `grid` or `day`.
- **Ends:** no DB change.

##### ORG-49. Work one day at a time
- **Route:** `/organizer/schedule?view=day&day=<key>`
- **Precondition:** the event spans more than one day for the tabs to be useful.
- **Steps:**
  1. In `data-testid="schedule-day-tabs"`, click a tab `data-testid="day-<key>"`.
  2. The grid filters to that day's bands; everything in ORG-44–ORG-47 works unchanged within it.
- **Error and refusal paths:** an unknown `?day=` falls back to the first day.
- **Ends:** no DB change.

##### ORG-50. Read the placement warnings
- **Route:** `/organizer/schedule` (building views)
- **Precondition:** something is placed.
- **Steps:**
  1. `speakerConflicts(...)` (`src/lib/conflicts.ts`) finds a speaker in two rooms at once and surfaces `data-testid="conflict-warning"`.
  2. `availabilityConflicts(...)` compares placements against `speaker_availability` and surfaces `data-testid="availability-warning"`; the offending cell is also marked `data-testid="unavailable-<slotId>"`.
  3. `capacityWarnings(...)` compares expected draw against `rooms.capacity` and surfaces `data-testid="capacity-warning"`, marking the cell `data-testid="over-capacity-<slotId>"`.
  4. Each warning names the people and the times involved.
- **Error and refusal paths:** **none of the three blocks anything.** They are reported, not enforced — the organizer may knowingly double-book. This is the one place in the app where a detected problem does not stop the write.
- **Ends:** no DB change.

##### ORG-51. Publish or unpublish the agenda
- **Route:** `/organizer/schedule`
- **Precondition:** none.
- **Steps:**
  1. Press the toggle `data-testid="toggle-publish"` → `setAgendaPublished` with the opposite of the current value.
  2. Writes `events.agenda_published`.
  3. Revalidates the schedule and the public agenda routes.
- **Error and refusal paths:** none. Unpublishing does not un-send anything already emailed.
- **Ends:** `/agenda` visible or hidden to the public; the `tile-agenda` value on `/organizer` flips between `Published` and `Draft`.

##### ORG-52. Send schedule notices
- **Route:** `/organizer/schedule`
- **Precondition:** `pending.length > 0` — the button is `disabled` otherwise. Pending means a placed, accepted talk whose current placement key differs from the speaker's stored `submissions.schedule_notice_key`.
- **Steps:**
  1. Press **Send N schedule notice(s)** (`data-testid="notify-schedule"`) → `notifySchedule`, which delegates to `sendScheduleNotices()` in `src/lib/schedule-notices.ts`. (The same function is exposed from the submissions board's `actions.ts`.)
  2. Per pending talk it builds the placement key from room + start, computes `sequence = (schedule_notice_seq ?? 0) + 1`, builds the ICS through `inviteFor(placement, {eventName, organizer, sequence})` and mails the speaker with the calendar attachment.
  3. Writes `submissions.schedule_notice_key` and `submissions.schedule_notice_seq` per row as each send succeeds, and logs to `email_log`.
- **Error and refusal paths:** the key comparison is the idempotency guard — a second press with nothing moved sends nothing. The rising `schedule_notice_seq` is the RFC 5545 `SEQUENCE`, which is what makes a calendar client treat the second invitation as an **update** to the first rather than a second event in the speaker's diary. ORG-15 sets both fields when it mails an already-placed acceptance, precisely so this action does not immediately re-send for a time nothing changed about.
- **Ends:** speakers hold a current calendar entry; the button returns to disabled.

---

### G. Rooms and tracks

Screen: `.../organizer/rooms/page.tsx` · Actions: `.../organizer/rooms/actions.ts`

##### ORG-53. Add a room
- **Route:** `/organizer/rooms`
- **Precondition:** none.
- **Steps:**
  1. Type into **New room** (`data-testid="new-room-name"`).
  2. Press **Add room** (`data-testid="add-room"`) → `addRoom`.
  3. Name trimmed and validated; `position` computed as the next value so the room appears at the right-hand end of the grid.
  4. Inserts into `rooms` (`name`, `capacity`, `position`).
  5. Revalidates `/organizer/rooms` and `/organizer/schedule`.
- **Error and refusal paths:** an empty name is rejected by the schema.
- **Ends:** a new grid column. **Existing time bands do not gain a slot in it** — bands are materialised per room at creation time (ORG-40), so the new room is empty until a band is added.

##### ORG-54. Rename a room or change its capacity
- **Route:** `/organizer/rooms`
- **Precondition:** the room exists.
- **Steps:**
  1. Edit **Name** (`data-testid="room-name-<roomId>"`) or **Capacity** (`data-testid="room-capacity-<roomId>"`, numeric).
  2. Submit the row form → `updateRoom`.
  3. Writes `rooms.name` and `rooms.capacity`.
  4. Revalidates rooms and the schedule.
- **Error and refusal paths:** schema validation on the name and the integer capacity.
- **Ends:** the grid column relabelled; `capacityWarnings` (ORG-50) recomputes against the new number.

##### ORG-55. Reorder the rooms
- **Route:** `/organizer/rooms`
- **Precondition:** more than one room.
- **Steps:**
  1. Press a row's move control → `moveRoom`.
  2. The action **renumbers every room from zero** in the resulting order rather than swapping two `position` values — the comment's reason is that a swap leaves gaps and duplicates behind after enough edits, and a full renumber is cheap at this table size.
  3. Revalidates rooms and the schedule.
- **Error and refusal paths:** moving past either end is a no-op.
- **Ends:** the grid columns reorder.

##### ORG-56. Delete a room
- **Route:** `/organizer/rooms` → `/organizer/rooms?confirmDeleteRoom=<id>`
- **Precondition:** the room exists.
- **Steps:**
  1. Press **Delete** (`data-testid="delete-room-<roomId>"`) → `deleteRoom` with no `confirm`.
  2. `confirm !== 'yes'` → **redirect to `?confirmDeleteRoom=<id>`**.
  3. The confirmation panel `data-testid="confirm-delete-room"` renders, naming the room and what goes with it.
  4. Press `data-testid="confirm-delete-room-submit"` to re-submit with `confirm=yes`.
  5. Deletes the `rooms` row; its `slots` go with it (and anything placed in them becomes unplaced).
  6. Revalidates rooms and the schedule.
- **Error and refusal paths:** the confirm round trip. There is no "room is in use" refusal — the confirmation screen is the warning.
- **Ends:** the column and its slots are gone; affected talks return to the unplaced pool.

##### ORG-57. Add a track
- **Route:** `/organizer/rooms`
- **Precondition:** none.
- **Steps:**
  1. Type into **New track** (`data-testid="new-track-name"`).
  2. Press **Add track** (`data-testid="add-track"`) → `addTrack`.
  3. Inserts into `tracks` with `name` and the default `colour` `#64748b`.
  4. Revalidates rooms, schedule and the public agenda.
- **Error and refusal paths:** empty name rejected.
- **Ends:** the track is selectable on submissions (ORG-11), on the CFP question scoping (ORG-34) and groups the `track` schedule view (ORG-48).

##### ORG-58. Rename or recolour a track
- **Route:** `/organizer/rooms`
- **Precondition:** the track exists.
- **Steps:**
  1. Edit **Name** (`data-testid="track-name-<trackId>"`) or **Colour** (`data-testid="track-colour-<trackId>"`).
  2. Submit → `updateTrack`.
  3. The colour is validated against `/^#[0-9a-fA-F]{6}$/` — a six-digit hex with the hash, nothing else. Writes `tracks.name`, `tracks.colour`.
  4. Revalidates rooms, schedule and agenda.
- **Error and refusal paths:** a colour failing the regex is rejected by the schema; three-digit hex and named colours are not accepted.
- **Ends:** the swatch changes everywhere the track is shown.

##### ORG-59. Delete a track
- **Route:** `/organizer/rooms` → `/organizer/rooms?confirmDeleteTrack=<id>`
- **Precondition:** the track exists.
- **Steps:**
  1. Press **Delete** (`data-testid="delete-track-<trackId>"`) → `deleteTrack` with no `confirm` → redirect to `?confirmDeleteTrack=<id>`.
  2. Confirmation panel `data-testid="confirm-delete-track"`; press `data-testid="confirm-delete-track-submit"` (`confirm=yes`).
  3. Deletes the `tracks` row. Submissions carrying it fall back to no track (`submissions.track_id` null).
  4. Revalidates rooms, schedule and agenda.
- **Error and refusal paths:** the confirm round trip only.
- **Ends:** the track is gone; its submissions are untracked and group under `Unassigned` in the abstract book and the `track` schedule view.

---

### H. Evaluators (AI personas and the grade audit)

Screen: `.../organizer/evaluators/page.tsx` · Audit: `.../organizer/evaluators/audit/page.tsx` ·
Actions: `.../organizer/evaluators/actions.ts` · Engine: `src/lib/evaluator.ts`

##### ORG-60. Create an evaluator persona
- **Route:** `/organizer/evaluators`
- **Precondition:** none. A persona can be authored with the API key absent; only *running* one needs it.
- **Steps:**
  1. Fill **Name** (`data-testid="persona-name"`) and the rubric weight inputs, one per criterion: `data-testid="weight-<key>"`.
  2. Press **Create persona** (`data-testid="create-persona"`) → `createPersona`.
  3. Validates the name and the weights, then inserts into `evaluator_personas` (`name`, `prompt`, `weights`, `active` true).
  4. Revalidates `/organizer/evaluators`.
- **Error and refusal paths:** schema validation on name and weights.
- **Ends:** the persona is listed as `data-testid="persona-<personaId>"` and selectable in the run panel.

##### ORG-61. Edit a persona
- **Route:** `/organizer/evaluators`
- **Precondition:** the persona exists.
- **Steps:**
  1. Change the name, prompt or any `weight-<key>` on the persona's row and submit → `updatePersona`.
  2. Writes `evaluator_personas.name`, `prompt`, `weights`.
  3. Revalidates.
- **Error and refusal paths:** same validation as ORG-60. Reviews already filed under the old rubric are not recomputed — they keep the `reviews.rubric` snapshot they were written with.
- **Ends:** future runs use the new weights; past scores are untouched.

##### ORG-62. Retire a persona
- **Route:** `/organizer/evaluators`
- **Precondition:** `active` is true.
- **Steps:**
  1. Press the persona's retire control → `setPersonaActive` with `active: false`.
  2. Writes `evaluator_personas.active = false`. **The row is never deleted** — `reviews.persona_id` points at it and the audit needs to say which persona produced a score.
  3. Revalidates.
- **Error and refusal paths:** none.
- **Ends:** the persona drops out of the run picker; its historic reviews still name it.

##### ORG-63. Restore a retired persona
- **Route:** `/organizer/evaluators`
- **Precondition:** `active` is false.
- **Steps:**
  1. Press restore → `setPersonaActive` with `active: true`. Writes `active = true`.
- **Error and refusal paths:** none.
- **Ends:** the persona is runnable again.

##### ORG-64. Run a persona over the submissions
- **Route:** `/organizer/evaluators` → `data-testid="run-panel"`
- **Precondition:** `ANTHROPIC_API_KEY` set, the persona active, and a review round open.
- **Steps:**
  1. Pick the persona, then choose the scope:
     - **Grade the ungraded** (`data-testid="run-pending"`) — only submissions this persona has not scored in the open round.
     - **Re-grade everything** (`data-testid="run-replace"`) — replaces this persona's existing scores for the round.
  2. The action is `runPersonaEvaluation`, which returns a `RunReport` rendered into `data-testid="run-report"` — counts graded, skipped, failed, and any refusal text.
  3. Each graded submission writes a `reviews` row with `source: 'ai'`, `model`, `persona_id`, `round_id`, `score`, `comment` and the `rubric` snapshot. The unique index `reviews_round_submission_reviewer_idx` is what makes "re-grade" an upsert rather than a duplicate.
  4. Revalidates the evaluators screen and `/review`.
- **Error and refusal paths:** returned as report text, verbatim:
  - `ANTHROPIC_API_KEY is not set, so the evaluator is off. Nothing was called.`
  - `That persona no longer exists.`
  - `` `${persona.name} is retired. Restore it before running it.` ``
  - `No review round is open. Open one on the call-for-papers screen first.`
  This is the deliberate contrast with `gradePending` (ORG-14), which refuses silently on the same two conditions.
- **Ends:** AI reviews present for the round; the submissions board's ordering by mean grade changes.

##### ORG-65. Audit the AI grades against the humans
- **Route:** `/organizer/evaluators/audit`
- **Precondition:** both human and AI reviews exist for something.
- **Steps:**
  1. `data-testid="outliers"` lists submissions where the human and AI means differ by at least `OUTLIER_GAP = 2` — the cases worth a second human read.
  2. `data-testid="competitive"` lists the submissions clustered near the decision boundary.
  3. Each entry `data-testid="compare-<submissionId>"` puts the two scores side by side with the AI comment.
- **Error and refusal paths:** none; read-only. There is no "accept the AI score" control — the audit informs ORG-3, it does not decide.
- **Ends:** no DB change.

---

### I. Speakers

Roster: `.../organizer/speakers/page.tsx` · Detail: `.../organizer/speakers/[id]/page.tsx` ·
Profile form: `.../speakers/[id]/ProfileForm.tsx` · Actions: `.../organizer/speakers/actions.ts` ·
Export: `.../organizer/speakers/export/route.ts`

`ROSTER_FILTERS`: `all`, `accepted`, `unconfirmed`, `missing_bio`, `missing_headshot`,
`outstanding`, `overdue`.
`REMINDER_COOLDOWN_MS` is 24 hours.

##### ORG-66. Search and filter the roster
- **Route:** `/organizer/speakers?filter=<key>&q=<text>`
- **Precondition:** none.
- **Steps:**
  1. Click a filter chip or submit the search box. The seven `ROSTER_FILTERS` are the whole set; an unrecognised `?filter=` falls back to `all`.
  2. Each person renders as `data-testid="roster-<userId>"` with their submission counts, confirmation state, bio/headshot presence and outstanding-task count.
  3. `/organizer/onboarding` links straight into `?filter=outstanding`, `?filter=overdue` and `?filter=unconfirmed` (ORG-80).
- **Error and refusal paths:** none.
- **Ends:** no DB change.

##### ORG-67. Export the roster CSV
- **Route:** `GET /organizer/speakers/export`
- **Precondition:** organizer.
- **Steps:**
  1. Click the export link.
  2. The handler calls `requireRole('organizer')` inside a try/catch and converts `NotAuthorised` to a **403** with the body `Organizer access only.\n` — the comment: a route handler has no layout to fall back on, so it must answer for itself.
  3. `ROSTER_CSV_HEADER` is `name,email,roles,submitted,accepted,rejected,withdrawn,confirmed,bio_present,headshot_present,outstanding_tasks`.
  4. Rows are quoted per RFC 4180 and lines are joined with **CRLF**, because that is what the spec says and what a spreadsheet on Windows expects.
- **Error and refusal paths:** 403 as above.
- **Ends:** file downloaded; no DB change.

##### ORG-68. Invite a speaker directly
- **Route:** `/organizer/speakers`
- **Precondition:** none — notably **not** an open CFP.
- **Steps:**
  1. Fill the invite form: email, name, talk title, abstract, format, track, and optionally tick **accept now**.
  2. Submit → `inviteSpeakerAction`.
  3. `requireRole('organizer')`. The abstract must be **at least 120 characters**, matching the speaker-side bar.
  4. `upsertUserByEmail` resolves or creates the account (granting `speaker` on creation), then inserts the `submissions` row. With **accept now** ticked the row is written straight to `status: 'accepted'`; otherwise it lands as `submitted`.
  5. **`decision_emailed_at` is left null on purpose**, so an invited-and-accepted speaker still appears in the ORG-15 count and gets the normal acceptance mail with its calendar attachment. The only mail this action sends is `speakerInviteMail`.
  6. The CFP window is deliberately ignored — the comment: a keynote is invited after the call closes, which is the normal case, not an edge case.
  7. Revalidates the roster and the submissions board.
- **Error and refusal paths:** an abstract under 120 characters is rejected; an invalid email is rejected.
- **Ends:** the person exists, holds `speaker`, has a submission, and has been invited by mail.

##### ORG-69. Create the same task for a whole cohort
- **Route:** `/organizer/speakers`
- **Precondition:** the roster filter selects somebody.
- **Steps:**
  1. With a filter applied, choose the task **kind** (`speaker_task_kind`: `headshot`, `bio`, `slides`, `poster`, `confirm`, `other`), a label and an optional due date, then submit the bulk form → `bulkCreateTasksAction`.
  2. The action **re-resolves the roster filter server-side** rather than trusting a list of ids posted from the browser — the comment: the set the organizer was looking at is the set they meant, and it may have changed since the page rendered.
  3. It skips `users.is_bot` rows and anyone who already owes an open task of that kind, so pressing it twice does not double anybody's list.
  4. Inserts `speaker_tasks` rows (`user_id`, `kind`, `label`, `due_at`).
  5. Revalidates the roster and `/organizer/onboarding`.
- **Error and refusal paths:** an empty resolved cohort inserts nothing.
- **Ends:** the cohort owes the task; the onboarding tiles move.

##### ORG-70. Remind everybody with an open task
- **Route:** `/organizer/speakers`
- **Precondition:** somebody owes something.
- **Steps:**
  1. Press the roster-level remind control → `sendTaskRemindersAction` with scope `all`.
  2. Per task it checks `speaker_tasks.last_reminded_at` against `REMINDER_COOLDOWN_MS` (24h) and skips anything reminded inside the window.
  3. Sends the reminder mail, writes `speaker_tasks.last_reminded_at` **per row**, and logs to `email_log`.
  4. The result reports sent and skipped counts.
- **Error and refusal paths:** the cooldown, reported not hidden. The per-row timestamp write means a partial failure resumes rather than restarting.
- **Ends:** reminders out; `last_reminded_at` refreshed on the rows that sent.

##### ORG-71. Grant a role
- **Route:** `/organizer/speakers`
- **Precondition:** the person exists.
- **Steps:**
  1. Press the role button `data-testid="grant-<role>-<email>"` → `grantRoleAction`.
  2. `requireRole('organizer')`, then `grantRole(userId, role)` inserts into `user_roles`.
  3. Revalidates the roster.
- **Error and refusal paths:** granting a role somebody already holds is idempotent.
- **Ends:** the person holds the role. Granting `reviewer` is the prerequisite the CFP screen names in its `no-reviewers` message (ORG-29).

##### ORG-72. Revoke a role
- **Route:** `/organizer/speakers`
- **Precondition:** the person holds the role.
- **Steps:**
  1. Press the role button again (it toggles) → `revokeRoleAction`.
  2. Two refusals fire before the delete:
     - **revoking `organizer` from yourself** is refused — the comment: the last organizer locking themselves out is unrecoverable without database access.
     - **revoking `speaker` from somebody with submissions** is refused, because their proposals would become orphaned from the role that lets them edit.
  3. Otherwise deletes the `user_roles` row.
- **Error and refusal paths:** the two above, returned as messages.
- **Ends:** the role is gone, or the refusal is shown.

##### ORG-73. Edit a speaker's profile
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the user exists.
- **Steps:**
  1. Edit **Name** (`data-testid="profile-name"`, max 120), **Bio** (max 4000, hint "Shown on the agenda detail page and the public directory.") and **Headshot URL** (`type="url"`, hint "A full URL. Left blank, initials are shown instead.").
  2. The `<Headshot>` preview sits beside the URL field — the comment: a headshot URL is usually pasted from somewhere else, and a broken paste should be visible here rather than on the published agenda.
  3. Press **Save profile** (`data-testid="profile-save"`) → `updateSpeakerProfileAction` via `useActionState`; the button reads "Saving…" while pending.
  4. Writes `users.name`, `users.bio`, `users.headshot_url`.
  5. On success a `Notice tone="good"` renders `data-testid="profile-saved"` reading "Saved."; on failure `state.error` renders in a `Notice tone="bad"`.
- **Error and refusal paths:** the returned `ProfileState.error` string; a malformed URL is caught by the schema.
- **Ends:** profile updated; the public speaker directory and agenda detail reflect it.

##### ORG-74. Add a task to one speaker
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the user exists.
- **Steps:**
  1. Choose **kind** (`data-testid="task-kind"`), type a **label** (`data-testid="task-label"`), optionally a **due date** (`data-testid="task-due"`).
  2. Press **Add** (`data-testid="task-add"`) → `createSpeakerTaskAction`.
  3. Inserts a `speaker_tasks` row (`user_id`, `kind`, `label`, `due_at`, `completed_at` null).
  4. Revalidates the detail page, the roster and `/organizer/onboarding`.
- **Error and refusal paths:** an empty label is rejected. A task with **no due date can never be overdue** — the onboarding screen calls this out explicitly (ORG-80).
- **Ends:** the task appears as `data-testid="speaker-task-<taskId>"`.

##### ORG-75. Mark a task complete
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the task is open.
- **Steps:**
  1. Press **Mark done** (`data-testid="task-complete"`) on the row → `completeSpeakerTaskAction`.
  2. Writes `speaker_tasks.completed_at = now()`.
  3. Revalidates the detail page, the roster and the onboarding screen.
- **Error and refusal paths:** none.
- **Ends:** the task leaves the outstanding counts and enters "Done this week" for seven days. The button is replaced by ORG-106's undo.

##### ORG-106. Put a task back on the list
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the task is done — `completed_at is not null`.
- **Steps:**
  1. Press **Not done after all** (`data-testid="task-reopen"`) → `reopenSpeakerTaskAction`.
  2. Writes `speaker_tasks.completed_at = null`, with `isNotNull(completedAt)` in the WHERE so a double submit is a no-op rather than an error.
  3. Revalidates the detail page, the roster, the onboarding screen and `/speaker`.
- **Error and refusal paths:** none, and deliberately no confirmation: this **is** the confirmation step for ORG-75, which has none. Mis-clicking the undo costs one more click.
- **Ends:** `completed_at` is null, the task rejoins the outstanding and overdue counts, and the row offers **Mark done** again. Delete (ORG-76) used to be the only route back, and it destroys the deadline and the chase history with it. Covered by `e2e/onboarding.spec.ts`.

##### ORG-76. Delete a task
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the task exists.
- **Steps:**
  1. Press **Delete** (`data-testid="task-delete"`) → `deleteSpeakerTaskAction`.
  2. Deletes the `speaker_tasks` row. No confirmation step.
  3. Revalidates.
- **Error and refusal paths:** none.
- **Ends:** the task is gone, along with its reminder history on that row.

##### ORG-77. Remind one speaker, or one task
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** an open task.
- **Steps:**
  1. Press remind at the person level or on a single task row → `sendTaskRemindersAction` with scope `user` (all their open tasks) or `task` (that one).
  2. Same 24-hour `REMINDER_COOLDOWN_MS` check and the same per-row `last_reminded_at` write as ORG-70.
- **Error and refusal paths:** the cooldown.
- **Ends:** as ORG-70, narrowed.

##### ORG-78. Record when a speaker cannot present
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the user exists.
- **Steps:**
  1. Fill the availability block's start and end (`datetime-local`, read through `wallClockToInstant`) and an optional note.
  2. Submit → `createAvailabilityAction`.
  3. Guard: the end must be after the start, otherwise the message `The block has to end after it starts.`
  4. Inserts a `speaker_availability` row.
  5. Revalidates the detail page and `/organizer/schedule`.
- **Error and refusal paths:** the message above.
- **Ends:** `availabilityConflicts` (ORG-50) now warns when a talk of theirs sits inside the block — as a warning, never a block on the placement.

##### ORG-79. Remove an unavailable block
- **Route:** `/organizer/speakers/<id>`
- **Precondition:** the block exists.
- **Steps:**
  1. Press the block's delete control → `deleteAvailabilityAction`; deletes the `speaker_availability` row.
  2. Revalidates the detail page and the schedule.
- **Error and refusal paths:** none.
- **Ends:** the warning it was causing disappears.

---

### J. Onboarding

Screen: `.../organizer/onboarding/page.tsx` · `.../onboarding/AutoRefresh.tsx` ·
Data: `src/lib/onboarding.ts`

##### ORG-80. Watch onboarding land and pick who to chase
- **Route:** `/organizer/onboarding`
- **Precondition:** none. The page is `export const dynamic = 'force-dynamic'` — the comment: a cached copy of this screen is a screen that says nothing changed while an organizer watches tasks land.
- **Steps:**
  1. The header shows "Read at <time>" via `inEventZone(view.readAt, event.timezone, {timeStyle: 'medium'})` so the figures carry their own timestamp.
  2. Toggle `data-testid="auto-refresh-toggle"` (`AutoRefresh`) turns on a 15-second `router.refresh()`. It **pauses while the tab is hidden** and resumes on focus.
  3. Four tiles, each with a `-hint` sibling testid:
     - `tile-clear` ("Ready", tone good) — hint `data-testid="tile-clear-hint"`, "N accepted speaker(s) in all". Not a link.
     - `tile-outstanding` — hint "N task(s) between them"; links to `/organizer/speakers?filter=outstanding`.
     - `tile-overdue` (tone bad) — hint "N task(s) past their date"; links to `/organizer/speakers?filter=overdue`.
     - `tile-completed` ("Done this week", tone good) — hint "Tasks completed in the last 7 days". Not a link.
  4. The **Confirmed to attend** card is kept visually apart from the tiles on purpose — the comment: a speaker can owe nothing and still not have said whether they are coming, and every other number on this screen counts them as fine. `data-testid="confirmation-mix"` reads "N of M accepted speaker(s)"; the bar carries `role="img"` and `aria-label="N confirmed, M not confirmed"`. When `unconfirmed > 0`, `data-testid="unconfirmed-link"` reads "N speaker(s) have not confirmed" and links to `/organizer/speakers?filter=unconfirmed`, followed by "— chase these before the programme goes out." Otherwise: "Everyone accepted has confirmed."
  5. When `view.undated > 0` a `Notice` renders `data-testid="undated-notice"`: "N open task(s) have no due date, so they are in the outstanding count and can never reach the overdue one. A task nobody dated is a task nobody is chasing."
  6. **What is outstanding** — table `data-testid="by-kind"`, one row `data-testid="kind-<kind>"` per `speaker_task_kind`, columns Task / Speakers / Open / Overdue, the overdue cell a `Badge tone="bad"` when non-zero.
  7. **Who to chase first** — list `data-testid="stuck-list"`, entries `data-testid="stuck-<userId>"` linking to `/organizer/speakers/<id>`, each with a "N day(s) late" bad Badge when `daysLate !== null` and an "N open" Badge. Ordered overdue before volume: "the person three weeks late matters more than the person with four fresh tasks."
- **Error and refusal paths:** none — the screen is entirely read-only. Empty states: `Nothing outstanding. Every speaker task is complete.` and `Nobody is outstanding.`
- **Ends:** no DB change; the organizer leaves for a filtered roster or one speaker's detail page.

---

### K. Posters

Screen: `.../organizer/posters/page.tsx` · Actions: `.../organizer/posters/actions.ts` ·
Gate: `src/lib/poster.ts`

##### ORG-81. Set one poster's board number
- **Route:** `/organizer/posters`
- **Precondition:** the submission's `format` is `poster`.
- **Steps:**
  1. In the row form `data-testid="board-form-<submissionId>"`, type the board number and submit → `setBoardNumber`.
  2. The update is scoped `WHERE id = ? AND format = 'poster'` — a talk cannot be given a board number even by a hand-built request.
  3. Writes `submissions.board_number`.
  4. Revalidates `/organizer/posters` and the public `/posters`.
- **Error and refusal paths:** a non-poster row matches nothing and the write is a silent no-op. Duplicate numbers are not prevented.
- **Ends:** the number shows in the poster gallery once the gate opens.

##### ORG-82. Auto-number every board
- **Route:** `/organizer/posters`
- **Precondition:** at least one poster.
- **Steps:**
  1. Press **Auto-number** (`data-testid="auto-number-boards"`) → `autoNumberBoards`.
  2. Numbers every poster `1..n` **in track order**, so posters on the same subject stand next to each other in the hall.
  3. This **overwrites** any hand-set number — it is a renumber, not a fill-the-gaps.
  4. Revalidates the organizer and public poster screens.
- **Error and refusal paths:** none, and no confirmation step. Hand-set numbers are lost.
- **Ends:** a contiguous board numbering grouped by track.

##### ORG-83. Understand why the public gallery is closed
- **Route:** `/organizer/posters`
- **Precondition:** none.
- **Steps:**
  1. `posterGalleryGate()` returns a reason the organizer screen surfaces:
     - `embargo` — `events.poster_embargo_until` is in the future (set on Settings, ORG-103).
     - `unpublished` — `events.agenda_published` is false (toggled on Schedule, ORG-51).
  2. The organizer view itself is never gated; it always shows the posters so numbering can be done ahead of opening.
- **Error and refusal paths:** neither reason is fixable on this screen — the two levers live on Settings and Schedule.
- **Ends:** no DB change.

---

### L. Awards

Screen: `.../organizer/awards/page.tsx` · Actions: `.../organizer/awards/actions.ts` ·
Tally component: `src/app/awards/AwardTally`

##### ORG-84. Create an award category
- **Route:** `/organizer/awards`
- **Precondition:** none.
- **Steps:**
  1. Fill **Name** (`data-testid="award-name"`), the criteria, and the community-voting settings — `public_voting`, `voting_opens_at`, `voting_closes_at`.
  2. Submit → `createAward`.
  3. Inserts into `awards` (`name`, `criteria`, `public_voting`, `voting_opens_at`, `voting_closes_at`), with `winner_submission_id`, `voting_closed_at` and `winner_override_reason` null.
  4. Revalidates the organizer awards screen and the public `/awards`.
- **Error and refusal paths:** schema validation on the name.
- **Ends:** the category renders as `data-testid="award-<awardId>"`.

##### ORG-85. Edit a category
- **Route:** `/organizer/awards`
- **Precondition:** the award exists.
- **Steps:**
  1. Change the name, criteria or the voting window and submit → `editAward`.
  2. Guard: `Community voting has to open before it closes.` when `voting_closes_at <= voting_opens_at`.
  3. Writes the `awards` columns.
  4. Revalidates both screens.
- **Error and refusal paths:** the message above.
- **Ends:** the category updated; the public voting window moves with it.

##### ORG-86. Nominate a submission
- **Route:** `/organizer/awards`
- **Precondition:** the submission's `status` is `accepted`.
- **Steps:**
  1. Pick a submission in the award's nominate control and submit → `nominate`.
  2. **Refusal:** only accepted submissions may be nominated — a rejected or withdrawn proposal cannot win a prize at an event it is not part of.
  3. Inserts an `award_nominees` row (`award_id`, `submission_id`, `is_finalist` false).
  4. Revalidates.
- **Error and refusal paths:** the accepted-only check.
- **Ends:** the submission is in the running and appears in the tally.

##### ORG-87. Withdraw a nomination
- **Route:** `/organizer/awards`
- **Precondition:** the nomination exists.
- **Steps:**
  1. Press withdraw on the nominee row → `withdrawNomination`; deletes the `award_nominees` row.
  2. Revalidates.
- **Error and refusal paths:** none. Any `award_votes` cast for them remain in the table but no longer have a nominee to count toward.
- **Ends:** the nominee is out.

##### ORG-88. Promote or demote a finalist
- **Route:** `/organizer/awards`
- **Precondition:** the nomination exists.
- **Steps:**
  1. Toggle the nominee's finalist control → `setFinalist`; writes `award_nominees.is_finalist`.
  2. Revalidates.
- **Error and refusal paths:** none.
- **Ends:** the finalist shortlist changes; the tally can be read finalists-only.

##### ORG-89. Close the voting and declare a winner
- **Route:** `/organizer/awards`
- **Precondition:** voting is open (`voting_closed_at` null).
- **Steps:**
  1. Press **Close voting** → `closeVoting`.
  2. Writes `awards.voting_closed_at = now()` and computes the winner from `award_votes`, weighting `channel` (`committee` / `community`) per the award's configuration.
  3. Two rules the code is explicit about:
     - **A standing override outranks the tally.** If `winner_override_reason` is set, closing does not overwrite the human decision with the arithmetic.
     - **A tie declares nobody.** `winner_submission_id` is left null rather than picked arbitrarily; the organizer then uses ORG-91.
  4. Revalidates the organizer and public awards screens.
- **Error and refusal paths:** the tie outcome is a result, not an error — it is reported on the screen.
- **Ends:** voting closed; a winner stands, or nobody does.

##### ORG-90. Reopen the voting
- **Route:** `/organizer/awards`
- **Precondition:** voting is closed **and no winner stands**.
- **Steps:**
  1. Press **Reopen** → `reopenVoting`.
  2. **Refusal:** it refuses while `winner_submission_id` is set — the winner must be retracted first (ORG-92), so that reopening cannot silently unmake a declared result.
  3. Writes `voting_closed_at = null`.
- **Error and refusal paths:** the refusal above.
- **Ends:** votes can be cast again.

##### ORG-91. Override the winner by hand
- **Route:** `/organizer/awards`
- **Precondition:** the chosen submission is already an `award_nominees` row for this award.
- **Steps:**
  1. Pick the winner and type a reason (**8–500 characters**), then submit → `overrideWinner`.
  2. **Refusal:** the target must be a nominee — the winner cannot be somebody who was never in the running.
  3. Writes `awards.winner_submission_id` and `awards.winner_override_reason`.
  4. Revalidates both screens; the reason is part of the record, not a private note.
- **Error and refusal paths:** a reason under 8 or over 500 characters; a non-nominee target.
- **Ends:** the override stands and now outranks any subsequent `closeVoting` tally (ORG-89).

##### ORG-92. Retract the winner
- **Route:** `/organizer/awards`
- **Precondition:** a winner stands.
- **Steps:**
  1. Press clear → `clearWinner`; writes `winner_submission_id` and `winner_override_reason` to null.
  2. Revalidates.
- **Error and refusal paths:** none. This is the step ORG-90 demands before reopening.
- **Ends:** no winner; voting may be reopened.

##### ORG-93. Delete a category
- **Route:** `/organizer/awards`
- **Precondition:** the award exists.
- **Steps:**
  1. Press delete → `deleteAward`; deletes the `awards` row and its nominees and votes.
  2. Revalidates.
- **Error and refusal paths:** none.
- **Ends:** the category and its voting record are gone.

##### ORG-94. Tell the winners
- **Route:** `/organizer/awards`
- **Precondition:** at least one award has `winner_submission_id` set.
- **Steps:**
  1. Press the notify control → `notifyWinners`.
  2. Mails each winner and writes an `email_log` row.
  3. **Idempotency is on `(kind, submissionId, subject)` in `email_log`** rather than a column on the award — a winner already mailed for that award is skipped on a second press.
- **Error and refusal paths:** the dedupe above; awards with no winner are skipped.
- **Ends:** winners told; a second press is safe.

---

### M. Speaker info pages (portal pages)

Screen: `.../organizer/pages/page.tsx` · Actions: `.../organizer/pages/actions.ts` ·
Table: `portal_pages`

##### ORG-95. Write a new speaker-info page
- **Route:** `/organizer/pages`
- **Precondition:** none.
- **Steps:**
  1. In `data-testid="page-form"` fill **Title** (`data-testid="page-title"`), optionally override the address in **Slug** (`data-testid="page-slug"`), then **Summary** (`data-testid="page-summary"`), **Body** (`data-testid="page-body"`) and **Position** (`data-testid="page-position"`).
  2. Press **Save** (`data-testid="page-save"`) → the create/update action.
  3. The slug is derived from the title when the field is left blank.
  4. Inserts into `portal_pages` (`slug`, `title`, `summary`, `body`, `published` false, `position`, `updated_by_id`).
  5. On success `data-testid="page-saved"` renders; on refusal `data-testid="page-error"`.
- **Error and refusal paths:**
  - `That title has no letters or digits to make an address from.` — a title of punctuation or emoji only leaves nothing to slug.
  - `` `Another page already uses /${slug}.` `` — slugs are unique.
- **Ends:** the page exists as a **draft**. `published` defaults false, so writing is not publishing.

##### ORG-96. Edit an existing page
- **Route:** `/organizer/pages`
- **Precondition:** the page exists.
- **Steps:**
  1. In `data-testid="organizer-page-list"` press **Edit** (`data-testid="page-edit-<slug>"`); the form fills with the current values.
  2. Change anything and press `page-save`.
  3. Writes the `portal_pages` columns plus `updated_by_id` and `updated_at`.
  4. **The body is stored raw.** `sanitizeHtml` runs on *read*, not on write — the comment's reasoning is that sanitising on write destroys the author's original irreversibly, while sanitising on read means a future fix to the sanitiser repairs every page at once.
- **Error and refusal paths:** the same two messages as ORG-95; renaming into another page's slug is refused.
- **Ends:** the page updated. If it was published, the change is live immediately.

##### ORG-97. Publish or unpublish a page
- **Route:** `/organizer/pages`
- **Precondition:** the page exists.
- **Steps:**
  1. Press `data-testid="page-publish-<slug>"` — it toggles.
  2. Writes `portal_pages.published`.
  3. Revalidates the organizer list and the public speaker-info routes.
- **Error and refusal paths:** none.
- **Ends:** the page is visible to speakers, or back to draft. Draft and published are the same row; there is no separate draft copy, so editing a published page edits what the public sees.

##### ORG-98. Delete a page
- **Route:** `/organizer/pages`
- **Precondition:** the page exists.
- **Steps:**
  1. Press `data-testid="page-delete-<slug>"` → the delete action; deletes the `portal_pages` row.
  2. Revalidates.
- **Error and refusal paths:** **no confirmation step, by design** — unlike rooms, tracks and time bands. The comment's reasoning is that a page is cheap to rewrite and nothing else in the schema points at it, so the confirm round trip would be friction without a payoff.
- **Ends:** the page and its address are gone; the address is free to reuse.

---

### N. Accelevents integration

Screen: `.../organizer/integrations/page.tsx` · Actions: `.../organizer/integrations/actions.ts` ·
Bundle: `.../organizer/integrations/[id]/bundle/route.ts` · Library: `src/lib/accelevents.ts`

The screen is `export const dynamic = 'force-dynamic'` — the comment: a cached copy would show the
export you just ran as not having happened. The header describes the contract: "One-way. The
programme goes out; nothing comes back and nothing here is ever overwritten by theirs."

##### ORG-99. Run the export
- **Route:** `/organizer/integrations`
- **Precondition:** none. `acceleventsConfig()` decides the mode.
- **Steps:**
  1. Read the mode card first: `data-testid="integration-mode"` reads `Dry run` or `Live`, and `data-testid="integration-target"` reads `config.baseUrl` or the literal `no endpoint configured`.
  2. **Dry run** — `data-testid="dry-run-explainer"` states: "Every request is built and checked against a recorded copy of what Accelevents accepts, and none of them leave this machine. Set `<config.missing joined>` to go live. The key is read from the environment and is never shown here or written to a run." The missing names are the unset members of `ACCELEVENTS_BASE_URL`, `ACCELEVENTS_API_KEY`, `ACCELEVENTS_EVENT_ID`.
  3. **Live** — a `Notice tone="warn"` instead: "Live. Pressing the button writes `<event.name>` into the Accelevents event at `<config.baseUrl>`."
  4. Press the header button `data-testid="run-export"`, labelled **Run a dry export** in dry-run mode and **Push to Accelevents** when live → `runAcceleventsExport`.
  5. The run inserts an `integration_runs` row: `target`, `mode`, `status` `running`, `base_url`, `started_by_id`, then pushes tracks, speakers and sessions in that order, recording each request. On completion it writes `status` `ok` or `failed`, `requests`, `track_count`, `speaker_count`, `session_count` and, on failure, `error`.
  6. Revalidates the screen; the run appears at the top of the list.
- **Error and refusal paths:** a failed run is recorded as a row with `status: 'failed'` and its `error`, not lost. The API key is never written into `integration_runs` and never rendered.
- **Ends:** one `integration_runs` row; in live mode, the remote event now carries the programme.

##### ORG-100. Read a past run
- **Route:** `/organizer/integrations?run=<id>`
- **Precondition:** the run exists.
- **Steps:**
  1. In `data-testid="run-list"`, click a run's timestamp link (`data-testid="run-<runId>"` on the row) — it navigates to `?run=<id>`.
  2. `data-testid="run-detail"` opens with the heading "Dry run"/"Live run" plus the start time in `event.timezone`, and `data-testid="run-status"` inside a tone-coded Badge (`ok` good, `failed` bad, `running` neutral).
  3. `opened.error`, when set, renders in a `Notice tone="bad"`.
  4. `data-testid="run-request-count"` gives the request count, followed by the track/speaker/session counts.
  5. `data-testid="run-requests"` lists every call, each `data-testid="run-request-<index>"`: an HTTP-status Badge (good for 2xx), `method` and `path` in a `<code>`, the body's `label` when there is one, `→ <remoteId>` when the remote assigned one, and the per-request `error` in red when it failed.
- **Error and refusal paths:** an unknown `?run=` id makes `runById` return null and the detail card is simply not rendered. Empty list state: `Nothing has been exported yet.`
- **Ends:** no DB change.

##### ORG-101. Download a run bundle
- **Route:** `GET /organizer/integrations/<id>/bundle`
- **Precondition:** organizer; the run exists.
- **Steps:**
  1. In the open run detail, click **Download the bundle** (`data-testid="run-bundle-link"`).
  2. The route handler re-checks the role itself (no layout runs) and streams the recorded request bundle for that run.
- **Error and refusal paths:** not an organizer → **403** with body `Organizer access only.\n`. Unknown id → **404** with body `No such run.\n`.
- **Ends:** file downloaded; no DB change.

---

### O. Embed

Screen: `.../organizer/embed/page.tsx`

##### ORG-102. Take the embed snippets
- **Route:** `/organizer/embed`
- **Precondition:** none.
- **Steps:**
  1. The page renders four read-only snippets to copy: `data-testid="snippet-script"` (the script tag), `data-testid="snippet-iframe"` (the iframe fallback), `data-testid="snippet-resize"` (the height-messaging handler) and `data-testid="snippet-feeds"` (the JSON/ICS feed URLs).
  2. `data-testid="embed-demo-link"` navigates to `/embed/demo` to see it rendered.
- **Error and refusal paths:** none.
- **Ends:** no DB change. **This screen has no writes at all** — it is a copy-paste reference, the only organizer tab that changes nothing.

---

### P. Settings

Screen: `.../organizer/settings/page.tsx` · Actions: `.../organizer/settings/actions.ts`

##### ORG-103. Save the event settings
- **Route:** `/organizer/settings`
- **Precondition:** none.
- **Steps:**
  1. Edit **Name** (`data-testid="event-name"`), **Timezone** (`data-testid="event-timezone"`, options from `SUPPORTED_TIMEZONES` at `src/lib/content.ts:139`, which is `Intl.supportedValuesOf('timeZone')`), **Starts on** (`data-testid="event-starts-on"`), **Ends on** (`data-testid="event-ends-on"`), **Poster embargo** (`data-testid="poster-embargo"`) and the **Agenda published** checkbox (`data-testid="agenda-published"`).
  2. The form also posts a hidden `renderedTimezone` — the zone the date fields were *rendered* in. The action reads the wall-clock values against that zone, not against the newly chosen one, so changing the timezone and the dates in one save does not shift the stored instants by the difference between the two zones.
  3. Press **Save** (`data-testid="save-settings"`) → the settings action.
  4. Guard: it **throws** `The event cannot end before it starts.` — this is the one organizer action that throws rather than redirecting with an error key or returning a state object.
  5. Writes `events.name`, `events.tagline`, `events.timezone`, `events.starts_on`, `events.ends_on`, `events.poster_embargo_until`, `events.agenda_published`.
  6. `revalidatePath('/', 'layout')` — the whole tree, because the timezone changes how every rendered date reads.
- **Error and refusal paths:** the thrown message above. **This action never touches `cfp_opens_at` or `cfp_closes_at`** — the call window belongs to `/organizer/cfp` (ORG-23–ORG-25) and a save here cannot silently reopen or close the call.
- **Ends:** the event's identity, zone, dates, poster embargo and agenda visibility are set. `poster_embargo_until` and `agenda_published` are the two levers behind `posterGalleryGate` (ORG-83), and `agenda_published` is the same column the schedule toggle writes (ORG-51).

---

### Q. Email log

Screen: `.../organizer/email/page.tsx` · Query: `recentEmails()` in `src/lib/email.ts`

##### ORG-104. Read what has been sent
- **Route:** `/organizer/email`
- **Precondition:** none.
- **Steps:**
  1. The page lists the most recent 200 `email_log` rows, newest first, each carrying its `kind` slug and a glossed label, the subject, the recipient's name and address, the send time in the event's zone, a link to the submission when the row names one, and a `delivered` badge.
  2. When `RESEND_API_KEY` is unset, `data-testid="mail-not-live"` says so, because every row then reads as undelivered and that is configuration rather than 19 failed sends.
  3. `data-testid="email-count"` is the number of rows shown.
- **Error and refusal paths:** none; it is read-only. The magic link is the one send with no row here (`sendMail` rather than `sendAndLog`), on the grounds that authentication is not correspondence.
- **Ends:** no DB change. The second read-only organizer tab, after ORG-102.

---

### Cross-cutting notes

**Where each destructive action's guard lives.** Every one of them uses the same query-string
confirmation round trip, so the pages can stay server components: `?confirmDelete=` for a time
band (ORG-43) and a portal page (ORG-98), `?confirmRoom=` (ORG-56), `?confirmTrack=` (ORG-59),
`?confirmTask=` (ORG-76) and `?confirmAward=` (ORG-93). Nomination withdrawal (ORG-87) and
`autoNumberBoards` (ORG-82) take the second press without a query parameter, on a
`confirm=yes` field. The board sweep only asks once a number exists to lose, because a first
run on a blank hall has nothing to overwrite.

**Archive rather than delete** holds for `form_questions.archived_at` (ORG-38), `evaluator_personas.active`
(ORG-62) and `review_rounds` (never deleted, ORG-27). It does not hold for rooms, tracks, pages, tasks,
awards or nominations.

**Deciding never emails.** Three actions decide (`setDecision`, `bulkSetStatus`, `inviteSpeakerAction`
with accept-now) and three separate presses send (`notifyDecided`, `notifySchedule`, `notifyWinners`).
Each send is idempotent on a stored key: `submissions.decision_emailed_at`,
`submissions.schedule_notice_key` + `schedule_notice_seq`, and `email_log(kind, submission_id, subject)`.

**Warnings that do not block.** Schedule conflicts, speaker unavailability and room over-capacity
(ORG-50) are the only detected problems in the organizer surface that are reported and then allowed.

**Silent refusals** — actions that return without telling anyone: `gradePending` with no key or no
open round (ORG-14), `extendCfp` with no close date (ORG-24), `placeSubmission` for a non-accepted talk
(ORG-44), `returnContent` when the recipient cannot be resolved (ORG-6), `setFieldLock` on a missing row
(ORG-7), `setBoardNumber` on a non-poster (ORG-81).

---

## Part 3 — Speaker, submitter and co-author flows (SPK-1 to SPK-25)

Read-only analysis of the source. Every route path,
`data-testid`, function name, table name and column name below is copied verbatim from source.

---

#### 0. The model these flows sit on

Read this first; every flow below refers back to it.

##### 0.1 Who a person is

- `currentUser()` (`src/lib/auth.ts:132`) resolves the signed-in user from the `sb_session`
  cookie. The cookie value is `<authSessions.id>.<HMAC-SHA256(id, SESSION_SECRET)>`. Three
  checks must all pass: HMAC via `signatureMatches` (constant-time, length-checked first),
  the `auth_sessions` row exists, and `auth_sessions.expires_at > now`. Roles come from a
  separate select on `user_roles`, returned as `CurrentUser = User & { roles: Role[] }`.
- `requireUser()` throws `NotAuthorised('not signed in')`. `requireRole(...allowed)` throws
  `NotAuthorised('requires one of: ...')`. Neither is caught anywhere in the speaker surface,
  so an unauthenticated POST to a speaker action produces a Next.js server error, not a
  redirect. Speaker **pages** instead call `currentUser()` and `redirect('/login')`.
- `upsertUserByEmail(rawEmail, name?)` finds by `normaliseEmail` (trim + lowercase) or inserts
  into `users`, then inserts `user_roles(user_id, role='speaker')` `onConflictDoNothing`. The
  comment is explicit: "Anyone who arrives through the CFP is a speaker. Reviewer and organizer
  are granted by an organizer, never self-assigned." An **existing** user is *not* granted the
  speaker role by this path — only newly created ones are.

##### 0.2 Who may write to a submission

`writableBy(userId)` (`src/lib/abstracts.ts:172`) is one SQL predicate:

```
submissions.speaker_id = userId
  OR EXISTS (select 1 from submission_authors
             where submission_id = submissions.id
               and user_id = userId
               and can_edit = true)
```

The filer's own access never reads `can_edit`, so nobody can lock themselves out.
`canWriteSubmission(submissionId, userId)` is the boolean form for a page deciding what to
render. Ownership is a WHERE clause on the write, never a check before it, so a forged
submission id updates zero rows.

Three different scopes coexist, and the differences are load-bearing:

| Scope | Used by | Co-author with `canEdit` passes? |
|---|---|---|
| `writableBy(userId)` | `mySubmissions`, `myContent`, `loadOwned`, `canWriteSubmission`, `applyAbstractEdit`, `applyTextEdit`, `setContentStatus`, `ownedSubmission`, `myPosters`, `writePosterUrl` | yes |
| `eq(submissions.speakerId, ownerId)` | `confirmAttendance`, `declineAttendance`, `withdrawSubmission`, `setAuthorAccess` | **no** |
| `eq(speakerTasks.userId, user.id)` | `completeTask`, `speakerTasksFor` | n/a — tasks are per person |

The second row is where the co-author's powers stop, and it is now a clean line: answering for
the talk and handing out access are the filer's, everything to do with the work itself is
shared. `applyTextEdit`, `myPosters` and `writePosterUrl` were on that row and moved to the
first, each for the same reason — the surface admitted a co-author and the write underneath it
refused, in one case while reporting success. See §SPK-19 and Bug B1.

##### 0.3 Field locks

`submissions.locked_fields` is a `jsonb` string array an organizer writes. Two independent
readers compare on a flattened key (`name.replace(/_/g,'').toLowerCase()`) so `audienceLevel`
and `audience_level` are the same lock:

- `isFieldLocked(lockedFields, field)` in `src/lib/abstracts.ts:69`, over
  `EDITABLE_FIELDS = ['title','abstract','keywords','format','audienceLevel']`.
- `isLocked(lockedFields, field)` in `src/lib/content.ts:104`, over
  `LOCKABLE_FIELDS = [...those five, 'slidesUrl','recordingUrl','resourcesNote']`.

`posterUrl` is **not** in `LOCKABLE_FIELDS`, yet `writePosterUrl` refuses on
`` not (locked_fields @> '["posterUrl"]'::jsonb) `` and `/speaker/posters` reads
`row.lockedFields.includes('posterUrl')` — a raw `includes`, not `isLocked`, so that one lock
is case- and underscore-sensitive where every other lock is not.

##### 0.4 Content publication

`contentIsPublic(status, value)` in `src/lib/content.ts:34`:
`contentStatus === 'approved'` OR (`contentStatus === 'draft'` AND the field is populated).
`'pending'` publishes nothing. The `'draft'` leg is a migration allowance for seeded rows.

---

#### SPK-1. File a proposal as a first-time submitter

- **Role:** first-time submitter (no account, no session)
- **Route:** `/cfp`
- **Precondition:** `cfpIsOpen(event)` — `now >= events.cfp_opens_at && now <= events.cfp_closes_at`.
  If false, `src/app/cfp/page.tsx:16` renders only a `PageHeader title="Call for papers"`, a
  `Notice` reading `The call closed on {dayLabel(event.cfpClosesAt, event.timezone)}.` and a
  `LinkButton href="/agenda"` — there is no form to post from.

**Steps**

1. Open `/cfp`. The page server-renders `getEvent()`, `allTracks()`, `currentUser()` and
   `activeQuestions()` in parallel, then renders `<CfpForm>` with `knownEmail`, `knownName`,
   `knownBio` all null.
2. Fill **Email** — `data-testid="cfp-email"`, `name="email"`, `type="email"`, `required`. Not
   read-only, because `knownEmail` is null.
3. Fill **Name** — `data-testid="cfp-name"`, `name="name"`, `required`.
4. Fill **Short bio** — `name="bio"`, no testid. Hint: "Shown on the public agenda beside your
   talk."
5. Fill **Title** — `data-testid="cfp-title"`, `maxLength={200}`, `required`.
6. Fill **Abstract** — `data-testid="cfp-abstract"`, `required`, `minLength={120}`.
7. Choose **Format** — `data-testid="cfp-format"`, a controlled `<Select>` over
   `FORMAT_LABELS` keys (`lightning_10`, `talk_25`, `talk_45`, `workshop_90`, `poster`),
   default `talk_25`. Held in React state because the custom questions narrow on it.
8. Choose **Audience level** — `data-testid="cfp-level"`, `defaultValue="intermediate"`, over
   `LEVEL_LABELS` (`beginner`, `intermediate`, `advanced`).
9. Choose **Track** — `data-testid="cfp-track"`, controlled, first option `value=""` labelled
   "No preference", then one `<option>` per `tracks` row.
10. Fill **Keywords** — `data-testid="cfp-keywords"`, `maxLength={400}`, comma separated.
11. If and only if format is `poster`, a **Poster artwork URL** field appears —
    `data-testid="cfp-poster-url"`, `name="posterUrl"`, `type="url"`, `required`.
12. Answer any organizer questions (see SPK-3).
13. Click **Submit proposal** — `data-testid="cfp-submit"`, disabled while `pending`, label
    flips to `Submitting…`. Calls `submitProposal(_prev, formData)` in `src/app/cfp/actions.ts:99`.

**Server-side, in order** (`submitProposal`)

1. `getEvent()`, then `cfpIsOpen(event)` re-checked. Closed ⇒ `{ error: 'The call for papers is closed.' }`.
2. `currentUser()` → null here.
3. Zod `schema.safeParse`. `email` takes `signedIn?.email ?? optional(formData.get('email'))`;
   `name` takes `optional(formData.get('name')) ?? signedIn?.name`.
4. Poster guard: `format === 'poster' && !posterUrl` ⇒
   `{ error: 'A poster submission needs a link to the poster artwork.' }`.
5. `activeQuestions()`, then every `formData` entry whose name starts `q_` is collected via
   `questionIdFromField` into an `AnswerMap`, then `validateAnswers(questions, {format, trackId}, posted)`.
   First error message is returned.
6. `upsertUserByEmail(input.email, input.name)` → inserts `users` row + `user_roles` row with
   `role='speaker'`.
7. `db.update(users).set({ name, bio: input.bio ?? speaker.bio })` — the CFP form is the whole
   of speaker profile maintenance on the way in.
8. `db.insert(submissions).values({ speakerId, trackId, title, abstract, format, audienceLevel,
   posterUrl, keywords: parseKeywords(...) }).returning({ id })`. Defaults apply:
   `status='submitted'`, `content_status='draft'`, `locked_fields=[]`, `schedule_notice_seq=0`.
   `parseKeywords` splits on comma, trims, slices each to 40 chars, dedupes case-insensitively
   but stores as typed, caps at `MAX_KEYWORDS = 12`.
9. `saveAnswers(created.id, checked.answers)` — one transaction: delete every
   `submission_answers` row for the submission, then insert the validated set.
10. Because `!signedIn`: `issueMagicLink(speaker.id)` inserts `magic_link_tokens` (only
    `sha256(token)` is stored, `expires_at = now + 15 min`), `sendMail(magicLinkMail(...))`
    — note **`sendMail`, not `sendAndLog`, so no `email_log` row for the sign-in link** —
    then `startSession(speaker.id)` inserts `auth_sessions` (`expires_at = now + 30 days`) and
    sets the `sb_session` cookie `httpOnly`, `sameSite:'lax'`, `path:'/'`, `secure` in production.
    The submitter is therefore signed in immediately *and* has a link in their inbox.
11. `sendAndLog(submissionReceivedMail(speaker.email, input.title, event.name), { userId,
    kind: 'submission_received', submissionId })` — writes an `email_log` row with
    `delivered` false when `RESEND_API_KEY` is unset.
12. `alertOrganizers(...)` selects every `users` row joined to `user_roles` where
    `role='organizer'` and sends `submissionAlertMail` per organizer with
    `kind: 'submission_alert'`. Wrapped in try/catch; failures are logged to
    `console.error('[cfp] organizer alert failed', ...)` and swallowed.
13. `redirect('/speaker?submitted=1')`.

**What they see next:** `/speaker`, with a `Notice tone="good"` containing
`data-testid="submitted-confirmation"`: "Proposal received. You will hear from the programme
committee after review."

**Error and refusal paths**

- `'The call for papers is closed.'` — window closed between page load and submit.
- `'Enter a valid email address'`, `'Tell us your name'` (name missing/blank),
  `'Give the talk a title'` (< 6 chars), `'Abstracts under 120 characters are too thin to review'`,
  plus zod defaults for `bio` > 2000, `title` > 200, `abstract` > 5000, a `trackId` that is not
  a uuid, a `posterUrl` that is not a URL. Only `parsed.error.issues[0]` is shown; the fallback
  string is `'Check the form and try again.'`.
- `'A poster submission needs a link to the poster artwork.'`
- Custom-question errors — see SPK-3.
- Rendered as `<Notice tone="bad">` at the top of the form. No field-level highlighting.
- There is **no duplicate-submission guard**: the same person may file the same title any
  number of times while the window is open.

**Ends:** one `submissions` row at `status='submitted'`, `content_status='draft'`; zero-or-more
`submission_answers` rows; a `users` row with the speaker role; an open `auth_sessions` row and
cookie; one unconsumed `magic_link_tokens` row; one `email_log` row of kind `submission_received`
plus one per organizer of kind `submission_alert`.

---

#### SPK-2. File another proposal while signed in

- **Role:** signed-in speaker
- **Route:** `/cfp`
- **Precondition:** `cfpIsOpen(event)`, session valid. `/speaker` shows a `LinkButton href="/cfp"`
  labelled "Submit another" only while the window is open.

**Steps**

1. `/cfp` renders with `knownEmail = user.email`, `knownName = user.name`, `knownBio = user.bio`.
2. The **Email** field is `readOnly={Boolean(knownEmail)}` with the hint "Signed in — proposals
   are filed against this address."
3. Steps 3–13 of SPK-1 are identical.
4. Server-side the divergence is:
   - `email: signedIn.email` — the posted `email` field is **ignored**, not merely validated.
     A signed-in speaker cannot file under someone else's address even by editing the DOM.
   - `speaker = signedIn` — no `upsertUserByEmail`, so no role grant happens.
   - The `!signedIn` branch is skipped: **no magic link, no new session**.
   - The receipt (`submission_received`) and the organizer alert still send.

**Error and refusal paths:** same as SPK-1, minus anything email-related.

**Ends:** as SPK-1, without the token, session or role write. `users.name` and `users.bio` are
overwritten from this form — filing a second proposal with the bio box left empty keeps the
old bio (`input.bio ?? speaker.bio`), but a *changed* name always overwrites.

---

#### SPK-3. Answer the organizer's questions on the CFP form

- **Role:** either submitter role
- **Route:** `/cfp` (the "A few more things" card, rendered only when `questions.length > 0`)
- **Precondition:** at least one `form_questions` row with `archived_at IS NULL`
  (`activeQuestions()` orders by `position`, then `created_at`).

**Steps**

1. `<CustomQuestions questions format trackId>` renders inside `data-testid="custom-questions"`.
   Visibility is recomputed by `visibleQuestions(questions, {format, trackId}, answers)` — the
   *same pure function* the server validates with — on every keystroke and on every format or
   track change.
2. `appliesTo` narrows first: `formats.length > 0 && !formats.includes(ctx.format)` hides it;
   `trackIds.length > 0` and either no track chosen or a track not in the list hides it. An
   empty list means "every one", which is the default.
3. `showIfQuestionId` is the conditional branch, resolved in one forward pass over
   `position`-sorted questions. A branch shows only when its parent was itself shown **and**
   `answers[parentId] === (showIfValue ?? '')`. A branch whose parent is hidden is hidden,
   however the parent's stale answer reads.
4. Each visible question renders one native input, `name={fieldName(id)}` = `q_<uuid>`,
   `data-testid={`question-<id>`}`:
   - `checkbox` — a `<label data-testid=...>` wrapping `<input type="checkbox" value="yes">`
     (`CHECKED = 'yes'`). Unticked posts nothing at all.
   - `long_text` — `<Textarea maxLength={4000} className="min-h-24">`
   - `select` — `<Select>` with a leading `<option value="">Choose one</option>` then `options`
   - `url` — `<Input type="url" maxLength={4000}>`
   - `short_text` — `<Input type="text" maxLength={4000}>`
   Required questions render their label as `` `${prompt} *` `` and set `required` on the input.
5. When nothing applies, the card shows "No extra questions apply to this format and track."
6. A hidden question renders **nothing** — not a disabled input — so its value never reaches
   the POST and cannot be revived when a branch reopens.

**Server-side:** `validateAnswers(questions, ctx, raw)` recomputes `visibleQuestions` from the
posted answers and iterates only the visible ones. Answers to hidden questions are **dropped,
not rejected**.

**Error and refusal paths** (first message only, shown in the form-level `Notice tone="bad"`)

- `` `"${question.prompt}" is required.` `` — blank on a `required` question.
- `` `"${value}" is not one of the choices for "${question.prompt}".` `` — a `select` value not
  in `options`.
- `` `"${question.prompt}" needs a full http:// or https:// address.` `` — `looksLikeUrl` parses
  with `new URL` and requires protocol `http:` or `https:`.
- `` `"${question.prompt}" is not a yes or no.` `` — a `checkbox` field posting anything but `yes`.
- `` `"${question.prompt}" is too long.` `` — value over 4000 chars.

**Ends:** `submission_answers` holds exactly the validated visible set, keyed
`(submission_id, question_id)`, values stored as `text` whatever the question kind.

---

#### SPK-4. Sign in with a magic link

- **Role:** any
- **Routes:** `/login`, then `/auth/verify?token=…`
- **Precondition:** none. The account need not exist.

**Steps**

1. Open `/login`. Client component, `useActionState(requestMagicLink, {})`.
2. Fill **Email** — `data-testid="login-email"`, `type="email"`, `required`,
   `autoComplete="email"`, placeholder `you@example.com`.
3. Click **Email me a link** — `data-testid="login-submit"`; label flips to `Sending…` while
   `pending`.
4. `requestMagicLink` (`src/app/login/actions.ts:19`) zod-parses the address, then
   `getEvent()`, `upsertUserByEmail(email)` — **this creates the account and the speaker role
   if there was none** — `issueMagicLink(user.id)`, `sendMail(magicLinkMail(...))`. Returns
   `{ sent: email }`.
5. The page shows `data-testid="magic-link-sent"`: "If {email} is a valid address, a sign-in
   link is on its way. It works once and expires in 15 minutes." Deliberately identical whether
   or not the account existed — "Reporting 'no such user' would turn the login form into an
   oracle for who has submitted to this conference."
6. The mail (`magicLinkMail`) subject is `Your sign-in link for ${eventName}` and the body
   carries `${APP_URL}/auth/verify?token=${encodeURIComponent(token)}`. With `RESEND_API_KEY`
   unset, `sendMail` writes `.mail/<timestamp>-<sanitised-address>.txt` and returns
   `{ delivered: false, path }`.
7. Open the link. `GET /auth/verify` (`src/app/auth/verify/route.ts:11`) reads `token`,
   calls `consumeMagicLink(token)` — a single conditional UPDATE setting `consumed_at` where
   `token_hash = sha256(token) AND consumed_at IS NULL AND expires_at > now`, so two concurrent
   redemptions race on the row and exactly one wins — then `startSession(user.id)` and
   `NextResponse.redirect(new URL('/speaker', APP_URL))`.
8. `/speaker` renders. The nav shows `data-testid="current-user"` with the email and a
   `data-testid="sign-out"` button.

**Error and refusal paths**

- Malformed address ⇒ `{ error: 'Enter a valid email address' }` in a `Notice tone="bad"`.
- No `token` query param ⇒ redirect to `/login?error=missing`.
- Token already consumed, expired (> 15 min), or simply wrong ⇒ `consumeMagicLink` returns null
  ⇒ redirect to `/login?error=expired`. All three collapse into one answer.
- **`/login` never reads `searchParams`.** `LoginPage` is a `'use client'` component taking no
  props, and its only `Notice tone="bad"` is driven by `state.error` from the action. A speaker
  bounced back with `?error=expired` or `?error=missing` therefore sees a **blank sign-in form
  with no explanation**. See Bug B2.
- A GET is used for redemption on purpose: "the link arrives by email and email clients only
  issue GETs." A mail scanner that prefetches burns the token, and the user asks for another.

**Ends:** one `magic_link_tokens` row with `consumed_at` set; one `auth_sessions` row valid 30
days; the `sb_session` cookie set. `email_log` gets **no** row — the sign-in path uses `sendMail`
directly, so "did the link go out?" is not answerable from the database.

---

#### SPK-5. Sign out

- **Role:** any signed-in
- **Route:** `POST /auth/logout`

**Steps**

1. Click **Sign out** in the nav — `data-testid="sign-out"`, a `<button type="submit">` inside
   `<form method="post" action="/auth/logout">`.
2. `endSession()` deletes the `sb_session` cookie, splits the raw value on `.`, and deletes the
   `auth_sessions` row by id.
3. `NextResponse.redirect(new URL('/', APP_URL), { status: 303 })`.

**Refusal path:** there is no `GET` export. The route comment records this as a fixed live bug:
as a GET, `next/link` prefetch fired the handler seconds after each sign-in and deleted the
session the user had just opened; it is also the classic CSRF logout hole.

---

#### SPK-6. Read the speaker home

- **Role:** signed-in speaker or co-author
- **Route:** `/speaker` (`src/app/speaker/page.tsx`)
- **Precondition:** signed in; `currentUser()` null ⇒ `redirect('/login')`.

**Steps**

1. The page loads `getEvent()`, `mySubmissions(user.id)`, `speakerTasksFor(user.id)` and
   `searchParams` in parallel. `mySubmissions` is scoped by `writableBy(speakerId)` and carries
   `isOwner: sql`${submissions.speakerId} = ${speakerId}``, ordered by `created_at` ascending.
2. `PageHeader title="My submissions"`, description `${user.email} · ${event.name}`, and a
   `LinkButton href="/cfp"` "Submit another" **only while `cfpIsOpen(event)`**.
3. `?submitted=1` renders `data-testid="submitted-confirmation"` (SPK-1 step 13).
4. **Profile card** — `<Headshot url={user.headshotUrl} …size="lg">`, name (or "Unnamed"),
   email, and when `profileGaps(user)` is non-empty a
   `data-testid="profile-prompt"`: "Your profile is missing {describeGaps(gaps)}. Attendees read
   it beside your talk on the agenda." `profileGaps` flags `name`, `bio`, `headshot` on
   empty-after-trim; `describeGaps` joins as "a, b and c". The button
   `data-testid="edit-profile"` reads "Complete your profile" (primary) with gaps and
   "Edit profile" (secondary) without.
5. **`data-testid="speaker-tasks"` section** — heading "What organizers need from you", and when
   any task exists a counter `{outstanding} outstanding of {tasks.length}`. Empty state:
   "Nothing outstanding. Anything the organizers need from you will appear here with its
   deadline." Tasks are split: one naming a submission in `ownIds` goes under that submission's
   card, everything else into the account-level `<Card>` (with `showSubmission`). A task pointing
   at a submission the speaker no longer has write access to falls back to the account list
   rather than vanishing.
6. **Per submission**, a `<Card data-testid={`submission-card-<id>`}>` showing:
   - title; `FORMAT_LABELS[row.format]` and `· {trackName}` when set;
   - `<Badge data-testid={`status-<id>`}>` with `STATUS_LABELS[status]` and `STATUS_TONE`:
     `submitted → 'Under review'` (neutral), `accepted → 'Accepted'` (good),
     `rejected → 'Not accepted'` (bad), `withdrawn → 'Withdrawn'` (neutral);
   - when `slotStartsAt && roomName`, one line
     `{dayLabel} at {timeOfDay} in {roomName}` — **the only place a speaker is shown their
     placement inside the app**;
   - `data-testid={`tasks-<id>`}` when this submission carries tasks;
   - when `!row.isOwner`, `data-testid={`coauthor-<id>`}`: "You are a co-author here. You can
     edit the proposal; withdrawing it and confirming attendance stay with the speaker who
     filed it."

**What is offered at each status** (owner, `row.isOwner === true`)

| status | Edit proposal | Confirm | Withdraw | Content link | Poster link |
|---|---|---|---|---|---|
| `submitted` | yes | no | yes | no | no |
| `accepted`, not confirmed | yes | yes (`confirm-<id>`) | yes | yes (`content-<id>`) | when `format='poster'` (`poster-<id>`) |
| `accepted`, confirmed | yes | replaced by `Notice tone="good"` "Attendance confirmed. Thank you." | yes | yes | as above |
| `rejected` | yes | no | yes | no | no |
| `withdrawn` | **no** | no | **no** | no | no |

A co-author (`isOwner === false`) sees Edit, Content and Poster on the same conditions but never
Confirm and never Withdraw.

**Error and refusal paths:** none on read. There is no per-submission error surface on this page.

**Ends:** read-only.

---

#### SPK-7. Complete a speaker task

- **Role:** whoever the task is assigned to (`speaker_tasks.user_id`)
- **Route:** `/speaker`
- **Precondition:** a `speaker_tasks` row exists for this user. Speakers cannot create tasks;
  they are written by `createSpeakerTaskAction` / `bulkCreateTasksAction` in
  `src/app/organizer/speakers/actions.ts`.

**Steps**

1. Each task renders as `<li data-testid={`task-<task.id>`}>` with the label (struck through and
   muted once done), `TASK_KIND_LABELS[kind]` (`headshot → 'Headshot'`, `bio → 'Bio'`,
   `slides → 'Slides'`, `poster → 'Poster'`, `confirm → 'Confirmation'`, `other → 'Task'`),
   the submission title when `showSubmission`, and either `due {dayLabel(dueAt, timezone)}` or
   `no deadline`.
2. `isOverdue(task)` — `completedAt === null && dueAt !== null && dueAt < now` — adds
   `<Badge tone="bad">overdue</Badge>`. A completed task gets `<Badge tone="good">done</Badge>`.
3. When not done and `taskTargetsProfile(kind)` (kind is `headshot` or `bio`), a ghost
   `LinkButton href="/speaker/profile"` "Update profile" appears.
4. Click **Mark done** — `data-testid={`complete-<task.id>`}`, inside its own `<form action={completeTask}>`
   carrying `<input type="hidden" name="taskId">`.
5. `completeTask` (`src/app/speaker/actions.ts:63`): `requireUser()`, `z.string().uuid().parse`
   on `taskId`, then
   `update speaker_tasks set completed_at = now where id = ? and user_id = ? and completed_at is null`.
   The null check is in the WHERE so a double submit cannot move a completion time already
   recorded. `revalidatePath('/speaker')`.

**Error and refusal paths**

- Not signed in ⇒ `NotAuthorised('not signed in')` thrown, uncaught.
- `taskId` not a uuid ⇒ zod `parse` throws (not `safeParse`) ⇒ server error.
- Someone else's task, or one already completed ⇒ zero rows updated, no error, page re-renders
  unchanged.
- Ordering: `speakerTasksFor` sorts `completed_at is not null asc`, then `due_at asc nulls last`,
  then `created_at`, so outstanding leads.

**Ends:** `speaker_tasks.completed_at` set. **No un-complete control exists on this screen** —
the button is rendered only under `!done`, and `completeTask` only ever writes a timestamp. The
undo is organizer-side, ORG-106, so a speaker who ticked the wrong row has to ask.

---

#### SPK-8. Confirm you will present an accepted talk

- **Role:** signed-in speaker, filer only
- **Route:** `/speaker`
- **Precondition:** `status='accepted'` and `speaker_confirmed_at IS NULL` and `isOwner`.

**Steps**

1. Click **Confirm I will present** — `data-testid={`confirm-<id>`}`, in a
   `<form action={confirmAttendance}>` with `<input type="hidden" name="submissionId">`.
   Beside it: "Organizers schedule confirmed talks first."
2. `confirmAttendance` (`src/app/speaker/actions.ts:16`):
   `update submissions set speaker_confirmed_at = now, updated_at = now
    where id = ? and speaker_id = user.id and status = 'accepted'`, then
   `revalidatePath('/speaker')`.
3. The form is replaced by `<Notice tone="good">Attendance confirmed. Thank you.</Notice>`.

**Error and refusal paths**

- Not the filer, not accepted, or a forged id ⇒ zero rows, no message, the button simply
  remains.
- A co-author with `canEdit` cannot confirm: the button is not rendered for them, and
  `confirmAttendance` scopes on `speaker_id` rather than `writableBy`.
- No `submission_revisions` row is written for a confirmation; it is not in `REVISABLE_FIELDS`
  and no `logRevisions` call accompanies it.
- A `confirm`-kind `speaker_tasks` row can be ticked with "Mark done" (SPK-7) without ever
  pressing this button, and nothing reconciles the two.

**Ends:** `submissions.speaker_confirmed_at` set. Declining is its own control now —
`data-testid={`decline-<id>`}` calling `declineAttendance` (`src/app/speaker/actions.ts:64`),
which writes `speaker_declined_at` and clears `speaker_confirmed_at` in the same update. So
un-confirming is declining, saying no no longer collapses into Withdraw (SPK-9), and the grid
raises `declined-warning` on a talk that still holds a slot.

---

#### SPK-9. Withdraw a submission

- **Role:** signed-in speaker, filer only
- **Route:** `/speaker`
- **Precondition:** `isOwner` and `status !== 'withdrawn'`.

**Steps**

1. Click **Withdraw** — a ghost `<Button type="submit">` in `<form action={withdrawSubmission}>`,
   `<input type="hidden" name="submissionId">`. **No testid, no confirmation dialog, no
   `formNoValidate` guard** — one click is the whole flow.
2. `withdrawSubmission` (`src/app/speaker/actions.ts:34`):
   `update submissions set status='withdrawn', updated_at=now where id = ? and speaker_id = user.id`,
   then `revalidatePath('/speaker')` and `revalidatePath('/agenda')`.

**Error and refusal paths**

- Any status is withdrawable, `accepted` included; there is no guard on status at all.
- A co-author cannot: the form is behind `row.isOwner`, and the WHERE is on `speaker_id`.
- Forged id ⇒ zero rows, silent.
- No `submission_revisions` row is written.

**Ends:** `status='withdrawn'`. The card then renders **no Edit and no Withdraw**, so from the
speaker's side the action is irreversible — only an organizer can move the status back.

---

#### SPK-10. Edit a proposal

- **Role:** signed-in speaker (filer) or co-author with `can_edit = true`
- **Route:** `/speaker/submissions/[id]/edit`
- **Precondition:** signed in; `id` parses as a uuid; `submissionForEdit(id)` returns a row; and
  `canWriteSubmission(submission.id, user.id)`.

**Steps**

1. Reach it from `/speaker` via `data-testid={`edit-<id>`}` ("Edit proposal"), or by URL.
2. Guards, in order (`src/app/speaker/submissions/[id]/edit/page.tsx`):
   `currentUser()` null ⇒ `redirect('/login')`; `z.string().uuid().safeParse(id)` fails ⇒
   `notFound()`; no row or `!canWriteSubmission` ⇒ `notFound()`. The comment states the rule:
   "Someone else's submission is not 'forbidden', it is not theirs to know about."
3. Header: "Edit submission", description `${FORMAT_LABELS[format]} · ${LEVEL_LABELS[audienceLevel]}`
   plus `· {trackName}` when set, and a `LinkButton href="/speaker"` "My submissions".
4. Badges: `STATUS_LABELS[status]`, plus `<Badge tone="warn">locked: {…}</Badge>` listing
   `EDITABLE_FIELDS.filter(f => isFieldLocked(lockedFields, f)).map(fieldLabel)`.
5. When the CFP window is shut, a `Notice`: "The call for papers closed on {date}, so the
   proposal text is read only. An organizer can still make a correction for you." The editor is
   replaced by `<AbstractFields locked={[...EDITABLE_FIELDS]} lockLabel="read only">` — every
   field renders as a `LockedValue` block with no input at all.
6. When open and some fields are locked, a second `Notice`: "The organizers have frozen {A} and
   {B} on this submission. Everything else is yours to change."
7. **Your proposal** card, `<AbstractEditor action={saveMyAbstract}>`:
   `<input type="hidden" name="submissionId">`, then `<AbstractFields>` rendering
   **Title** (`name="title"`, `required`, `maxLength=200`), **Abstract** (`name="abstract"`,
   `required`, `minLength=120`), **Keywords** (`name="keywords"`, comma separated),
   **Format** (`name="format"`) and **Audience level** (`name="audienceLevel"`) as selects.
   A locked field renders as a `LockedValue` with a `<Badge tone="warn">` and **no input**.
8. Click **Save changes** — `data-testid="save-abstract"`, label `Saving…` while pending.
9. `saveMyAbstract` (`src/app/speaker/submissions/actions.ts:78`):
   - `requireUser()`; `submissionId` must parse as a uuid else `{ error: 'Unknown submission.' }`.
   - `getEvent()`, `submissionForEdit`, `canWriteSubmission` in parallel; either failing ⇒
     `{ error: 'Unknown submission.' }`.
   - `!cfpIsOpen(event)` ⇒ `{ error: 'The call for papers is closed, so this can no longer be
     edited here. Ask an organizer.' }`.
   - `pick(field, submitted, stored, lockedFields, refused)` per field: an absent field keeps
     the stored value; a locked field keeps the stored value and, if the posted value differed,
     is pushed onto `refused`.
   - `editSchema.safeParse` over title/abstract/format/audienceLevel.
   - `applyAbstractEdit({ submissionId, editorId: user.id, ownerId: user.id, next })` — one
     transaction, `select … where and(eq(id), writableBy(ownerId)) … .for('update')`, then
     `changedFields` (comparing keywords as a joined string), then the UPDATE, then one
     `submission_revisions` row per changed field with `field`, `old_value`, `new_value`,
     `editor_id`. Returns the changed list.
   - `revalidateSubmission(id)` touches `/speaker`, `/speaker/submissions/<id>/edit`,
     `/organizer/abstracts/<id>`, `/organizer/abstracts/<id>/history`, `/organizer/abstracts`,
     `/agenda/<id>`.
10. Result notices, which can appear **together**:
    - `` `Saved. ${changed.length} field(s) added to the revision history.` `` (good)
    - `'No changes to save.'` when nothing changed and nothing was refused
    - one refusal: `` `${Field} is locked by the organizers, so that change was not saved.` ``
    - several: `` `${A} and ${B} are locked by the organizers, so those changes were not saved.` ``
      (`fieldLabel` maps `title→Title`, `abstract→Abstract`, `keywords→Keywords`,
      `format→Format`, `audienceLevel→Audience level`)

**Error and refusal paths**

- `'Unknown submission.'` covers a bad uuid, a missing row **and** someone else's row — the same
  string for all three.
- `'The call for papers is closed, so this can no longer be edited here. Ask an organizer.'`
- `'Give the talk a title'` (< 6), `'Abstracts under 120 characters are too thin to review'`,
  zod defaults on the enums and lengths.
- A forged post carrying a locked field is recorded in `refused` and dropped rather than thrown
  on, "because the speaker's other three corrections in the same submit are worth keeping".
  Both `error` and `notice` are returned, and `AbstractEditor` renders both.

**Ends:** `submissions` updated; one `submission_revisions` row per changed field.

---

#### SPK-11. Add a co-author

- **Role:** filer, or co-author with `can_edit = true`
- **Route:** `/speaker/submissions/[id]/edit`, "Co-authors" card
- **Precondition:** write access. **Not** gated on the CFP window — the copy says so:
  "Co-authors can be added after the call for papers closes."

**Steps**

1. Fill **Co-author email** (`name="email"`, `type="email"`, `required`, hint "An account is
   created if there is none."), **Name** (`name="name"`, `maxLength=120`), **Affiliation**
   (`name="affiliation"`, `maxLength=200`).
2. Tick or untick **Will be in the room** — `name="isPresenter"`, `defaultChecked`.
3. Only when the viewer is the filer, a second checkbox appears: **Can edit this proposal, not
   only be credited on it** — `name="canEdit"`, `data-testid="grant-edit"`. It is rendered under
   `accessAction ? … : null`, and `accessAction` is `isFiler ? setMyAuthorAccess : undefined`.
4. Click **Add co-author** (no testid; label `Adding…` while pending).
5. `addMyAuthor` → `addAuthorByEmail({ submissionId, ownerId: user.id, editorId: user.id, email,
   name, affiliation, isPresenter: formData.get('isPresenter') !== null,
   canEdit: formData.get('canEdit') !== null })`:
   - `ownedSubmission(submissionId, ownerId)` uses `writableBy`, so a `canEdit` co-author passes.
   - `mayGrantAccess` = `ownerId === undefined || ownerId === owned.speakerId`. A co-author's
     `canEdit` is forced to `false` here, whatever they posted, because crediting somebody is
     theirs to do and granting access is the filer's. See B4.
   - `upsertUserByEmail(email, name)` — creates the account and the speaker role if new.
   - `ensureFilerIsAuthorZero(submissionId, speakerId)` inserts the filer at `position 0` with
     `can_edit = true`, `onConflictDoNothing`. Rows that predate the table get their author 0 here.
   - `position` = `coalesce(max(position),0) + 1`.
   - Insert into `submission_authors` with `onConflictDoUpdate` on `(submission_id, user_id)`
     setting `affiliation` and `is_presenter`, plus `can_edit` only when `mayGrantAccess` —
     re-adding someone edits them and does **not** reshuffle their position, and a co-author
     correcting an affiliation cannot revoke access on the way past either.
   - `logAuthorChange` writes a `submission_revisions` row with `field='authors'` and the
     comma-joined email list before and after, skipped when they are equal.
6. Notice: `` `${email} is credited on this submission.` ``

**Error and refusal paths**

- `'Enter a valid email address'`; zod defaults for name > 120, affiliation > 200.
- `'Submission not found.'` from `ownedSubmission` — no write access, or a bad id.
- `'Unknown submission.'` when `submissionId` is not a uuid.
- A co-author adding another co-author cannot grant `canEdit`: the checkbox is not rendered, and
  a forged `canEdit` field is dropped by `addAuthorByEmail`'s `mayGrantAccess` test. The new
  author is credited with `can_edit = false`; there is no error, because crediting was allowed
  and only the access half was refused. See Bug B4.

**Ends:** a `submission_authors` row (and possibly a `users` row, a `user_roles` row, and the
filer's author-0 row); one `submission_revisions` row of field `authors`.

---

#### SPK-12. Grant or revoke a co-author's edit access

- **Role:** **filer only**
- **Route:** `/speaker/submissions/[id]/edit`, "Co-authors" card

**Steps**

1. Each author row shows `position`, name-or-email, email, `· affiliation`, and badges:
   `<Badge tone="accent">filed this</Badge>` for the filer, `<Badge>not presenting</Badge>` when
   `!isPresenter`, `<Badge tone="good">can edit</Badge>` for a non-filer with `canEdit`.
2. For each non-filer, a button `data-testid={`access-<userId>`}` reading **Let them edit** or
   **Revoke editing**. Its form carries `submissionId`, `userId` and a hidden
   `canEdit` whose value is `author.canEdit ? '' : 'on'` — the *toggle target*, not the current
   state.
3. `setMyAuthorAccess` computes
   `canEdit = formData.get('canEdit') !== null && formData.get('canEdit') !== ''` — so the empty
   string means revoke — and calls `setAuthorAccess`.
4. `setAuthorAccess` (`src/lib/abstracts.ts:482`) resolves the submission with
   `and(eq(submissions.id), eq(submissions.speakerId, ownerId))` — **`speakerId`, deliberately
   not `writableBy`**: "a co-author who could grant access could grant it to anyone, and the
   filer would have given away more than they chose to." Then
   `update submission_authors set can_edit = ? where submission_id = ? and user_id = ?`
   `.returning(...)`, then a `submission_revisions` row with `field='authorAccess'`,
   `oldValue: canEdit ? 'view' : 'edit'`, `newValue: canEdit ? 'edit' : 'view'`.
5. Notice: `'They can now edit this proposal.'` or `'They are still credited, but can no longer
   edit this proposal.'`

**Error and refusal paths**

- `'Unknown author.'` when either id is not a uuid.
- `'Submission not found.'` when the caller is not the filer.
- `'The speaker who filed the submission always has access to it.'` when `userId === speakerId`.
  The UI never offers it (`accessAction && !isFiler`), so this only fires on a forged post.
- `'That person is not credited on this submission.'` when the UPDATE returns zero rows.
- A co-author viewing this page gets `accessAction={undefined}`; `AuthorEditor` then wires
  `useActionState` to `async (prev) => prev` and renders no access buttons.

**Ends:** `submission_authors.can_edit` flipped; one `submission_revisions` row of field
`authorAccess`.

---

#### SPK-13. Remove a co-author

- **Role:** filer, or co-author with `can_edit = true`
- **Route:** `/speaker/submissions/[id]/edit`

**Steps**

1. Click **Remove** on any non-filer row (no testid). Posts `submissionId` and `userId`.
2. `removeMyAuthor` → `removeAuthor({ submissionId, ownerId: user.id, editorId: user.id, userId })`:
   `ownedSubmission` with `writableBy`, then the guard, then
   `delete from submission_authors where submission_id = ? and user_id = ?`, then
   `logAuthorChange`.
3. Notice: `'Co-author removed.'`

**Error and refusal paths**

- `'Unknown author.'` on a non-uuid.
- `'Submission not found.'` without write access.
- `'The speaker who filed the submission cannot be removed from it.'` — the filer's row is
  protected in code, and `AuthorEditor` renders no Remove button on `isFiler`.
- Nothing stops a `canEdit` co-author removing **another** co-author, or removing the very row
  that grants a third party access.

**Ends:** the `submission_authors` row deleted; one `submission_revisions` row of field `authors`.
Deleting the row is what revokes that person's `writableBy` access.

---

#### SPK-14. Edit your profile

- **Role:** any signed-in user
- **Route:** `/speaker/profile`
- **Precondition:** signed in; else `redirect('/login')`.

**Steps**

1. The page renders a headshot card (SPK-15) and then `<ProfileForm>`, a client component holding
   preview state.
2. The preview shows `<Headshot url={previewUrl} name={previewName} email size="lg">` plus the
   name and email. `Headshot` renders `data-testid="headshot-image"` when a URL is present and
   has not errored, otherwise `data-testid="headshot-fallback"` with up to two initials derived
   by splitting on `/[\s@._-]+/`. The failed URL is remembered rather than a boolean, so a
   corrected URL recovers without a remount. Plain `<img>`, not `next/image`, because headshots
   are arbitrary third-party URLs.
3. Fill **Name** — `data-testid="profile-name"`, `required`, `maxLength=120`, updates the preview
   on change.
4. Fill **Short bio** — `data-testid="profile-bio"`, `maxLength=2000`.
5. Fill **Headshot URL** — `data-testid="profile-headshot-url"`, `type="url"`, placeholder
   `https://example.com/me.jpg`, updates the preview on change.
6. Click **Save profile** — `data-testid="profile-save"`, `Saving…` while pending.
7. `saveProfile` (`src/app/speaker/profile/actions.ts:38`): `requireUser()`, zod parse with
   `headshotUrl: linkField`, then
   `update users set name, bio, headshot_url where id = user.id` — the id comes from the
   session and is never read off the form, "so there is no id to forge". Then
   `revalidatePath` on `/speaker`, `/speaker/profile`, `/agenda`.
8. `data-testid="profile-saved"`: "Profile saved."

**Error and refusal paths**

- `'Tell us your name'` on an empty name.
- `'Keep the bio under 2000 characters'`.
- `linkField` refusal: `'Paste a full URL starting http:// or https://, or upload a file.'`
  The regex is `/^(https?:\/\/|\/files\/)/i`, which is what keeps `data:` and `javascript:` out
  of an `<img src>`, and what lets an uploaded headshot's own `/files/…` path survive the next
  save.
- An empty string transforms to `null`, clearing the column — which is how a speaker removes a
  *pasted* headshot.

**Ends:** `users.name`, `users.bio`, `users.headshot_url` written. Note the profile has **no**
timezone, pronouns, social links or affiliation — `users` carries only these plus `email`,
`is_bot` and `created_at`.

---

#### SPK-15. Upload a headshot

- **Role:** any signed-in user
- **Route:** `/speaker/profile`

**Steps**

1. The headshot card shows the current `<Headshot size="lg">` and
   `data-testid="headshot-file-meta"` reading either `` `${uploaded.filename} · ${formatBytes(uploaded.bytes)}` ``
   or "Upload an image, or paste a link to one below." `headshotUpload(user.id)` returns the
   oldest `uploads` row of kind `headshot` for this owner.
2. Choose a file — `data-testid="headshot-file"`, `name="headshotFile"`, `required`,
   `accept={acceptAttribute('headshot')}` = `image/png,image/jpeg,image/gif,image/webp`.
   Hint: "PNG, JPEG, GIF or WebP, up to 5.0 MB. It replaces whatever is there now."
3. Click **Upload headshot** — `data-testid="headshot-upload"`.
4. `uploadHeadshot` → `saveUpload({ file, kind: 'headshot', ownerId: user.id })`:
   - zero-byte / non-`File` ⇒ `'Choose a headshot file first.'`
   - `size > 5 MB` ⇒ `` `That headshot is ${formatBytes(size)}. The limit is 5.0 MB.` ``
   - the first 16 bytes are matched against `SNIFFED_TYPES` — PNG `89 50 4E 47 0D 0A 1A 0A`,
     JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`, WebP `RIFF`…`WEBP` at offset 8, PDF `%PDF-`.
     No match ⇒ `` `That file is not an image, whatever it is named. A headshot has to be an image.` ``
   - a match not in `accepts` ⇒ `` `A headshot has to be an image. That file is a PDF.` ``
   - on success: `storedName = <randomUUID><sniffed.ext>`, written under `UPLOAD_DIR`, and a
     row in `uploads` with `filename: displayName(file.name, ext)`, `content_type` = the
     **sniffed** mime, `bytes`.
5. `replaceHeadshot(user.id, upload)` sets `users.headshot_url = uploadHref(next)` =
   `/files/<id>/<encodeURIComponent(filename)>`, then `deleteUpload`s every other headshot row
   this owner has — row first, bytes second, so a failed unlink orphans a megabyte rather than
   leaving a link to nothing.
6. `refreshProfileViews()` revalidates `/speaker`, `/speaker/profile`, `/agenda`, `/speakers`;
   `redirect('/speaker/profile?uploaded=1')`.
7. `data-testid="headshot-uploaded"`: "Headshot uploaded. It is beside your talks on the public
   agenda."

**Refusals** land as `redirect('/speaker/profile?error=' + encodeURIComponent(reason))` and
render in `data-testid="headshot-error"`. Nothing about the profile changes on a refusal.

**Removing it:** when an uploaded headshot exists, a second form shows **Remove the uploaded
headshot** — `data-testid="headshot-remove"`, hidden `uploadId`. `removeHeadshot` calls
`deleteUpload(id, user.id)` (scoped by `owner_id`) and, only if it deleted a row, sets
`users.headshot_url = null`. Always redirects to `?removed=1`, which renders
`<Notice tone="accent">Headshot removed.</Notice>` — **even when nothing was deleted**.

**SVG** is refused everywhere: it is not in `SNIFFED_TYPES` at all, so it fails the "not an
image, whatever it is named" branch. The module comment gives the reason: "It is the one
raster-looking format that carries script, and an `<img>` tag is not a sandbox."

**Ends:** one `uploads` row of kind `headshot`, `users.headshot_url` pointing at it, and at most
one such row per owner.

---

#### SPK-16. Save session content as a draft

- **Role:** filer, or co-author with `can_edit = true` — **but see Bug B1**
- **Route:** `/speaker/content`
- **Precondition:** signed in; at least one submission with `status='accepted'` reachable via
  `writableBy` (`myContent`). Otherwise the page shows `<Empty>`: "Nothing to add content to
  yet. This screen fills up once a proposal is accepted."

**Steps**

1. Reach it from `/speaker` via `data-testid={`content-<id>`}` ("Slides, recording and
   resources"), or by URL.
2. Per accepted submission, a `<Card data-testid={`content-<id>`}>` with title,
   `FORMAT_LABELS[format]`, `· trackName`, `· {dayLabel} at {timeOfDay} in {roomName}` when
   slotted, and `<Badge data-testid={`content-status-<id>`}>` reading `CONTENT_STATUS_LABELS`:
   `draft → 'Draft'` (neutral), `pending → 'Awaiting review'` (warn),
   `approved → 'Approved'` (good).
3. State notices:
   - `pending`: "With the organizers for review. It is off the public page until they approve it."
   - `approved`: `tone="good"` "Approved and live on the agenda. Editing it below moves it back
     to a draft you will need to resubmit." — **aspirational; see Bug B3.**
   - every one of `slidesUrl`, `recordingUrl`, `resourcesNote` locked (`frozen`): "An organizer
     has frozen every field here. Ask them to unlock it."
4. Fill **Slides URL** — `data-testid={`slides-<id>`}`, `name="slidesUrl"`, deliberately **not**
   `type="url"` because an uploaded deck stores an app-relative `/files/…` path here.
   `disabled={locks.slidesUrl}`.
5. Or choose **Or upload the deck** — `data-testid={`slides-file-<id>`}`, `name="slidesFile"`,
   `accept={acceptAttribute('slides')}` = `application/pdf,image/png,image/jpeg,image/gif,image/webp`,
   hint "PDF or an image, up to 25.0 MB. A file replaces the URL above."
6. Fill **Recording URL** — `name="recordingUrl"`, `type="url"`, no testid,
   `disabled={locks.recordingUrl}`.
7. Fill **Resources** — `name="resourcesNote"`, a textarea, no testid,
   `disabled={locks.resourcesNote}`.
   Each field's hint is `hint(locked, live)`: "Frozen by an organizer. Ask them to unlock it." /
   "Currently visible on the public agenda." / "Not public yet.", the last two decided by
   `contentIsPublic(row.contentStatus, value)`.
8. Click **Save draft** — a `<Button type="submit" variant="secondary" disabled={frozen}>`,
   no testid. Calls `saveContentDraft`.
9. `saveContentDraft` (`src/app/speaker/content/actions.ts:164`):
   - `requireUser()`; `submissionId` `z.string().uuid().parse` (throws on a bad id).
   - `loadOwned(id, user.id)` — `and(eq(id), writableBy(speakerId), eq(status,'accepted'))`.
     Null ⇒ `redirect('/speaker/content')` with no message.
   - `readFields(formData, lockedFields)` — a field is written **only when the form carried it**
     (`formData.has(field)`) and it is not locked. A disabled input is not posted at all, and
     treating an absent field as "clear the column" "would let a lock delete the very content it
     was meant to protect". `resourcesNote` goes through `noteField` (max 4000, trim, `''→null`),
     `slidesUrl` through `linkField`, `recordingUrl` through `urlField`
     (`z.string().url().or(z.literal(''))`, `''→null`) — a recording is always somebody else's
     URL because there is no video upload.
   - `foldInSlidesUpload` — if a real file was posted: locked ⇒ `'An organizer has frozen the
     slides on that talk. Ask them to unlock it.'`; else `saveUpload({kind:'slides'})` and
     `next.slidesUrl = uploadHref(result.upload)`. **The file wins over the text field**: "A
     speaker who did both meant the file: it is the one they had to go and find."
   - `applyTextEdit({ submissionId, editorId: user.id, ownerId: user.id, next })` — transaction,
     `SELECT … FOR UPDATE`, diff against `REVISABLE_FIELDS`, UPDATE, one
     `submission_revisions` row per changed field.
   - `revalidate(id)`: `/speaker/content`, `/speaker`, `/organizer/submissions`, `/agenda/<id>`.
   - `redirect('/speaker/content?saved=1')`.
10. `data-testid="content-flash"` reads: "Saved. Nothing here is public until you submit it and
    an organizer approves it."

**Error and refusal paths**

- Any `saveUpload` refusal (SPK-15's list, with noun "slide deck" and limit 25.0 MB) reaches
  `refuse(reason)` → `redirect('/speaker/content?error=' + encodeURIComponent(reason))`, rendered
  in `data-testid="upload-error"`.
- Frozen slides + a posted file ⇒ the frozen message above.
- Not accepted, not writable, forged id ⇒ bare `redirect('/speaker/content')`, no explanation.
- Locked fields are dropped at `readFields`; **no "that was locked" message exists here** —
  unlike SPK-10, the content form reports nothing about a refused field.

**Ends:** `submissions.slides_url` / `recording_url` / `resources_note` written;
`content_status` **unchanged**; one `submission_revisions` row per changed field.

---

#### SPK-17. Submit content for review

- **Role:** as SPK-16
- **Route:** `/speaker/content`
- **Precondition:** `!frozen && !pending` — the button is `disabled` otherwise.

**Steps**

1. Click **Submit for review** — `data-testid={`submit-review-<id>`}`, a second submit button on
   the same form using `formAction={submitContentForReview}`, so it saves and submits in one post.
2. `submitContentForReview`: identical load / read / upload-fold / `applyTextEdit` as SPK-16, then:
   - `after = { ...row, ...next }`; `empty = CONTENT_FIELDS.every(f => !after[f])` over
     `['slidesUrl','recordingUrl','resourcesNote']`. Empty ⇒ `revalidate(id)` and
     `redirect('/speaker/content?empty=1')`, flash: "Add slides, a recording or a resources note
     before submitting for review." The reason is spelled out: "an organizer opening a review
     with nothing in it cannot approve or send back anything."
   - `setContentStatus(row, user.id, 'pending')` — no-ops when already `pending`; otherwise
     `update submissions set content_status='pending', updated_at=now where id = ? and
     writableBy(speakerId)`, plus a `submission_revisions` row with `field='contentStatus'`,
     old and new values.
   - `redirect('/speaker/content?review=1')`, flash: "Sent to the organizers. They will approve
     it or send it back with a note."
3. A supporting document does **not** count: it is not in `CONTENT_FIELDS`, so attaching one
   alone still hits the `empty` refusal.

**Ends:** `content_status='pending'`. Everything drops off the public agenda immediately —
`contentIsPublic` excludes `'pending'` from both clauses, and the agenda detail page's
`showMaterial` mirrors that. `readableUpload` for kind `slides` requires `'approved'`, so an
uploaded deck is unreadable to the public in this state too.

---

#### SPK-18. Pull content back out of review

- **Role:** as SPK-16
- **Route:** `/speaker/content`
- **Precondition:** `content_status = 'pending'` — the form renders only under `pending`.

**Steps**

1. Click **Pull back out of review** — a ghost `<Button>`, no testid, its own
   `<form action={withdrawContentFromReview}>` carrying `submissionId`.
2. `withdrawContentFromReview`: `loadOwned`; `!row || row.contentStatus !== 'pending'` ⇒
   `redirect('/speaker/content')`. Otherwise `setContentStatus(row, user.id, 'draft')`,
   `revalidate(id)`, `redirect('/speaker/content?pulled=1')`.
3. Flash `tone="accent"`: "Pulled back out of review. Edit away and resubmit."

**Ends:** `content_status='draft'`; one `submission_revisions` row of field `contentStatus`.
Any populated field becomes public again under the `'draft'` leg of `contentIsPublic` — except
an uploaded deck, whose `/files/` read still requires `'approved'`.

**The organizer's side of this loop:** `approveContent` sets `'approved'`; `returnContent` sets
`'draft'` **before** building the mail ("a send that fails leaves the speaker able to edit
rather than stuck in a review queue nobody is looking at") and sends `contentReturnedMail`,
subject `Changes needed: content for "${title}"`, quoting the organizer's reason verbatim and
linking `${APP_URL}/speaker/content`, logged as `kind: 'content_returned'`. It is addressed to
`contentRecipient`, which resolves `submissions.speaker_id` — **a co-author is never told**.

---

#### SPK-19. Attach and remove a supporting document

- **Role:** filer, or co-author with `can_edit = true` (this one genuinely works for both)
- **Route:** `/speaker/content`, the `data-testid={`documents-<id>`}` panel

**Steps**

1. The panel is headed "Supporting documents" with "Handouts, a data appendix, a signed release.
   Organizers only — these never appear on the public agenda." Empty state: "Nothing attached yet."
2. Existing documents come from `documentsFor(ids)` — every `uploads` row with
   `kind='document'` on these submissions, oldest first — and each renders as
   `<li data-testid={`document-<upload.id>`}>` with an `<a href={uploadHref(document)}>` on the
   filename and `formatBytes(document.bytes)`.
3. A **Remove** button `data-testid={`document-remove-<upload.id>`}` renders **only when
   `document.ownerId === user.id`**: "A co-author may attach and withdraw their own material
   without being able to delete the filer's."
4. Choose a file — `data-testid={`document-file-<id>`}`, `name="documentFile"`, `required`,
   `accept={acceptAttribute('document')}` = PDF or image.
5. Click **Attach document** — `data-testid={`document-upload-<id>`}`.
6. `uploadDocument`: `loadOwned`; `saveUpload({kind:'document', ownerId: user.id, submissionId})`
   with a 15.0 MB cap; refusal ⇒ `refuse(result.reason)` → `?error=…`; success ⇒
   `logRevisions([{ field: 'document', oldValue: null, newValue: result.upload.filename }])`,
   `revalidate`, `redirect('/speaker/content?document=1')`. Flash: "Document attached.
   Supporting documents go to the organizers only, never to the public agenda."
7. Remove: `removeDocument` parses `submissionId` and `uploadId`, calls
   `deleteUpload(uploadId, user.id)` — scoped by `owner_id`, not by submission — and on success
   logs `{ field: 'document', oldValue: 'attached', newValue: null }`. It **always** redirects to
   `?removed=1`, flash "Document removed.", whether or not a row was deleted.

**Ends:** an `uploads` row of kind `document` with `submission_id` set. It never publishes:
`readableUpload`'s document branch admits only the owner, an organizer, or someone passing
`writableBy` on that submission.

---

#### SPK-20. Read a file back

- **Role:** anyone, including anonymous
- **Route:** `GET /files/<uploadId>/<filename>` (`src/app/files/[...path]/route.ts`)

**Steps**

1. Only `path[0]` is read. It must match
   `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` or the route returns 404.
   Everything after the id is decorative: it carries the extension so `classifyPosterUrl` can
   read it and a browser can name the download. **Nothing from the URL reaches the filesystem** —
   the name on disk is `uploads.stored_name`, so a `..` in the tail is a caption, not a traversal.
2. `currentUser()`, then `readableUpload(id, viewer)` (`src/lib/uploads.ts:316`), in this order:
   - viewer holds the `organizer` role ⇒ **any** row;
   - viewer is `row.ownerId` ⇒ the row;
   - `kind === 'headshot'` ⇒ the row, to anyone, signed in or not;
   - `row.submissionId` null ⇒ null;
   - the submission is loaded for `status` and `contentStatus`, and:
     - `slides` ⇒ only when `status === 'accepted' && contentStatus === 'approved'`;
     - `poster` ⇒ `status === 'accepted'` and `posterGalleryGate(event, false).open`, which is
       closed while `posterEmbargoUntil > now` (reason `'embargo'`) and closed while
       `!agendaPublished` (reason `'unpublished'`);
     - `document` ⇒ signed in **and** passing `writableBy(viewer.id)` on that submission.
3. `readUploadBytes` reads `join(UPLOAD_DIR, row.storedName)`; a missing file returns null.
4. Response headers: `content-type` = the **sniffed** `uploads.content_type`;
   `content-length`; `x-content-type-options: nosniff`;
   `content-disposition: inline; filename="<row.filename>"`;
   `cache-control: public, max-age=60` for a headshot, `private, no-store, max-age=0` otherwise.

**The 404-not-403 rule:** one `notFound()` helper answers both "no such file" and "not yours",
body `Not found`, `content-type: text/plain; charset=utf-8`. The comment states why: "Splitting
them into 404 and 403 would let an anonymous prober walk the id space and learn which documents
exist, which is most of what the access rule is protecting." There is no 403 anywhere on this
route, and a missing file on disk answers the same way as a forbidden one.

**Cache note:** a removed headshot stays readable from a browser that already fetched it for up
to 60 seconds. The module says so: "the bytes are gone from this server immediately."

---

#### SPK-21. Put artwork on a poster

- **Role:** the filer, or a co-author holding `can_edit` — was filer-only, see Bug B5
- **Route:** `/speaker/posters`
- **Precondition:** signed in; a submission with `format='poster'` that `writableBy(user.id)`
  admits. `myPosters` returns them at **any** status. Empty state: "You have no poster submissions. Only
  a submission filed as a poster can carry artwork."

**Steps**

1. Reach it from `/speaker` via `data-testid={`poster-<id>`}` — a link rendered **only when the
   submission is accepted**, though the page itself lists posters at every status.
2. Per poster: title, `STATUS_LABELS[status]`, `· trackName`, and a board badge —
   `<Badge tone="accent">Board {boardNumber}</Badge>` or `<Badge>Board not assigned</Badge>`.
   `board_number` is organizer-written; a speaker can only read it.
3. When artwork exists, a preview: "How the gallery will show it:" and `<PosterMedia variant="card">`,
   the same component the public gallery uses, plus a `<PosterKindBadge>` from
   `classifyPosterUrl` (`pdf` / `video` / `image` / `unknown → 'Link'`). Otherwise "No artwork yet."
4. If `row.lockedFields.includes('posterUrl')`, both forms are replaced by a `Notice`: "An
   organizer has frozen this poster's artwork. Ask them if it needs to change."
5. **Upload the artwork** — `data-testid={`poster-file-<id>`}`, `name="posterFile"`, `required`,
   `accept` = PDF or image; button `data-testid={`poster-upload-<id>`}`. Hint: "A PDF or an
   image, up to 25.0 MB. It is stored on this server and shown in the hall."
6. **Or point at a URL** — `data-testid={`poster-url-<id>`}`, `name="posterUrl"`, deliberately
   not `type="url"`; hint "A PDF, an image or a video hosted anywhere you can link to. A video
   has to be a link; there is no video upload. Leave it empty to remove the artwork."
   Button **Save poster** (no testid).
7. Both doors converge on `writePosterUrl(submissionId, userId, posterUrl)`, whose WHERE is
   `id = ? AND writableBy(?) AND format = 'poster' AND not (locked_fields @> '["posterUrl"]'::jsonb)`,
   returning the updated ids. Zero rows is reported as a refusal rather than a silent success.
8. `uploadPoster` stores the file **before** checking ownership, on purpose: "`writePosterUrl` is
   the only thing that knows whether this poster is the caller's, and asking it twice would mean
   two queries." A refused upload therefore leaves an orphan file and an orphan `uploads` row.
9. Success ⇒ `refreshPosterViews` revalidates `/speaker/posters`, `/posters`, `/posters/<id>`,
   then `redirect('/speaker/posters?saved=1')` → `<Notice tone="good">Poster saved.</Notice>`.
10. When `status === 'accepted' && posterUrl`, a link "See it in the gallery →" to `/posters/<id>`.

**Error and refusal paths** — rendered in `data-testid="poster-error"`

- `?error=url` ⇒ "That is not a URL we can link to. Paste the full address including https://,
  or upload a file." (from `linkField` failing, i.e. neither `http(s)://` nor `/files/`)
- `?error=refused` ⇒ "That poster was not updated. It is either not one you can edit, not a
  poster, or its artwork has been frozen by an organizer." — one message for all three. It used
  to say "not yours", which was wrong twice over once co-authors were admitted.
- `?message=<reason>` ⇒ the `saveUpload` refusal verbatim (wrong type, over 25.0 MB, no file
  chosen). The page distinguishes the two on purpose: "`error` is a key into a fixed table;
  `message` is a refusal the upload library wrote."
- An **empty** `posterUrl` is not an error: `linkField` transforms it to `null` and the artwork
  is cleared. That is "the 'replace' flow half-done".
- Note the lock here is a raw `lockedFields.includes('posterUrl')` in the page and a raw jsonb
  containment in the action — neither goes through `isLocked`, so `poster_url` would not hold.

**Ends:** `submissions.poster_url` set or cleared. No `submission_revisions` row is written for
a poster change — `posterUrl` is not in `REVISABLE_FIELDS` and neither action calls `logRevisions`.

---

#### SPK-22. Read the organizer's speaker-information pages

- **Role:** any signed-in user
- **Routes:** `/speaker/pages`, `/speaker/pages/[slug]`
- **Precondition:** signed in; else `redirect('/login')`. Also linked from the nav as
  "Speaker info" for every signed-in user.

**Steps**

1. `/speaker/pages` runs `publishedPages()` — `select … where published = true order by position,
   title` — never a filter in the template, "so a draft cannot reach a speaker by way of a screen
   that forgot to check."
2. Empty state: `<Empty>Nothing published yet.</Empty>`. Otherwise a
   `data-testid="portal-page-index"` list, each entry a
   `data-testid={`portal-page-link-<slug>`}` link to `/speaker/pages/<slug>`, the
   `excerpt(page)` (the `summary` when set, else the first 140 characters of `htmlToText(page.html)`
   with an ellipsis), and "Updated {date}".
3. `/speaker/pages/[slug]` computes `isOrganizer = user.roles.includes('organizer')` and calls
   `pageBySlug(slug, isOrganizer)`. `includeDrafts` defaults to `false`, so a screen that forgets
   to pass anything shows only what a speaker may see.
4. `!page` ⇒ `notFound()`.
5. The body renders as `<article data-testid="portal-page-body" dangerouslySetInnerHTML={{ __html: page.html }}>`.
   `page.html` is always `sanitizeHtml(row.body)` — `renderPage` is the only constructor of a
   `RenderedPage`, and `RenderedPage` is not exported in a shape that carries the raw body.
   `portal_pages.body` stores the organizer's HTML as typed, and sanitising happens on every read
   so a tightened allowlist applies retroactively.
6. `data-testid="portal-page-draft"` renders when `!page.published`: "This page is a draft.
   Speakers cannot see it until you publish it." Note the second person — **this notice is
   written for the organizer and a speaker can never see it**, because an unpublished page is
   already a `notFound()` for them.

**What a draft page does to a speaker:** it is invisible in the index and 404s by slug. There
is no "coming soon" state and no way to tell a draft page from one that never existed.

**Ends:** read-only. Speakers cannot create, comment on or acknowledge a portal page.

---

#### SPK-23. The co-author's view, with `can_edit = true`

- **Role:** co-author reached through `submission_authors`, not `submissions.speaker_id`
- **Precondition:** a `submission_authors` row with `can_edit = true`, granted by the filer (SPK-12)
  or set at creation (SPK-11). Seeded rows set it on every other co-author (`i % 2 === 0` in
  `src/db/seed.ts:481`).

**What they get**

1. `/speaker` lists the submission, because `mySubmissions` is scoped by `writableBy`. The card
   carries `data-testid={`coauthor-<id>`}` and `isOwner` is false.
2. **Edit proposal** works in full (SPK-10): `canWriteSubmission` passes, `applyAbstractEdit` scopes
   on `writableBy`, and revisions are attributed to the co-author's `editor_id`.
3. **Co-authors card** — they may add (SPK-11) and remove (SPK-13) other authors, because both go
   through `ownedSubmission(..., writableBy)`. They may **not** grant or revoke access:
   `accessAction` is `undefined` for them, so no `access-<userId>` buttons render, and
   `setAuthorAccess` compares `ownerId` to `speakerId` and answers `'Submission not found.'`
   on a forged post. The card's copy for them reads: "You are a co-author here. The speaker who
   filed this manages the billing and who may edit."
4. **`/speaker/content`** lists the submission (`myContent` uses `writableBy`). They can attach
   and remove **their own** documents (SPK-19), submit for review and pull back out of review
   (`setContentStatus` uses `writableBy`), and their edits to `slidesUrl`, `recordingUrl` and
   `resourcesNote` land: `applyTextEdit` takes `writableBy` too. It did not, and reported success
   anyway — see Bug B1, now closed.
5. **`/speaker/posters`** lists the poster and takes their artwork, through `myPosters` and
   `writePosterUrl`, both `writableBy`. The `poster-<id>` link on `/speaker` has always rendered
   for them; for a while it led to "You have no poster submissions."
6. **`/files/<id>`** — they can read the submission's documents, because `readableUpload`'s
   document branch runs `writableBy(viewer.id)`.
7. **Not offered:** Confirm attendance, Decline, Withdraw, and every mail. Decision mail
   (`acceptanceMail`, `rejectionMail`), schedule mail (`scheduleNoticeMail`) and
   `contentReturnedMail` all address `submissions.speaker_id` alone.

#### SPK-24. The co-author's view, with `can_edit = false`

- **Precondition:** a `submission_authors` row with `can_edit = false` — the column default, and
  the common case, because "crediting somebody is the common case, and handing them write access
  to a proposal should be a thing the filer chose."

**What they get: nothing.** `writableBy` excludes them, so:

- `/speaker` does not list the submission — `mySubmissions` returns it only through `writableBy`.
  If they hold no submissions of their own the page renders "Nothing submitted yet."
- `/speaker/submissions/<id>/edit` is `notFound()` (`canWriteSubmission` false).
- `/speaker/content` does not list it; `/speaker/posters` does not list it.
- `/files/<id>` on that submission's documents is 404.
- They still appear on the public billing: `authorsForDisplay` and the poster detail's `credited`
  query read `submission_authors` without regard to `can_edit`.
- They receive no mail at any point in the lifecycle. Adding them ran `upsertUserByEmail`, which
  created an account and a speaker role **without notifying them** — there is no
  "you have been added as a co-author" template anywhere in `src/lib/email.ts`.

The only route back in is SPK-12, run by the filer.

---

#### SPK-25. Export your own agenda

- **Role:** any signed-in user
- **Route:** `GET /agenda/my.ics`
- Not linked from any speaker page; reachable from `/agenda`.
- `currentUser()` null ⇒ **401** with body "Sign in to export your agenda" — explicitly *not*
  404, "because the file exists and the caller is simply not anyone yet".
- `!event.agendaPublished && !isOrganizer` ⇒ 404.
- Otherwise `agendaSlots({...EMPTY_FILTERS, mine: true}, timezone, user.id)` — this is the
  **bookmarks** filter, not "talks I am giving". A speaker exporting this gets what they starred,
  not their own sessions, unless they starred themselves. Calendar entries for a speaker's own
  talks arrive by mail instead, as `.ics` attachments from `acceptanceMail` and
  `scheduleNoticeMail`, whose UID derives from the submission id so a later change updates the
  entry rather than adding a second.

---

#### What a speaker cannot do

Six of the ten this pass listed have since been built. They are kept, struck and dated, because
the reader most likely to open this section is looking for whether a wall is real.

1. ~~**Set their own availability.**~~ Built: `/speaker/availability`, with
   `src/app/speaker/availability/actions.ts` as a second writer of `speaker_availability`
   alongside the organizer's.
2. ~~**Decline an accepted talk.**~~ Built: `declineAttendance` and `data-testid={`decline-<id>`}`
   on `/speaker`. Saying no no longer collapses into Withdraw.
3. ~~**Un-confirm.**~~ Built, as the same control: `declineAttendance` clears
   `speaker_confirmed_at` while it sets `speaker_declined_at`.
4. **Un-complete a task.** Still true on `/speaker`. The "Mark done" button is rendered only
   under `!done` and `completeTask` only ever writes a timestamp. The organizer can undo it for
   them (ORG-106).
5. ~~**See a decision or a schedule change in the app before it is emailed.**~~ Built:
   `mySubmissions` selects `decision_emailed_at` and `schedule_notice_key`, so `/speaker`
   distinguishes "accepted and told" from "accepted and not yet told".
6. ~~**Reply to `contentReturnedMail`.**~~ Half built: the organizer's reason is on the page at
   `src/app/speaker/content/page.tsx:167`, from `submissions.content_return_reason`. There is
   still no reply control; the mail is the channel.
7. **See their own reviews or scores.** Nothing under `/speaker/**` selects from `reviews`. This
   one is deliberate and should stay while review is blind.
8. **Withdraw a proposal they are a co-author on**, or grant access onward as a co-author. Both
   deliberate: answering for the talk and handing out access are the filer's. Poster artwork used
   to be on this line and is not any more.
9. **Upload a video.** Stated in the poster hint; `recordingUrl` is `type="url"` with no file
   input, and `SNIFFED_TYPES` has no video signature.
10. **Delete their account or any submission.** There is no delete anywhere in the speaker
    surface; withdrawal is the terminal state.

---

#### Bugs and sharp edges found while tracing

All eight are closed. Each keeps its original description, because the description is
what makes the fix legible, with a closing line naming what fixed it. B6 closed as a decision
rather than a change; the other seven are code.

**B1 — CLOSED — a co-author's content edits are silently discarded.** `/speaker/content` admits a
co-author with `can_edit = true` at every gate: `myContent` and `loadOwned` both use
`writableBy`. But `applyTextEdit` (`src/lib/content.ts:231`) builds its scope as
`and(eq(submissions.id, opts.submissionId), eq(submissions.speakerId, opts.ownerId))`, and
`saveContentDraft` passes `ownerId: user.id`. For a co-author that WHERE matches zero rows, the
transaction returns `[]`, and the action still runs `revalidate(id)` and
`redirect('/speaker/content?saved=1')` — so the flash reads "Saved. Nothing here is public
until you submit it and an organizer approves it." while nothing was written. Every sibling
scope on this screen (`loadOwned`, `setContentStatus`) uses `writableBy`; this one does not.
Two consequences follow: a co-author who attaches a slide deck gets the file and the `uploads`
row written but `slides_url` left untouched (an orphan), and `submitContentForReview` computes
`empty` from the in-memory `after` rather than the database, so it can flip `content_status` to
`'pending'` on a submission whose content columns are all still null.
`applyAbstractEdit` in `src/lib/abstracts.ts:207` — the same shape, one file over — uses
`writableBy(opts.ownerId)`, which is what makes SPK-10 work for a co-author.
*Closed:* `applyTextEdit` takes `writableBy` (`src/lib/content.ts:245`), and
`e2e/content.spec.ts` asserts the co-author's edit is in the database afterwards rather than
only that the flash said so.

**B2 — CLOSED — `/login` swallows its own error codes.** `/auth/verify` redirects to `/login?error=missing`
and `/login?error=expired`, but `LoginPage` is a client component that takes no props and never
reads `searchParams`. A speaker who clicks a link twice, or clicks one after 15 minutes, lands on
a clean sign-in form with no indication that anything went wrong.
*Closed:* the page reads `searchParams` and renders `SIGN_IN_ERRORS[params.error]` into
`data-testid="login-error"`, with three tests in `e2e/auth.spec.ts`.

**B3 — CLOSED — "editing it moves it back to a draft" is not implemented.** `/speaker/content` tells an
approved speaker: "Approved and live on the agenda. Editing it below moves it back to a draft you
will need to resubmit." `saveContentDraft` never calls `setContentStatus`; only
`submitContentForReview` and `withdrawContentFromReview` do. Saving a draft edit on an approved
submission therefore rewrites the live URLs while `content_status` stays `'approved'`, and the
new content publishes immediately with no organizer pass.
*Closed:* `saveContentDraft` calls `setContentStatus(row, user.id, 'draft')`
(`src/app/speaker/content/actions.ts:205`), so the promise the screen makes is the behaviour.

**B4 — CLOSED — a co-author can grant themselves nothing, but can grant a stranger everything.**
`addMyAuthor` reads `canEdit: formData.get('canEdit') !== null` unconditionally, and
`addAuthorByEmail`'s only gate is `ownedSubmission(..., writableBy)`. The checkbox is hidden from
a co-author (`accessAction ? … : null`), so the UI does not offer it, but a hand-built POST from
a `can_edit` co-author would add a fourth person with `can_edit = true`. `setAuthorAccess` is
carefully filer-only; `addAuthorByEmail` is the back door round it.
*Closed:* `addAuthorByEmail` computes `mayGrantAccess = opts.ownerId === undefined ||
opts.ownerId === owned.speakerId` (`src/lib/abstracts.ts:491`) and forces `canEdit` to `false`
otherwise, which is the rule `setAuthorAccess` already enforces. `undefined` is the organizer
path, which has no owner to compare and is gated by `requireRole('organizer')` instead. The
conflict branch omits `can_edit` from its `set` in the refused case, so a co-author correcting an
affiliation neither grants access nor revokes it. The test in `e2e/features.spec.ts` appends the
hidden field to the page's own form, so the escalation attempt travels with a genuine action id
and session cookie rather than a reconstructed POST; it was red on the old code at the
`not.toContainText('can edit')` assertion.

**B5 — CLOSED — an uploaded deck on a `'draft'` submission is advertised publicly and 404s.**
`contentIsPublic` and the agenda detail page's `showMaterial` both publish a populated field at
`content_status = 'draft'`. `readableUpload`'s `slides` branch requires
`status === 'accepted' && contentStatus === 'approved'`. So an accepted talk in `'draft'` with an
uploaded deck renders a "Slides" button on `/agenda/<id>` that returns 404 for every anonymous
visitor. A pasted third-party URL in the same column works fine — the divergence only bites the
upload path.
*Closed:* the agenda detail page runs every material through `showMaterial`
(`src/app/agenda/[id]/page.tsx:92`), so the button and the file agree about who may have it.

**B6 — CLOSED, as a decision — two flash messages lie on failure.** `removeHeadshot` redirects to
`?removed=1` ("Headshot removed.") whether or not `deleteUpload` matched a row, and
`removeDocument` redirects to `?removed=1` ("Document removed.") on the same terms — it only
skips the revision log.
*Resolved the other way:* all three removers (headshot, document, availability) now say in their
own comments that this is deliberate. Each is scoped to the caller's own rows, so a miss means
the row was already gone, and reporting a failure would be telling somebody their intent failed
when it had already succeeded.

**B7 — CLOSED — the `posterUrl` lock does not use the shared comparator.** Every other lock in the
app goes through `isFieldLocked` / `isLocked`, which flatten underscores and case precisely because
"a lock that silently does not hold is worse than no lock at all". The poster lock is a literal
`lockedFields.includes('posterUrl')` in the page and a literal `@> '["posterUrl"]'` in the action.
`posterUrl` is also absent from `LOCKABLE_FIELDS`, so it is not clear which organizer control is
meant to write it.
*Closed:* `posterUrl` is in `LOCKABLE_FIELDS` with a comment recording that it "was read before
it could be written", the page reads it through `isLocked`, and the action's jsonb containment
is safe because `withLock` is the only writer of the column and always stores the canonical key.

**B8 — CLOSED — `/speaker` links a co-author to a page that will be empty.** The `poster-<id>` link
renders for anyone with an accepted poster in `mySubmissions`, co-authors included;
`/speaker/posters` scopes on `speaker_id` and shows them "You have no poster submissions."
*Closed:* `myPosters` and `writePosterUrl` both take `writableBy`, so the link leads somewhere
and the artwork form underneath it accepts the write. Covered by `e2e/posters.spec.ts`, which
checks the credited-only case refuses and the `can_edit` case saves.

---

## Part 4 — Reviewer and anonymous visitor flows (REV-1 to REV-45)

Read-only analysis of the source. Every route path,
`data-testid`, function name, table and column below is copied verbatim from source.

There is no `middleware.ts`. Every guard is either in a `page.tsx`, in a route handler, or in
the server action itself. `src/app/organizer/layout.tsx` is the only layout guard, and its own
comment calls it "defence in depth, not the control".

---

#### Role model, in one place

`src/db/schema.ts` `roleEnum` = `['organizer', 'reviewer', 'speaker']`, held in `user_roles`
(`user_id`, `role`), many per user. `src/lib/auth.ts` `currentUser()` returns
`CurrentUser = User & { roles: Role[] }` or null; `requireRole(...allowed)` throws
`NotAuthorised` unless the caller holds one of `allowed`; `requireUser()` throws unless signed
in at all.

`upsertUserByEmail` (`src/lib/auth.ts:39`) grants `speaker` on account creation and comments
"Reviewer and organizer are granted by an organizer, never self-assigned."

**Reviewer-gated surfaces:** `/review` and `/awards/judge`. Both admit `reviewer` OR
`organizer`. Nothing else in the app is reviewer-only.

---

### PART 1 — REVIEWER FLOWS

#### Blind review as a query-level property

The task asked specifically about `reviewQueue()`. Finding, stated plainly:

**`reviewQueue()` in `src/lib/queries.ts` was dead code and has been removed.** It had no
callers; the only occurrences were its own definition, its own type `ReviewQueueRow`, and two
*comments in other files* that cited it as the exemplar of the blind-review rule (now updated):

- `src/lib/awards.ts:40` — "the habit of never selecting a column the template must not print
  is what keeps the review queues honest too"
- `src/lib/evaluator-queries.ts:147` — "in the same way blind review is a property of
  `assignedQueue()` and `openSubmissionQueue()`"

The live queue is `assignedQueue()` and `openSubmissionQueue()` in `src/lib/grading.ts`, which
`src/app/review/page.tsx:78-79` calls. The old documented example was a function nobody ran; the
other modules now point at the live queues as the canonical statement of the rule they follow.

What the old `reviewQueue()` deliberately did not select, per its (now removed) docstring:
it selected `submissions.id`, `submissions.title`, `submissions.abstract`, `submissions.format`,
`submissions.audienceLevel`, `tracks.name`, plus three aggregates (`reviewCount`, `averageScore`,
`myScore`). It joined `submissions` → `tracks` and `submissions` → `reviews`. **It never joined
`users`, so it never had access to `submissions.speakerId` → `users.name`, `users.email`,
`users.bio` or `users.headshotUrl`.** The docstring read: "Blind review is enforced here rather
than in the template: the identity never enters the payload, so it cannot leak through a stray
render or a client component receiving props it did not need." It also excluded `submissions.status`
(it was pinned to `'submitted'` in the WHERE) and `averageScore` was selected but the live page
had no equivalent.

The live replacements hold the same property, and `src/lib/grading.ts:15-28` restates it:
"every reviewer-facing select below joins `review_assignments` to `submissions` and stops
there. None of them reaches `users` through `submissions.speakerId`."

| function | file | joins | speaker identity? |
|---|---|---|---|
| `assignedQueue` | `src/lib/grading.ts:146` | `review_assignments` → `submissions` → `tracks`, `reviews` | no |
| `openSubmissionQueue` | `src/lib/grading.ts:188` | `submissions` → `tracks`, `reviews` | no |
| `myCompletedReviews` | `src/lib/grading.ts:248` | `reviews` → `submissions`, `review_rounds`, `tracks` | no |
| `answersByQuestion` | `src/lib/question-queries.ts:126` | `submission_answers` → `form_questions` | no |
| `reviewQueue` (removed) | — | — | — |

Contrast `organizerSubmissions()` (`src/lib/queries.ts:86`), which `innerJoin`s `users` and
selects `speakerName: users.name` and `speakerEmail: users.email` — "deciding is exactly where
both are needed."

One more query-level detail: the AI-note fetch on `src/app/review/page.tsx:86-94` selects
`reviews.submissionId`, `reviews.score`, `reviews.comment`, `reviews.rubric` filtered to
`reviews.source = 'ai'` and the active round. It does not join `users` either, so the persona's
bot user row never enters the payload.

---

##### REV-1. Open the review queue
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** signed in; holds `reviewer` or `organizer` in `user_roles.role`; at least
  one row in `review_rounds` that `activeRound()` considers open.
- **Steps:**
  1. Follow **Review** in the nav (`src/components/Nav.tsx:29`, rendered only when
     `user.roles.includes('reviewer')` — an organizer without the reviewer role has no nav link
     but the page still admits them).
  2. `ReviewPage` (`src/app/review/page.tsx:40`) calls `currentUser()`. Null → `redirect('/login')`.
  3. Role check at line 47: `!user.roles.includes('reviewer') && !user.roles.includes('organizer')`.
  4. `getEvent()` (`src/lib/queries.ts:7`) and `activeRound()` (`src/lib/rounds.ts:35`) run in
     parallel. `activeRound` selects `review_rounds` where `closed_at IS NULL`, ordered by
     `position` desc then `created_at` desc, and returns the first for which `roundIsOpen`
     holds (`closed_at` null AND `opens_at` either null or in the past).
  5. `assignmentCount(user.id, round.id)` (`src/lib/grading.ts:214`) counts
     `review_assignments` rows for this reviewer in this round.
  6. Branch: `usingFallback = assignments === 0`. Zero → `openSubmissionQueue(user.id, round.id)`;
     otherwise `assignedQueue(user.id, round.id)`.
  7. `myCompletedReviews(user.id)` for the second tab's count.
  8. `answersByQuestion(queue.map(row => row.id))` loads organizer-configured answers for the
     whole page in one query.
  9. Page header reads `Review queue · ${round.name}` with `${graded} of ${queue.length} graded`
     and, when any are past due, ` · ${overdue} past due`.
  10. Two tabs render: `data-testid="tab-queue"` (href `/review`) and `data-testid="tab-done"`
      (href `/review?tab=done`). `params.tab === 'done' ? 'done' : 'queue'` — any other value
      falls back to the queue.
  11. A fixed accent notice always renders: *"Reviews are blind: speaker names and bios are not
      loaded on this page. Grade the proposal, not the person."*
  12. Each card is `data-testid="review-card-${row.id}"` and shows title, a due badge
      `data-testid="due-${row.id}"` when `review_assignments.due_at` is set, either
      `data-testid="my-score-${row.id}"` reading `you scored N` or a plain `ungraded` badge,
      a `N review(s)` badge, the format/level/track line, the abstract, the answer list, the AI
      disclosure, and the grading form.
- **Error and refusal paths:**
  - Not signed in → `redirect('/login')`.
  - Neither role → `<Notice tone="bad">` reading *"This page is for programme-committee
    reviewers. Ask an organizer to add you."* (200, not a 403).
  - `activeRound()` null → `<Notice tone="warn">` reading *"No review round is open. An
    organizer opens one from the call-for-papers screen, and grading resumes here the moment
    they do."* Nothing else on the page renders — no tabs, no completed list. See REV-9.
  - Empty queue with a round open → `<Empty>Nothing awaiting review.</Empty>`.
- **Ends:** nothing written. Read-only render.

##### REV-2. Grade a proposal against the four criteria
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** a round open; the card's submission has `submissions.status = 'submitted'`;
  the reviewer is not the submission's `speaker_id`.
- **Steps:**
  1. The rubric is `RUBRIC` in `src/lib/rubric.ts:9`, four keys in `RUBRIC_KEYS` order:
     `clarity`, `originality`, `relevance`, `credibility`. Labels come from `RUBRIC_LABELS`;
     each `<label>` carries `title={RUBRIC[key]}`, the question text
     (e.g. `clarity` → "Is the abstract specific about what the audience will see and learn?").
  2. Four `<Select>`s named `rubric-clarity`, `rubric-originality`, `rubric-relevance`,
     `rubric-credibility`, each `data-testid="score-${key}-${row.id}"`, options 1–5.
  3. Default value per select is `defaultFor(row, key)` (`src/app/review/page.tsx:36`):
     `row.myRubric?.[key] ?? row.myScore ?? 3`. The comment explains the middle term: a grade
     filed before the rubric existed has a `reviews.score` and a null `reviews.rubric`, so
     seeding every criterion from the old score means an accidental resubmit re-derives the same
     number instead of silently dropping to 3.
  4. Optional `<Textarea name="comment">`, placeholder *"Notes for the rest of the committee
     (optional)"*, prefilled from `row.myComment`.
  5. Press the submit button, `data-testid="grade-${row.id}"`, labelled `Grade` when
     `row.myScore === null` and `Update grade` otherwise.
  6. `submitReview(formData)` (`src/app/review/actions.ts:28`) runs:
     - `requireRole('reviewer', 'organizer')`.
     - `schema.parse` on `submissionId` (uuid) and `comment` (trimmed, max 4000, undefined when
       empty).
     - Each `rubric-${key}` parsed by `criterion = z.coerce.number().int().min(1).max(5)`.
     - `score = weightedScore(rubric)` (`src/lib/rubric.ts:45`) with `DEFAULT_WEIGHTS`, all four
       weights 1, result `clampScore`ed to an integer 1–5.
     - Three guards (see refusals).
     - `activeRound()` re-read server-side.
     - Upsert into `reviews`: `round_id`, `submission_id`, `reviewer_id`, `score`, `rubric`,
       `comment`, `source = 'human'`, with
       `onConflictDoUpdate` on `(reviews.roundId, reviews.submissionId, reviews.reviewerId)`
       setting `score`, `rubric`, `comment`, `created_at = now()`. The unique index is
       `reviews_round_submission_reviewer_idx`.
     - `revalidatePath('/review')`, `revalidatePath('/organizer/submissions')`,
       `revalidatePath('/organizer/cfp')`.
  7. The page re-renders. The card now carries `data-testid="my-score-${row.id}"` reading
     `you scored N`, the button reads `Update grade`, and the `N review(s)` badge has gone up.
- **Error and refusal paths:**
  - A criterion outside 1–5 or non-integer → `criterion.parse` throws `ZodError`. Unhandled,
    so it surfaces as a Next server-action error, not a field message.
  - `comment` over 4000 chars → `ZodError`, same.
  - Not a reviewer or organizer → `requireRole` throws `NotAuthorised('requires one of:
    reviewer, organizer')`.
  - **Every domain refusal below is a bare `return` — no thrown error, no redirect, no message.**
    The action completes, the page does not revalidate, and the reviewer sees the form exactly
    as they left it with no indication anything was refused. This is true of all three:
    - `if (!target || target.status !== 'submitted') return;` (line 45)
    - `if (target.speakerId === reviewer.id) return;` (line 48)
    - `if (!round) return;` (line 54)
- **Ends:** one row in `reviews` for `(round_id, submission_id, reviewer_id)` with `source =
  'human'`, `rubric` holding the four-key breakdown and `score` its weighted mean.

##### REV-3. Change a grade already filed
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** a `reviews` row exists for this reviewer, this submission, this round; the
  submission is still `'submitted'` and the round still open.
- **Steps:**
  1. The card shows `you scored N` (`data-testid="my-score-${row.id}"`); the button reads
     `Update grade`.
  2. Selects are prefilled from `row.myRubric`, which `MY_GRADE` (`src/lib/grading.ts:127`)
     reads as `(array_agg(reviews.rubric) filter (where reviews.reviewer_id = ${reviewerId}))[1]`
     — the `[1]` is safe only because the unique index guarantees at most one element per round,
     which is why the join must already be narrowed to one round.
  3. `myComment` is read the same way and prefills the textarea.
  4. Submitting takes the `onConflictDoUpdate` branch. `created_at` is reset to `now()`, so the
     "graded" date on the done tab moves to the edit time rather than the original.
- **Error and refusal paths:** identical to REV-2. The action's docstring gives the reason for
  upsert over insert: "a reviewer who changes their mind moves their own score instead of
  stacking a second one and quietly double-weighting themselves in the average."
- **Ends:** the same single row, with new `score`, `rubric`, `comment` and `created_at`.

##### REV-4. Leave a comment for the rest of the committee
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** as REV-2.
- **Steps:** The comment field is part of the same form; there is no separate comment control
  and no threading. Value goes to `reviews.comment` (nullable text, max 4000 enforced by zod).
  Empty or whitespace-only is coerced to `undefined` by
  `(formData.get('comment') as string | null)?.trim() || undefined` and stored as SQL NULL.
- **Where it surfaces:** the reviewer's own done tab (`src/app/review/page.tsx:293`), and the
  organizer's screens via `revalidatePath('/organizer/submissions')`. It is **not** shown to
  other reviewers on the queue — the queue only surfaces `reviewCount`, not other people's text.
- **Ends:** `reviews.comment` set or nulled.

##### REV-5. Read the AI evaluator's advisory note
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** a `reviews` row with `source = 'ai'` and `round_id` = the active round for
  that submission.
- **Steps:**
  1. `src/app/review/page.tsx:86-95` fetches all AI rows for the round into `aiBySubmission`.
  2. When one matches the card, a `<details>` renders. Collapsed summary text:
     `AI evaluator note (advisory, scored ${ai.score}/5)`.
  3. Expanding shows `ai.comment` and, when `reviews.rubric` is present, the per-criterion
     numbers as `key: value` pairs (raw jsonb keys, not `RUBRIC_LABELS`).
- **Design note in source** (`src/app/review/page.tsx:83-85`): it is fetched separately and put
  behind a disclosure so "the human reads the abstract before an advisory score has a chance to
  anchor them." There is no way to hide it permanently and no setting for it.
- **Ends:** no write.

##### REV-6. Read the organizer's custom-question answers
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** the submission has rows in `submission_answers`.
- **Steps:**
  1. `answersByQuestion(ids)` (`src/lib/question-queries.ts:126`) joins `submission_answers` →
     `form_questions` (inner), ordered by `form_questions.position` then `created_at`.
     Archived questions are included on purpose: "a reviewer reading a proposal has to see the
     question the answer answered, even when the organizer has since taken it off the form."
  2. `<AnswerList>` (`src/components/AnswerList.tsx`) renders a `<dl data-testid="answers">`,
     prompt in the `<dt>`, value in the `<dd>`.
  3. A `url`-kind question renders as an `<a target="_blank" rel="noreferrer noopener">`.
     Everything else goes through `displayAnswer` (`src/lib/questions.ts:178`), which maps a
     `checkbox` value of `'yes'` (`CHECKED`) to `Yes` and anything else to `No`, and empty to `—`.
  4. `page.tsx:98` and `AnswerList`'s own docstring both note this path touches nothing in
     `users`, so it does not open a hole in the blind read.
- **Ends:** no write.

##### REV-7. Review my own filed reviews
- **Role:** reviewer
- **Route:** `/review?tab=done`
- **Precondition:** a round is open (the no-round notice at line 62 returns before the tab is
  ever evaluated — see REV-9).
- **Steps:**
  1. Click `data-testid="tab-done"`, labelled `My reviews (${completed.length})`.
  2. `myCompletedReviews(user.id)` (`src/lib/grading.ts:248`) returns every grade this reviewer
     filed, **at any submission status and in any round**, ordered `reviews.created_at desc`.
     It is the one function in that module that deliberately spans rounds.
  3. Each card is `data-testid="completed-${row.submissionId}"` with `data-round={row.roundId}`.
  4. Badges: `data-testid="round-badge-${row.roundId}-${row.submissionId}"` carrying
     `review_rounds.name`; `you scored ${row.score}`; and the submission's status via
     `STATUS_LABELS` with tone from `STATUS_TONE` — `submitted` → "Under review" (neutral),
     `accepted` → "Accepted" (good), `rejected` → "Not accepted" (bad), `withdrawn` →
     "Withdrawn" (neutral).
  5. Meta line: format, level, optional track, and `graded ${dayLabel(row.gradedAt)}`.
  6. Rubric breakdown renders when `reviews.rubric` is non-null, filtered to keys whose value
     is a number, labelled with `RUBRIC_LABELS`. When null, the card reads *"Graded before
     per-criterion scoring."* rather than back-filling numbers nobody chose.
  7. The comment renders verbatim when present.
- **What this discloses:** the decision. A reviewer learns whether a proposal they graded was
  accepted or rejected here, before any public announcement — `submissions.status` is selected
  by `myCompletedReviews`. Still no speaker column, which the docstring calls out: "a
  reviewer's own history is not a hole in blind review."
- **Error and refusal paths:** nothing graded → `<Empty>You have not graded anything yet.</Empty>`.
- **Ends:** no write.

##### REV-8. Work an assigned queue, or the unassigned fallback
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** differs by branch.
- **Steps (assigned):**
  1. `assignmentCount > 0`, so `assignedQueue(reviewerId, roundId)` runs.
  2. It starts `.from(reviewAssignments)`, inner-joins `submissions`, and filters
     `review_assignments.reviewer_id = me`, `review_assignments.round_id = round`,
     `submissions.status = 'submitted'`.
  3. Ordering: `review_assignments.due_at asc nulls last`, then `count(reviews.id) asc`, then
     `submissions.created_at asc`.
  4. `due_at` renders as `data-testid="due-${row.id}"`, tone `warn` normally and `bad` when
     `row.dueAt.getTime() < now`, text `due <day>` or `overdue <day>`, `title` the full ISO
     timestamp.
  5. Docstring reason for the status filter: an assignment on a decided submission "is not
     actionable — `submitReview` refuses it — so leaving it in the queue would show a card whose
     form cannot do anything."
- **Steps (fallback):**
  1. `assignmentCount === 0`, so `openSubmissionQueue(reviewerId, roundId)` runs: **every**
     submission with `status = 'submitted'`, ordered least-reviewed first then oldest.
  2. `dueAt` is `sql\`null::timestamptz\``, so no due badge ever renders in this mode.
  3. An extra notice renders above the cards: *"You have no assignments yet, so this is every
     proposal still open for grading."*
  4. Rationale in `src/app/review/page.tsx:73-75`: "Falling back to every open submission is
     what this page did before assignments existed, and it is better than an empty screen that
     looks broken."
- **Gap worth naming:** `openSubmissionQueue` has no self-exclusion. `assignedQueue` inherits
  one indirectly because `planAssignments` (`src/lib/grading.ts:451-458`) filters
  `reviewer.id !== submission.speakerId` when distributing. So in fallback mode a reviewer who
  also submitted a proposal sees **their own proposal in their queue**, with a working-looking
  `Grade` button that `submitReview` silently discards (REV-10).
- **Ends:** no write.

##### REV-9. Meet a closed round, or no round at all
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** every row in `review_rounds` has `closed_at` set, or `opens_at` in the
  future, or the table is empty.
- **Steps:**
  1. `activeRound()` returns null.
  2. `src/app/review/page.tsx:62` returns, before the tabs, the queue, the completed list and
     the blind-review notice:
     `<Notice tone="warn">No review round is open. An organizer opens one from the
     call-for-papers screen, and grading resumes here the moment they do.</Notice>`
  3. Rationale at line 60: "Grading happens in a round. With none open there is nothing to grade
     into, and a queue that accepted scores would be filing them nowhere."
- **Consequence:** `/review?tab=done` is also unreachable in this state. A reviewer whose round
  just closed loses the view of their own history until an organizer opens the next round.
- **Refusal on a replayed POST:** `submitReview` re-reads `activeRound()` at line 53 and bails
  with a bare `return`. Its comment: "silently writing it into the last closed one would reopen
  a pass the committee has already reported on."
- **Ends:** no write.

##### REV-10. Try to grade my own proposal
- **Role:** reviewer who is also a submitter
- **Route:** `/review`
- **Precondition:** `submissions.speaker_id = reviewer.id`, and either the fallback queue is in
  use or the form is posted directly.
- **Steps:**
  1. In fallback mode the card renders like any other, with full rubric selects and a live
     `Grade` button.
  2. Pressing it calls `submitReview`.
  3. `if (target.speakerId === reviewer.id) return;` (`src/app/review/actions.ts:48`), comment
     "A reviewer may not grade their own proposal."
- **Error and refusal paths:** **silent.** No message, no notice, no redirect, no write. The
  page does not revalidate, so the button still reads `Grade` and the card still reads
  `ungraded`. Nothing tells the reviewer why.
- **Ends:** no row in `reviews`.

##### REV-11. Try to grade a decided submission
- **Role:** reviewer
- **Route:** `/review`
- **Precondition:** an organizer moved `submissions.status` to `accepted`, `rejected` or
  `withdrawn` while the reviewer had the page open.
- **Steps:**
  1. Both queue queries filter `eq(submissions.status, 'submitted')`, so on the next render the
     card is gone.
  2. A stale form posted before that re-render hits
     `if (!target || target.status !== 'submitted') return;` (line 45). Comment: "Grading a
     submission that has already been decided would not change the outcome and would make the
     average shift under the organizer's feet."
  3. The same line covers a submission id that does not exist at all (`!target`).
- **Error and refusal paths:** silent bare `return`, as REV-10.
- **Ends:** no write. Any grade the reviewer *had* already filed stays in `reviews` and keeps
  appearing on the done tab with the new status badge.

##### REV-12. Cast a committee award ballot — no criteria
- **Role:** reviewer
- **Route:** `/awards/judge`
- **Precondition:** signed in with `reviewer` or `organizer`; at least one row in `awards`;
  `awards.criteria` empty for this award; `awards.voting_closed_at IS NULL`; at least one row in
  `award_nominees` for it.
- **Steps:**
  1. Follow **Judge awards** in the nav (`src/components/Nav.tsx:33`, reviewer-only) or the
     `Judge awards` secondary button on `/awards` (`src/app/awards/page.tsx:49`, shown to
     organizer or reviewer).
  2. `JudgeAwardsPage` (`src/app/awards/judge/page.tsx:37`) runs `currentUser()`; null →
     `redirect('/login')`; neither role → `<Notice tone="bad">Committee access only.</Notice>`.
     Its docstring explains the placement: the guard is on the page rather than a layout because
     "`/awards` above it is public: a layout guard would have to let everyone through anyway."
  3. `awardDetails()` (`src/lib/awards.ts:251`) loads every award with `criteriaOf(award)`, its
     nominees (joining `submissions` and `users` for `speakerName`) and every ballot in
     `award_votes`.
  4. Per award, `data-testid="judge-award-${award.id}"`, with a badge reading `voting open` or
     `voting closed` from `committeeOpen(award)` (`awards.voting_closed_at === null`).
  5. With `criteria.length === 0` the nominees render as a list, each with the title,
     `speakerName ?? 'Unnamed'`, a `finalist` badge when `award_nominees.is_finalist`, and a
     one-button form. The button reads `your ballot` (primary) when it matches the existing vote
     and `vote` (secondary) otherwise.
  6. `castCommitteeVote` (`src/app/awards/judge/actions.ts:21`):
     - `requireRole('organizer', 'reviewer')`.
     - zod-parses `awardId` and `submissionId` as uuids.
     - `awardDetail(input.awardId)`; missing → `redirect('/awards/judge?ballot=unknown')`.
     - `committeeOpen` false → `redirect('/awards/judge?ballot=closed')`.
     - Looks up `award_nominees` on `(award_id, submission_id)`; missing →
       `redirect('/awards/judge?ballot=not_nominated')`.
     - `criteria.length === 0`, so `scores` stays `null`.
     - Upsert into `award_votes` with `channel = 'committee'`, conflict target
       `(award_votes.awardId, award_votes.judgeId, award_votes.channel)`, setting
       `submission_id`, `scores`, `created_at = now()`.
     - `revalidatePath` on `/awards/judge`, `/awards`, `/organizer/awards`, then
       `redirect('/awards/judge?ballot=ok')`.
  7. Back on the page, `BALLOT_MESSAGES.ok` renders: *"Ballot recorded. You can change it until
     voting closes."* A line above the nominees reads `Your ballot: <title>`.
- **Error and refusal paths:** the four `?ballot=` keys and their exact text
  (`src/app/awards/judge/page.tsx:24-30`):
  - `ok` (good) — "Ballot recorded. You can change it until voting closes."
  - `closed` (bad) — "Voting for that award has closed, so nothing was recorded."
  - `not_nominated` (bad) — "That submission is not nominated for the award."
  - `incomplete` (bad) — "Score every criterion from 1 to 5." (interpolated from
    `MIN_CRITERION_SCORE`/`MAX_CRITERION_SCORE`)
  - `unknown` (bad) — "That award no longer exists."
  - A non-uuid id → `ZodError`, unhandled.
  - Neither role → `NotAuthorised('requires one of: organizer, reviewer')`.
- **Ends:** exactly one `award_votes` row per `(award_id, judge_id, 'committee')`, enforced by
  the composite primary key rather than a read-then-write.

##### REV-13. Cast a weighted committee ballot — with criteria
- **Role:** reviewer
- **Route:** `/awards/judge`
- **Precondition:** as REV-12, but `awards.criteria` holds at least one valid entry.
- **Steps:**
  1. `criteriaOf(award)` (`src/lib/awards.ts:75`) reads the jsonb defensively: each entry must
     be an object; `key` must match `CRITERION_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/` and be
     unseen; `label` must be a non-empty string; `weight` defaults to 1 when not a finite
     number and is floored at 0 by `Math.max(0, w)`. Anything failing is **dropped**, not
     rejected — "a malformed entry is dropped rather than allowed to produce a NaN score
     downstream."
  2. The form renders a `<Select name="submissionId">` of nominees (finalists suffixed
     ` (finalist)`), required, with a disabled placeholder *"Pick the entry you are scoring"*.
  3. One `<Select name="score_${criterion.key}">` per criterion, required, options 1–5, with a
     disabled `—` placeholder. Each field's hint reads
     `weight ${criterion.weight} · 1 to 5`.
  4. Existing values prefill from `mine?.scores?.[criterion.key]`.
  5. Button reads `Update ballot` when a ballot exists, `Submit ballot` otherwise.
  6. In `castCommitteeVote`, `detail.criteria.length > 0` takes the collection branch
     (`actions.ts:50-64`): each `score_${key}` is `Number(...)`ed and must satisfy
     `Number.isInteger(raw) && raw >= 1 && raw <= 5`.
  7. `scores` is written as a jsonb object into `award_votes.scores`.
- **Error and refusal paths:**
  - Any criterion missing or out of range → `redirect('/awards/judge?ballot=incomplete')`.
    The docstring gives the reason a partial rubric is refused rather than averaged: it "would
    let a judge raise a mean by leaving a weak criterion blank."
  - Everything from REV-12 applies unchanged.
- **How the weight is used:** `ballotScore(scores, criteria)` (`src/lib/awards.ts:139`) clamps
  each value to 1–5, multiplies by weight, divides by the summed weights; all weights zero falls
  back to the unweighted mean; no usable value returns 0. It is a separate function from
  `weightedScore` in `src/lib/rubric.ts` because "award criteria are whatever an organizer
  typed, so the keys cannot be shared."
- **Ends:** one `award_votes` row with a populated `scores` jsonb.

##### REV-14. Change a committee ballot
- **Role:** reviewer
- **Route:** `/awards/judge`
- **Precondition:** a ballot exists; `awards.voting_closed_at IS NULL`.
- **Steps:** identical control, identical action. The `onConflictDoUpdate` on
  `(awardId, judgeId, channel)` moves `submission_id` and `scores` and resets `created_at`.
  The line above the form updates to the new pick, and when scores exist it appends
  ` · ${label} ${value}` per criterion, joined by ` · `, with `—` for a missing key.
- **Error and refusal paths:** once an organizer sets `awards.voting_closed_at`, the form is
  replaced by the tally (REV-15) and any replayed POST redirects to `?ballot=closed`.
- **Ends:** the same single row, moved.

##### REV-15. Read committee standings after voting closes
- **Role:** reviewer
- **Route:** `/awards/judge`
- **Precondition:** `awards.voting_closed_at` is set, so `committeeOpen(award)` is false.
- **Steps:**
  1. The nominee list and the ballot form are both replaced by
     `<AwardTally tally={tally(detail, 'committee')} winnerSubmissionId={award.winnerSubmissionId} />`
     (`src/app/awards/judge/page.tsx:100`). Note **no `sealed` prop**, so the numbers show.
  2. `tally` (`src/lib/awards.ts:171`): `weighted = channel === 'committee' && criteria.length > 0`.
     Rows are the nominees (all of them, since `finalistsOnly` defaults false), each carrying
     `ballots` (how many judges picked it) and `score` (mean `ballotScore` across those ballots
     when weighted, otherwise the ballot count). Ballots for a withdrawn nomination drop out
     because the row is built from the nominee pool, not from the ballots.
  3. Sort: score desc, then ballots desc, then `title.localeCompare`. The title term is what
     makes a close re-tally reproducible.
  4. `leader` is the top row only when `contenders.length > 1 && contenders[1].score === top.score`
     is false; otherwise `tied` is true and `leader` is null.
  5. `AwardTally` renders `data-testid="tally-committee-${row.submissionId}"` per row, an index,
     the title, `speakerName ?? 'Unnamed'`, a `finalist` badge, a `winner` badge when it matches
     `awards.winner_submission_id`, and either `${score.toFixed(2)} · N ballot(s)` when weighted
     or `N vote(s)` when not. Header reads `Committee` and `${cast} ballot(s)` plus
     ` · weighted rubric` when applicable.
  6. When tied: *"Tied at the top. Nothing is declared from a tie; an organizer picks and says
     why."*
- **The sealing rule, stated in `src/app/awards/AwardTally.tsx:14-17`:** "`sealed` hides the
  numbers while the ballot is still open. A live committee tally tells judges how their
  colleagues voted before they have voted themselves, which is the thing blind review exists to
  prevent." On `/awards/judge` the tally is only rendered in the closed branch, so the effect
  holds without the prop.
- **Ends:** no write.

##### REV-16. Reach award judging at all
- **Role:** reviewer
- **Routes:** `/` → `/awards` → `/awards/judge`, or the nav
- **Steps:** `src/components/Nav.tsx:28-34` pushes both `/review` and `/awards/judge` when
  `user.roles.includes('reviewer')`. The comment marks the second as load-bearing: "committee
  balloting lives outside the organizer layout precisely so a reviewer can reach it, and without
  this link their only route to it is a typed URL." `castCommitteeVote`'s own docstring records
  the bug this fixed: under the organizer layout, the page answered "Organizer access only." and
  "the reviewer half of this check was unreachable through the UI".
- **Note:** an **organizer without the `reviewer` role** gets neither nav link, yet both pages
  admit them. They reach `/review` and `/awards/judge` only by typing the URL or via the
  `Judge awards` button on `/awards`.
- **Ends:** no write.

##### REV-17. Star a talk, as a reviewer
- **Role:** reviewer (acting as any signed-in attendee)
- **Route:** `/agenda`, `/agenda/[id]`, `/posters`, `/posters/[id]`
- **Precondition:** signed in. No role requirement.
- **Steps:** identical to REV-36 but with the signed-in branch: `StarButton`
  (`src/app/agenda/StarButton.tsx`) renders a form calling `toggleBookmark`
  (`src/app/agenda/actions.ts:21`); `BookmarkButton` (`src/app/posters/BookmarkButton.tsx`)
  calls `toggleBookmark` in `src/app/posters/actions.ts:19`. Both write the same `bookmarks`
  row `(user_id, submission_id)` — the agenda action's docstring: "starring a poster in the
  gallery and starring it on the agenda are the same act, not two."
- **What a reviewer cannot do:** there is **no bookmarking, starring or flagging control on
  `/review` at all.** The queue has no star, no shortlist, no "read later". The only per-card
  persistent state a reviewer can create is a grade and a comment. A reviewer who wants to mark
  a proposal has to grade it.
- **Ends:** a row inserted into or deleted from `bookmarks`.

##### REV-18. What a reviewer can and cannot see about a submitter
- **Role:** reviewer
- **Route:** `/review`
- **Cannot see, anywhere on `/review`:** `users.name`, `users.email`, `users.bio`,
  `users.headshot_url`, `submissions.speaker_id`. None of the four queries the page runs joins
  `users`. Not withheld in the template — never fetched. The four are `assignedQueue` /
  `openSubmissionQueue`, `myCompletedReviews`, the inline AI-notes select, and
  `answersByQuestion`.
- **Can see:** `submissions.title`, `submissions.abstract`, `submissions.format`,
  `submissions.audience_level`, `tracks.name`, the count of reviews on the row, their own
  score/rubric/comment, `review_assignments.due_at`, every `submission_answers.value` with its
  `form_questions.prompt`, and the AI persona's score, comment and rubric.
- **Can infer:** a `submission_answers` free-text answer can obviously name the speaker — the
  blind property is about columns, not about content the speaker typed. Same for the abstract.
- **Can see on the done tab only:** `submissions.status`, i.e. the accept/reject decision, in
  any round, before it is announced publicly.
- **Ends:** n/a.

---

### PART 2 — ANONYMOUS PUBLIC VISITOR FLOWS

Reachable with no cookie: `/`, `/cfp`, `/agenda`, `/agenda/[id]`, `/agenda/calendar.ics`,
`/agenda/filtered.ics`, `/speakers`, `/speakers/[id]`, `/posters`, `/posters/[id]`, `/awards`,
`/login`, `/auth/verify`, `/embed/demo`, `/embed/speakers`, `/embed/agenda`,
`/embed/speakers.json`, `/embed/agenda.json`, `/embed/embed.js`, and `/files/<id>/<name>` for a
headshot.

The nav an anonymous visitor sees (`src/components/Nav.tsx`): the event name, then **Agenda**,
**Posters**, **Speakers**, **Awards**, and **Sign in** on the right. No `My submissions`, no
`Speaker info`, no `Profile`, no `Review`, no `Judge awards`, no `Organize`.

##### REV-19. Land on the home page
- **Role:** anonymous visitor
- **Route:** `/`
- **Precondition:** one row in `events` (`getEvent()` throws `No event row. Run \`pnpm db:seed\`
  to create one.` otherwise).
- **Steps:**
  1. `HomePage` (`src/app/page.tsx:5`) reads `getEvent()` and `cfpIsOpen(event)`
     (`src/lib/queries.ts:15`: `now >= events.cfp_opens_at && now <= events.cfp_closes_at`).
  2. Header shows `events.name` and `events.tagline`.
  3. The header action is `Submit a proposal` → `/cfp` when the CFP is open, otherwise
     `See the agenda` → `/agenda` (secondary).
  4. Two cards: **When** (`events.starts_on` to `events.ends_on`, plus `events.timezone`) and
     **Call for papers** (`events.cfp_opens_at` to `events.cfp_closes_at`).
  5. A notice: open → *"The call for papers is open. Talks, workshops, lightning talks and
     posters are all welcome."*; closed → *"The call for papers is closed. The programme is
     published on the agenda."* with a link to `/agenda`.
- **Error and refusal paths:** none. This page has no auth reference at all.
- **Ends:** no write.

##### REV-20. Submit a proposal without an account
- **Role:** anonymous visitor
- **Route:** `/cfp`
- **Precondition:** `cfpIsOpen(event)` true.
- **Steps:**
  1. `CfpPage` (`src/app/cfp/page.tsx:8`) loads the event, `allTracks()`, `currentUser()` (null
     here) and `activeQuestions()`. Description: *"Open until <date>. Reviewers grade abstracts
     without seeing who wrote them."*
  2. `CfpForm` renders. **About you:** `data-testid="cfp-email"` (required, editable because
     `knownEmail` is null), `data-testid="cfp-name"` (required), a bio textarea hinted *"Shown
     on the public agenda beside your talk."*
  3. **The proposal:** `data-testid="cfp-title"` (max 200), `data-testid="cfp-abstract"`
     (`minLength={120}`, hint *"Reviewers see this without your name attached."*),
     `data-testid="cfp-format"`, `data-testid="cfp-level"` (default `intermediate`),
     `data-testid="cfp-track"` (default `No preference`), `data-testid="cfp-keywords"`.
  4. Choosing format `poster` reveals a required `data-testid="cfp-poster-url"`.
  5. `<CustomQuestions>` (`data-testid="custom-questions"`) renders the organizer's questions,
     each `data-testid="question-${question.id}"`, posting under `q_${questionId}`.
     `visibleQuestions` (`src/lib/questions.ts:68`) recomputes on every keystroke using the same
     pure function the server validates with; a hidden question renders nothing at all rather
     than a disabled input.
  6. Press `data-testid="cfp-submit"` → `submitProposal` (`src/app/cfp/actions.ts:99`).
  7. Server side: re-checks `cfpIsOpen`; zod-parses; poster check; `activeQuestions()` +
     `validateAnswers`; `upsertUserByEmail(email, name)` creates a `users` row and grants
     `speaker` in `user_roles`; updates `users.name`/`users.bio`; inserts into `submissions`
     (`speaker_id`, `track_id`, `title`, `abstract`, `format`, `audience_level`, `poster_url`,
     `keywords`, status defaulting to `'submitted'`); `saveAnswers` writes `submission_answers`
     in a transaction (delete-then-insert).
  8. Because there was no session: `issueMagicLink` writes a `magic_link_tokens` row (hash
     only), `sendMail(magicLinkMail(...))`, then `startSession(speaker.id)` writes an
     `auth_sessions` row and sets the `sb_session` cookie. **The anonymous visitor is signed in
     by the act of submitting.**
  9. `sendAndLog(submissionReceivedMail(...))` writes `email_log` with `kind =
     'submission_received'`; `alertOrganizers` mails every `user_roles.role = 'organizer'` with
     `kind = 'submission_alert'`, wrapped in try/catch so a mail failure never surfaces.
  10. `redirect('/speaker?submitted=1')`.
- **Error and refusal paths:** returned as `{ error }` and rendered in a `<Notice tone="bad">`:
  - "Enter a valid email address"
  - "Tell us your name"
  - "Give the talk a title" (min 6)
  - "Abstracts under 120 characters are too thin to review"
  - "A poster submission needs a link to the poster artwork."
  - "The call for papers is closed." (re-checked server-side)
  - The first custom-question error, e.g. `"<prompt>" is required.`, `"<value>" is not one of the
    choices for "<prompt>".`, `"<prompt>" needs a full http:// or https:// address.`,
    `"<prompt>" is not a yes or no.`, `"<prompt>" is too long.`
  - Fallback: "Check the form and try again."
- **Ends:** one `submissions` row at `'submitted'`, one `users` row with the `speaker` role, an
  open session, two or more `email_log` rows.

##### REV-21. Find the call for papers closed
- **Role:** anonymous visitor
- **Route:** `/cfp`
- **Precondition:** now is outside `[events.cfp_opens_at, events.cfp_closes_at]`.
- **Steps:** `src/app/cfp/page.tsx:16` returns a `PageHeader` reading `Call for papers`, a
  `<Notice>` reading `The call closed on ${dayLabel(event.cfpClosesAt, event.timezone)}.`, and a
  secondary `See the agenda` button. The form is not rendered.
- **Error and refusal paths:** a replayed POST is refused by the same check inside
  `submitProposal`, returning `{ error: 'The call for papers is closed.' }`.
- **Ends:** no write.

##### REV-22. Browse the published agenda
- **Role:** anonymous visitor
- **Route:** `/agenda`
- **Precondition:** `events.agenda_published = true`.
- **Steps:**
  1. `AgendaPage` (`src/app/agenda/page.tsx:22`) parses filters, loads the event and
     `currentUser()` (null), sets `isOrganizer = false`.
  2. Publish gate at line 32 passes.
  3. `agendaSlots(filters, event.timezone, null)` (`src/lib/agenda-filters.ts:146`) runs. The
     session leg is pinned to `eq(submissions.status, 'accepted')` — comment: "Only accepted
     work is public. A submission placed and later withdrawn would otherwise keep its slot on
     the published agenda." With no content filter set, the WHERE is
     `or(sessionLeg, blockLeg)` where `blockLeg = slots.submission_id IS NULL AND slots.label IS
     NOT NULL`, so named breaks render alongside talks.
  4. `bookmarkedByMe` is `sql\`false\`` for a null viewer; `bookmarkCount` is still a real count
     over `bookmarks`, so **the star count on each card is public.**
  5. Entries are grouped by `dayKey` then `timeOfDay`, both in `events.timezone`. A day whose
     buckets hold no sessions is filtered out — "A day that only contains a break is not a day
     worth a heading."
  6. Break blocks render as `data-testid="block-${label}"`, with the room name appended only
     when the block covers exactly one room.
  7. Each session card links to `/agenda/${entry.submissionId}`, shows
     `speakerName ?? 'Speaker to be confirmed'` · room, badges for `tracks.name` and
     `FORMAT_LABELS[format]`, and a left border in `tracks.colour` (fallback `#cbd5e1`).
  8. A `StarButton` renders on every card — for an anonymous visitor it is a `<Link href="/login">`
     with `title="Sign in to build your own agenda"`, a `☆`, a screen-reader label *"Sign in to
     star this"*, and the public count.
- **Error and refusal paths:** none; an empty result renders `<Empty>Nothing scheduled yet.</Empty>`.
- **Ends:** no write.

##### REV-23. Hit the agenda before it is published
- **Role:** anonymous visitor
- **Route:** `/agenda`
- **Precondition:** `events.agenda_published = false`.
- **Steps:** `src/app/agenda/page.tsx:32` returns the header plus
  `<Notice>The programme is not published yet. It appears here as soon as the organizers are
  happy with it.</Notice>`. No filter bar, no ICS links, no cards. An organizer instead sees the
  full page with an extra `<Notice>Unpublished. Only organizers can see this.</Notice>`.
- **Ends:** no write.

##### REV-24. Filter the agenda, including the day filter
- **Role:** anonymous visitor
- **Route:** `/agenda?...`
- **Precondition:** agenda published.
- **Steps:**
  1. `AgendaFilterBar` (`src/app/agenda/AgendaFilters.tsx`) is a plain `method="get"
     action="/agenda"` form — "the URL is the filter".
  2. Controls: `data-testid="agenda-search"` (`name="q"`), Day (`name="day"`), Track
     (`name="track"`), Room (`name="room"`), Format (`name="format"`), Level (`name="level"`),
     and `data-testid="agenda-filter-apply"`.
  3. Day options come from `agendaDays(timezone)` (`src/lib/agenda-filters.ts:241`), which
     distinct-selects `slots.starts_at` and buckets by `dayKey`. Option value is the
     `YYYY-MM-DD` key, label is `dayLabel`.
  4. `parseAgendaFilters` (line 67) validates: `track`/`room` against a UUID regex, `day`
     against `/^\d{4}-\d{2}-\d{2}$/`, `format` against `submissionFormatEnum.enumValues`,
     `level` against `audienceLevelEnum.enumValues`, `q` truncated to 120 chars, `mine` true
     only when `view === 'mine'`.
  5. The day filter is applied in SQL as
     `to_char(slots.starts_at at time zone ${timezone}::text, 'YYYY-MM-DD') = ${filters.day}` —
     "The day an attendee means is the day in the event's timezone, which is not the day the
     instant falls on in UTC for anything after early evening."
  6. `dayKey` (`src/lib/format.ts`) formats with `en-CA` rather than the module's usual `en-GB`,
     and the comment records the bug that forced it: under `en-GB` the key formatted as
     `06/11/2026`, so "every day the filter offered was thrown away on arrival and the agenda
     came back unfiltered."
  7. Content filters (`track`, `format`, `level`, `q`, `mine`) set `narrowedByContent`, which
     **drops break blocks** — "someone narrowing to one track wants that track, not lunch".
     `room` and `day` are filters on the timeline and keep the blocks.
  8. `q` is matched with `ilike` against `submissions.title` OR `submissions.abstract`, escaped
     by `likePattern` so a literal `%` or `_` typed by an attendee means that character.
  9. A `Clear` link appears when `hasActiveFilters`; `data-testid="view-all"` and
     `data-testid="view-mine"` toggle `?view=mine`; a `${matchCount} session(s)` counter renders.
- **Error and refusal paths:** none that show. Everything malformed is silently discarded — REV-25.
- **Ends:** no write.

##### REV-25. Send a malformed filter
- **Role:** anonymous visitor
- **Route:** `/agenda?track=banana`, `/agenda?day=13/11/2026`, `/agenda?format=keynote`, etc.
- **Steps:** `parseAgendaFilters` returns null for that key and **the agenda renders
  unfiltered**. There is no 400 and no message. The docstring is explicit: "A hand-edited
  `?track=banana` has to render an unfiltered agenda: a junk uuid reaching a `uuid` column is a
  Postgres error, not a 400 worth showing an attendee."
- **Consequence to note:** a visitor who mistypes a filter gets the whole programme back with the
  filter bar showing `Any track`, and nothing says the parameter was dropped.
- **Same behaviour** in `/agenda/filtered.ics`, `/embed/agenda.json` and `/embed/agenda`, all of
  which call `parseAgendaFilters` on the raw query string.
- **Ends:** no write.

##### REV-26. Ask for "My agenda" while signed out
- **Role:** anonymous visitor
- **Route:** `/agenda?view=mine`
- **Steps:**
  1. `filters.mine` is true, `viewerId` is null.
  2. `agenda-filters.ts:176-187` pushes `sql\`false\`` into the session leg — "A signed-out
     visitor asking for 'my agenda' has an empty one, not everyone's."
  3. `sessionCount === 0`, so the empty state renders the signed-out variant: a `/login` link
     reading `Sign in`, then *" to star talks and build your own agenda."*
  4. The `data-testid="export-mine"` link is not rendered (`signedIn` false).
- **Ends:** no write.

##### REV-27. Subscribe to the calendar feeds
- **Role:** anonymous visitor
- **Routes:** `/agenda/calendar.ics`, `/agenda/filtered.ics`, `/agenda/my.ics`
- **Precondition:** agenda published (for the first two).
- **Steps:**
  1. The filter bar renders `Whole programme` → `/agenda/calendar.ics`, and, when narrowed or in
     "mine", `data-testid="export-filtered"` → `/agenda/filtered.ics?<same query string>`.
  2. `calendar.ics` (`src/app/agenda/calendar.ics/route.ts`) checks
     `!event.agendaPublished && !isOrganizer` → `new Response('Not found', { status: 404 })`.
     Otherwise `agendaSlots(EMPTY_FILTERS, tz, user?.id ?? null)` →
     `buildCalendar(entries, { calendarName: event.name })` → `calendarResponse(..., 'agenda.ics')`.
  3. `filtered.ics` does the same after `parseAgendaFilters` on the request URL, naming the
     calendar `${event.name} (filtered)` and the file `agenda-filtered.ics`.
  4. `calendarResponse` (`src/lib/ics.ts:222`) sets `content-type: text/calendar; charset=utf-8`,
     `content-disposition: attachment; filename="..."` and `cache-control: no-store`.
  5. `buildCalendar` emits `METHOD:PUBLISH`, and each VEVENT's `UID` is
     `${submissionId}@saas-killa` so a re-import updates rather than duplicates. Break
     blocks collapse on (start, end, label) and keep a `LOCATION` only when genuinely in one room.
     `DESCRIPTION` carries `speakerName`, then track/format, then the abstract.
- **Error and refusal paths:**
  - Unpublished agenda, anonymous → **404** `Not found` on both.
  - `/agenda/my.ics` with no session → **401** with the body `Sign in to export your agenda`.
    The docstring gives the reason for 401 over 404: "the file exists and the caller is simply
    not anyone yet." That is the one place in the app where the two are deliberately split;
    `/files/<id>` deliberately merges them.
- **Ends:** no write.

##### REV-28. Open one session's detail page
- **Role:** anonymous visitor
- **Route:** `/agenda/[id]`
- **Precondition:** `events.agenda_published = true` AND `submissions.status = 'accepted'`.
- **Steps:**
  1. `SubmissionDetailPage` (`src/app/agenda/[id]/page.tsx:11`) selects the submission with
     `innerJoin(users)` for `speakerName` and `speakerBio`, left joins `tracks`, `slots`,
     `rooms`, and a correlated subquery counting `bookmarks` for `bookmarkCount`.
  2. Header title is the title; description is
     `${dayLabel} at ${timeOfDay} · ${roomName}${roomCapacity ? ' · seats N' : ''}` or the
     literal `Not scheduled yet`.
  3. A `StarButton` in the header action (login link when anonymous).
  4. Badges: `FORMAT_LABELS[format]`, `LEVEL_LABELS[audienceLevel]`, the track name, and one
     `good`-tone badge per `awards.name` where `awards.winner_submission_id = row.id`.
  5. The abstract renders in a card.
  6. `submissions.poster_url` renders as an `<img>` when present — **note this is not gated by
     `posterGalleryGate`**, so a poster image is visible here whenever the agenda is published
     and the submission is accepted, even while `/posters` is embargoed.
  7. Speaker card: `users.name` as the heading, `users.bio` or `No bio provided.`
  8. Materials card gated by `showMaterial` (line 81): a field shows when it is non-empty AND
     `submissions.content_status` is `'approved'` or `'draft'`. `'pending'` hides everything.
     The `'draft'` leg is deliberate: "every seeded row is 'draft' with materials already on it,
     and those must not vanish the day moderation ships." Renders `Slides` and `Recording`
     buttons and the `resourcesNote` text.
- **Error and refusal paths:** all three are `notFound()`, i.e. a plain 404 with no distinction:
  - `if (!row) notFound();`
  - `if (row.status !== 'accepted' && !isOrganizer) notFound();`
  - `if (!event.agendaPublished && !isOrganizer) notFound();`
  The comment: "A detail page for a rejected or still-under-review proposal would leak a
  decision that has not been announced."
- **Ends:** no write.

##### REV-29. Browse the public speaker directory
- **Role:** anonymous visitor
- **Route:** `/speakers`
- **Precondition:** `events.agenda_published = true`.
- **Steps:**
  1. `SpeakerDirectoryPage` (`src/app/speakers/page.tsx:21`) reads `q` and `track` from the
     query string, loads the event and `currentUser()` (null).
  2. Publish gate at line 33 → otherwise `<Notice>The speaker directory opens when the programme
     is published.</Notice>`. Docstring: "'Everyone with an accepted submission' is the list of
     people who got in, so publishing it early would announce the committee's decisions before
     the organizers chose to."
  3. `speakerDirectory({ q, trackId })` (`src/lib/speakers.ts:288`) inner-joins `submissions` on
     `speaker_id` AND `status = 'accepted'`, so only accepted speakers appear. It aggregates
     `acceptedCount`, `trackNames` and a distinct `keywords` array.
  4. Search spans `users.name` OR (accepted `submissions.title` ilike) OR (any element of
     `submissions.keywords` ilike). Escaped by `likeTerm`.
  5. A `method="get"` form with `name="q"` (`aria-label="Search speakers"`), `name="track"`
     (`aria-label="Track"`), a `Search` button, and a `Clear` link to `/speakers` when either is
     set.
  6. Cards show the headshot (`<Headshot src={speaker.headshotUrl}>`), a link to
     `/speakers/${speaker.id}`, `${acceptedCount} in the programme`, a bio excerpt truncated to
     180 chars with an ellipsis, track badges and up to 6 keyword badges.
- **Error and refusal paths:** no match → `<Empty>No speaker matches that search.</Empty>`.
  Ordering is `coalesce(users.name, users.email)`, so an unnamed speaker sorts by email — the
  email is used as a **sort key** but is never selected into the payload.
- **Ends:** no write.

##### REV-30. Open one speaker's public page
- **Role:** anonymous visitor
- **Route:** `/speakers/[id]`
- **Precondition:** agenda published AND the account has at least one accepted submission.
- **Steps:**
  1. `SpeakerProfilePage` (`src/app/speakers/[id]/page.tsx:15`): `if (!event.agendaPublished &&
     !isOrganizer) notFound();`
  2. `speakerProfile(id)` (`src/lib/speakers.ts:368`) finds the user, then selects their
     `status = 'accepted'` submissions with track and slot. **`if (accepted.length === 0) return
     null;`** → the page 404s. Docstring: "so the route 404s rather than turning every
     registered address into a public page."
  3. Header: `users.name` or `Speaker`, description `${n} in the programme at ${event.name}`,
     and an `All speakers` link.
  4. A card with the large headshot and `users.bio` or `No bio provided.`
  5. Per accepted submission: a link to `/agenda/${id}`, the scheduled time and room or
     `Not scheduled yet`, format badge, track badge, and one badge per keyword.
- **Error and refusal paths:** both misses are `notFound()`. `users.email` is never selected.
- **Ends:** no write.

##### REV-31. Walk the poster hall
- **Role:** anonymous visitor
- **Route:** `/posters`
- **Precondition:** `posterGalleryGate(event, false)` returns `{ open: true }`, i.e.
  `events.poster_embargo_until` is null or past AND `events.agenda_published = true`.
- **Steps:**
  1. `PostersPage` (`src/app/posters/page.tsx:34`) computes the gate first.
  2. `page` = `Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1)` — a non-numeric or
     negative `?page=` silently becomes 1.
  3. `mineOnly = params.mine === '1' && Boolean(user)` — false for an anonymous visitor whatever
     the query string says.
  4. `posterGallery(filters, null)` (`src/lib/poster-queries.ts:99`) applies
     `visibilityConditions()`: `submissions.status = 'accepted'`, `submissions.format =
     'poster'`, `submissions.poster_url IS NOT NULL`, and a moderation leg of
     `content_status = 'approved'` OR (`content_status = 'draft'` AND `poster_url` not null).
     **`'pending'` is the one state that hides a poster.**
  5. Search matches `title`, `abstract` or `array_to_string(keywords, ' ')` with `ilike`.
     Note: unlike the agenda and the directory, this pattern is **not** wildcard-escaped —
     `%` typed into `data-testid="poster-search"` acts as a LIKE wildcard here.
  6. Ordering is `BOARD_ORDER` (digits of `submissions.board_number` cast to int, nulls last)
     then title, so board 2 precedes board 10.
  7. `POSTERS_PER_PAGE = 12`; `LIMIT/OFFSET` paging with `data-testid="poster-next-page"` and a
     `← Previous` link, plus `Page N of M`.
  8. Controls: `data-testid="poster-search"`, a track `<Select name="track">`, a `Filter`
     button, and a `Clear` link. `data-testid="poster-mine"` is rendered **only when signed in**.
  9. Each card is `data-testid="poster-${poster.id}"`, with `<PosterMedia variant="card">`, a
     link to `/posters/${id}`, `speakerName ?? 'Unnamed'`, a `Board N` badge, a track badge, a
     `<PosterKindBadge>` and a `<BookmarkButton>` (login link when anonymous).
  10. `PosterMedia` (`src/app/posters/PosterMedia.tsx`) renders by `classifyPosterUrl`:
      `image` → `<img>`, `pdf` → `<object type="application/pdf">` with a fallback link,
      `video` → an `<iframe>` at `videoEmbedUrl(...)` for YouTube/Vimeo or a `<video controls>`
      for a direct media file, `unknown` → a labelled link showing `posterHost(url)`.
- **Error and refusal paths:** no rows → `<Empty>` reading either *"No poster matches those
  filters."* or *"No posters in this year's programme."*
- **Ends:** no write.

##### REV-32. Hit the poster hall under embargo
- **Role:** anonymous visitor
- **Route:** `/posters` or `/posters/[id]`
- **Precondition:** `events.poster_embargo_until` is in the future.
- **Steps:** `posterGalleryGate` (`src/lib/poster.ts:148`) checks the embargo **before** the
  publish flag, "because it is the more specific control and the one with something to say".
  - Embargo → `<Notice>` with `data-testid="poster-embargo"` on `/posters`, reading
    `Posters open on ${inEventZone(gate.opensAt, tz, { dateStyle: 'long', timeStyle: 'short' })}.`
  - Unpublished, no embargo → *"The poster gallery opens when the programme is published."*
  - The detail page renders the same two notices (without the `data-testid`), and returns them
    **instead of 404** — so `/posters/<anything>` under embargo answers 200 with the notice, and
    reveals nothing about whether the id exists.
  - An organizer is never gated (`if (isOrganizer) return { open: true }`), and `/posters` shows
    them an `organizer preview` warn badge when the agenda is unpublished.
- **Ends:** no write.

##### REV-33. Open one poster full size
- **Role:** anonymous visitor
- **Route:** `/posters/[id]`
- **Precondition:** the gate is open.
- **Steps:**
  1. `posterById(id, { userId: null, includeHidden: false })` (`src/lib/poster-queries.ts:150`)
     applies the same `visibilityConditions()`. `includeHidden` is true only for an organizer.
  2. `if (!poster || !poster.posterUrl) notFound();`
  3. Byline is built from `submission_authors` joined to `users`, ordered by
     `submission_authors.position`, formatted `Name (affiliation)` and joined with ` · `. When
     there are no author rows — a CFP-filed submission has none — it falls back to the owning
     `users.name` as a single presenter.
  4. `← All posters` link, header with the `<BookmarkButton>` action, badges
     (`data-testid="poster-board"` for the board number, track, kind, one per keyword), the
     full-size `<PosterMedia variant="full">`, and the abstract.
  5. When `events.agenda_published`, a trailing link to `/agenda/${poster.id}` reading
     *"Speaker bio and materials →"*.
- **Error and refusal paths:** `notFound()` covers a hidden poster, a non-poster submission, a
  poster with no artwork, and a nonexistent id — one answer for all four.
- **Ends:** no write.

##### REV-34. Try to star or bookmark while signed out
- **Role:** anonymous visitor
- **Routes:** `/agenda`, `/agenda/[id]`, `/posters`, `/posters/[id]`
- **Steps:**
  1. `StarButton` with `signedIn={false}` renders a `<Link href="/login">` — never a form.
     Docstring: "which is the difference between an invitation and a dead end."
  2. `BookmarkButton` with `signedIn={false}` renders a `<LinkButton href="/login">` reading
     `☆ Bookmark`, `aria-label="Sign in to bookmark this poster"`. Docstring: "the star is what
     makes an account worth having, so it is never hidden."
  3. A direct POST to either `toggleBookmark` hits `const user = await currentUser(); if (!user)
     redirect('/login');` — a redirect, not a throw.
- **Notable design decision** (`src/app/agenda/actions.ts:35-39`): the action does **no status
  check** on the submission. "Refusing to star anything but an accepted talk would turn this
  action into an oracle for decisions that have not been announced. A bookmark on a row the
  agenda does not publish is inert: every read path filters to accepted anyway."
- **Ends:** no write; the visitor lands on `/login`.

##### REV-35. Read the awards page
- **Role:** anonymous visitor
- **Route:** `/awards`
- **Precondition:** at least one row in `awards`. **No publish gate, no embargo, no role check.**
- **Steps:**
  1. `AwardsPage` (`src/app/awards/page.tsx:28`) loads `searchParams`, `getEvent()`,
     `awardDetails()` and `currentUser()` (null).
  2. Header `Awards`, description `${event.name} · nominees, finalists and results`. The
     `Judge awards` action button renders only for an organizer or reviewer.
  3. When any award has `communityWindow === 'open'` and there is no session, an accent notice
     renders: *"Voting is open. Sign in to cast a ballot."* with a `/login` link.
  4. Per award, `data-testid="award-${award.id}"`:
     - Badges: `voting open`/`voting closed` from `committeeOpen`, plus the community state from
       `COMMUNITY_WINDOW_LABELS[communityWindow(award)]` — `community voting off` (suppressed:
       the `disabled` badge is not rendered), `community voting not open yet`,
       `community voting open`, `community voting window has passed`, `voting closed`.
     - When `publicVoting` and a window bound exists, a line naming the open and close times in
       `events.timezone`.
     - Winner: a `good` notice reading `Winner: ${title}` · `speakerName ?? 'Unnamed'`, plus
       `Chosen by the organizers rather than by the tally: ${awards.winner_override_reason}`
       when set. Voting closed with no winner → *"Voting has closed and no winner was declared."*
     - **Nominees section:** every `award_nominees` row, each a link to
       `/agenda/${nominee.submissionId}`, the speaker's name, a `finalist` badge and a `winner`
       badge. Count line: `${n} nominated` plus `· ${m} finalist(s)`.
     - Two `<AwardTally>`s side by side: committee with `sealed={open}`, community with no
       `sealed` prop and a `note` of *"Community voting is off for this award."* when
       `publicVoting` is false.
  5. `AwardTally` prints `Sealed until voting closes.` for the committee column while committee
     voting is open, and the full ranked list once it closes.
- **What this discloses to a signed-out visitor:** nominee titles, nominee speaker names, the
  finalist flag, the declared winner and the override reason, the **live People's Choice tally
  with per-nominee vote counts**, and the **full committee tally with weighted scores and ballot
  counts once committee voting closes**.
- **Error and refusal paths:** no awards → `<Empty>No award categories yet.</Empty>`. The
  `?vote=` messages (`src/app/awards/page.tsx:16-21`) render for anyone, though only a signed-in
  visitor can produce them: `ok` — "Your vote is in. You can change it while voting is open.";
  `closed` — "Voting for that award is not open, so nothing was recorded."; `not_nominated` —
  "That submission is not nominated for the award."; `unknown` — "That award no longer exists."
- **Ends:** no write.

##### REV-36. Try to vote in the People's Choice while signed out
- **Role:** anonymous visitor
- **Route:** `/awards`
- **Steps:**
  1. The vote form renders only when `me && publicVote === 'open'`
     (`src/app/awards/page.tsx:165`), so an anonymous visitor sees no button — only the
     *"Voting is open. Sign in to cast a ballot."* notice.
  2. A hand-posted `castCommunityVote` (`src/app/awards/actions.ts:19`) calls `requireUser()`,
     which **throws `NotAuthorised('not signed in')`**.
  3. If signed in: `communityWindow(award) !== 'open'` → `redirect('/awards?vote=closed')`;
     a submission not in `award_nominees` → `redirect('/awards?vote=not_nominated')`; unknown
     award → `redirect('/awards?vote=unknown')`; otherwise upsert into `award_votes` with
     `channel = 'community'` and `scores: null`, then `redirect('/awards?vote=ok')`.
- **Inconsistency worth naming:** `toggleBookmark` redirects an anonymous caller to `/login`;
  `castCommunityVote` throws. A replayed anonymous vote POST therefore surfaces a Next error
  boundary rather than a sign-in page.
- **Design note** (`src/app/awards/actions.ts:13-18`): "The window is enforced here, not by
  hiding the button. Hiding it is a courtesy to someone reading the page; this is the control,
  and it is what a form replayed after the deadline meets."
- **Committee vs community, in one place:** two `award_votes` rows can exist for the same person
  and award because `channel` is in the primary key `(award_id, judge_id, channel)`. `tally()`
  never sums them — "the same person may hold a committee seat and an attendee ballot, and
  adding the two would weight them twice." A community ballot is always a single unweighted
  pick: `weighted = channel === 'committee' && criteria.length > 0`.
- **Ends:** no write for an anonymous visitor.

##### REV-37. Embed the widgets with a script tag
- **Role:** anonymous visitor (a third-party website)
- **Route:** `/embed/embed.js` plus `/embed/speakers.json` or `/embed/agenda.json`
- **Precondition:** none to load; `events.agenda_published` decides what comes back.
- **Steps:**
  1. The host page carries `<div data-saas-killa="agenda"></div>` and
     `<script src="https://…/embed/embed.js" async></script>`.
  2. `GET /embed/embed.js` (`src/app/embed/embed.js/route.ts`) returns `embedScript()` with
     `content-type: text/javascript; charset=utf-8`, `access-control-allow-origin: *`,
     `access-control-allow-private-network: true`, `cache-control: public, max-age=300`.
     `OPTIONS` returns `preflightResponse()`. The comment explains why a script tag needs CORS
     at all: "Chrome preflights *any* subresource when the host page sits in a less private
     address space than the server".
  3. The script (`src/lib/embed-script.ts`) derives `ROOT` from `document.currentScript.src` by
     cutting at `/embed/embed.js`; if there is no `currentScript` or no `src`, it returns and
     does nothing.
  4. `ensureStyle()` injects `EMBED_CSS` once under `id="saas-killa-embed-css"`.
  5. `start()` runs on `DOMContentLoaded` (or immediately if the document is already parsed) and
     mounts every `[data-saas-killa]` node.
  6. `mount(node)` returns early if `data-saas-killa-state` is already set, so a node is never
     mounted twice.
  7. `feedUrl` reads `data-track`, `data-day`, `data-q`, `data-format`, `data-level`,
     `data-room` off the div (the `OPTIONS` array) and appends them, `encodeURIComponent`d.
  8. `fetch(url, { credentials: 'omit' })` — the embed never sends the session cookie.
  9. The container's `data-saas-killa-state` walks `loading` → `ready` (feed published) or
     `closed` (not published) or `error`.
  10. Nodes are built with `createElement`/`textContent`, **never `innerHTML`** — the file's
      docstring: "Speaker bios and talk titles are typed by strangers and this code runs on
      somebody else's origin."
- **Error and refusal paths:**
  - Non-2xx response → `throw new Error('HTTP ' + response.status)` → `fail(node, 'The ' + name
    + ' could not be loaded right now.', ...)`, state `error`, and a
    `console.warn('[saas-killa] ' + detail)`.
  - Network failure → the same `fail`.
- **Ends:** no write. The whole embed surface is read-only and anonymous by construction
  (`src/lib/embed.ts:29-31`: "It never reads the session cookie, so a signed-in organizer
  looking at their own widget sees exactly what a visitor sees").

##### REV-38. Use an unknown widget name
- **Role:** anonymous visitor (a third-party website)
- **Route:** `/embed/embed.js`
- **Precondition:** the host page has e.g. `<div data-saas-killa="posters"></div>`.
- **Steps:** `mount` resolves `render` as `name === 'speakers' ? renderSpeakers : name ===
  'agenda' ? renderAgenda : null`. Null → `fail(node, ...)` with the message text, verbatim:
  `Unknown Saas Killa widget "posters". Use data-saas-killa="speakers" or
  data-saas-killa="agenda".` The node's `data-saas-killa-state` becomes `error`, and the
  console gets `[saas-killa] unknown widget: posters`.
- **Empty name** (`<div data-saas-killa>`): `(node.getAttribute(...) || '').trim()` is `''`,
  which also hits the `null` branch, producing `Unknown Saas Killa widget "".`
- **No fetch is issued** in either case.
- **Ends:** no write.

##### REV-39. Read the JSON feeds directly
- **Role:** anonymous visitor
- **Routes:** `/embed/speakers.json`, `/embed/agenda.json`
- **Steps:**
  1. `GET` calls `speakerFeed(params)` or `agendaFeed(params)` (`src/lib/embed.ts:87`, `:123`)
     and wraps it in `feedResponse` — `content-type: application/json; charset=utf-8`,
     `access-control-allow-origin: *`, `access-control-allow-private-network: true`,
     `cache-control: no-store`.
  2. `OPTIONS` returns `preflightResponse()` — 204 with the same two CORS headers plus
     `access-control-allow-methods: GET, OPTIONS`, `access-control-allow-headers: content-type`,
     `access-control-max-age: 86400`.
  3. `speakerFeed` shape: `{ event: { name, timezone, url }, published, speakers: [{ id, name,
     bio, headshotUrl, url, tracks, keywords, talks }] }`. It reads `?q=` and `?track=` and
     passes them to `speakerDirectory`.
  4. `agendaFeed` shape: `{ event, published, days: [{ key, label, entries: [{ id, title, url,
     startsAt, endsAt, time, room, track, trackColour, format, speaker }] }] }`. It forces
     `mine: false` — "there is no session on a cross-origin fetch, so it would silently return
     nothing." A named break arrives with `id: null` and `url: null`, and duplicates across
     rooms collapse on `(start, end, label)`, keeping `room` only when it really is one room.
  5. `event.url` and every entry `url` are absolute, built from `env().APP_URL`.
- **CORS rationale, verbatim** (`src/lib/embed.ts:369-376`): "`*` rather than an allowlist
  because the whole point is that we do not know the host page's origin, and the payload is
  read-only, anonymous and already public." The private-network header is for "a conference site
  embedding a widget served from inside the venue's network."
- **Error and refusal paths:** malformed filters are dropped by `parseAgendaFilters` (REV-25); a
  bad `?track=` returns the full feed with HTTP 200.
- **Ends:** no write.

##### REV-40. Embed the widgets in an iframe
- **Role:** anonymous visitor (a third-party website)
- **Routes:** `/embed/speakers`, `/embed/agenda`
- **Steps:**
  1. `GET` reads the query string, builds the same feed, and returns
     `embedDocument(title, renderSpeakersHtml(feed))` or `renderAgendaHtml(feed)`.
  2. `embedDocument` (`src/lib/embed.ts:341`) emits a full `<!doctype html>` with `EMBED_CSS`
     inline, `cache-control: no-store`, and a four-line script that posts
     `{ saasKillaHeight: document.documentElement.scrollHeight }` to `parent` on load and on
     every `ResizeObserver` tick, because "`height: auto` is not a thing an iframe does".
  3. Every interpolated value goes through `esc()` (`src/lib/embed.ts:238`), which escapes
     `&`, `<`, `>`, `"` and `'`. That includes `entry.trackColour`, which lands inside a
     `style="background:…"` attribute.
  4. Titles are `<h3 class="sb-day">`, entries `<li class="sb-item">`, breaks get the extra
     `sb-break` class, and every link is `target="_blank" rel="noopener"`.
  5. `renderSpeakersHtml` and the script's `renderSpeakers` are two renderers of one design,
     kept aligned by sharing `EMBED_CSS` and the class names — "the script must construct nodes
     … while the route must emit a string."
- **Note:** neither iframe route sets `access-control-allow-origin` and neither needs to; a
  document loaded into an iframe is not a CORS fetch. There is also **no
  `X-Frame-Options`/`frame-ancestors` header anywhere in the app**, which is what makes these
  embeddable — and equally makes every other page framable.
- **Ends:** no write.

##### REV-41. Look at the embed demo page
- **Role:** anonymous visitor
- **Route:** `/embed/demo`
- **Steps:** `GET` (`src/app/embed/demo/route.ts`) returns a hand-written HTML document, its own
  serif font and colours, titled `Embed preview · ${event.name}`, containing an `<h1>` with the
  event name, an `Our speakers` heading over `<div data-saas-killa="speakers">`, a
  `The schedule` heading over `<div data-saas-killa="agenda">`, and a script tag pointing at
  `${env().APP_URL}/embed/embed.js`. `cache-control: no-store`.
- **Purpose:** "The organizer opens it to see what the snippet on `/organizer/embed` will do
  before they paste it into their CMS, and `e2e/embed.spec.ts` drives it."
- **Refusal paths:** none. It is fully anonymous, and it discloses `events.name` and
  `env().APP_URL`.
- **Ends:** no write.

##### REV-42. Hit any embed surface before the agenda is published
- **Role:** anonymous visitor
- **Routes:** all six embed routes
- **Precondition:** `events.agenda_published = false`.
- **Steps:**
  1. `speakerFeed` returns `{ event: meta, published: false, speakers: [] }` and `agendaFeed`
     returns `{ event: meta, published: false, days: [] }`. **HTTP 200, not 404.** The reason
     (`src/lib/embed.ts:82-86`): "a widget already pasted into a host page has to say something
     honest on the morning before publication, and a broken request in the host's console reads
     as our fault."
  2. `renderSpeakersHtml` emits `The speaker line-up for ${event.name} is not published yet.`
     inside `<p class="sb-note">`; `renderAgendaHtml` emits
     `The schedule for ${event.name} is not published yet.`
  3. The script's `renderSpeakers`/`renderAgenda` produce the same two sentences as text nodes,
     and `mount` sets `data-saas-killa-state="closed"`.
  4. Published but nothing matching the filter → `No speaker matches that filter.` /
     `Nothing scheduled matches that filter.`, and the state is `ready`, not `closed`.
- **Note:** the event **name** is disclosed by every embed route regardless of publication
  state, as is `event.timezone` and the app's own URL.
- **Ends:** no write.

##### REV-43. Sign in
- **Role:** anonymous visitor
- **Route:** `/login`
- **Steps:**
  1. `LoginPage` (`src/app/login/page.tsx`) is a client component using `useActionState`.
     Header: `Sign in`, description *"We email you a link. There is no password to remember or
     lose."*
  2. One field, `data-testid="login-email"`, `type="email"`, `required`,
     `autoComplete="email"`, placeholder `you@example.com`.
  3. Submit is `data-testid="login-submit"`, labelled `Email me a link` and `Sending…` while
     pending (`disabled={pending}`).
  4. `requestMagicLink` (`src/app/login/actions.ts:19`): zod-validates the address, calls
     `getEvent()`, `upsertUserByEmail(email)` — **which creates the account if it does not
     exist, and grants `speaker`** — then `issueMagicLink(user.id)` and
     `sendMail(magicLinkMail(...))`.
  5. Success renders a `good` notice containing `data-testid="magic-link-sent"`:
     `If ${email} is a valid address, a sign-in link is on its way. It works once and expires in
     15 minutes.`
- **Error and refusal paths:**
  - Invalid address → `<Notice tone="bad">` with `Enter a valid email address`.
  - **Never "no such user."** Docstring: "Reporting 'no such user' would turn the login form
    into an oracle for who has submitted to this conference." The success text is deliberately
    conditional ("If … is a valid address").
  - `?error=missing` and `?error=expired` are set by `/auth/verify` but **`LoginPage` never reads
    `searchParams`**, so neither is displayed. A visitor who clicks an expired link lands on a
    clean sign-in form with no explanation.
- **Ends:** a `users` row may be created, a `user_roles` row `speaker` may be created, and one
  `magic_link_tokens` row is written holding only `sha256(token)`, `expires_at` 15 minutes out.

##### REV-44. Redeem a magic link
- **Role:** anonymous visitor holding a token
- **Route:** `/auth/verify?token=…`
- **Steps:**
  1. `GET` (`src/app/auth/verify/route.ts`) reads `token`; missing →
     `NextResponse.redirect('/login?error=missing')`.
  2. `consumeMagicLink(token)` updates `magic_link_tokens` setting `consumed_at = now()` where
     `token_hash = sha256(token) AND consumed_at IS NULL AND expires_at > now()`, returning the
     row. Conditional on `consumed_at IS NULL`, so "two concurrent redemptions of the same link
     race on the row and exactly one wins."
  3. No row → `redirect('/login?error=expired')`.
  4. `startSession(user.id)` inserts into `auth_sessions` and sets the `sb_session` cookie to
     `${session.id}.${hmac}`, `httpOnly`, `sameSite: 'lax'`, `secure` in production, path `/`,
     expiring in 30 days.
  5. `redirect('/speaker')` — a reviewer signing in lands on the speaker portal, not `/review`.
- **Design note:** GET is used deliberately for a state change "because the link arrives by
  email and email clients only issue GETs. The token is single use, so a scanner that prefetches
  the link burns it and the user simply asks for another rather than gaining access."
- **Cookie verification** on every subsequent request (`currentUser()`): split at the **last**
  dot, constant-time HMAC compare via `timingSafeEqual` after a length check, then the
  `auth_sessions` row must exist and not be expired.
- **Ends:** one `magic_link_tokens` row consumed, one `auth_sessions` row created, cookie set.

##### REV-45. Read an uploaded file
- **Role:** anonymous visitor
- **Route:** `/files/<uuid>/<name>`
- **Steps:**
  1. `GET` (`src/app/files/[...path]/route.ts`) takes `path[0]` and requires it to match the
     UUID regex; anything else is `notFound()`.
  2. `currentUser()` (null), then `readableUpload(id, null)` (`src/lib/uploads.ts:316`).
  3. For an anonymous viewer the rules reduce to: `uploads.kind = 'headshot'` → **always
     readable**; `slides` → readable when `submissions.status = 'accepted'` AND
     `submissions.content_status = 'approved'`; `poster` → readable when accepted AND
     `posterGalleryGate(event, false).open`; `document` → **never**.
  4. Response carries the sniffed `uploads.content_type`, `x-content-type-options: nosniff`,
     `content-disposition: inline; filename="${uploads.filename}"`, and `cache-control:
     public, max-age=60` for a headshot or `private, no-store, max-age=0` otherwise.
- **Error and refusal paths:** every miss — bad uuid, no row, not permitted, bytes missing from
  disk — returns the same `404 Not found` plain-text response. Deliberate: "Splitting them into
  404 and 403 would let an anonymous prober walk the id space and learn which documents exist."
- **Ends:** no write.

---

### Things reachable signed out that I think should not be

Ranked. Only the first is, in my reading, a real disclosure bug rather than a judgement call.

##### 1. `/awards` announces acceptances before the agenda is published

`src/app/awards/page.tsx` has **no `events.agenda_published` gate and no role check**. Every
other public read of accepted work has one:

| route | gate |
|---|---|
| `/agenda` | `!event.agendaPublished && !isOrganizer` → notice |
| `/agenda/[id]` | `notFound()` on unpublished **and** on `status !== 'accepted'` |
| `/speakers` | `!event.agendaPublished && !isOrganizer` → notice |
| `/speakers/[id]` | `notFound()` |
| `/posters`, `/posters/[id]` | `posterGalleryGate` |
| `/embed/*` | `published: false`, empty payload |
| `/agenda/*.ics` | 404 |
| **`/awards`** | **none** |

`nominatableSubmissions()` (`src/lib/awards.ts:298`) restricts nomination to
`submissions.status = 'accepted'`, and `awardDetails()` inner-joins `submissions` and `users` to
select `title` and `speakerName`. So while the agenda is unpublished, an anonymous visitor
reading `/awards` gets nominee titles paired with speaker names — which is precisely the list of
who got in. `/agenda/{id}` 404s, but the title and the name are already printed on `/awards`.

`AwardDetail`'s own docstring (`src/lib/awards.ts:38-41`) says "No speaker email: this payload
reaches the public page" — the payload was audited for `users.email`, and `users.name` was kept
on purpose for the winner line. The gap is the *publication timing*, not the column choice.

Whether this matters depends on whether an organizer can create an award and nominate before
publishing. Nothing in the code prevents it. **I did not verify against the live database
whether any award currently has nominees while `events.agenda_published` is false** — that would
have meant reading the running Postgres, which was out of scope for this pass.

##### 2. The live People's Choice tally is never sealed

`src/app/awards/page.tsx:195` renders the community `<AwardTally>` with **no `sealed` prop**,
while the committee one gets `sealed={open}`. So while community voting is open, an anonymous
visitor sees the running vote counts per nominee, ranked. `AwardTally`'s docstring gives the
reason sealing exists at all: "A live committee tally tells judges how their colleagues voted
before they have voted themselves." The same bandwagon argument applies to a public vote, and
the code makes the opposite choice for the two channels without saying why. This reads as
deliberate (a People's Choice leaderboard is a normal thing to publish) but the asymmetry is
undocumented.

##### 3. `/embed/demo` is a production route

`src/app/embed/demo/route.ts` serves a fake conference website to anyone, unauthenticated, no
`noindex`. It discloses `events.name` and `env().APP_URL`. Harmless content, but it is a
developer/organizer preview tool sitting on a public URL with nothing marking it as such — the
docstring says the organizer opens it from `/organizer/embed`, which is behind the organizer
layout, but the demo route itself is not.

##### 4. Headshot bytes are public with no publication gate

`readableUpload` (`src/lib/uploads.ts:322`) returns any `kind = 'headshot'` row to anyone,
before the `submissionId` lookup and therefore before any status or publication check. Its
comment justifies it as "public. It is already on the public speaker gallery" — but the gallery
is gated on `events.agenda_published` and this is not. An anonymous visitor holding an upload
uuid can fetch a headshot while `/speakers` still says the directory is closed. Low severity:
uuids are not enumerable and a headshot is not sensitive. Flagging it because the stated
justification does not actually hold in the unpublished window.

##### 5. A poster image renders on `/agenda/[id]` outside the poster gate

`src/app/agenda/[id]/page.tsx:124` renders `submissions.poster_url` in an `<img>` with no
`posterGalleryGate` check. So while `/posters` correctly answers *"Posters open on <date>"*
under embargo, the same artwork is visible on the session detail page for any accepted poster
once the agenda is published. `readableUpload` **does** apply the gate for an uploaded poster
(`src/lib/uploads.ts:342-345`), so this only bites when `poster_url` points at an external host
rather than `/files/`. Given the embargo is described as a journal embargo, the split is worth
an organizer knowing about.

---

### Two reviewer-side gaps that are not public-facing but are real

**Every domain refusal in `submitReview` is silent.** `src/app/review/actions.ts` lines 45, 48
and 54 each `return` with no message, no redirect and no `revalidatePath`. Self-review, grading
a decided submission and grading with no open round all present identically to the reviewer: the
button appears to work and nothing changes. Compare `castCommitteeVote` in the same feature
area, which redirects to `?ballot=closed` / `?ballot=not_nominated` / `?ballot=incomplete` /
`?ballot=unknown` and renders a specific sentence for each. The award action has a refusal
vocabulary; the review action has none.

**The fallback queue shows a reviewer their own proposal.** `openSubmissionQueue`
(`src/lib/grading.ts:188`) selects every `status = 'submitted'` row with no self-exclusion,
while `planAssignments` (`src/lib/grading.ts:451-458`) does exclude
`reviewer.id === submission.speakerId` when distributing. So a committee that has not run the
distributor hands every reviewer-who-also-submitted a card for their own abstract with a live
`Grade` button that silently discards the grade. Combined with the point above, that is the
worst instance of the silent refusal: the one card most likely to be pressed is the one whose
refusal says nothing.
