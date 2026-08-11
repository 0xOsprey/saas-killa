# Pre-push checklist for `main`

Run through this before every push to `origin/main`.

## 1. No secrets or local config in the diff

- [ ] `git diff --name-only` shows no `.env*`, `.mail/`, `.auth/`, `CLAUDE.local.md`, `uploads/`.
- [ ] `git status --short` has no untracked local files you did not mean to commit.
- [ ] No hostnames, IPs, ports, or operational details in comments beyond `127.0.0.1` (local dev) and `localhost`.
- [ ] No public deployment domain, personal project codenames, or machine-specific paths in the diff.

Quick scan (the concrete grep patterns live in `CLAUDE.local.md`, which is gitignored):

- [ ] No `.env*`, `.mail/`, `.auth/`, `CLAUDE.local.md`, or `uploads/` files staged.
- [ ] No hostnames, machine names, operational tools, or non-localhost ports in `src/`, `README.md`, or `CLAUDE.md`.
- [ ] No live deployment domain in `src/`, `README.md`, or `CLAUDE.md`.

## 2. Typecheck and build

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # next build; must finish with exit 0
```

- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm build` is clean.

## 3. Database migrations are committed and applied

- [ ] If `src/db/schema.ts` changed, `pnpm db:generate` was run and the new migration is staged.
- [ ] `drizzle/meta/_journal.json` and `drizzle/meta/*.json` are staged.
- [ ] The live database has been migrated (`pnpm db:migrate` against the live `.env.local`).

## 4. Live service health (after push)

The live URL and host commands are in `CLAUDE.local.md` (gitignored). After push:

```bash
git push origin main
# restart the live service and check the health endpoint
# (see CLAUDE.local.md for the exact commands and URL)
```

- [ ] Push succeeded.
- [ ] Service restarted and returns `200`.
- [ ] Magic-link sign-in still works.

## 5. Repository visibility reminder

- [ ] `gh repo view <owner>/<repo> --json visibility` returns `PUBLIC` before sharing the submission form.
