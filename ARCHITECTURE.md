# Lenskart IdP — Architecture & Change Log

> Identity Provider, Single Sign-On, and Identity Governance platform for Lenskart.
> **Repository:** [github.com/ravione9/idp](https://github.com/ravione9/idp)
> **Production hostname (target):** `idp.lenskart.com`
> **Dev server:** `http://192.168.24.254:8080` (host `pam-2`, install dir `/opt/idp`)

This document is the **living source of truth** for the system. It is updated on every architectural change. The most recent change is at the top of [§ Change Log](#change-log).

---

## Table of contents

1. [Mission](#1-mission)
2. [High-level architecture](#2-high-level-architecture)
3. [Tech stack](#3-tech-stack)
4. [Service topology](#4-service-topology-dev)
5. [Authentication & sessions](#5-authentication--sessions)
6. [SAML 2.0 IdP](#6-saml-20-idp)
7. [Database & migrations](#7-database--migrations)
8. [API surface](#8-api-surface)
9. [Frontend (web console)](#9-frontend-web-console)
10. [Configuration (env vars)](#10-configuration-env-vars)
11. [Deployment](#11-deployment)
12. [Operations runbook](#12-operations-runbook)
13. [Security model](#13-security-model)
14. [Roadmap](#14-roadmap)
15. [Change log](#15-change-log)

---

## 1. Mission

Lenskart IdP is a unified platform that delivers **enterprise SSO + Identity Governance + Privileged Access**, modelled on best-of-breed commercial products. The feature catalogue below is the contract — the live admin sidebar mirrors it.

**Access Management** *(modelled on miniOrange, OneLogin, Entrust Identity, Okta, Auth0)*
- Multi-protocol SSO: SAML 2.0, OIDC / OAuth 2.0, WS-Federation, JWT, header-based (legacy proxy)
- Inbound federation: Google Workspace OIDC, future LDAP/AD bind
- Strong authentication: TOTP, WebAuthn / passkeys, Email/SMS OTP, push, hardware tokens, PKI, magic-link, security questions
- Adaptive / risk-based authentication: geo-velocity, IP rules, device fingerprint, behavioural baseline → ALLOW / MFA / DENY / BLOCK
- Application launcher portal (miniOrange-style tile grid) and admin SP registry
- Login customization (logo, theme, copy, per-tenant branding)
- Application discovery (find unsanctioned SaaS via Workspace logs / browser proxy)

**Identity Governance & Administration** *(modelled on SailPoint IdentityNow / IdentityIQ, Saviynt, RSA IGA, Oracle Identity Governance)*
- Joiner / Mover / Leaver lifecycle (driven by HRMS feed) with state machine
- Identity profiles per population (employees, contractors, partners, customers)
- Application catalogue with entitlements, business roles and birthright access
- Pluggable connector framework: SCIM, REST, LDAP, JDBC, Google, Slack, GitHub, AD, AWS IAM, Azure AD, Okta, Salesforce
- Self-service access request → multi-level approval → automated fulfilment
- Periodic access review / certification campaigns (manager / app owner / role owner)
- Segregation-of-Duties policies and violation detection
- Risk scoring (per-identity and per-login)
- Workflow library + event triggers + notification dispatcher
- Compliance reports (SOX, GDPR, HIPAA, PCI-DSS) with evidence retention
- Tamper-evident hash-chained audit trail

**Privileged Access Management** *(modelled on miniOrange PAM, CyberArk, BeyondTrust)*
- Privileged resources (SSH / RDP / DB / web admin consoles)
- Just-in-time elevation with auto-expiry
- Credential vault (KMS-rooted, auto-rotation)
- Session recording (terminal + screen) with playback
- Service / system account inventory and certification

> **Authentication note (May 2026):** Zoho is **not** a sign-in provider for this portal. Zoho Mail is consumed as a **SAML application** (this IdP issues assertions to `zoho.com`). End users sign in with local password or Google Workspace OIDC, then click the Zoho Mail tile in *My Applications*.

> **Implementation status:** see §15 Roadmap and the per-page status badges in the admin console (Live / Schema+Read API / Scaffolded / Planned). The schema is intentionally ahead of the service code so each phase only needs to flip features on.

---

## 2. High-level architecture

```
                   ┌──────────────────────────────────────────────┐
                   │                  Browser                     │
                   │  Vanilla-JS SPA  (web/index.html + app.js)   │
                   └──────────┬─────────────────────────┬─────────┘
                              │ session cookie          │ /saml/sso
                              ▼                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                     LILG API (Node 22, Express)                  │
   │                                                                  │
   │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
   │  │  /auth/*    │  │  /api/*      │  │  /saml/*                 │ │
   │  │  Local +    │  │  me, apps,   │  │  IdP metadata,           │ │
   │  │  Google +   │  │  admin/*,    │  │  SP-init SSO,            │ │
   │  │  Zoho +     │  │  audit, ...  │  │  IdP-init launch         │ │
   │  │  MFA        │  │              │  │                          │ │
   │  └─────────────┘  └──────────────┘  └──────────────────────────┘ │
   │                                                                  │
   │  Migrations runner ── Rate limiter ── Pino logger                │
   └──────────┬─────────────────────────┬─────────────────────────────┘
              │                         │
              ▼                         ▼
   ┌──────────────────┐         ┌──────────────────┐
   │  MySQL 8         │         │  Redis 7         │
   │  - employees     │         │  - sessions      │
   │  - lilg_sessions │         │  - mfa challenges│
   │  - saml_*        │         │  - rate limit    │
   │  - mfa_secrets   │         │    (future)      │
   │  - audit_log     │         └──────────────────┘
   │  - ...           │
   └──────────────────┘
              │
              ▼
   ┌──────────────────┐         ┌──────────────────┐
   │  Outbox worker   │ ──SQS── │  Adapters:       │
   │  (Node)          │         │  Google, Zoho,   │
   │                  │         │  AD, Slack, ...  │
   └──────────────────┘         └──────────────────┘
```

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 (Alpine) | Modern, ESM-native, long-term support |
| Language | TypeScript 5 (strict) | Type safety; compiles to ESM |
| HTTP | Express 4 | Battle-tested, simple, well-supported |
| DB | MySQL 8 (`mysql2/promise`) | Enterprise standard at Lenskart |
| Cache / sessions | Redis 7 (`ioredis`) | Hot session lookup, MFA challenges |
| SAML | `samlify` | SAML 2.0 IdP/SP with signing/validation |
| OIDC verification | `jose` | JWKS-based JWT verification |
| Password | `bcryptjs` | Salted bcrypt at rest |
| MFA | `otplib` v12 + `qrcode` | RFC 6238 TOTP, QR enrollment |
| Validation | `zod` | Runtime schema validation for env + request bodies |
| Logging | `pino` + `pino-http` | Structured JSON logs |
| Frontend | Vanilla JS modules + custom CSS | Single static file, no build step |
| Container | Docker (multi-stage) + docker-compose v1 | Single-tier dev deploy |
| Local AWS | LocalStack | SQS for the outbox in dev |

> **Why no React (yet)?** The dev environment (docker-compose v1.29) is fragile; a build pipeline adds risk. Vanilla JS is intentional until we move past dev. See [Roadmap](#14-roadmap).

---

## 4. Service topology (dev)

`docker-compose.dev.yml` defines a single-tier stack on port **8080**:

| Container | Image | Port | Purpose |
|---|---|---|---|
| `idp-api` | built from `Dockerfile` | 8080 → host | Express app + static SPA |
| `idp-worker` | same image, different command | — | Outbox poller (Adapter dispatcher) |
| `idp-mysql` | `mysql:8.0` | internal 3306 | DB |
| `idp-redis` | `redis:7-alpine` | internal 6379 | Sessions, MFA challenges |
| `idp-localstack` | `localstack/localstack:3` | internal 4566 | SQS in dev |

Only `idp-api:8080` is exposed to the host network.

---

## 5. Authentication & sessions

### 5.1 Sign-in methods

| Method | Endpoint | Status |
|---|---|---|
| Local password | `POST /auth/local/login` | Live |
| Local password + TOTP | `POST /auth/local/login` then `POST /auth/local/login/mfa-verify` | Live |
| Google Workspace OIDC | `GET /auth/google` → `GET /auth/google/callback` | Live (requires `GOOGLE_CLIENT_ID`) |
| WebAuthn / passkeys | — | Schema staged in migration 003; routes pending |
| Risk-based MFA step-up | — | Risk engine schema staged; engine pending |

> **Removed:** Zoho OIDC was an inbound sign-in provider in the original design. It has been removed — Zoho Mail is now consumed as a SAML application (see §6.4). The legacy `/auth/zoho` endpoints respond with HTTP 410 Gone.

### 5.2 Session model

- Sessions are stored in **MySQL** (`lilg_sessions`) and cached in **Redis** (`lilg:session:<id>`).
- Session ID = `uuid v4`. Cookie value is `<id>.<HMAC-SHA256(SESSION_SECRET, id)>` (base64url).
- TTL: 8 hours (corporate) / 12 hours (store) — configurable via env.
- Cookie flags: `HttpOnly`, `SameSite=Lax`. `Secure` is on in production but **off** when `COOKIE_SECURE=false` (dev plain HTTP).

### 5.3 Master administrator

A bootstrap account is provisioned from `MASTER_ADMIN_EMAIL` + `MASTER_ADMIN_PASSWORD` on every startup. Password is synced (re-hashed) when the env value changes.

### 5.4 MFA (TOTP)

- Per-user secret in `mfa_secrets` (Base32, 160-bit).
- 8 single-use **backup codes** (8 hex chars), bcrypt-hashed at rest.
- Login flow when MFA is enabled:
  1. `POST /auth/local/login {email, password}` → returns `{mfaRequired:true, challengeId}`.
  2. UI prompts for 6-digit code (or backup code).
  3. `POST /auth/local/login/mfa-verify {challengeId, code}` → session issued.
- Challenge lives in Redis with 5-minute TTL.

### 5.5 Rate limiting

`/auth/local/login` and `/auth/local/login/mfa-verify` are rate limited at **10 requests / minute / (IP+email)** via in-process sliding window (`src/auth/rate-limit.ts`).
Every attempt (success or failure) is logged to `auth_attempts` for forensics.

---

## 6. SAML 2.0 IdP

### 6.1 Endpoints

| Endpoint | Purpose |
|---|---|
| `GET  /saml/metadata` | IdP metadata XML (give to every SP admin) |
| `GET/POST /saml/sso` | SP-initiated SSO (`AuthnRequest` via Redirect or POST binding) |
| `GET  /saml/launch/:slug` | IdP-initiated launch (browser → app tile click) |

### 6.2 Service Provider registry

Each SAML application is registered in `saml_service_providers`:

| Field | Description |
|---|---|
| `slug` | URL-safe identifier (`darwinbox`, `servicenow`, …) |
| `entity_id` | SP's SAML EntityID |
| `acs_url` | SP's Assertion Consumer Service URL |
| `slo_url` | (optional) Single Logout URL |
| `nameid_format` | Default: `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` |
| `attribute_map` | JSON map of SAML attribute → employee field |
| `entitlement_rule` | JSON ABAC rule (`all_active`, `roles`, `dept_ids`, `deny_ilg_states`) |

Apps can be registered:
- Via UI: **Admin Central → SAML Applications → Register new SAML application** (super admin only)
- Via internal API: `POST /api/internal/saml` with `X-Internal-Token`

### 6.3 Assertion log

Every assertion issued is recorded in `saml_assertion_log` (sp_id, emp_id, binding, ts). Used by **Audit Logs → SSO assertions**.

### 6.4 Pre-seeded SAML applications

| Application | Slug | Entity ID | ACS URL | Notes |
|---|---|---|---|---|
| **Zoho Mail** | `zoho-mail` | `zoho.com` | `https://accounts.zoho.in/signin/samlsp` | Seeded in migration `004_seed_zoho_mail_saml_app.sql`. After the IdP signing keys are present in `.env`, paste the metadata at `/saml/metadata` into Zoho's SAML configuration. End users launch via *My Applications* → *Zoho Mail* (`/saml/launch/zoho-mail`). |

Add more apps via **Admin Central → SAML Applications → Register new SAML application** or `POST /api/internal/saml`.

---

## 7. Database & migrations

### 7.1 Migration system

- Folder: `migrations/NNN_name.sql`
- Runner: `src/db/migrate.ts` — runs on startup before listening.
- Tracking: `lilg_schema_migrations(name, checksum, applied_at, duration_ms)`.
- Each file is executed as a single multi-statement batch (the runner opens a connection with `multipleStatements: true`).
- Files are applied in lexicographic order; already-applied files are skipped.
- A checksum mismatch (file was edited after apply) logs a warning but does **not** fail startup.
- A failed migration aborts startup (`process.exit(1)`).

To add a new migration:

```bash
# 1. Add migrations/003_my_change.sql with idempotent DDL
# 2. Pull on the server, restart the API; migration applies automatically
```

### 7.2 Tables (current)

#### Identity core (live)

| Table | Purpose |
|---|---|
| `employees` | Master record from HRMS — primary identity |
| `identity_links` | **(009)** External system → employee mapping (AD, Google, Zoho, …) — used by Universal Directory and connector sync |
| `local_accounts` | Email/password admin accounts |
| `local_password_history` | Password change history |
| `mfa_secrets` | TOTP secret + hashed backup codes |
| `auth_attempts` | Every login attempt (forensics) |
| `lilg_sessions` | Issued sessions |
| `lilg_schema_migrations` | Migration tracking |

#### SSO / Access Management

| Table | Purpose |
|---|---|
| `saml_service_providers` | Legacy SAML SP registry (live) |
| `saml_assertion_log` | Issued SAML assertions audit (live) |
| `applications` | **(003)** Protocol-agnostic application catalog |
| `app_protocol_configs` | **(003)** Per-application protocol bindings (SAML / OIDC / SCIM …) |
| `oidc_clients` | **(003, 007, 010)** Registered OIDC RP clients — `name`, `token_endpoint_auth_method` (010 idempotent backfill/rename when 007 partially applied) |
| `oauth_tokens` | **(003)** Refresh / authorization-code token store |
| `webauthn_credentials` | **(003)** Passkeys (routes pending) |

#### IGA core

| Table | Purpose |
|---|---|
| `connectors` | **(003)** Pluggable target-system adapters |
| `connector_runs` | **(003)** Sync / reconcile / provision job history |
| `entitlements` | **(003)** Granular permissions (roles / groups / licences) |
| `user_entitlements` | **(003)** Active entitlement assignments — heart of governance |
| `business_roles` | **(003)** Bundled role definitions |
| `role_entitlements` | **(003)** Role → entitlement bundle mapping |
| `user_roles` | **(003)** Role assignments |
| `access_requests` | **(003)** Self-service access requests |
| `access_request_approvals` | **(003)** Multi-level approval chain |
| `access_review_campaigns` | **(003)** Quarterly certification campaigns |
| `access_review_items` | **(003)** Items routed to a reviewer in a campaign |
| `sod_policies` | **(003)** Segregation-of-Duties rules (toxic combinations) |
| `sod_violations` | **(003)** Detected SoD violations |
| `risk_scores` | **(003)** Per-identity risk score |
| `login_risk_events` | **(003)** Per-login risk evaluations |

#### Existing lifecycle / governance / async

| Table | Purpose |
|---|---|
| `audit_log` | Tamper-evident hash-chained audit trail |
| `adapter_outbox` | Outbox pattern for downstream sync |
| `attendance_events`, `leave_records` | HRMS-driven lifecycle inputs |
| `abac_policies`, `role_bindings` | Legacy authorization model (will fold into `business_roles` + `entitlements`) |
| `workflow_definitions` | **(007)** Workflow library definitions (`steps_json`, `trigger_event`) — backs `/api/admin/workflows` |
| `workflow_runs` | Generic workflow run history |
| `compliance_reports` | **(003)** Generated SOX / GDPR / HIPAA reports |
| `notifications` | **(003, 011)** Email / Slack / Teams notification outbox — 011 adds `recipient_emp_id`, `subject`, `body`, `template_id`, `reference_id`, `reference_type`, `error` for service layer |

> The legacy `src/db/schema.sql` is **still present** for reference; it is NOT applied automatically — the `migrations/` folder is authoritative.

---

## 8. API surface

### 8.1 Public (no auth)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness (DB + Redis) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/saml/metadata` | IdP metadata XML |

### 8.2 Auth

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/local/login` | Local password (returns session OR MFA challenge) |
| `POST` | `/auth/local/login/mfa-verify` | Submit TOTP / backup code |
| `GET`  | `/auth/google` `/auth/google/callback` | Google Workspace OIDC |
| `POST` | `/auth/logout` | End current session |
| `GET`  | `/auth/zoho` `/auth/zoho/callback` | **Removed** — returns HTTP 410 Gone (Zoho Mail is now a SAML SP) |

### 8.3 Self-service (auth required)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/me` | Current user + capabilities |
| `PUT` | `/api/me/password` | Change own password |
| `GET` | `/api/me/sessions` | List own active sessions |
| `DELETE` | `/api/me/sessions/:id` | Revoke a session |
| `GET` | `/api/me/mfa` | MFA status |
| `POST` | `/api/me/mfa/enroll` | Start TOTP enrollment (returns QR) |
| `POST` | `/api/me/mfa/confirm` | Verify code → enable MFA |
| `POST` | `/api/me/mfa/disable` | Disable MFA |
| `POST` | `/api/me/mfa/regenerate-codes` | New backup codes |
| `GET` | `/api/apps` | SAML apps the user is entitled to |

### 8.4 Admin (ADMIN / SUPER_ADMIN)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/dashboard` | Aggregate stats |
| `GET` | `/api/admin/users` | Paginated employee list (search, state, identity source filter) |
| `GET` | `/api/admin/users/:empId` | Full profile: employee, identity links, sessions, password writeback log |
| `POST` | `/api/admin/users/local` | Create local employee + password account |
| `POST` | `/api/admin/users/:empId/reset-password` | Admin password reset with AD/Google writeback |
| `POST` | `/api/admin/users/:empId/link-identity` | Attach an external identity link |
| `DELETE` | `/api/admin/users/:empId/identity-links/:linkId` | Remove an identity link |
| `GET`/`POST`/`DELETE` | `/api/admin/local-users[/:id]` | Local admin CRUD |
| `GET`/`POST`/`DELETE` | `/api/admin/saml-apps[/:id]` | SAML SP registry |
| `GET` | `/api/admin/audit/saml` | SAML assertions log |
| `GET` | `/api/admin/audit/system` | `audit_log` rows |

### 8.5 IGA + multi-protocol AM (live read APIs; write paths return 501 until service layer ships)

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/api/iga/applications[/:id]` | Protocol-agnostic application catalog |
| `PUT` | `/api/iga/applications/:id` | Update application metadata (ADMIN+) |
| `DELETE` | `/api/iga/applications/:id` | Remove application (SUPER_ADMIN) |
| `GET` | `/api/iga/connectors` | Target-system connectors |
| `POST` | `/api/iga/connectors` | Register connector (501) |
| `GET` | `/api/iga/connectors/:id/runs` | Connector run history |
| `POST` | `/api/iga/connectors/:id/sync` | Trigger sync (501) |
| `GET` | `/api/iga/entitlements[?appId=…]` | Entitlement catalog |
| `GET` | `/api/iga/entitlements/me` | My current entitlements |
| `GET` | `/api/iga/access-requests?scope=mine\|tasks\|all` | List access requests by scope |
| `POST` | `/api/iga/access-requests` | Submit access request (SoD pre-check + approval chain) |
| `POST` | `/api/iga/access-requests/:id/decision` | Approve / reject pending request |
| `GET` | `/api/iga/access-reviews` | Active certification campaigns |
| `GET` | `/api/iga/access-reviews/:id/items` | All review items for a campaign (admin) |
| `GET` | `/api/iga/access-reviews/me` | Review items routed to me |
| `POST` | `/api/iga/access-reviews` | Create campaign |
| `POST` | `/api/iga/access-reviews/:id/items/:itemId/decision` | Certify / revoke / exception on a review item |
| `GET` | `/api/iga/sod-policies` | SoD policy registry |
| `GET` | `/api/iga/sod-violations?status=…` | Detected violations |
| `POST` | `/api/iga/sod-violations/:id/remediate` | Mark an open SoD violation as RESOLVED |
| `GET` | `/api/iga/risk/dashboard` | Top risk identities + 24h counters |
| `GET`/`POST` | `/api/iga/reports` | Compliance report archive (POST returns 501) |

### 8.5 Internal (X-Internal-Token gated)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/internal/saml` | Programmatic SP registration |
| Various | `/api/internal/*` | Airflow / automation hooks |

---

## 9. Frontend (web console)

### 9.1 Files

```
web/
├── index.html        ← single page, loads app.js as ES module
├── css/styles.css    ← enterprise theme (light, sidebar, cards)
└── js/app.js         ← SPA: router, views, API client
```

### 9.2 Layout

- **Login screen** — split: brand hero (gradient) + sign-in card. **Identity-first flow**: email step → password step (avatar + "Not you?" link) → optional MFA challenge inline. Google SSO button on email step.
- **Console** — fixed top primary nav + contextual left sidebar (user or admin mode).

Layout: a fixed dark **top primary nav** (workspace) + a **left sidebar** that switches by mode:

| Mode | Sidebar | Behaviour |
|---|---|---|
| **End-user** (JumpCloud-style) | My Portal nav: All Applications · Request Access · Approvals (badge) · My Access · Security | Top-nav user buttons hidden; sidebar drives navigation |
| **Admin** (miniOrange-style) | Grouped admin sections (collapsible via ◀/▶ toggle, persisted in `localStorage`) | Visible only when Admin is active |

**Top primary nav** (always visible, modelled on SailPoint IdentityNow)
- **Home** — JumpCloud-style app launcher: search bar, All Apps / Favorites tabs, star-to-favorite (stored in `localStorage`), entitled + catalog tiles merged
- **Request Center** — browse the catalogue, raise an access request
- **Approvals** — pending approvals + access-review items routed to the user
- **My Access** — current entitlements & roles
- **Admin** — opens admin sidebar (admin / super-admin only)

**Admin sidebar** (modelled on miniOrange PAM admin) — every group is collapsible per-tenant in a future release; today every entry is a feature page with status, summary and capability list.

| Group | Sidebar items |
|---|---|
| **Overview** | Dashboard |
| **Identity** | Users / Identities · Groups · Administrators · System / Privileged Users · Identity Profiles |
| **Authentication** | SSO Configuration · Strong Auth Methods · Adaptive Auth · Password Policies · Login Customization |
| **Applications** | Application Catalog · SAML Applications · OIDC / OAuth · App Discovery |
| **Connections** | Connectors / Sources · Directory Sync |
| **Access Model** | Business Roles · Birthright Rules |
| **Privileged Access** | Privileged Resources · Privileged Sessions · Credential Vault |
| **Identity Governance** | Certifications · Segregation of Duties · Risk |
| **Workflows** | Workflow Library · Event Triggers · Notifications |
| **Reports** | Audit Log · SSO Reports · Compliance Reports |
| **Settings** | General · Branding · License · Tickets · System Health |

**Account** (everyone) — top-right profile dropdown
- Account settings (Profile / Security / Sessions / Two-factor)
- Audit logs (admins)
- SAML metadata link
- Sign out

### 9.3 Routing

- `/login` — login form (no auth)
- `/` — console (default landing: admins → Dashboard, others → My Apps)
- `/?v=<view>` — direct deep link to any view

---

## 10. Configuration (env vars)

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | yes | — | MySQL |
| `REDIS_URL` | yes | — | Sessions + MFA challenges |
| `SESSION_SECRET` | yes (≥32 chars) | — | HMAC for cookie signing |
| `SESSION_TTL_CORPORATE_HOURS` | no | `8` | Corporate session TTL |
| `SESSION_TTL_STORE_HOURS` | no | `12` | Store session TTL |
| `COOKIE_SECURE` | no | `true` if `NODE_ENV=production`, else `false` | Force secure cookie. **Set `false` for plain-HTTP dev.** |
| `INTERNAL_TOKEN` | yes (≥16) | — | `X-Internal-Token` for `/api/internal/*` |
| `LOCAL_BOOTSTRAP_TOKEN` | no | — | First-time admin bootstrap (disable after) |
| `MASTER_ADMIN_EMAIL` | recommended | — | Master admin auto-provisioned on startup |
| `MASTER_ADMIN_PASSWORD` | recommended | — | (≥10 chars) |
| `MASTER_ADMIN_FULL_NAME` | no | `Master Administrator` | |
| `PUBLIC_BASE_URL` | yes | — | `http://192.168.24.254:8080` (dev) / `https://idp.lenskart.com` (prod) |
| `SAML_IDP_BASE_URL` | yes for SAML | — | Same as above |
| `SAML_IDP_ENTITY_ID` | no | `<base>/saml/metadata` | IdP entity ID |
| `SAML_IDP_PRIVATE_KEY_PEM` | yes for SAML | — | PEM (escape `\n` as literal `\n`) |
| `SAML_IDP_CERT_PEM` | yes for SAML | — | PEM |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_HOSTED_DOMAIN` | yes for Google | — | Google Workspace OIDC inbound login |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_SCIM_BASE_URL` | optional | empty | **Outbound Zoho People SCIM provisioning only.** Not used for sign-in. Leave blank to disable. |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `SQS_*` | yes | — | LocalStack URLs in dev |

---

## 11. Deployment

### 11.1 Dev (single-tier docker-compose on `pam-2`)

**Deploy model:** `pam-2` is a **deploy-only** checkout — never edit tracked files under `/opt/idp` on the server (manual patches to `scripts/*.sh` cause recurring `git pull` conflicts). Configuration lives in **`.env`** only (gitignored). All code changes happen in git; the server syncs with `git reset --hard origin/main`.

**One command deploy** (sync + rebuild + restart API):

```bash
ssh pam-2
cd /opt/idp
bash scripts/deploy.sh
```

`deploy.sh` runs `sync-repo.sh` (hard reset to `origin/main`, keeps `.env`) then `restart-api.sh`.

Other commands:

```bash
# Sync repo only (fix "local changes would be overwritten by merge")
bash scripts/sync-repo.sh

# Restart API without pulling (already synced)
bash scripts/restart-api.sh

# Full stack reset (MySQL volume kept)
sudo bash scripts/fix-and-start.sh
```

**Do not** run bare `git pull` on pam-2 — use `bash scripts/sync-repo.sh` or `bash scripts/deploy.sh`.

**Do not** run raw `docker-compose up --build` — use `./dev-up.sh` or `restart-api.sh` (ContainerConfig workaround).

`./dev-up.sh` and `scripts/compose.sh` auto-remove stale `idp-api` / `lilg-api` containers before any `up --build`. **Permanent fix:** install Compose v2 once: `sudo bash scripts/install-compose-v2.sh`.

`fix-and-start.sh` handles:
1. `.env` bootstrap from `env.dev.example` if missing.
2. Master admin block in `.env` if missing.
3. `down` + remove stale containers (works around docker-compose v1.29 `KeyError: ContainerConfig`).
4. `up -d --build`.
5. Migrations apply automatically on API startup — **no manual SQL**.
6. Wait for `/healthz`, print login info.

### 11.2 Production (target: `idp.lenskart.com`)

Not yet deployed. See [Roadmap §14.A](#14-roadmap).

### 11.3 Docker image

Multi-stage build (`Dockerfile`):

1. `builder` — `npm ci` + `npm run build` + `npm prune --production`.
2. `runner` — Alpine + non-root user + `dumb-init` + healthcheck.
3. Copies: `dist/`, `node_modules/`, `package.json`, `web/`, `migrations/`.

---

## 12. Operations runbook

### 12.1 Common commands (on `pam-2`)

```bash
# Standard deploy after code is pushed to GitHub
bash scripts/deploy.sh

# Status
docker ps --filter name=idp-

# Restart API only (repo already synced)
bash scripts/restart-api.sh

# Logs
docker logs idp-api --tail 100 -f
docker logs idp-worker --tail 100 -f

# Compose via wrapper (never raw docker-compose on pam-2)
./dev-up.sh up -d --build lilg-api

# Diagnostics
bash scripts/diagnose.sh

# DB shell
docker exec -it idp-mysql mysql -ulilg_app -ps3cr3t_change_me lilg

# Apply migrations manually (normally automatic on startup)
docker exec -i idp-mysql mysql -ulilg_app -ps3cr3t_change_me lilg < migrations/<file>.sql
```

### 12.2 Known issues

| Symptom | Cause | Fix |
|---|---|---|
| `git pull` — "local changes would be overwritten" | Tracked files edited on pam-2 (manual script fixes) | **`bash scripts/sync-repo.sh`** or **`bash scripts/deploy.sh`** — never commit on pam-2; use `.env` for config |
| `KeyError: 'ContainerConfig'` on `up -d --build` | docker-compose **v1.29** tries to recreate an existing container after image rebuild | **`bash scripts/deploy.sh`** or **`bash scripts/restart-api.sh`**. Permanent fix: `sudo bash scripts/install-compose-v2.sh` |
| Browser login appears to fail (no redirect) | `Secure` cookie flag rejected over HTTP | `COOKIE_SECURE=false` in `.env` |
| `Table 'lilg.lilg_sessions' doesn't exist` | Pre-migration MySQL volume | Restart API — migrations apply automatically |
| `getaddrinfo EAI_AGAIN mysql` / API crash-loop, container named `lilg-api` while DB is `idp-mysql` | API started with root `docker-compose.yml` instead of `docker-compose.dev.yml` — `lilg-api` lands on a different network and cannot resolve hostname `mysql` | `docker rm -f lilg-api` then `./dev-up.sh up -d --build lilg-api` or `bash scripts/restart-api.sh` (never use bare `docker-compose up` on pam-2) |
| `No such container: idp-api` after deploy | Same mismatch — API container is `lilg-api` from wrong compose file | Use `./dev-up.sh` / `docker-compose -f docker-compose.dev.yml`; logs: `docker logs idp-api` |

---

## 13. Security model

| Surface | Control |
|---|---|
| Local password | `bcryptjs` cost 12, ≥10 chars on change, history retained |
| Session cookie | HMAC-signed, `HttpOnly`, `SameSite=Lax`, `Secure` (configurable for dev) |
| MFA | TOTP RFC 6238, 30-second window, ±1 step skew tolerance, hashed backup codes |
| Rate limiting | 10 req / minute / (IP + email) on auth endpoints |
| Forensics | `auth_attempts` table records every attempt with reason + IP |
| Internal API | `X-Internal-Token` shared secret (`INTERNAL_TOKEN`) |
| Audit | Hash-chained `audit_log` (tamper-evident) |
| RBAC | Role hierarchy: `EMPLOYEE < MANAGER < HRBP < ADMIN < SUPER_ADMIN` |
| ABAC | `policy-engine.ts` evaluates rules on resource access |
| Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |

---

## 14. Roadmap

The platform is being delivered in **phases**. Schema is ahead of service code so each phase only flips features on.

### Phase 1 — SSO MVP **(live)**

- ✅ SAML 2.0 IdP, IdP-initiated launch
- ✅ Local password + Google OIDC sign-in, TOTP MFA, password change, session revocation
- ✅ Pre-seeded **Zoho Mail** SAML application
- ✅ Audit log of every assertion + every login attempt
- ✅ Database migration runner

### Phase 2 — IGA Foundation **(COMPLETE)**

- ✅ Schema for applications, connectors, entitlements, roles, access requests, reviews, SoD, risk, reports, notifications (`migrations/003_iga_foundation.sql`)
- ✅ Read APIs at `/api/iga/*`; new sidebar sections
- ✅ **Approval-chain resolver** — `POST /api/iga/access-requests` (SoD pre-check, multi-level approval chain creation, SLA deadline) in `src/services/access-request-workflow.ts`
- ✅ **Access request decisions** — `POST /api/iga/access-requests/:id/decision` (approve/reject, auto-fulfil entitlements on final approval) in `src/services/access-request-workflow.ts`
- ✅ **Birthright entitlement engine** — `src/services/birthright.ts` assigns/revokes birthright entitlements on lifecycle events (JOINER/LEAVER)
- ✅ **Connector dispatcher** — `src/services/connector-dispatcher.ts` routes `POST /api/iga/connectors/:id/sync` to the right sync service (AD or Google)
- ✅ **AD Directory Sync** — `src/services/ad-sync.ts` reconciles HRMS employees → Active Directory (provision, update, disable); tracks runs in `connector_runs`
- ✅ **Google Workspace Sync** — `src/services/google-sync.ts` + `src/services/google-directory-config.ts`: inbound import and outbound provision via Admin SDK; connector `config_json` supports **sync scope** (`syncOrgUnits`, `syncGroups`, `syncUsers`, `includeSubOrgUnits`, `provisionOrgUnit`) — blank scope syncs the full directory; non-empty filters combine with AND logic
- ✅ **Password Writeback** — `src/services/password-writeback.ts` writes password changes to AD (unicodePwd/LDAP) and Google (Admin SDK); wired into `PUT /api/me/password`; logs to `password_writeback_log`
- ✅ **User Lifecycle** — `src/services/user-lifecycle.ts` + `src/api/admin-lifecycle.ts`: `POST /api/admin/users/:empId/suspend|unsuspend|terminate` — revokes sessions (DB + Redis), enqueues DISABLE/ENABLE outbox ops to AD + Google, records `lifecycle_events`
- ✅ **Access review campaign generator** — `POST /api/iga/access-reviews` + `POST /api/iga/access-reviews/:id/items/:itemId/decision` in `src/services/access-review.ts` (scopes: ALL_USERS, APP_SPECIFIC, HIGH_RISK; auto-closes campaign when all items reviewed; REVOKE triggers user_entitlement revocation)
- ✅ **SoD evaluator** — `src/services/sod-evaluator.ts` runs on every entitlement grant; populates `sod_violations`; full-scan available
- ✅ **Notification dispatcher** — `src/services/notification.ts` dispatches EMAIL (nodemailer), SLACK (webhook), TEAMS, IN_APP; called by access-request, lifecycle, and review workflows
- ✅ **Direct entitlement grant** — `POST /api/iga/entitlements/:entId/grant` (admin, SoD-gated)
- ✅ **Connector registration** — `POST /api/iga/connectors` now persists to DB (was 501)
- ✅ **Compliance report creation** — `POST /api/iga/reports` now creates a report record (was 501)
- ⏳ Risk engine — location / device / velocity heuristics → `login_risk_events`, `risk_scores`

### Phase 3 — Modern AM

- OIDC issuer endpoints (`/.well-known/openid-configuration`, `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`) — schema staged in `oidc_clients`, `oauth_tokens`
- WebAuthn / passkeys — schema staged in `webauthn_credentials`
- WS-Federation, header-based SSO (legacy proxy)
- Adaptive / risk-based MFA step-up (deny / MFA / allow decision)
- Account lockout policy (data already in `auth_attempts`)
- Redis-backed rate limiter for multi-instance deploys

### Phase 4 — Productionize `idp.lenskart.com`

- TLS termination (Caddy with auto-HTTPS or Nginx + cert-manager / Let's Encrypt)
- DNS, real domain, replace `192.168.24.254:8080`
- HA: 2× API replicas behind LB, MySQL primary+replica, Redis Sentinel
- Secrets in AWS Secrets Manager (already wired via `@aws-sdk/client-secrets-manager`)
- MySQL backup strategy
- Move frontend to **React + Vite + TypeScript**, add as a build stage in Dockerfile

### Phase 5 — Advanced IGA

- Privileged Access (vault for shared credentials, JIT elevation)
- Session recording for high-risk apps
- SCIM 2.0 *server* (inbound, so Workday / Zoho People can push directly into `employees`)
- Identity warehouse on Elasticsearch / OpenSearch for slice-and-dice analytics
- Compliance report templates (SOX, GDPR, HIPAA, PCI)
- Privilege creep / orphan / dormant account detection

### Real SAML SP onboardings (continuous)

| App | Status |
|---|---|
| **Zoho Mail** | Seeded by migration `004` — sign assertions live as soon as IdP keys are configured |
| Darwinbox HRMS | Planned |
| ServiceNow | Planned |
| Google Workspace | Planned (currently used as inbound IdP) |
| Internal apps | Planned per app |

---

## 15. Change log

> **Convention:** newest entries at the top. Each entry includes commit hash, date, and summary.

### `38f20c6` — 2026-06-06 — Google connector: fix domain-wide delegation auth + clearer errors

**Why** — Test Connection returned `unauthorized_client` when Admin Console delegation only authorized `admin.directory.user` (code requested extra scopes) or when Admin Email was missing / set to the service account.

**What changed:**

- **`src/services/google-directory-config.ts`** — request only delegated scopes (`user` always; `group.readonly` only when Sync Groups set); require Workspace super-admin impersonation email; `formatGoogleAuthError()` with Client ID + scope checklist.
- **`src/api/iga.ts`** — Google test returns `GOOGLE_AUTH_FAILED` with actionable message.
- **`web/js/views-stubs.js`** — domain-wide delegation setup hint + Admin Email field guidance.

### `f50768b` — 2026-06-06 — Google Workspace connector: OU / group / user sync scope

**Why** — Directory Sync imported every Google user with no way to limit inbound sync to specific organisational units, groups, or named accounts (AD already had `targetOu`).

**What changed:**

- **`src/services/google-directory-config.ts`** — `resolveGoogleSyncScope()`, `buildGoogleJwtAuth()`, `listScopedGoogleUsers()` (AND across non-empty OU / group / user filters; optional `includeSubOrgUnits`).
- **`src/services/google-sync.ts`** — reads per-connector `config_json` instead of global `.env` SA key; inbound uses scoped user list; outbound provisions to `provisionOrgUnit`.
- **`src/api/iga.ts`** — `POST /api/iga/connectors/:id/test` for `GOOGLE_WORKSPACE` performs a live Admin SDK probe and reports how many users match the configured scope.
- **`web/js/views-stubs.js`** — Google connector modal adds **Sync Scope** fields: OUs, groups, users, provision OU, include sub-OUs checkbox.

### `97424f5` — 2026-05-24 — Integration setup wizard (SAML + OIDC) replaces ad-hoc "+ Add" modals

**Why** — Clicking *+ Add* on a pre-built integration just showed an info dialog or a flat form — there was no guided setup, no SP detail capture, and no success/test step. miniOrange and Entrust both ship a step-by-step wizard, which the previous flow lacked.

**What changed:**

- **`web/js/views-stubs.js`** — adds `runWizard()` (shared multi-step modal runner), `openSamlWizard(app)`, `openOidcWizard(app)`, `VENDOR_TIPS` table with per-vendor setup steps for Slack, Zoom, Google Workspace, GitHub, Teams, Jira, AWS (generic fallback for the rest).
  - **SAML wizard**: Overview → IdP Details (copy-from-us URLs) → SP Configuration (paste from vendor: Entity ID, ACS, SLO, NameID format, slug) → Activate (review + create + success screen with test launch link).
  - **OIDC wizard**: Overview → Redirect URIs → Advanced (grants, scopes, token auth) → Review (register and reveal Client ID / Secret in the same modal).
- **`web/css/styles.css`** — `.modal-wizard`, `.wizard-stepper` (pill-style numbered progress), `.wizard-success`, `.wiz-readonly-input` with copy buttons, and matching responsive styles.

### `e8b9646` — 2026-05-24 — System Health page: fix false DB/Redis ERROR + working refresh

**Why** — Backend returned `{ db: true, redis: true }` but the frontend compared `h.db?.status === 'ok'`, so health pills always rendered as ERROR even when both services were fine. Refresh button referenced a non-existent `#sys-body` and uptime under 1h showed `0h`.

**What changed:**

- **`src/api/config-system-health.ts`** — returns `{ db: { ok, latency_ms }, redis: { ok, latency_ms }, outbox: {pending, processing, done, dead}, connectors: [...], migrations: [...], uptime_seconds }`.
- **`web/js/views-stubs.js`** — `serviceOk()` accepts boolean OR `{ ok }` OR `{ status:'ok' }`; uptime formatter shows seconds/minutes/hours; refresh button now actually re-fetches.

### `f2b431e` — 2026-05-24 — Fix OIDC integration add (response_types + catalog link)

**Why** — Registering an OIDC client from the pre-built integration catalog returned 500: `INSERT` omitted required `response_types` column. Integration add also did not create a row in the application catalog.

**What changed:**

- **`POST /api/admin/oidc-clients`** — always inserts `response_types`; optional `catalog_slug` + `category` auto-create/link `applications` row via `app_id`.
- **`viewOidcApps`** — passes catalog metadata on + Add; validates redirect URI for authorization_code; scrolls to registered clients after success.

### `27ccbe9` — 2026-05-24 — OIDC clients API: schema-tolerant reads/writes

**Why** — `/api/admin/oidc-clients` returned 500 on pam-2 when migration 010 had not yet applied: queries assumed `name` and `token_endpoint_auth_method` columns that may be missing on partially-migrated schemas.

**What changed:**

- **`src/api/config-oidc-clients.ts`** — introspects `information_schema` at runtime; SELECT aliases missing columns; INSERT branches for pre-007, post-007, and post-010 schemas.

### `8fb0537` — 2026-05-24 — Schema fixes (010/011) + OIDC page redesign + role entitlements fix

**Why** — Partial migration 007 left `oidc_clients` columns inconsistent on pam-2; notification service expected columns missing from migration 003; role entitlement POST used a non-existent `id` column; OIDC admin page used Clearbit CDN logos (blocked in airgapped deploys) and tab UX was awkward.

**What changed:**

- **`migrations/010_oidc_clients_schema_fix.sql`** — idempotent `name` backfill + `token_endpoint_auth_method` rename/add.
- **`migrations/011_notifications_schema_fix.sql`** — adds service-layer columns to `notifications` + index on `recipient_emp_id`.
- **`src/api/config-business-roles.ts`** — `INSERT IGNORE INTO role_entitlements (role_id, entitlement_id)` (composite PK, no `id`).
- **`web/js/views-stubs.js`** — unified OIDC page (registered clients + inline pre-built catalog); letter-avatar icons instead of Clearbit CDN.

### `7970a96` — 2026-05-24 — IGA application catalog CRUD + admin UI

**Why** — Application catalog was read-only in the admin console; admins could not register, edit, or retire apps from the UI.

**What changed:**

- **`PUT /api/iga/applications/:id`** — partial update (name, description, icon, category, visibility, SSO/provisioning flags, active).
- **`DELETE /api/iga/applications/:id`** — SUPER_ADMIN only.
- **`web/js/views-admin.js`** — full catalog UI: search/filter, register/edit modal, activate/deactivate, delete.
- **`web/js/api.js`** — `createIgaApp`, `updateIgaApp`, `deleteIgaApp` client methods.
- **`web/js/views-stubs.js`** — OIDC catalogue letter-avatar icons; system health connector table fixes.

### `23d5fb2` — 2026-05-24 — Admin console UI polish: line-icon system + cache-control

**Why** — User reported the admin GUI looked unfinished and asked for miniOrange / Entrust-grade polish. Emoji glyphs (`◍`, `⛨`, `🏠`, etc.) used as nav and stat icons were the most visible quality regression; sidebar items had no icons at all; and deployed UI changes did not show up because static assets were cached aggressively by browsers.

**What changed:**

- **`web/js/icons.js`** *(new)* — Lucide/Phosphor-style inline SVG icon library (≈40 line icons), 24×24 viewBox, 1.6 stroke, `currentColor`. Used by every nav item, stat card, and topnav button.
- **`web/js/app.js`** — every route in `ROUTES` now declares `icon`; admin sidebar group headers gained a per-group icon; admin top-nav `Admin` button is now an Entrust-style pill with icon; collapsed-sidebar chevron uses SVG.
- **`web/js/views-admin.js`**, **`web/js/views-stubs.js`** — `statCard` accepts an icon name; dashboard tiles + Risk + MFA Methods cards now use SVG line icons instead of geometric Unicode glyphs. MFA Methods stat card structure aligned with the standard `auto 1fr` grid.
- **`web/css/styles.css`** — new `.i { 18×18 }` SVG class; refined `.admin-sidebar` typography (text-muted by default, primary on hover/active, 3px left border in active state); user-sidebar nav-icon switched from emoji to SVG; `.admin-sidebar.collapsed` now hides labels but keeps icons centred; new `.admin-pill` topnav pill; `.sidebar-toggle-btn` redesigned as a bordered chip; `.stat-card .stat-icon .i` sized for the 44px tile.
- **`web/index.html`** — cache-bust query param on entry `app.js` / `styles.css`; theme-color meta.
- **`src/index.ts`** — `express.static` sends `Cache-Control: no-cache, must-revalidate` for `.js`, `.css`, `.html` so deployed changes always show after a single refresh (no fingerprinting needed for this small SPA).

**Reference:** miniOrange admin console (group sidebar with icons + collapse, KPI tiles), Entrust Identity (dark navy topnav with right-aligned admin pill, line-icon system, generous whitespace).

### `841dfab` — 2026-05-24 — Admin GUI fix: hidden user sidebar + MFA boolean stat

**Why** — In admin mode both the user sidebar (`#user-sidebar`) and admin sidebar were rendering side-by-side because `.user-sidebar.hidden` had no CSS rule, breaking the 240/1fr admin grid into a 3-cell layout (user nav top-left, admin nav top-right, content below). Separately, the MFA Methods page rendered the literal string `false` because `status?.enrolled ?? 0` does not coerce a boolean.

**What changed:**

- **`web/css/styles.css`** — add `.user-sidebar.hidden { display: none; }` (parity with `.admin-sidebar.hidden`).
- **`web/js/views-stubs.js`** (`viewMfaMethods`) — derive enrolled count from `status.methods.length`, render an explicit Active/Pending/Not enrolled badge, never display `status.enrolled` directly as a number.

### `ded9501` — 2026-05-24 — pam-2 deploy model: sync-repo.sh + deploy.sh (no local edits on server)

**Why** — Repeated `git pull` failures on pam-2 (`local changes would be overwritten`) from manual script patches; deploy workflow was undefined.

**What changed:**

- **`scripts/sync-repo.sh`** — `git fetch` + `git reset --hard origin/main` (`.env` gitignored, untouched).
- **`scripts/deploy.sh`** — standard pam-2 entry point: sync + `restart-api.sh`.
- **§11 / §12** — document deploy-only server model; replace bare `git pull` with `deploy.sh`.

### `1d9b177` — 2026-05-24 — Fix Compose v2 install URL (v2.24.9 404) + v1 fallback never aborts

- **`install-compose-v2.sh`** — default pin `v2.36.1` (v2.24.9 removed from GitHub); fallback to `/latest/download/`; verify `docker compose version` after install.
- **`idp_ensure_compose_v2`** — install failure no longer aborts `restart-api.sh`; falls back to v1 `create`+`start`.

### `03f23d4` — 2026-05-24 — ContainerConfig fix v2: compose rm ghosts + auto-install Compose v2 + create/start on v1

**Why** — `restart-api.sh` still failed: compose v1 left ghost containers (`504b9cb60f54_idp-api`) that `docker rm idp-api` did not remove; `up` still hit recreate/ContainerConfig.

**What changed:**

- **`idp_rm_stale_api`** — also runs `compose rm -f -s lilg-api` and removes all containers matching `name=idp-api` / `name=lilg-api`.
- **`idp_ensure_compose_v2`** — `restart-api.sh` auto-installs Compose v2 plugin when only v1.29 is present.
- **`idp_compose_start_api`** — on v1, uses `compose create` + `docker start idp-api` instead of `up` (avoids recreate code path).

### `20de138` — 2026-05-24 — Permanent ContainerConfig workaround: compose wrapper scripts

**Why** — Every `docker-compose up -d --build lilg-api` on pam-2 hit `KeyError: ContainerConfig` because compose v1.29 cannot recreate containers after rebuild.

**What changed:**

- **`scripts/compose-lib.sh`** + **`scripts/compose.sh`** — shared wrapper: prefers `docker compose` v2, auto-`docker rm -f idp-api lilg-api` before `up --build`.
- **`dev-up.sh`** — execs `scripts/compose.sh` (use `./dev-up.sh` instead of raw docker-compose).
- **`scripts/restart-api.sh`**, **`fix-and-start.sh`**, **`reset-and-up.sh`** — use compose-lib; removed `--force-recreate` from reset-and-up.
- **§11 / §12** — document preferred deploy commands.

### `910aa5c` — 2026-05-24 — Universal Directory profile drawer + migration 009 identity_links

**Why** — User profile panel was a cramped modal; `identity_links` table was missing on migration-only DB volumes (schema.sql init path had it, migrations folder did not).

**What changed:**

- **Migration `009_identity_links.sql`** — creates `identity_links` aligned with `schema.sql` (`ACTIVE|DISABLED|DELETED|ORPHAN`, `uk_system_external`).
- **`src/api/admin-users.ts`** — profile endpoint wraps identity_links / sessions / writeback queries in try/catch so a missing table never 500s the drawer.
- **`web/js/views-stubs.js`** — Universal Directory user profile rebuilt as a **slide-in drawer** (avatar header, tabbed sections: Overview, Identity Links, Sessions, Password Reset, Writeback Log).
- **`web/css/styles.css`** — profile panel overlay, drawer, tabs, and action-bar styles.

### `63bd7b1` — 2026-05-24 — End-user portal UX: JumpCloud-style sidebar, identity-first login, app favorites

**Why** — End-user experience still felt like an admin console; login and home needed to match JumpCloud / miniOrange user-portal patterns.

**What changed:**

- **`web/js/app.js`** — end-user **My Portal** left sidebar (All Applications, Request Access, Approvals with task badge, My Access, Security); admin sidebar **collapse toggle** (persisted in `localStorage`); `user-mode` / `admin-mode` shell classes.
- **`web/js/views-end-user.js`** — **identity-first login** (email → password with avatar); **Home** redesign with search, All Apps / Favorites tabs, star-to-favorite (`localStorage idp_fav_apps`), merged entitled + catalog tiles.
- **`web/css/styles.css`** — styles for user sidebar, admin collapse, auth avatar chip, app favorites, home tabs/toolbar.

### `6e8515d` — 2026-05-24 — Deploy scripts: remove orphan lilg-api + runbook for network mismatch

- **`scripts/restart-api.sh`** / **`scripts/fix-and-start.sh`** — also remove orphan `lilg-api` container created when someone runs root `docker-compose.yml` instead of `docker-compose.dev.yml` on pam-2.
- **§12.2 Known issues** — document `EAI_AGAIN mysql` / `No such container: idp-api` symptoms and fix.

### `e00665b` — 2026-05-24 — doc: log a8daf21 migration 007 fix in change log

### `a8daf21` — 2026-05-24 — Fix migration 007: idempotent OIDC/workflow DDL + valid timestamps

**Why** — `007_fix_oidc_workflows.sql` crashed API startup on pam-2: `DEFAULT UTC_TIMESTAMP()` is invalid MySQL syntax for `CREATE TABLE`, and the first partial run left `oidc_clients.name` in place so every restart hit `Duplicate column name 'name'`.

**What changed:**

- **`migrations/007_fix_oidc_workflows.sql`** (never successfully applied — safe to rewrite):
  - Guard `ADD COLUMN name` and `CHANGE COLUMN token_endpoint_auth` with `information_schema` checks (idempotent after partial apply).
  - Replace `DEFAULT UTC_TIMESTAMP()` with `DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE CURRENT_TIMESTAMP` on `workflow_definitions`.

### `e3b54d0` — 2026-05-24 — doc: log ba09929 in change log

- **Migration `008_local_account_roles.sql`** — expands `local_accounts.role` enum to `USER | MANAGER | HRBP | ADMIN | SUPER_ADMIN` so non-admin local identities can sign in.
- **`src/api/admin-users.ts`** — full unified directory API:
  - `GET /` — list with `q`, `state`, `source` filters and aggregated identity sources per employee.
  - `GET /:empId` — profile with identity links, recent sessions (`idp_sessions`), writeback log.
  - `POST /local` — create employee + local account (zod-validated).
  - `POST /:empId/reset-password` — local hash update + AD/Google writeback via `password-writeback.ts`.
  - `POST /:empId/link-identity` / `DELETE /:empId/identity-links/:linkId` — manual link management.
- **`web/js/api.js`** — client methods for all new endpoints.
- **`web/js/views-stubs.js`** — Universal Directory split into **Directory Sources** and **Users** tabs; Users tab has searchable hybrid directory, profile drawer (links, sessions, writeback log), multi-system password reset, link/unlink identity, and create-local-user modal.

### `2decef9` — 2026-05-24 — doc: log cec8cd4 in change log

### `cec8cd4` — 2026-05-24 — IGA governance UI: access requests, review campaigns, SoD remediation

**Why** — End-user and admin IGA pages were read-only stubs; operators could not submit requests, run certification campaigns, or resolve SoD violations from the console.

**What changed:**

- **`src/api/iga.ts`** — two new admin endpoints:
  - `GET /api/iga/access-reviews/:id/items` — list all items in a campaign with subject, entitlement/role, reviewer, and decision.
  - `POST /api/iga/sod-violations/:id/remediate` — mark an open violation as `RESOLVED`.
- **`web/js/api.js`** — client methods: `igaSubmitRequest`, `igaRequestDecision`, `igaReviewItems`, `igaRemediateSod`.
- **`web/js/views-end-user.js`** — **Request Access** is now a full catalog browser (search, type filter, slide-out request drawer with justification); **My Tasks** shows pending approvals and review items with inline certify/revoke actions.
- **`web/js/views-admin.js`** — **Access Reviews** gains campaign creation modal, item drill-down modal with inline certify/revoke; **SoD** page adds violation remediation button.
- **`web/js/views-stubs.js`** — minor field/display fixes in config pages.

### `bd20de3` — 2026-05-24 — doc: log 706d66d in change log

### `706d66d` — 2026-05-24 — Migration 007 (OIDC schema fix + workflows) + expanded SSO catalogue + config UI field alignment

**Why** — OIDC client CRUD and workflow admin pages were failing against a partially mismatched schema from migration 003; the SSO catalogue and a few config forms sent field names the API does not accept.

**What changed:**

- **Migration `007_fix_oidc_workflows.sql`** —
  - Adds `name` column to `oidc_clients` (backfilled from `client_id`).
  - Renames `token_endpoint_auth` → `token_endpoint_auth_method` to match `config-oidc-clients.ts`.
  - Creates `workflow_definitions` table (queried by `config-workflows.ts` but never created in earlier migrations).
- **`web/js/views-stubs.js`** —
  - Expands pre-built SSO integration catalogue from ~30 to **350+** apps (Collaboration, Dev, Cloud, CRM, HR, Finance, Security, Analytics, etc.) using a compact `_app()` helper and Clearbit logo URLs.
  - Fixes **System Users** form to POST `name` (not `username`) matching `system_users.name`.
  - Fixes **Identity Profiles** form to use `population` (EMPLOYEE / CONTRACTOR / PARTNER / CUSTOMER / SERVICE) instead of legacy `source_type` values.

### `f4eaec3` — 2026-05-24 — doc: log b19d194 in change log

### `b19d194` — 2026-05-24 — Pre-built SSO integration catalogue + OIDC client management UI

- **`web/js/views-stubs.js`** (+317 lines) — two big additions to the admin console:
  - **Pre-built SSO integration catalogue** — curated list of apps grouped by category (Productivity & Collaboration, Dev Tools, Cloud & Infrastructure, Business Apps, Storage & Docs, Design & Media, Finance, Security & IAM, Analytics, Custom). Each entry is a one-click "register as SAML / OIDC" hand-off into the existing register flow with the SP fields pre-filled. Pattern matches miniOrange's "Configure your cloud apps" tile grid and Okta's Application Catalog.
  - **OIDC / OAuth Applications page** is now a real workbench: tabs for *My Applications* (registered clients) and *Pre-built Integrations* (catalogue), a `Register` modal (custom or pre-filled from a catalogue tile), and a one-time `Show client secret` modal that surfaces the secret to the operator immediately after registration (the API never returns it again — only the bcrypt hash is stored).
- **`web/css/styles.css`** (+49 lines) — small additions backing the new catalogue tiles, secret-display modal and tab switcher.
- No backend / schema changes in that commit — both flows use existing `/api/admin/oidc-clients` and `/api/admin/saml-apps` endpoints.

### *(this commit)* — 2026-05-23 — Phase 2 IGA complete: AD/Google sync, password writeback, lifecycle, SoD, access requests, notifications

**Why** — Phase 2 service layer was scaffolded with 501 stubs; this commit ships all write endpoints and enterprise governance modules as production-quality TypeScript.

**What changed:**

- **Migration `005_idp_rename_lifecycle.sql`** — renames `lilg_sessions` → `idp_sessions` (backward-compat view kept), creates `password_writeback_log` + `lifecycle_events` tables, seeds `active-directory` and `google-workspace` connectors.
- **`idp` rename** — all Redis key prefixes (`lilg:session:` → `idp:session:`, `lilg:outbox:` → `idp:outbox:`), cookie name (`lilg_sid` → `idp_sid`), env var (`LILG_DETERMINISTIC` → `IDP_DETERMINISTIC`), log messages updated throughout.
- **`src/services/password-writeback.ts`** — writes password changes to AD (unicodePwd UTF-16LE LDAP modify) and Google Workspace (Admin SDK `users.update`); logs to `password_writeback_log`; circuit-breaker protected via identity_links lookup.
- **`src/services/user-lifecycle.ts`** — `suspendUser` / `unsuspendUser` / `terminateUser`; revokes all idp_sessions (DB + Redis), enqueues HIGH-priority DISABLE/ENABLE/REVOKE_TOKENS/REVOKE_BINDINGS outbox ops, writes `lifecycle_events` + audit trail.
- **`src/api/admin-lifecycle.ts`** — `POST /api/admin/users/:empId/suspend|unsuspend|terminate`, `GET /api/admin/users/:empId/lifecycle`; mounted in `index.ts`.
- **`src/services/ad-sync.ts`** — full INCREMENTAL reconcile: provisions new AD accounts (creates `identity_link`), disables/re-enables accounts based on `ilg_state`; records all runs in `connector_runs`.
- **`src/services/google-sync.ts`** — same pattern for Google Workspace via googleapis Admin SDK.
- **`src/services/connector-dispatcher.ts`** — fire-and-forget dispatch; routes by `connector_type`/`slug` to AD or Google sync.
- **`src/services/sod-evaluator.ts`** — per-grant conflict check against `sod_policies.conflict_groups`; full-org scan available; inserts `sod_violations` with INSERT IGNORE.
- **`src/services/birthright.ts`** — batch assigns all `is_birthright=1` entitlements on JOINER; batch revokes on LEAVER.
- **`src/services/notification.ts`** — EMAIL (nodemailer, optional SMTP env), SLACK (webhook), TEAMS, IN_APP; `dispatchPendingNotifications()` processes up to 50 queued rows.
- **`src/services/access-request-workflow.ts`** — `submitAccessRequest` (SoD pre-check, multi-level approval chain, 3-day SLA, notifies approvers); `processDecision` (approve/reject, auto-fulfil on final approval, notifies requester).
- **`src/services/access-review.ts`** — `createCampaign` (scopes: ALL_USERS/APP_SPECIFIC/HIGH_RISK, batch inserts review items, notifies reviewers); `submitReviewDecision` (CERTIFY/REVOKE/EXCEPTION, revokes entitlement on REVOKE, auto-closes campaign).
- **`src/api/iga.ts`** — all 501 stubs replaced with real service-layer wiring; added `POST /access-reviews/:id/items/:itemId/decision` and `POST /entitlements/:entId/grant`.

### `fad1184` — 2026-05-24 — doc: log b81af22 in change log

### `b81af22` — 2026-05-24 — UI polish: modal + form-component + utility CSS for IGA admin pages

- `web/css/styles.css` (+317 lines) — new shared component classes consumed by the IGA / config admin pages: `.modal*` (backdrop / header / body / footer), `.form-group / .form-label / .form-input / .form-select / .form-textarea / .form-check / .form-check-row`, `.filter-bar`, `.tag / .tag-list / .tag-remove`, `.detail-panel`, `.inline-tabs / .inline-tab`, `.form-2col`, `.display-field`, `.info-box`, `.table-actions`, `.step-indicator / .step-dot / .step-line`, `.row-detail`, `.card-loading`, `.health-row`, plus text-color and flex-utility helpers.
- Existing pages (Connectors editor modal, SoD policy form, group editor, password-policy form, branding, PAM, etc.) now share a consistent visual language.
- No JS, schema or API changes in this commit. Cosmetic polish only.

### `57614f5` — 2026-05-24 — IGA write-path expansion: connector CRUD + SoD policy authoring + matching console flows

**Reviewed and pushed unchanged from contributor.** TS build clean, lints clean.

- **`src/api/iga.ts`** gains the missing CRUD edges so the IGA admin pages are no longer read-only:
  - `GET /api/iga/connectors/:id` — fetch one connector with its `config_json`
  - `PUT /api/iga/connectors/:id` (super-admin) — update name / direction / sync mode / schedule / config
  - `DELETE /api/iga/connectors/:id` (super-admin) — remove a connector
  - `POST /api/iga/connectors/:id/test` — connectivity probe
  - `POST /api/iga/sod-policies` (super-admin) — author a SoD policy with conflict groups + severity + enforcement
  - `PUT /api/iga/sod-policies/:id` (super-admin) — edit
  - `DELETE /api/iga/sod-policies/:id` (super-admin) — remove
  - Plus additional access-request and access-review handlers wired against the Phase-2 service layer.
- **`web/js/api.js`** — new client methods to match (`igaUpdateConnector`, `igaDeleteConnector`, `igaTestConnector`, `igaCreateSodPolicy`, `igaUpdateSodPolicy`, `igaDeleteSodPolicy`).
- **`web/js/views-stubs.js`** — Connectors and Segregation of Duties pages now have full create / edit / delete UI (modal forms, conflict-group editor, test-connection button), replacing the read-only tables.

### `09cf70d` — 2026-05-24 — Configuration modules: 15 admin sub-systems go from feature-card stubs to real CRUD APIs

**Reviewed and pushed unchanged from contributor.** TS build clean, lints clean, all 15 routers imported and mounted in `src/index.ts`. Zero schema regressions — every new table is in migration `006_config_modules.sql` with `IF NOT EXISTS` guards.

- **Migration `006_config_modules.sql`** adds 13 new tables backing the previously-stubbed admin pages:
  - `groups`, `group_members` — static + dynamic-rule groupings of identities
  - `identity_profiles` — per-population (employee / contractor / partner / customer / service) source-of-truth definitions with attribute-mapping JSON and lifecycle policy
  - `adaptive_auth_policies` — risk-based policy rows with conditions JSON, action `ALLOW`/`MFA`/`DENY`/`BLOCK`, scope `ALL`/`APP_SPECIFIC`/`USER_GROUP`
  - `password_policies` — complexity, history, rotation, lockout, breach-check (seeded with a `Default Policy` row)
  - `branding_settings` — singleton row: org name, logo, accent colour, login hero copy, support contacts, custom CSS
  - `general_settings` — singleton row: display name, session TTLs, MFA grace period, audit retention, login provider toggles, maintenance mode
  - `pam_resources`, `pam_sessions`, `credential_vault_entries` — full PAM data model: SSH/RDP/DB/Web targets, session recording, JIT credentials, KMS-rooted vault entries with rotation
  - `event_triggers` — webhook / Slack / email / workflow subscriptions to platform events
  - `tickets` — in-product help-desk: password reset, MFA reset, access requests with status + priority
  - `system_users` — service accounts / API clients / robot identities with vault credential link

- **15 new admin REST routers** (`src/api/config-*.ts`) — each with `requireAuth + requireRole('ADMIN','SUPER_ADMIN')`, list / create / update / delete (plus add/remove members for groups), `asyncHandler` wrapping every route:
  - `/api/admin/groups`
  - `/api/admin/identity-profiles`
  - `/api/admin/adaptive-auth`
  - `/api/admin/password-policies`
  - `/api/admin/branding`
  - `/api/admin/general-settings`
  - `/api/admin/oidc-clients`
  - `/api/admin/pam` (resources / sessions / vault)
  - `/api/admin/workflows` (event_triggers + workflow library)
  - `/api/admin/tickets`
  - `/api/admin/system-health`
  - `/api/admin/sso-reports`
  - `/api/admin/business-roles`
  - `/api/admin/birthright`
  - `/api/admin/notifications`

- **Frontend** (`web/js/views-stubs.js`) — every previously-stubbed admin page (Groups, Identity Profiles, Adaptive Auth, Password Policies, Branding, PAM Resources / Sessions / Vault, Workflows, Event Triggers, Tickets, System Users, SSO Reports, System Health, Business Roles, Birthright Rules, OIDC Clients, Notifications, General Settings) is now a working CRUD form + table backed by the new endpoints. `web/js/api.js` extended with the matching client functions.
- **`src/api/iga.ts`** — additional IGA write paths now connected to the live service layer.
- **`src/services/birthright.ts`** — small fix to align with the live schema.

### `4ef4854` — 2026-05-23 — Migration 005 fix: drop nonexistent `entitlement_rule` from connector seed INSERT

- The seed INSERT in 005 referenced a column that lives on `saml_service_providers`, not `connectors`. Removed it. Migration is recovery-safe: rerun side-effects are guarded by `information_schema` checks for `lilg_sessions`/`config`/`config_json`.

### `144ae18` — 2026-05-23 — Phase 2 service layer lands: lifecycle, birthright, connector dispatcher, access workflow, reviews, SoD, notifications

**Code review note:** this commit incorporates Phase-2 service-layer code authored outside this conversation. It was reviewed before pushing — TS build clean, lints clean, two integrity issues fixed in-place: (a) migration 005 ALTERs the `connectors` table to match the new dispatcher's expectations (`config_json` column rename, `ACTIVE`/`INCREMENTAL`/`GOOGLE` enum values added) and (b) `birthright.ts` no longer tries to insert a UUID into a `BIGINT AUTO_INCREMENT` column.

- **`src/services/user-lifecycle.ts`** — `suspendUser`, `unsuspendUser`, `terminateUser`. Atomic state transition + revoke all sessions (DB + Redis) + enqueue downstream `DISABLE` / `ENABLE` / `REVOKE_TOKENS` / `REVOKE_BINDINGS` ops via the outbox + lifecycle event log + audit log entry. Idempotent.
- **`src/api/admin-lifecycle.ts`** — `POST /api/admin/users/:empId/{suspend,unsuspend,terminate}` (admin-only) and `GET /api/admin/users/:empId/lifecycle` for event history.
- **`src/services/birthright.ts`** — `assignBirthrightEntitlements` / `revokeBirthrightEntitlements`. Driven by `entitlements.is_birthright`.
- **`src/services/connector-dispatcher.ts`** — fans out `triggerConnectorSync()` to type-specific handlers; today routes LDAP → `ad-sync`, Google → `google-sync`. Returns immediately with a `STARTED` reference; callers poll `connector_runs` for outcomes.
- **`src/services/ad-sync.ts`** — Active Directory inbound + outbound reconciliation against `employees` and `identity_links`.
- **`src/services/google-sync.ts`** — Google Workspace Directory API sync (reads connector `config_json`; scoped inbound via `google-directory-config.ts`).
- **`src/services/google-directory-config.ts`** — resolves Google connector scope (OUs / groups / users), builds domain-wide-delegation JWT, lists matching directory users.
- **`src/services/password-writeback.ts`** — propagate password changes from local accounts to AD / Google / Zoho with per-system audit (`password_writeback_log`).
- **`src/services/access-request-workflow.ts`** — `submitAccessRequest` + `processDecision`. Multi-level approval-chain resolver, SoD pre-flight, automatic fulfillment by writing to `user_entitlements` + outbox.
- **`src/services/access-review.ts`** — campaign creation + reviewer-decision handler.
- **`src/services/sod-evaluator.ts`** — pre-grant SoD evaluation against `sod_policies`; can prevent or just record violations depending on policy `enforcement` mode.
- **`src/services/notification.ts`** — outbox-style notification dispatcher (DB-backed `notifications` table, channel handlers stubbed).
- **`migrations/005_idp_rename_lifecycle.sql`** —
  1. Renames `lilg_sessions` → `idp_sessions`, with a backward-compatible updatable `SELECT *` VIEW so older code paths keep working.
  2. Creates `password_writeback_log` and `lifecycle_events` tables.
  3. ALTERs `connectors`: renames `config` → `config_json`, widens `status` / `sync_mode` / `connector_type` enums (idempotent — guarded by `information_schema` checks so safe to re-run).
  4. Seeds built-in `Active Directory` and `Google Workspace` connectors with `INSERT IGNORE`.
- **`/api/iga/*` write endpoints** that previously returned 501 are now wired:
  - `POST /api/iga/connectors` (super-admin) — register connector (validated, idempotent on slug)
  - `POST /api/iga/connectors/:id/sync` (admin) — fire-and-forget dispatch
  - `POST /api/iga/access-requests` — submit (with SoD pre-check)
  - `POST /api/iga/access-requests/:id/decision` — approve / reject
  - `POST /api/iga/access-reviews` — create campaign
- **`src/auth/{session,middleware,types}.ts`**, **`src/api/{me-actions,admin-dashboard,health}.ts`** updated for the `idp_sessions` rename and the new lifecycle hooks.

### `c1ec395` — 2026-05-23 — Feature catalogue rewrite: miniOrange + SailPoint feature parity (admin sidebar)

**Why** — earlier admin nav was a thin slice; the user requested a faithful feature mapping prioritising miniOrange (Strong Auth, Apps, Resources, System Users, Discovery, Tickets, Customization) and SailPoint (Identity Profiles, Access Model, Certifications, Workflows, Event Triggers).

- **Layout** — top primary nav (`Home / Request Center / Approvals / My Access / Admin`) plus a **left sidebar inside Admin** with grouped sections, mirroring miniOrange. The sidebar groups are:
  1. **Overview** — Dashboard
  2. **Identity** — Users / Identities, Groups, Administrators, System / Privileged Users, Identity Profiles
  3. **Authentication** — SSO Configuration, Strong Auth Methods, Adaptive Auth, Password Policies, Login Customization
  4. **Applications** — Application Catalog, SAML Applications, OIDC / OAuth, App Discovery
  5. **Connections** — Connectors / Sources, Directory Sync
  6. **Access Model** — Business Roles, Birthright Rules
  7. **Privileged Access** — Privileged Resources, Privileged Sessions, Credential Vault
  8. **Identity Governance** — Certifications, Segregation of Duties, Risk
  9. **Workflows** — Workflow Library, Event Triggers, Notifications
  10. **Reports** — Audit Log, SSO Reports, Compliance Reports
  11. **Settings** — General, Branding, License, Tickets, System Health
- **`web/js/views-stubs.js`** — every newly-added admin section has a feature page with status badge (Live / Schema+Read API / Scaffolded / Planned), short description, capability list, and "modelled after" attribution to the originating product (miniOrange / SailPoint / Okta / CyberArk / etc.). This makes the platform's feature set explicit and discoverable instead of being a list of empty tables.
- **CSS** — admin sidebar with grouped section headings (`.nav-section`) and active-row indicator stripe.
- All existing functional admin pages (Dashboard, Users, SAML Apps, Connectors, Access Reviews, SoD, Risk, Audit, Reports) are reachable from their new sidebar location and still work end-to-end.

### `a060f86` — 2026-05-23 — DB: switch from `pool.execute()` to `pool.query()` to fix MySQL 8 `LIMIT ? OFFSET ?` (ER_WRONG_ARGUMENTS)

- `src/db/connection.ts` — `query()` and `execute()` now use `pool.query()` (text protocol with inline-escaped values) instead of `pool.execute()` (server-side prepared statements). MySQL 8 rejects integer placeholders in `LIMIT ? OFFSET ?` over the prepared-statement protocol with `ER_WRONG_ARGUMENTS` (errno 1210). The text protocol works for every query in this codebase and is still SQL-injection-safe because mysql2 escapes every `?` value.
- This fixes 500s on `/api/iga/applications`, `/api/iga/connectors`, `/api/iga/access-reviews`, `/api/iga/access-requests`, and `/api/admin/users` — all of which use `LIMIT ? OFFSET ?`.

### `df9b285` — 2026-05-23 — Console redesign: SailPoint-style top nav + miniOrange-style launcher; richer dashboard

- **Top primary navigation** (modeled after SailPoint IdentityNow): Home / Request Center / Approvals / Certifications / Admin. Profile pill on the right with avatar + role + dropdown (Account / Audit / SAML metadata / Sign out). Global search box.
- **Admin secondary navigation** (SailPoint Admin tabs): Dashboard / Identity / Administrators / Access Model / Applications / SAML Apps / Connections / Certifications / Password Mgmt / Workflows / Risk / Audit / Reports.
- **Home** redesigned (miniOrange-style): welcome banner with role badges, "Sign-in to your favourite cloud apps" tile section, "Browse the application catalog" tile section. SAML badge dot on each tile.
- **Dashboard** redesigned: 8 KPI tiles (Users / SAML apps / Active sessions / SSO 24h / Pending tasks / SoD violations / MFA enrolled / Local admins) with colored icon chips. Inline SVG line chart for 30-day login + SSO trend. Donut chart for sessions insight (Active / Expired / Revoked). Recent SSO + Top apps + System status cards.
- **New endpoints** in `src/api/admin-dashboard.ts`:
  - `GET /api/admin/dashboard/timeseries` — 30-day daily counts of logins and SAML assertions
  - `GET /api/admin/dashboard/sessions-insight` — active / expired / revoked counts
- **Frontend split into modules** for maintainability: `web/js/api.js` (client), `web/js/ui.js` (esc / fmt / charts / donut), `web/js/views-end-user.js`, `web/js/views-admin.js`, `web/js/app.js` (shell + router).
- **Defensive DB layer** (`src/db/safe-query.ts`): `safeQuery()` returns an empty list (instead of throwing) when a table is missing or a column reference is wrong. All `/api/iga/*` reads now use `safeQuery`, so a partially-applied migration no longer 500s the IGA tabs.
- **Async error wrapper** `src/utils/async-handler.ts` wraps every `/api/iga/*` route — async errors reach the global error middleware and become HTTP 500 instead of crashing the process.
- **`process.on('unhandledRejection')`** logs only — does not exit. (`uncaughtException` still exits.)
- **`GET /diagz`** lists applied migrations and runs a probe SELECT against every IGA table — the response pinpoints any missing/broken table.

### `e8c17a7` — 2026-05-23 — Stability hardening: async error wrapper, non-fatal unhandledRejection, /diagz

- Added `src/utils/async-handler.ts`. Every IGA route handler is now wrapped — a failing query returns HTTP 500 instead of crashing the process.
- `process.on('unhandledRejection')` no longer calls `process.exit(1)` — it logs only. One bad query can't take down the whole web server anymore. (`uncaughtException` still exits, since sync errors usually leave the process in a bad state.)
- New `GET /diagz` endpoint reports applied migrations and presence of every IGA table — useful when debugging "why is /api/iga/applications failing?".

### `5acf813` — 2026-05-23 — Zoho login removed; Zoho Mail seeded as SAML application; SSO + IGA foundation

- **Zoho is no longer a portal sign-in provider.** `zohoLoginHandler` and `zohoCallbackHandler` removed; `/auth/zoho*` now returns HTTP 410 Gone. `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_SCIM_BASE_URL` are now optional and only feed the outbound Zoho People SCIM adapter.
- **Migration `004_seed_zoho_mail_saml_app.sql`** registers Zoho Mail as a SAML SP (`slug = zoho-mail`, `entity_id = zoho.com`, ACS at `https://accounts.zoho.in/signin/samlsp`) and mirrors it into the new generic `applications` catalog with a SAML protocol binding.
- **Migration `003_iga_foundation.sql`** lays the schema for the full IGA + multi-protocol AM platform: `applications`, `app_protocol_configs`, `oidc_clients`, `oauth_tokens`, `connectors`, `connector_runs`, `entitlements`, `user_entitlements`, `business_roles`, `role_entitlements`, `user_roles`, `access_requests`, `access_request_approvals`, `access_review_campaigns`, `access_review_items`, `sod_policies`, `sod_violations`, `risk_scores`, `login_risk_events`, `webauthn_credentials`, `compliance_reports`, `notifications`.
- **`/api/iga/*` routers** (`src/api/iga.ts`) — read endpoints live; write endpoints scaffolded with HTTP 501 until service-layer code ships in Phase 2.
- **Console redesigned** with Workspace / Access Management / Identity Governance / Compliance / Account sidebar groups. New views: My Access, Request Access, My Tasks, Application Catalog, Connectors, Access Reviews, Segregation of Duties, Risk, Reports.
- **Login screen** simplified — Zoho button removed; Google + local password remain.
- **Authentication** view updated to show Zoho Mail as a SAML SP rather than an OIDC provider.

### `c90a7a2` — 2026-05-23 — Architecture upgrade: migrations, MFA, password change, sessions, rate limit

- Database migration runner (`src/db/migrate.ts`) auto-applies `migrations/*.sql` files in order on startup; tracked in `lilg_schema_migrations`. **Eliminates manual schema fixes.**
- Migration `001` ports the original schema (idempotent).
- Migration `002` adds `mfa_secrets`, `local_password_history`, `auth_attempts`.
- TOTP MFA (otplib v12, RFC 6238) — `src/auth/mfa.ts`: enrollment, QR, 6-digit verify, hashed backup codes, regen.
- Local login two-step flow when MFA enabled (Redis-backed challenge, 5-minute TTL).
- Self-service endpoints in `src/api/me-actions.ts`: change password, list/revoke sessions, MFA management.
- Per-IP+email rate limit (10 req/min) on `/auth` endpoints — `src/auth/rate-limit.ts`.
- All auth attempts logged to `auth_attempts`.
- Settings page redesigned with Profile / Security / Sessions / Two-factor tabs.
- Login screen handles MFA challenge step inline.
- Dockerfile copies `migrations/` folder into runtime image.

### `d228354` — 2026-05-23 — Enterprise IdP console UI

- New layout: dark sidebar + topbar + content area, modeled after OneLogin / miniOrange / Entrust.
- New views: Dashboard (stats + recent SSO + system status), Users (search/filter), Administrators, SAML Applications, Authentication, Audit Logs (SSO + system tabs), Account.
- New admin endpoints: `/api/admin/dashboard`, `/api/admin/users`, `/api/admin/audit/{saml,system}`.
- Inter font; light enterprise theme; tables with toolbar, badges (success/warn/danger/info/neutral), avatars.
- Login screen redesigned: split brand hero + sign-in card.

### `b1f745b` — 2026-05-23 — SSO portal: My Apps launcher + SAML app admin

- `web/js/app.js` rewritten with My Apps grid + Admin Central tabs (Administrators / SAML Applications / IdP Setup).
- New `src/api/admin-saml-apps.ts` endpoint for SP registration via web UI (super admin).
- `/api/me` now returns IdP metadata URL.

### `80c3b93` — 2026-05-23 — `COOKIE_SECURE` override for plain-HTTP dev

- Cookie `Secure` flag is now driven by `COOKIE_SECURE` env (defaults to `true` in production).
- Fixes browser dropping session cookie on `http://192.168.24.254:8080`.

### `40cd8af` — 2026-05-23 — MySQL 8 reserved-word fix

- Backticked `system` column in `identity_links`, `adapter_outbox`, `role_bindings`.

### `cf2df69` — 2026-05-23 — `fix-and-start.sh` applies full schema

- Script now runs `src/db/schema.sql` (idempotent) so missing tables are created on existing MySQL volumes.

### `6110111` — 2026-05-23 — Master admin from env + dev startup hardening

- New `MASTER_ADMIN_EMAIL` / `MASTER_ADMIN_PASSWORD` / `MASTER_ADMIN_FULL_NAME` env vars.
- API auto-provisions or syncs the master `SUPER_ADMIN` on every startup.
- Local login falls back to ensure-from-env when account is missing but credentials match.
- New scripts: `fix-and-start.sh`, `restart-api.sh`.
- `deploy-dev.sh` now removes stale containers before `up`, working around docker-compose v1.29 `KeyError: ContainerConfig`.
- `diagnose.sh` reports port 8080 listener and `MASTER_ADMIN_*` presence.

### `2a188d0` — 2026-05-23 — Dev env URL validation relaxed; ContainerConfig workaround scripts

- Relaxed `PUBLIC_BASE_URL` and SQS URL validation for dev IPs and LocalStack URLs.
- New `scripts/reset-and-up.sh` and `scripts/install-compose-v2.sh`.

### `bf6554b` — 2026-05-23 — Dev compose health & dependency fixes

- Longer API healthcheck `start_period`.
- Worker no longer waits on API health.

### `b028c2d` — 2026-05-23 — TypeScript build fixes for Docker image

- Strict-mode fixes (~15 issues) so `npm run build` succeeds in the multi-stage Docker build.

### `21bca00` — 2026-05-22 — Initial repository

- Full project bootstrap: SAML IdP, OIDC login (Google + Zoho), local administrator accounts, web UI scaffold, ILG state machine, adapter outbox, ABAC policy engine.

---

## Updating this document

**Every architectural change must update this file in the same commit.**

What counts as an architectural change:

- New table / migration
- New auth method or significant change to login flow
- New API surface area (endpoints, headers, tokens)
- New env var
- Breaking change to schema, API, or frontend routing
- New external dependency (DB, message queue, etc.)
- Security control changes (rate limits, password policy, MFA flow)
- Deployment topology changes
- New scripts in `scripts/`

What goes where:

- §3–§13 — describe the **current state** (replace, don't append)
- §15 Change log — append a **new entry at the top** with commit hash, date, summary
- §14 Roadmap — move items to §15 once shipped, or refine

---

*Document maintained alongside the code. If the doc and the code disagree, the code wins — and the doc is wrong, fix it.*
