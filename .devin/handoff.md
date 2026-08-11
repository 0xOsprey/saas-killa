# Devin handoff — Phase 3

## Current state

- **Branch:** `main`
- **Remote:** `origin/main` is at `a10b934` (`docs: commit the phase 2 UX handoff.`)
- **Local status:** clean, no uncommitted changes
- **Live instance:** `https://saas-killa.0xosprey.com/` returning `200`
- **Build/typecheck:** `pnpm typecheck` and `pnpm build` pass
- **Services:** `saas-killa.service` and `saas-killa-tunnel.service` running

## What was done in the previous session

All six Phase 2 focus areas were addressed:

1. **Empty states with no CTA** — Linked `Empty` blocks to the form/page that creates the first item across rooms, awards, CFP, contacts, rounds, abstracts, posters, integrations, evaluators, speaker content/posters/availability, wiki pages, files, email, abstract book, and round list.
2. **Disabled controls with no explanation** — Added `title` tooltips to disabled buttons/selects in run panel, schedule, CFP, awards, submissions, speaker content, rooms, questions, import, compose, files, availability, profile, login, abstracts, speakers, and CFP form.
3. **Notices that describe but do not offer a solution** — Added `.env.local` hints to config notices (email, AI evaluator) and linked the CFP “Nothing is being graded” notice to the open-round form.
4. **Horizontal scrolling without visual cues** — Added scroll hints to pipeline, schedule grid/week view, contacts table, files library, and import preview.
5. **Status badges that are not actionable** — Submission status and content-status badges now link to the matching filter on the submissions board.
6. **Missing empty filters / bulk actions** — Empty filtered states on contacts and speakers now offer a clear-filters link.

Phase 2 was pushed to `origin/main`.

## Phase 3 goal

Finish the two items deliberately left out of Phase 1:

1. **Email log “not sent” badge retry action**
2. **Onboarding bulk unconfirmed/overdue reminder buttons**

Apply the same rule as Phase 2: the status/object itself should carry the action where possible.

## 1. Email log “not sent” retry action

### Context

- `src/app/organizer/email/page.tsx` renders the email history.
- Each row has a badge: `<Badge tone={row.delivered ? 'good' : 'warn'}>{row.delivered ? 'delivered' : 'not sent'}</Badge>`.
- `src/lib/email.ts` has `sendAndLog`, `sendMail`, and `recentEmails`.
- The `email_log` table stores: `id`, `userId`, `submissionId`, `kind`, `subject`, `delivered`, `sentAt`. It does **not** store the rendered body.

### Approaches to consider

- **Option A (store the body):** Add a `body` or `mailJson` column to `email_log` (Drizzle schema in `src/db/schema.ts`) and persist the rendered `Mail` at send time. A retry is then `log.delivered = true` after calling `sendMail(JSON.parse(log.mailJson))`.
- **Option B (re-render from context):** Use `kind` + `userId` + `submissionId` to reconstruct the same `Mail` with the existing template helpers. This works for some kinds (task reminders, decisions, schedule notices) but is harder for one-off `ComposeForm` announcements; for those the body must have been stored.

### Minimum next step

1. Inspect `src/db/schema.ts` (`emailLog` table) and decide whether to add a stored body.
2. Add a server action in `src/app/organizer/email/actions.ts` (create it if missing) that takes `emailLog.id`, rebuilds or replays the email, calls `sendAndLog` or updates the existing row, and revalidates `/organizer/email`.
3. Wrap the `not sent` badge (or the whole row) in a form that posts that `id`.
4. Add a `title` and possibly a confirmation for retries that mutate decision/schedule state.

## 2. Onboarding bulk unconfirmed/overdue reminder buttons

### Context

- `src/app/organizer/onboarding/page.tsx` shows the dashboard.
- `src/app/organizer/speakers/actions.ts` has `sendTaskRemindersAction` and `src/app/organizer/speakers/mail.ts` has `taskReminderMail`.
- `src/lib/onboarding.ts` returns `view.unconfirmed` and `view.overduePeople`.
- `unconfirmed` = accepted speakers who have not confirmed or declined. This is **not** a task, so `sendTaskRemindersAction` will not chase them.

### Approaches to consider

- **Overdue:** Add a `<ReminderForm filter="overdue" ... />` to the onboarding page (or a dedicated form) that reuses `sendTaskRemindersAction`. This already chases overdue tasks.
- **Unconfirmed:** This needs a new action because it is not task-based:
  - Add `confirmationReminderMail` to `src/app/organizer/speakers/mail.ts` (or a new `src/app/organizer/onboarding/mail.ts`).
  - Add `sendConfirmationRemindersAction` in `src/app/organizer/onboarding/actions.ts` (or `src/app/organizer/speakers/actions.ts`). It should collect accepted-but-unconfirmed speakers, dedupe by speaker with a cooldown, send the mail, and update an idempotency timestamp if desired.
  - Add the form buttons on `src/app/organizer/onboarding/page.tsx`.

### Minimum next step

1. Reuse the existing `ReminderForm` for the **overdue** tile on onboarding.
2. For **unconfirmed**, design the confirmation-reminder email, write the action, and add a button near the “confirmed to attend” card.

## Useful commands

```bash
pnpm typecheck
pnpm build
pnpm test           # Playwright; resets auth_sessions in globalSetup
pnpm db:reset       # if you need a clean seed
systemctl --user restart saas-killa.service saas-killa-tunnel.service
curl -s -o /dev/null -w "%{http_code}" https://saas-killa.0xosprey.com/
```

## Suggested process

1. Pick one of the two features and fully spec it before writing code.
2. Run `pnpm typecheck` and `pnpm build` after each meaningful change.
3. Commit with the same style: `feat(area): ...`, `Generated with [Devin](https://devin.ai)`, and `Co-Authored-By:`.
4. Push to `origin/main` when done.
