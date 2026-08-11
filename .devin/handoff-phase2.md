# Phase 2 UX Handoff

## Project context

- Repo: `/home/osprey/NanoClaw/projects/saas-killa`
- Service: `saas-killa.service` (user systemd) + `saas-killa-tunnel.service`
- Verify live: `curl -s -o /dev/null -w "%{http_code}" https://saas-killa.0xosprey.com/`
- Build: `pnpm build`
- Typecheck: `pnpm typecheck`
- Restart: `systemctl --user restart saas-killa.service saas-killa-tunnel.service`

## What Phase 1 already did (do not repeat)

Phase 1 converted dead-end status cues into inline actions:

- Submissions board: "not notified" sends that row's decision email; "not scheduled" accepted talks link to `/organizer/schedule`; content-pending notice has "Review pending" link.
- CFP: "Nobody assigned" pre-fills the manual assignment form.
- Schedule: placement warnings (withdrawn/declined/unavailable/too-small) have per-row "Clear slot"; conflict badges in reading views link back to the grid.
- Speakers: roster badges (bio/headshot/not confirmed/declined) link to the speaker page; "overdue" is a per-speaker "Remind" button.
- Posters: "no artwork" links to the speaker page.
- Abstracts: "unedited" links to the edit form.
- Evaluators: disabled run panel explains why.
- Review: "ungraded" badge links to the grade form.
- Contacts: "unconfirmed" badge links to the speaker page.
- Rounds: empty reviewer pool has an "Add one" link to the form.

These two Phase 1 items are intentionally out of scope for this handoff:
- Email log "not sent" badge retry action
- Onboarding bulk unconfirmed/overdue reminder buttons

## Phase 2 goal

Fix the remaining UX-audit issues by applying the same rule: every status, warning, or empty state that describes a problem should also surface the next action. Prefer making the status object itself clickable. Only add a separate button when the object cannot carry the action.

Focus areas for Phase 2 (search the codebase for these patterns):

1. **Empty states with no call to action**
   - Any `Empty` component that says "Nothing..." or "No..." without telling the user how to create the first one.
   - Examples: empty track/room/stage lists, empty pages, empty tables.

2. **Disabled controls with no explanation**
   - Buttons, selects, or form fields that are `disabled` without a hint or nearby notice explaining why.
   - Examples: disabled bulk action buttons, disabled save buttons, disabled run controls.

3. **Notices that describe but do not offer a solution**
   - `Notice`/`tone` banners that explain a problem but do not contain a link or form to fix it.

4. **Horizontal scrolling without visual cues**
   - Containers with `overflow-x-auto` that have no fade, shadow, or hint that more content is off-screen.

5. **Status badges that are not actionable**
   - Any remaining badge that communicates a state the user can change but is not a link/button.

6. **Missing "empty" filters / bulk actions**
   - Lists where an empty filtered view does not offer to clear the filter or add a matching item.

## How to proceed

1. Run `git log --oneline -20` and `git status` to orient.
2. Search for `Empty`, `disabled=`, `Notice`, `overflow-x-auto`, and `Badge` across `src/app/organizer` and `src/app/speaker`.
3. For each issue, pick the smallest change that makes the object actionable:
   - If the control/object can carry the action, make it a link or button (e.g. a badge that links to the page where the action lives).
   - If it cannot, add a link or button immediately next to the status.
   - For disabled controls, add a `title`, hint, or `Notice` explaining the condition.
4. After each change: typecheck, build, restart the services, verify 200, and commit.
5. Keep the same commit style as Phase 1: concise `feat(area): ...` messages, `Generated with [Devin](https://devin.ai)` and Co-Authored-By line.
6. Update a todo list as you go. Stop if you hit a decision that is not obvious and ask the user.

## Starting point

Branch: `main` (all Phase 1 commits are already pushed/committed locally; do not push unless asked).
Current todo list state in this conversation:
- Email and Onboarding Phase 1 items are intentionally left undone.
- Phase 2 begins with the focus areas above.
