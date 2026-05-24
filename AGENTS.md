# AGENTS.md — repo guidance for AI coding agents and human contributors

> Keep this file short. Add longer guidance to `ARCHITECTURE.md`.

## 1. Architecture doc is mandatory

`ARCHITECTURE.md` is the living source of truth for this project.

**Every architectural change updates `ARCHITECTURE.md` in the same commit.** No exceptions.

What counts as architectural:

- New / dropped table or migration
- New auth method or change to login flow (incl. MFA, session, cookies)
- New or removed API endpoint
- New env var (or removal/rename)
- Breaking change to schema, API contract, or frontend routing
- New external dependency (DB, queue, third-party service)
- Security control changes (rate limits, password policy, MFA, RBAC)
- Deployment topology changes (compose, Dockerfile, scripts)
- New scripts in `scripts/`

What to update:

- **§3 – §13** of `ARCHITECTURE.md` — describe the **current state** (replace, do not append).
- **§15 Change log** — append a **new entry at the top** with commit hash, date, summary.
- **§14 Roadmap** — move items to §15 when shipped.

## 2. Migrations, not schema patches

- Schema changes go in `migrations/NNN_description.sql`.
- Files are applied in lexicographic order at API startup.
- Use `CREATE TABLE IF NOT EXISTS` and idempotent ALTERs.
- Never edit a migration file after it has been applied to any environment — add a new file instead.

## 3. Code style

- TypeScript strict; `npm run build` must pass before commit.
- Prefer feature folders (`src/auth/`, `src/saml/`) over generic `src/api/`.
- Validate every external input with `zod`.
- Log with `pino`, structured fields, no `console.log` in production code.
- No comments that just narrate the code; explain *why* when non-obvious.

## 4. Frontend

- Single-file vanilla-JS SPA in `web/js/app.js` — keep functions small and focused.
- Escape all user-supplied content with `esc()`.
- Do not introduce a build step (Vite/React) without updating §B of the Roadmap and discussing.

## 5. Scripts

- New deploy/diagnostic scripts live in `scripts/`.
- Must be idempotent and safe to re-run.
- Document them in §11 (Deployment) of `ARCHITECTURE.md`.
- **pam-2 (`/opt/idp`)** is deploy-only: use `bash scripts/deploy.sh` — never edit tracked files on the server (causes `git pull` conflicts). Config belongs in `.env` only.

## 6. Don't

- Don't run schema SQL by hand in production — use a migration.
- Don't store secrets in env example files (use `change_me_*` placeholders).
- Don't commit `.env` (already in `.gitignore`).
- Don't add `console.log`, hard-coded localhost URLs, or skip auth on new endpoints.
