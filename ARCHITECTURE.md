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

Lenskart IdP is a single platform that combines two product surfaces, modelled on best-of-breed enterprise IAM:

**Access Management (compare: OneLogin, miniOrange, Entrust Identity)**
- Multi-protocol SSO: SAML 2.0 (live), OIDC OP, WS-Federation, header-based (planned)
- Inbound federation: Google Workspace OIDC (live)
- Local password + TOTP MFA (live), WebAuthn / passkeys (planned)
- Adaptive / risk-based authentication
- Application launcher portal for end users

**Identity Governance & Administration (compare: Saviynt, SailPoint IdentityIQ, RSA IGA)**
- Joiner / Mover / Leaver lifecycle (driven by HRMS feed)
- Application catalog with entitlements and birthright access
- Pluggable connector framework for target system provisioning / reconciliation
- Self-service access request → multi-level approval → automated fulfillment
- Periodic access review / certification campaigns
- Segregation-of-Duties policies and violation detection
- Risk scoring (per-identity and per-login)
- Tamper-evident audit trail and compliance reports (SOX / GDPR / etc.)

> **Deliberate non-goals (for now):** privileged-access vaulting, session recording, mobile push-MFA — see [Roadmap §14](#14-roadmap).

> **Authentication note (May 2026):** Zoho is **not** a sign-in provider for this portal. Zoho Mail is consumed as a **SAML application** (this IdP issues assertions to `zoho.com`). End users sign in with local password or Google Workspace OIDC, then click the Zoho Mail tile in *My Applications*.

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
| `identity_links` | External system → employee mapping |
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
| `oidc_clients` | **(003)** Registered OIDC RP clients (issuer endpoints pending) |
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
| `workflow_definitions`, `workflow_runs` | Generic workflow runs |
| `compliance_reports` | **(003)** Generated SOX / GDPR / HIPAA reports |
| `notifications` | **(003)** Email / Slack / Teams notification outbox |

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
| `GET` | `/api/admin/users` | Employee + admin list (search, filter) |
| `GET`/`POST`/`DELETE` | `/api/admin/local-users[/:id]` | Local admin CRUD |
| `GET`/`POST`/`DELETE` | `/api/admin/saml-apps[/:id]` | SAML SP registry |
| `GET` | `/api/admin/audit/saml` | SAML assertions log |
| `GET` | `/api/admin/audit/system` | `audit_log` rows |

### 8.5 IGA + multi-protocol AM (live read APIs; write paths return 501 until service layer ships)

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/api/iga/applications[/:id]` | Protocol-agnostic application catalog |
| `GET` | `/api/iga/connectors` | Target-system connectors |
| `POST` | `/api/iga/connectors` | Register connector (501) |
| `GET` | `/api/iga/connectors/:id/runs` | Connector run history |
| `POST` | `/api/iga/connectors/:id/sync` | Trigger sync (501) |
| `GET` | `/api/iga/entitlements[?appId=…]` | Entitlement catalog |
| `GET` | `/api/iga/entitlements/me` | My current entitlements |
| `GET` | `/api/iga/access-requests?scope=mine\|tasks\|all` | List access requests by scope |
| `POST` | `/api/iga/access-requests` | Submit request (501) |
| `POST` | `/api/iga/access-requests/:id/decision` | Approve / reject (501) |
| `GET` | `/api/iga/access-reviews` | Active certification campaigns |
| `GET` | `/api/iga/access-reviews/me` | Review items routed to me |
| `POST` | `/api/iga/access-reviews` | Create campaign (501) |
| `GET` | `/api/iga/sod-policies` | SoD policy registry |
| `GET` | `/api/iga/sod-violations?status=…` | Detected violations |
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

- **Login screen** — split: brand hero (gradient) + sign-in card. MFA challenge step renders inline when needed.
- **Console** — fixed dark sidebar + topbar + content area.

Sidebar layout:

**Workspace** (every user)
- Dashboard *(admin only)* — stat cards, recent SSO, system status
- My Applications — SAML launcher tiles
- My Access — current entitlements / roles
- Request Access — catalog browser (foundation; UI ships next)
- My Tasks — pending approvals + review items

**Access Management** (admin only)
- SAML Applications
- Application Catalog *(generic registry)*
- Connectors *(target-system adapters)*
- Authentication *(IdP & inbound providers)*

**Identity Governance** (admin only)
- Users
- Administrators *(super admin only)*
- Access Reviews
- Segregation of Duties
- Risk

**Compliance** (admin only)
- Audit Logs *(SSO + system audit tabs)*
- Reports

**Account** (every user)
- Settings — Profile / Security / Sessions / Two-factor

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

```bash
ssh pam-2
cd /opt/idp
git pull
sudo bash scripts/fix-and-start.sh
```

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
# Status
docker ps --filter name=idp-

# Logs
docker logs idp-api --tail 100 -f
docker logs idp-worker --tail 100 -f

# Restart only the API after pulling new code
docker-compose -f docker-compose.dev.yml stop lilg-api
docker rm -f idp-api
docker-compose -f docker-compose.dev.yml up -d --build --no-deps lilg-api

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
| `KeyError: 'ContainerConfig'` on `up -d` | docker-compose 1.29 + new Docker Engine | `docker rm -f idp-api` then `up -d` again, or run `scripts/fix-and-start.sh`, or install Compose v2 (`scripts/install-compose-v2.sh`) |
| Browser login appears to fail (no redirect) | `Secure` cookie flag rejected over HTTP | `COOKIE_SECURE=false` in `.env` |
| `Table 'lilg.lilg_sessions' doesn't exist` | Pre-migration MySQL volume | Restart API — migrations apply automatically |
| `Configuration validation failed` at boot | Missing/invalid env var | Read message; `SESSION_SECRET` must be ≥32 chars, `INTERNAL_TOKEN` ≥16 |

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

### Phase 2 — IGA Foundation **(in progress — schema landed, services next)**

- ✅ Schema for applications, connectors, entitlements, roles, access requests, reviews, SoD, risk, reports, notifications (`migrations/003_iga_foundation.sql`)
- ✅ Read APIs at `/api/iga/*`; new sidebar sections
- ⏳ Approval-chain resolver for `POST /api/iga/access-requests`
- ⏳ Birthright entitlement engine (assign/revoke on lifecycle events)
- ⏳ Connector dispatcher — adapter outbox already exists; add a connector-typed handler and per-type executors
- ⏳ Access review campaign generator + reviewer UI
- ⏳ SoD evaluator (runs on entitlement grant; populates `sod_violations`)
- ⏳ Risk engine (location / device / velocity heuristics → `login_risk_events`, `risk_scores`)
- ⏳ Notification dispatcher (Email / Slack)

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

### *(this commit)* — 2026-05-23 — Console redesign: SailPoint-style top nav + miniOrange-style launcher; richer dashboard

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
