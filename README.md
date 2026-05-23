# Lenskart IdP

Enterprise Identity Provider, Single Sign-On, and Identity Governance for Lenskart.

- **SAML 2.0 Identity Provider** for enterprise application SSO
- **OIDC login** via Google Workspace and Zoho
- **Local admin accounts** with TOTP MFA
- **Identity Lifecycle & Governance** — HRMS sync, lifecycle states, adapter outbox
- **Self-service** — change password, manage sessions, enroll MFA
- **Admin console** — manage SAML apps, users, audit logs

> **Production target:** `idp.lenskart.com`
> **Dev:** `http://192.168.24.254:8080` (host `pam-2`, install dir `/opt/idp`)

---

## Quick start (dev server `pam-2`)

```bash
cd /opt/idp
git pull
sudo bash scripts/fix-and-start.sh
```

Then open `http://192.168.24.254:8080/login`. Master admin credentials come from `.env` (`MASTER_ADMIN_EMAIL` / `MASTER_ADMIN_PASSWORD`).

---

## Architecture & change log

**See [`ARCHITECTURE.md`](./ARCHITECTURE.md)** — single source of truth for:

- High-level system diagram
- Tech stack
- Authentication & sessions (incl. MFA flow)
- SAML 2.0 IdP design
- Database & migrations
- Full API surface
- Frontend layout
- Configuration reference
- Deployment & operations runbook
- Security model
- Roadmap
- **Change log** (every commit that changes architecture)

> **Rule:** every architectural change updates `ARCHITECTURE.md` in the same commit. See the rule at the bottom of that doc.

---

## Repository layout

```
.
├── ARCHITECTURE.md              ← living architecture + change log
├── README.md                    ← you are here
├── Dockerfile                   ← multi-stage Node 22 image
├── docker-compose.dev.yml       ← single-tier dev stack
├── env.dev.example              ← dev .env template
├── migrations/                  ← versioned SQL migrations (auto-applied on startup)
│   ├── 001_base_schema.sql
│   └── 002_mfa_and_password_history.sql
├── src/
│   ├── index.ts                 ← API server entry point
│   ├── config.ts                ← zod-validated env config
│   ├── api/                     ← HTTP routers
│   ├── auth/                    ← login, sessions, MFA, RBAC, rate limit
│   ├── saml/                    ← SAML IdP issuer + SP registry + entitlements
│   ├── services/                ← business logic
│   ├── db/                      ← MySQL pool + migration runner
│   ├── abac/                    ← policy engine
│   └── utils/                   ← logger, helpers
├── web/                         ← static SPA (vanilla JS + custom CSS)
│   ├── index.html
│   ├── css/styles.css
│   └── js/app.js
└── scripts/                     ← deploy, reset, diagnose, gen-saml-keys, ...
```

---

## Local development

```bash
npm ci
npm run build         # compile TS → dist/
npm run dev           # nodemon + ts-node (requires .env or env vars set)
npm run typecheck     # tsc --noEmit
npm run lint
npm run test
```

Container build:

```bash
docker-compose -f docker-compose.dev.yml up -d --build
```

---

## Contributing

1. Make your change.
2. Update `ARCHITECTURE.md` (description in §3–§13 if state changed; new entry in §15 Change log).
3. `npm run build` must pass.
4. Commit and push.

---

## License

Internal — Lenskart proprietary.
