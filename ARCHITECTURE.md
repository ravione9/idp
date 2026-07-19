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
The IdP signing keys used by SAML are stored on named volume `saml-keys` mounted at `/app/data/saml` to keep certificate fingerprints stable across API container rebuilds.

---

## 5. Authentication & sessions

### 5.1 Sign-in methods

| Method | Endpoint | Status |
|---|---|---|
| Local password | `POST /auth/local/login` | Live |
| AD-synced corporate password | `POST /auth/local/login` (LDAP bind fallback when no `local_accounts` row) | Live |
| Local password + TOTP | `POST /auth/local/login` then `POST /auth/local/login/mfa-verify` | Live |
| Google Workspace OIDC | `GET /auth/google` → `GET /auth/google/callback` | Live (env defaults + optional Admin GUI DB override) |
| WebAuthn / passkeys | — | Schema staged in migration 003; routes pending |
| Risk-based MFA step-up | `POST /auth/local/login` (engine in `src/services/adaptive-auth-engine.ts`) | Live |

> **Removed:** Zoho OIDC was an inbound sign-in provider in the original design. It has been removed — Zoho Mail is now consumed as a SAML application (see §6.4). The legacy `/auth/zoho` endpoints respond with HTTP 410 Gone.

Google OIDC credentials are resolved in this order:
1. `general_settings.google_oidc_*` (set from **Admin → Authentication**)
2. `.env` fallback (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_HOSTED_DOMAIN`)

**Multi-domain Workspace tenants:** `google_oidc_hosted_domain` and the Google Directory connector **Workspace domains** field accept multiple domains (comma or newline separated, e.g. `lenskart.com`, `lenskart.in`, `dealskart.in`). Portal Google sign-in validates the user’s email domain against the merged allowlist (Authentication settings + active `google-workspace` connector). Directory sync uses `customer: my_customer` and imports users from all domains on the tenant when sync scope is blank.

### 5.2 Session model

- Sessions are stored in **MySQL** (`idp_sessions`) and cached in **Redis** (`idp:session:<id>`).
- Session ID = `uuid v4`. Cookie value is `<id>.<HMAC-SHA256(SESSION_SECRET, id)>` (base64url).
- TTL: 8 hours (corporate) / 12 hours (store) — configurable via env.
- Cookie flags: `HttpOnly`, `SameSite=Lax`. `Secure` is on in production but **off** when `COOKIE_SECURE=false` (dev plain HTTP).
- Each session records **public IP** (`ip`), **device** (`device_info`), and **location** (`geo_location`). Gmail-style attribution — no workstation agent required:
  1. **`device_info`** — parsed from the `User-Agent` at login time (e.g. `Chrome · Windows 10/11`). Always populated synchronously.
  2. **`ip`** — client public IP via `getClientIp()` (`CF-Connecting-IP` → first `X-Forwarded-For` hop → socket).
  3. **`geo_location`** — async IP geolocation after login (e.g. `Mumbai · India` via ip-api.com). Fire-and-forget; never blocks login.
- Migrations **`024_drop_client_mac.sql`** and **`025_session_geo_device.sql`** removed agent-dependent columns (`client_hostname`, `client_local_ip`, `client_mac`).

### 5.3 Master administrator

A bootstrap account is provisioned from `MASTER_ADMIN_EMAIL` + `MASTER_ADMIN_PASSWORD` on every startup. Password is synced (re-hashed) when the env value changes.

### 5.4 MFA (TOTP)

- Per-user secret in `mfa_secrets` (Base32, 160-bit).
- 8 single-use **backup codes** (8 hex chars), bcrypt-hashed at rest.
- MFA is required when **any** of these conditions match:
  - adaptive engine returns `MFA` / `STEP_UP`
  - user already has active MFA (`mfa_secrets.enabled = 1`)
  - user-level enforcement (`employees.mfa_enforced = 1`)
  - global policy `mfa_policy.global_enforce = true`
  - admin policy `mfa_policy.enforce_for_admins = true` and role is `ADMIN` / `SUPER_ADMIN`
- Group exclusions: `mfa_policy.excluded_group_ids` (JSON group-id array) bypasses **global/admin policy MFA** for matching users, but does not bypass adaptive risk MFA or explicit per-user enforcement.
- Login flow when MFA is enabled:
  1. `POST /auth/local/login {email, password}` → returns `{mfaRequired:true, challengeId}`.
  2. UI prompts for 6-digit code (or backup code).
  3. `POST /auth/local/login/mfa-verify {challengeId, code}` → session issued.
- Login flow when MFA is **required but not yet enrolled**:
  1. `POST /auth/local/login {email, password}` → returns `{enrollRequired:true, enrollChallengeId, gracePeriodHours, graceActive}` (password verified; no session yet).
  2. UI shows QR / manual secret via `POST /auth/local/login/mfa-enroll {enrollChallengeId}` (no auth cookie required).
  3. User confirms TOTP → `POST /auth/local/login/mfa-enroll/confirm {enrollChallengeId, code}` → MFA enabled, backup codes returned, session issued.
  4. User may defer → `POST /auth/local/login/mfa-enroll/defer {enrollChallengeId}` → returns to sign-in without a session, or issues a session during the policy **grace period** (`mfa_policy.grace_period_hours`, tracked in Redis from first required login).
- MFA verify and enroll challenges live in Redis with 5-minute TTL.

### 5.5 Rate limiting

`/auth/local/login`, `/auth/local/login/mfa-verify`, `/auth/local/login/mfa-enroll`, `/auth/local/login/mfa-enroll/confirm`, and `/auth/local/login/mfa-enroll/defer` are rate limited at **10 requests / minute / (IP+email or IP+challenge)** via in-process sliding window (`src/auth/rate-limit.ts`).
Every attempt (success or failure) is logged to `auth_attempts` for forensics.

### 5.6 Adaptive / Risk-based Authentication

**Engine:** `src/services/adaptive-auth-engine.ts` — evaluates active policies from `adaptive_auth_policies` against a `LoginContext` and returns the highest-severity matching action.

**Decision priority:** `BLOCK > STEP_UP > MFA > ALLOW`

**Authentication logic matrix:**

| Condition | Action |
|---|---|
| Corporate Network + Managed Device + Risk Score < 30 | ALLOW (primary auth only) |
| External Network + Managed Device | MFA |
| External Network + Unmanaged Device | STEP_UP (MFA + device-verification flag) |
| High-Risk Country (`CN`, `RU`, `KP`, `IR`, `BY`, `CU`, `SD`, `SY`, `VE`, `LY`, `MM`, `AF`) | BLOCK |
| TOR exit node / anonymous proxy IP | BLOCK |
| Impossible travel (country changed in < 4 h since last session) | MFA |
| New / unrecognised device | MFA |
| Risk score ≥ 60 | STEP_UP |
| Sensitive app (`Finance`, `HR`, `ERP`, `CRM`, `PAM`, `Administration`) + external network | MFA |
| Privileged role (`ADMIN`, `SUPER_ADMIN`, `IT_OPS`, `SECURITY`) | MFA (hard-coded override regardless of policies) |
| Any unmatched external login (catch-all, priority 999) | MFA |

**Supported condition types** (stored as JSON in `adaptive_auth_policies.conditions_json`):

| Type | Parameters |
|---|---|
| `IP_RANGE` | `values: string[]` — CIDR or dot-prefix list |
| `NETWORK_TYPE` | `values: ('CORPORATE'\|'EXTERNAL'\|'TOR'\|'PROXY')[]` |
| `DEVICE_MANAGED` | `value: 'true'\|'false'` — corporate IP proxies managed status |
| `NEW_DEVICE` | *(no extra fields)* |
| `IMPOSSIBLE_TRAVEL` | *(no extra fields)* |
| `COUNTRY` | `op: 'in'\|'not_in'`, `values: string[]` — ISO 3166-1 alpha-2 |
| `USER_ROLE` | `values: string[]` |
| `RISK_SCORE` | `op: 'gt'\|'gte'\|'lt'\|'lte'`, `value: number` (0–100) |
| `SENSITIVE_APP` | *(no extra fields)* — matches apps in sensitive categories |
| `TOR_PROXY` | *(no extra fields)* — ip-api.com `proxy` flag |

**Risk score signals** (computed per login, additive):

| Signal | Score contribution |
|---|---|
| New device | +20 |
| High-risk country | +30 |
| TOR / proxy IP | +30 |
| Hosting/datacenter egress IP | +10 |
| Impossible travel | +25 |

**Login flow with adaptive auth (`POST /auth/local/login`):**

1. Password verified (local hash or AD fallback).
2. Adaptive engine evaluates context → `ALLOW / MFA / STEP_UP / BLOCK`.
3. `BLOCK` → HTTP 403 `ADAPTIVE_BLOCKED` — login rejected immediately.
4. `MFA` or `STEP_UP` → MFA challenge issued (`{mfaRequired:true, challengeId, stepUp}`).
   - If user has not enrolled TOTP → `{enrollRequired:true, enrollChallengeId}` and inline enrollment UI (QR + confirm).
5. `ALLOW` and user has TOTP enrolled → MFA challenge issued (preserves existing voluntary MFA).
6. `ALLOW` and no TOTP → session issued directly.

**`STEP_UP`** means MFA **plus** a manager-approval workflow is recommended. The `stepUp: true` flag is returned to the frontend so it can display an additional notice; the auth flow itself still requires TOTP.

**Geo detection:** ip-api.com free tier (synchronous, 4 s timeout). Private/RFC-1918 IPs are treated as corporate and skip the geo call. Country data written to `idp_sessions.geo_location` by the async `enrichSessionGeo` helper (fire-and-forget after session creation).

**Default policies** are seeded by migration `027_adaptive_auth_enhancements.sql` and are editable via **Admin → Adaptive Auth Policies**.

---

## 6. SAML 2.0 IdP

### 6.1 Endpoints

| Endpoint | Purpose |
|---|---|
| `GET  /saml/metadata` | IdP metadata XML (ADMIN+ session required; shared with SP admins during onboarding) |
| `GET/POST /saml/sso` | SP-initiated SSO (`AuthnRequest` via Redirect or POST binding) |
| `GET  /saml/resume/:pendingId` | Resume SP-initiated SSO after portal sign-in (pending `AuthnRequest` in Redis) |
| `GET  /saml/launch/:slug` | IdP-initiated launch (browser → app tile click) |

**Unauthenticated SP-initiated flow:** when `/saml/sso` receives an `AuthnRequest` without a session, the IdP stores the request in Redis (5 min TTL) and redirects to `/login?returnTo=/saml/resume/<id>`. The user signs in with **local password** or **Google OIDC**; after auth, the browser hits `/saml/resume/<id>`, which replays the stored request and posts the SAML assertion to the SP ACS.

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

**Launch entitlement** (`canUserLaunchApp` in `src/services/app-access-policy.ts`) is evaluated for `GET /api/apps`, `/saml/launch/:slug`, and SP-initiated SSO:

| Condition | Who may launch |
|---|---|
| `applications.visibility = RESTRICTED` **or** any active `app_access_assignments` for the app | Only users with an explicit Application Access Policy grant (user, identity group, or tag group) |
| Otherwise | SAML `entitlement_rule` **or** an Application Access Policy grant |

Apps can be registered:
- Via UI: **Admin Central → SAML Applications → Register new SAML application** (super admin only)
- Via internal API: `POST /api/internal/saml` with `X-Internal-Token`

### 6.3 Assertion log

Every assertion issued is recorded in `saml_assertion_log` (sp_id, emp_id, binding, ts). Used by **Audit Logs → SSO assertions**.

### 6.4 Pre-seeded SAML applications

| Application | Slug | Entity ID | ACS URL | Notes |
|---|---|---|---|---|
| **Zoho Mail** | `zoho-mail` | `zoho.com` | `https://accounts.zoho.in/signin/samlsp` | Seeded in migration `004_seed_zoho_mail_saml_app.sql`; policy-gated in `017_zoho_policy_gated_access.sql` (`visibility = RESTRICTED`, `entitlement_rule.all_active = false`). Grant access via **Application Access Policy** before users see the tile. After the IdP signing keys are present in `.env`, paste the metadata at `/saml/metadata` into Zoho's SAML configuration. |

Add more apps via **Admin Central → SAML Applications → Register new SAML application** or `POST /api/internal/saml`.

---

## 7. Database & migrations

### 7.1 Migration system

- Folder: `migrations/NNN_name.sql`
- Runner: `src/db/migrate.ts` — runs on startup before listening.
- Tracking: `lilg_schema_migrations(name, checksum, applied_at, duration_ms)`.
- Each file is executed as a single multi-statement batch (the runner opens a connection with `multipleStatements: true`).
- Compatibility fallback: if MySQL rejects `ADD COLUMN IF NOT EXISTS` with `ER_PARSE_ERROR`, the runner retries that migration statement-by-statement and emulates `IF NOT EXISTS` via `information_schema.COLUMNS` checks before each `ALTER TABLE ... ADD COLUMN`.
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
| `access_requests` | **(003)** Self-service access requests — `item_type` includes `APP_ACCESS` (013) |
| `access_request_approvals` | **(003)** Multi-level approval chain |
| `tag_groups` | **(013)** Tag-based groups for application access policy |
| `tag_group_members` | **(013)** Membership in tag groups |
| `app_access_assignments` | **(013, 018)** User, identity-group (`GROUP`), or tag-group (`TAG_GROUP`) grants to applications |
| `app_group_access_workflows` | **(013)** Configurable approval chains for group access requests |
| `app_access_audit_log` | **(013)** Audit trail for assignments, requests, approvals, provisioning, revocations |
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
| `workflow_runs` | **(028)** Execution history for workflow_definitions (status, step progress, errors) |
| `attendance_iga_config` | **(029, 030)** Singleton config: source (REST API / SFTP / file upload), API auth, SFTP credentials (`sftp_config`), polling interval, cutoff, approval, connector actions |
| `attendance_iga_rules` | **(029)** Configurable rules A–H (action + ignore types) with priority |
| `attendance_iga_exclusions` | **(029)** VIP users, departments, individual employees to skip |
| `attendance_iga_import_runs` | **(029)** Import run metadata + aggregate report counters |
| `attendance_iga_staging` | **(029)** Temporary validated attendance rows per import run |
| `attendance_iga_evaluations` | **(029)** Rule engine output per employee per run |
| `attendance_iga_approvals` | **(029)** Optional approval queue (approve / reject / skip) before execution |
| `attendance_iga_executions` | **(029)** SSO actions taken + rollback snapshot JSON |
| `attendance_iga_rollback_log` | **(029)** Admin rollback audit trail |
| `event_triggers` | **(006)** Webhook / Slack / email subscriptions fired on platform events |
| `compliance_reports` | **(003)** Generated SOX / GDPR / HIPAA reports |
| `notifications` | **(003, 011)** Email / Slack / Teams notification outbox — 011 adds `recipient_emp_id`, `subject`, `body`, `template_id`, `reference_id`, `reference_type`, `error` for service layer |
| `general_settings` | **(006, 012, 021)** Singleton operational settings (login toggles, maintenance mode, portal TLS certs, Google OIDC GUI overrides) |

> The legacy `src/db/schema.sql` is **still present** for reference; it is NOT applied automatically — the `migrations/` folder is authoritative.

---

## 8. API surface

### 8.1 Public (no auth)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness (DB + Redis) |
| `GET` | `/metrics` | Prometheus metrics |

### 8.2 Auth

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/local/login` | Local password (returns session OR MFA challenge OR enroll challenge) |
| `POST` | `/auth/local/login/mfa-verify` | Submit TOTP / backup code |
| `POST` | `/auth/local/login/mfa-enroll` | Start TOTP enrollment during login (QR + secret; no session) |
| `POST` | `/auth/local/login/mfa-enroll/confirm` | Confirm TOTP during login → enable MFA + issue session |
| `POST` | `/auth/local/login/mfa-enroll/defer` | Defer enrollment (sign in during grace period, or return to login) |
| `GET`  | `/auth/google` `/auth/google/callback` | Google Workspace OIDC |
| `POST` | `/auth/logout` | End current session |
| `GET`  | `/auth/zoho` `/auth/zoho/callback` | **Removed** — returns HTTP 410 Gone (Zoho Mail is now a SAML SP) |

### 8.3 Self-service (auth required)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/me` | Current user + capabilities |
| `PUT` | `/api/me/password` | Change own password |
| `GET` | `/api/me/sessions` | List own active sessions (IP, device, location) |
| `DELETE` | `/api/me/sessions/:id` | Revoke a session |
| `GET` | `/api/me/mfa` | MFA status |
| `POST` | `/api/me/mfa/enroll` | Start TOTP enrollment (returns QR) |
| `POST` | `/api/me/mfa/confirm` | Verify code → enable MFA |
| `POST` | `/api/me/mfa/disable` | Disable MFA |
| `POST` | `/api/me/mfa/regenerate-codes` | New backup codes |
| `GET` | `/api/apps` | SAML apps the user may launch (policy grants + entitlement rules; see §6.2) |

### 8.4 Admin (ADMIN / SUPER_ADMIN)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/dashboard` | Aggregate stats |
| `GET` | `/api/admin/users` | Paginated employee list (search, state, identity source filter). By default returns only portal-accessible users (`ACTIVE`, `REACTIVATED`); pass `includeInactive=1` or `state=SUSPENDED` to include suspended accounts |
| `GET` | `/api/admin/users/:empId` | Full profile: employee, identity links, sessions, password writeback log |
| `POST` | `/api/admin/users/local` | Create local employee + password account |
| `PATCH` | `/api/admin/users/:empId/role` | Assign/revoke portal administrator access (`local_accounts` only; does not change job designation) |
| `GET` | `/api/admin/users/:empId/mfa` | Admin MFA status for a specific user |
| `POST` | `/api/admin/users/:empId/mfa/enroll` | Start user MFA enrollment (returns QR + secret) |
| `POST` | `/api/admin/users/:empId/mfa/confirm` | Confirm user MFA with 6-digit code |
| `POST` | `/api/admin/users/:empId/mfa/disable` | Disable MFA for a user |
| `POST` | `/api/admin/users/:empId/mfa/regenerate-codes` | Regenerate user MFA backup codes |
| `POST` | `/api/admin/users/:empId/mfa/enforce` | Set/clear per-user MFA enforcement |
| `GET` | `/api/admin/users/mfa-policy` | Read global MFA policy |
| `POST` | `/api/admin/users/mfa-policy` | Update global MFA policy (`global_enforce`, `enforce_for_admins`, `grace_period_hours`, `excluded_group_ids`) |
| `POST` | `/api/admin/users/:empId/reset-password` | Admin password reset with AD/Google writeback |
| `POST` | `/api/admin/users/:empId/link-identity` | Attach an external identity link |
| `DELETE` | `/api/admin/users/:empId/identity-links/:linkId` | Remove an identity link |
| `POST` | `/api/admin/bulk-users/batch` | Bulk create/update employees and add to local groups (max 500 rows per request; clients chunk up to 100,000 total) |
| `GET`/`POST`/`DELETE` | `/api/admin/local-users[/:id]` | Local admin CRUD |
| `GET`/`POST`/`DELETE` | `/api/admin/saml-apps[/:id]` | SAML SP registry |
| `GET` | `/saml/metadata` | IdP metadata XML (ADMIN+ session) |
| `POST` | `/api/admin/saml-apps/parse-metadata` | Parse uploaded SP metadata XML → entity ID, ACS, SLO, NameID format |
| `GET`/`PUT` | `/api/admin/general-settings/google-oidc` | Read/update Google inbound OIDC credentials (SUPER_ADMIN) |
| `GET` | `/api/admin/audit/saml` | SAML assertions log |
| `GET` | `/api/admin/audit/system` | `audit_log` rows |
| `GET` | `/api/admin/app-access-policy/summary` | Assignment / workflow / audit counts |
| `GET` | `/api/admin/app-access-policy/applications` | Assignable apps (IGA catalog + auto-mirrored SAML SPs) |
| `GET`/`POST` | `/api/admin/app-access-policy/tag-groups[/:id]` | Tag group CRUD |
| `POST`/`DELETE` | `/api/admin/app-access-policy/tag-groups/:id/members[/:empId]` | Tag group membership |
| `GET`/`POST`/`DELETE` | `/api/admin/app-access-policy/assignments[/:id]` | User, identity-group, or tag-group application grants |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/admin/app-access-policy/workflows[/:id]` | Group access approval workflows |
| `GET` | `/api/admin/app-access-policy/audit` | Application access policy audit log |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/admin/workflows/definitions[/:id]` | Workflow library CRUD (trigger event + ordered steps) |
| `GET` | `/api/admin/workflows/runs` | Workflow execution history |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/admin/workflows/triggers[/:id]` | Event trigger CRUD (webhook / Slack / email on platform events) |
| `GET` | `/api/admin/attendance-iga/dashboard` | Attendance IGA dashboard stats (imports, suspensions, approvals, connector health) |
| `GET`/`PUT` | `/api/admin/attendance-iga/config` | Read/update attendance source, rules config, approval, notifications |
| `GET`/`PUT` | `/api/admin/attendance-iga/rules[/:id]` | List/update rule definitions (A–H) |
| `GET`/`POST`/`DELETE` | `/api/admin/attendance-iga/exclusions[/:id]` | VIP / department / employee exclusions |
| `GET` | `/api/admin/attendance-iga/imports[/:id/staging]` | Import run history + staging rows |
| `POST` | `/api/admin/attendance-iga/run` | Manual pipeline run (REST API, CSV upload, or evaluation-only) |
| `GET`/`POST` | `/api/admin/attendance-iga/approvals[/:id/decision]` | Pending approvals; approve / reject / skip |
| `GET`/`POST` | `/api/admin/attendance-iga/executions[/:id/rollback]` | Execution audit + rollback |
| `GET` | `/api/admin/attendance-iga/rollbacks` | Rollback history |

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
| `GET` | `/api/iga/entitlements[?appId=…]` | Entitlement catalog (any authenticated user — Request Access) |
| `GET` | `/api/iga/entitlements/me` | My current entitlements |
| `GET` | `/api/iga/roles` | Active business roles for Request Access catalog |
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
| `POST` | `/api/internal/attendance-iga/run` | Attendance IGA pipeline (scheduler / Airflow; same body as admin `/run`) |
| `POST` | `/api/internal/risk-scan` | Legacy attendance risk FSM scan — **skipped when Attendance IGA `enabled=1`** (IGA owns suspensions) |
| `POST` | `/api/internal/ingest/truein` | Legacy Truein ingest into `attendance_events` — prefer Attendance IGA when enabled |
| Various | `/api/internal/*` | Airflow / automation hooks |

**Attendance ownership:** when Attendance IGA is enabled, use that pipeline for Truein/SFTP fetch + suspensions. Keep Airflow on `/attendance-iga/run`; do not also schedule `/risk-scan` for the same attendance gap policy.

---

## 9. Frontend (web console)

### 9.1 Files

```
web/
├── index.html        ← single page, loads app.js as ES module
├── css/styles.css    ← enterprise design system (tokens, shell, primitives, .ent-*)
└── js/app.js         ← SPA: router, views, API client
```

**Visual system** — IBM Plex Sans / Mono; cool slate surfaces; dense headers, tables, and KPIs; shared `.ent-*` panel/toolbar primitives (Attendance IGA `.aig-*` remains compatible). Themes: light / dark / midnight / ocean / slate / sand / violet via `data-theme` (`web/js/theme.js`, `localStorage` key `idp_theme`).

### 9.2 Layout

- **Login screen** — split: brand hero (grid + gradient) + sign-in card. **Identity-first flow**: email step → password step (avatar + "Not you?" link) → optional MFA verify or MFA enrollment (QR) inline when required. Google SSO button on email step.
- **Console** — fixed top primary nav + contextual left sidebar (user or admin mode); content pane uses subtle atmosphere + page-enter motion.
- **Routing** — SPA state is reflected in the URL: `/?v=<route>` (e.g. `users`, `settings`, `applications`) with optional `?tab=<subtab>` (e.g. `sessions`, `prebuilt`, `favs`). A full page refresh restores the same view and sub-tab. Per-page search/filter text is persisted in `sessionStorage` via `persistSearch()` and re-applied on load.
- **Admin → Authentication** — shows Google OIDC status and supports SUPER_ADMIN save of Client ID / Secret / Hosted Domain (or pasted OAuth web-client JSON) into DB overrides.

Layout: a fixed dark **top primary nav** (workspace) + a **left sidebar** that switches by mode:

| Mode | Sidebar | Behaviour |
|---|---|---|
| **End-user** (JumpCloud-style) | My Portal nav: All Applications · Request Access · Approvals (badge) · My Access · Security | Top-nav user buttons hidden; sidebar drives navigation |
| **Admin** (miniOrange-style) | Grouped admin sections (collapsible via ◀/▶ toggle, persisted in `localStorage`) | Visible only when Admin is active |

**Top primary nav** (always visible, modelled on SailPoint IdentityNow)
- **Home** — JumpCloud-style app launcher: search bar, All Apps / Favorites tabs, star-to-favorite (stored in `localStorage`); shows only apps returned by `GET /api/apps` (no catalog merge)
- **Request Center** — browse the catalogue, raise an access request
- **Approvals** — pending approvals + access-review items routed to the user
- **My Access** — current entitlements & roles
- **Admin** — opens admin sidebar (admin / super-admin only)

**Admin sidebar** (modelled on miniOrange PAM admin) — every group is collapsible per-tenant in a future release; today every entry is a feature page with status, summary and capability list.

| Group | Sidebar items |
|---|---|
| **Overview** | Dashboard |
| **Identity** | Users / Identities · Groups (Directory · Tag Groups) · Bulk User Import · Administrators *(SUPER_ADMIN)* · System / Privileged Users *(SUPER_ADMIN / PAM)* · Identity Profiles |
| **Authentication** | SSO Configuration · Strong Auth Methods · Adaptive Auth · Password Policies |
| **Applications** | Applications (tabs: Catalog · SAML · OIDC · Pre-built · App Discovery) |
| **Connections** | Directory Sync (Connectors redirects here) |
| **Access Model** | Business Roles · Birthright Rules · Application Access Policy |
| **Privileged Access** | Privileged Resources · Privileged Sessions · Credential Vault — **SUPER_ADMIN only** (portal `ADMIN` excludes PAM) |
| **Identity Governance** | Certifications · Segregation of Duties · Risk · **Attendance IGA** |
| **Workflows** | Workflows (tabs: Definitions · Event Triggers · Run History) · Notifications |
| **Reports** | Audit & SSO Reports (tabs: SSO assertions · System audit · SSO Reports) · Compliance Reports |
| **Settings** | General · Branding & Login · License · Tickets · System Health |

**Merged / redirected routes** (bookmarks still work): `loginCustomization`→`branding`, `connectors`→`directorySync`, `eventTriggers`→`workflowLibrary?tab=triggers`, `appDiscovery`→`applications?tab=discovery`, `ssoReports`→`audit?tab=sso`. Groups also exposes Tag Groups under `/?v=groups&tab=tags`.

**Account** (everyone) — top-right profile dropdown
- Account settings (Profile / Security / Sessions / Two-factor)
- Audit logs (admins)
- SAML metadata link (admins only)
- Sign out

### 9.3 Routing

- `/login` — login form (no auth)
- `/` — console (default landing: admins → Dashboard, others → My Apps)
- `/?v=<view>` — direct deep link to any view (e.g. `/?v=attendanceIga` for Attendance IGA admin console)
- `/?v=<view>&tab=<tab>` — sub-tab deep links (e.g. `/?v=workflowLibrary&tab=triggers`, `/?v=applications&tab=discovery`, `/?v=audit&tab=sso`, `/?v=groups&tab=tags`)

**Attendance IGA admin console** (`/?v=attendanceIga`) — tabs: Dashboard · Configuration · Import History · Approvals · Executions. Pipeline: fetch attendance (REST API with exponential-backoff retry, or CSV upload) → staging validation → employee match (employee ID → email → username) → rule evaluation (uses `leave_records`, `holiday_calendar`, exclusions) → optional approval → connector actions (suspend, disable, revoke sessions, remove apps/groups/roles) → audit + notification → rollback restores snapshot.

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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_HOSTED_DOMAIN` | yes for Google fallback | — | Google Workspace OIDC inbound login defaults (can be overridden by `general_settings.google_oidc_*` from Admin GUI) |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_SCIM_BASE_URL` | optional | empty | **Outbound Zoho People SCIM provisioning only.** Not used for sign-in. Leave blank to disable. |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `SQS_*` | yes | — | LocalStack URLs in dev |

---

## 11. Deployment

### 11.1 Dev (single-tier docker-compose on `pam-2`)

**Deploy model:** `pam-2` is a **deploy-only** checkout — never edit tracked files under `/opt/idp` on the server (manual patches to `scripts/*.sh` cause recurring `git pull` conflicts). Baseline configuration lives in **`.env`** (gitignored); selected runtime settings (for example portal TLS and Google OIDC GUI overrides) are persisted in MySQL `general_settings`. All code changes happen in git; the server syncs with `git reset --hard origin/main`.

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
bash scripts/check-user-sso.sh test.a@itinfralenskart.com

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
| Zoho / SP says "Signature verification failed" after deploy | IdP signing cert changed (auto-generated key was not persisted) | Re-upload current IdP metadata/certificate to SP, then ensure `saml-keys` volume is mounted at `/app/data/saml` so cert does not rotate on rebuild |

---

## 13. Security model

| Surface | Control |
|---|---|
| Local password | `bcryptjs` cost 12; default `password_policies` enforced on create/change/reset (complexity + history) |
| Session cookie | HMAC-signed (length-safe verify), `HttpOnly`, `SameSite=Lax`, `Secure` (configurable for dev). Redis cache always re-checks DB `revoked_at` + live role |
| MFA | TOTP RFC 6238, ±1 step skew, hashed backup codes. Enforced for local **and Google** login when policy/adaptive requires it. Portal operators cannot defer enrollment. Disable/regen requires password (local) + TOTP step-up |
| Rate limiting | 10 req / minute / (IP + email) on auth endpoints |
| Forensics | `auth_attempts` table records every attempt with reason + IP |
| Internal API | `X-Internal-Token` timing-safe compare (`INTERNAL_TOKEN`). Also required for `/diagz` and `/metrics` |
| Outbound HTTP | `assertSafeOutboundUrl` blocks loopback/private/link-local/metadata (Attendance IGA, workflow webhooks, event triggers) |
| XSS | `esc()` / `escAttrJson()` for HTML text and JSON-in-attribute sinks |
| Audit | Hash-chained `audit_log` (tamper-evident) |
| RBAC | Job hierarchy + **server-enforced** portal module R/W via `requirePortalModule` on admin/IGA routers. Coarse `ADMIN` gate still admits portal operators, but module ACL is authoritative. Google OIDC write + portal SSL mutate = **Super Admin only**. Creating `SUPER_ADMIN` accounts = Super Admin only. **PAM is not available** (APIs return 501). |
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
- ✅ **AD Directory Sync** — `src/services/ad-sync.ts` reconciles HRMS employees → Active Directory (provision, update, disable); inbound import **skips disabled AD accounts** (does not create new portal users); existing linked users disabled in AD are marked `SUSPENDED_AUTO` and hidden from the Universal Directory; tracks runs in `connector_runs`
- ✅ **Google Workspace Sync** — `src/services/google-sync.ts` + `src/services/google-directory-config.ts`: inbound import **skips suspended Google accounts** (same rules as AD); outbound provision via Admin SDK; connector `config_json` supports **sync scope** (`syncOrgUnits`, `syncGroups`, `syncUsers`, `includeSubOrgUnits`, `provisionOrgUnit`) — blank scope syncs the full directory; non-empty filters combine with AND logic
- ✅ **Password Writeback** — `src/services/password-writeback.ts` writes password changes to AD (unicodePwd/LDAP) and Google (Admin SDK); auto-links AD/Google identity by corporate email before writeback when connectors are active; AD writeback auto-retries StartTLS/LDAPS when the connector uses plain LDAP; wired into admin reset and `PUT /api/me/password`; logs to `password_writeback_log`
- ✅ **User Lifecycle** — `src/services/user-lifecycle.ts` + `src/api/admin-lifecycle.ts`: `POST /api/admin/users/:empId/suspend|unsuspend|terminate` — admin suspend sets `SUSPENDED_HR` (hidden from directory, login blocked); revokes sessions (DB + Redis), enqueues DISABLE/ENABLE outbox ops to AD + Google, records `lifecycle_events`
- ✅ **Access review campaign generator** — `POST /api/iga/access-reviews` + `POST /api/iga/access-reviews/:id/items/:itemId/decision` in `src/services/access-review.ts` (scopes: ALL_USERS, APP_SPECIFIC, HIGH_RISK; auto-closes campaign when all items reviewed; REVOKE triggers user_entitlement revocation)
- ✅ **SoD evaluator** — `src/services/sod-evaluator.ts` runs on every entitlement grant; populates `sod_violations`; full-scan available
- ✅ **Notification dispatcher** — `src/services/notification.ts` dispatches EMAIL (nodemailer), SLACK (webhook), TEAMS, IN_APP; called by access-request, lifecycle, and review workflows
- ✅ **Direct entitlement grant** — `POST /api/iga/entitlements/:entId/grant` (admin, SoD-gated)
- ✅ **Connector registration** — `POST /api/iga/connectors` now persists to DB (was 501)
- ✅ **Compliance report creation** — `POST /api/iga/reports` now creates a report record (was 501)
- ⏳ Risk engine — location / device / velocity heuristics → `login_risk_events`, `risk_scores`

**Workflow engine (live):**
- ✅ `workflow_definitions` + `event_triggers` admin CRUD at `/api/admin/workflows`
- ✅ `src/services/workflow-engine.ts` — executes step types `NOTIFY`, `GRANT_BIRTHRIGHT`, `REVOKE_BIRTHRIGHT`, `WEBHOOK` on matching `trigger_event`
- ✅ `src/services/event-dispatcher.ts` — fires event triggers + starts workflows on platform events (`JOINER`, `LEAVER`, `SUSPEND`, `ACCESS_REQUEST`, …)
- ✅ Wired into FSM transitions, user lifecycle (suspend/terminate), and access-request submission
- ✅ `workflow_runs` table + `GET /api/admin/workflows/runs` execution history
- ✅ Admin **Workflow Library** UI — step builder (no raw JSON), run history tab

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

> **Convention:** newest entries at the top. Each entry includes commit hash, date, summary.

### TBD — 2026-07-19 — VAPT hardening (portal RBAC, MFA, SSRF, XSS)

**Why** — Security review found portal module permissions were UI-only (scoped operators had full Admin API power), plus session/MFA/XSS/SSRF gaps.

**What changed:**

- **RBAC** — `requirePortalModule(...)` on all `/api/admin/*` and IGA admin routes; Super Admin–only for Google OIDC PUT, portal SSL mutate, and minting `SUPER_ADMIN` local accounts.
- **Sessions** — Redis session hit re-validates DB revocation + refreshes role; HMAC cookie verify is length-safe (no `timingSafeEqual` throw).
- **MFA** — Google OIDC runs the same MFA/adaptive gate as local login; `enforce_for_admins` covers all portal operator roles; operators cannot defer enrollment; MFA disable/regen requires step-up.
- **Password policy** — default policy enforced on self-service change, admin create, and admin reset.
- **SSRF** — outbound URL allowlist/denylist for Attendance IGA, workflow webhooks, event triggers.
- **XSS** — `esc()` escapes `'`; JSON-in-`data-*` uses `escAttrJson`.
- **Diagnostics** — `/diagz` and `/metrics` require `X-Internal-Token`; internal token compares are timing-safe.
- **IDOR** — employee state-history applies management scope.
- **SAML** — AuthnRequest Issuer extraction strips XML comments and prefers Issuer inside `<AuthnRequest>`.

### TBD — 2026-07-19 — SSO Configuration UI polish

**Why** — Authentication / SSO Configuration page looked flat and misaligned (cramped 3-column grid, inconsistent label/value rows, form mixed into read-only panel).

**What changed:**

- **Layout** — SSO page uses `ent-panel` stacks: SAML + local login in a balanced 2-column row; OIDC status and Google settings form in a split panel.
- **Design system** — upgraded `.kv-list` / `.kv` (bordered rows, uppercase labels, aligned values), pill badges with status dots, structured `.card-head` / `.card-body`, theme-aware content background.
- **Assets** — cache bust `2026-07-19-ui-pro1`.

### TBD — 2026-07-19 — Portal themes: Midnight + Sand

**Why** — Users requested additional appearance options beyond the original five themes.

**What changed:**

- **Themes** — added **Midnight** (deep indigo dark) and **Sand** (warm cream light) with full token palettes in `web/css/styles.css`.
- **Picker** — `web/js/theme.js` registers seven themes; swatch previews and `theme-color` meta updated.
- **Boot** — `web/index.html` inline theme guard accepts `midnight` and `sand`; asset cache bust `2026-07-19-theme2`.

### TBD — 2026-07-19 — Portal module roles (no PAM) + custom R/W

**Why** — Need clear console roles without PAM (not designed yet), plus Application Contributor, User & Group Manager, and custom roles with per-module Read/Write.

**What changed:**

- **Migration `032_portal_module_roles.sql`** — `portal_roles` + `portal_role_permissions`; expands `local_accounts.role`; seeds Super Admin, Admin, Application Contributor, User and Group Manager.
- **No PAM role** — Privileged Access hidden from sidebar; `/api/admin/pam/*` returns `501 PAM_NOT_AVAILABLE`.
- **Custom roles** — Super Admin creates roles under Administrators with module Read/Write matrix.
- **Session** — `/api/me` returns `portalModules` + `portalRoleName`; sidebar/routes gated by module.
- **API** — `/api/admin/portal-roles` CRUD; `requirePortalModule` middleware.

### TBD — 2026-07-19 — UI layout QC (License vertical text + shared grids)

**Why** — License Edition Details rendered values as vertical single-character columns; same nested-`.kv` / `grid-column:span` pattern risked Branding, Health, Dashboard, and Tickets. Local Docker was also serving a baked image, so host `web/` edits never appeared until remount/rebuild.

**What changed:**

- **Root cause** — nested `.kv` inside `.kv` packed rows into the 160px label track + `word-break:break-all` → character-per-line wrap.
- **License** — Edition Details uses a real `<table class="lic-table">` (not `.kv` / `.ent-kv`).
- **CSS** — hardened `.kv` / `.ent-kv`; new `.grid-main-side` / `.lic-layout`.
- **Pages** — Branding, System Health, Dashboard system status, Tickets detail, SSO Reports cards.
- **Local Docker** — `docker-compose.local.yml` mounts `./web:/app/web:ro` so UI edits show on `:8081` without image rebuild.
- **Assets** — cache bust `2026-07-19-lic-fix1`.

### TBD — 2026-07-18 — Duplicate surface merger (nav + tabs)

**Why** — Several admin pages duplicated the same capability under separate sidebar entries (triggers vs workflows, discovery vs applications, SSO reports vs audit, tag groups vs groups).

**What changed:**

- **Workflows** — Event Triggers merged as a tab under Workflows; old `eventTriggers` redirects to `workflowLibrary?tab=triggers`.
- **Applications** — App Discovery merged as a tab; old `appDiscovery` redirects to `applications?tab=discovery`.
- **Audit & SSO Reports** — SSO Reports merged as a tab; old `ssoReports` redirects to `audit?tab=sso`.
- **Groups** — Tag Groups CRUD under `/?v=groups&tab=tags` (same APIs as Application Access Policy).
- **Attendance** — when Attendance IGA is enabled, legacy `POST /api/internal/ingest/truein` skips unless `force:true` (pairs with existing risk-scan skip).
- **Assets** — cache bust `2026-07-18-dup-merge1`.

### TBD — 2026-07-18 — Enterprise UI polish (console-wide design system)

**Why** — Admin and end-user pages looked uneven next to Attendance IGA; the console needed a single professional craft level.

**What changed:**

- **Typography** — IBM Plex Sans + IBM Plex Mono; tighter type scale and letter-spacing.
- **Tokens** — cooler slate palette, smaller radii, quieter shadows, focus rings.
- **Shell** — denser topnav/sidebar; content atmosphere + page-enter motion; refined tables, badges, modals, buttons, forms, empty states.
- **Shared primitives** — `.ent-*` panel/toolbar/status classes; AIG styles remain; unified `header()` / `statCard()` markup.
- **Surfaces** — login hero, License matrix, General Settings stack, end-user portal headers.

### `eb6eec8` — 2026-07-18 — Full-codebase QC pass (security, CRUD, roles, dual pipelines)

**Why** — Cross-module audit found secret leaks, many UI↔API field mismatches, ADMIN nav hitting SUPER_ADMIN-only APIs, and dual attendance paths that could double-suspend.

**What changed:**

- **Security** — redact `google_oidc_client_secret` from general-settings GET; redact Attendance IGA tokens/SFTP secrets on config GET; never echo event-trigger webhook secrets.
- **Access requests** — accept `APP`→`APP_ACCESS`, default `targetEmpId` to requester; `GET /api/iga/roles` + open entitlements list for end-user catalog.
- **Tickets / Password policies / SoD / Notifications / PAM / System users / Business roles** — UI payloads and displays aligned to DB/API; SoD PUT is partial (toggle no longer wipes policy).
- **Role walls** — SAML apps, OIDC clients, adaptive auth, password policies, portal SSL, connectors write, SoD CRUD, birthright run, notification test/dispatch opened to `ADMIN` + `SUPER_ADMIN` (matches sidebar).
- **Attendance ownership** — when Attendance IGA `enabled=1`, `POST /api/internal/risk-scan` skips (no double-suspend); legacy Truein ingest returns a warning if IGA is on.
- **Nav / labels** — Login Customization → Branding; Connectors → Directory Sync; License/MFA/Workflow copy honesty; dual `022_*` migrations left as-is (tracked by full filename).
- **Intentional dual registries** — `saml_service_providers` remains SAML runtime; `applications` is IGA catalog (slug mirror via `syncSamlAppsToCatalog`). Three workflow surfaces remain layered (library / triggers / app-access approvals) with clearer UI labels.

### `eb6eec8` — 2026-07-18 — Attendance IGA: Truein API integration + empty-import safety guard

**Why** — Lenskart uses Truein for attendance; integration requires Bearer token auth and date-based daily API fetch without suspending users when HR data is missing.

**What changed:**

- **`migrations/031_attendance_iga_truein.sql`** — `api_provider` (`GENERIC`|`TRUIN`), `api_config` JSON.
- **`src/services/attendance-iga/truein-client.ts`** — Truein fetch with token, date params, lookback, default field mapping.
- **`GET /api/admin/attendance-iga/api/preview`**, **`POST .../api/test`** — preview request and test connection.
- **Pipeline guard** — skips rule evaluation when import yields zero valid records (REST/SFTP/file).
- **Admin UI** — Truein configuration panel, test connection, setup guide.

### `eb6eec8` — 2026-07-18 — Attendance IGA: dynamic SFTP date templates + enterprise UI

**Why** — HR uploads a new dated CSV daily (e.g. `attendance_2026-07-18.csv`); admins need path preview and a polished governance console.

**What changed:**

- **`src/services/attendance-iga/date-template.ts`** — expands `{YYYY-MM-DD}`, `{YYYYMMDD}`, `{date}`, etc.; lookback if today's file missing.
- **Updated** `sftp-fetcher.ts`, SFTP config schema (`fileNameTemplate`, `timezone`, `dateOffsetDays`, `lookbackDays`).
- **`GET /api/admin/attendance-iga/sftp/preview`** — resolved path candidates.
- **Updated** Attendance IGA admin UI (status bar, panel layout, live path preview, styled tables).

### `eb6eec8` — 2026-07-18 — Attendance IGA: SFTP auto-fetch for CSV imports

**Why** — HR attendance files are often dropped on SFTP; the scheduler should pull them automatically without manual upload.

**What changed:**

- **`migrations/030_attendance_iga_sftp.sql`** — `sftp_config` JSON + `sftp_last_file`; `source_type` adds `SFTP`; `BOTH` now means REST API + SFTP on schedule.
- **`src/services/attendance-iga/sftp-fetcher.ts`** — SFTP connect with password or key, fetch exact path or newest file in directory, exponential backoff, optional archive/delete.
- **Updated** orchestrator, scheduler, admin API, Attendance IGA config UI (`Run SFTP Import` button).
- **Dependency:** `ssh2-sftp-client` (native `ssh2` module; Docker builder installs `python3 make g++`).

### `eb6eec8` — 2026-07-18 — Attendance-Based Identity Governance (import, rules, approvals, rollback)

**Why** — HR attendance gaps should automatically suspend or remove application access under configurable business rules, with full audit and reversible rollback.

**What changed:**

- **`migrations/029_attendance_iga.sql`** — config singleton, rules A–H, exclusions, staging, import runs, evaluations, approvals, executions, rollback log.
- **`src/services/attendance-iga/`** — `fetcher` (REST + CSV), `orchestrator` (import → match → rules → approval/execute), `actions` (SSO mutations + rollback snapshots + notifications), `scheduler` (5m/15m/1h/1d polling; skips user actions when API fetch fails after retries).
- **`src/api/config-attendance-iga.ts`** — admin API at `/api/admin/attendance-iga/*`.
- **`src/api/internal.ts`** — `POST /api/internal/attendance-iga/run` for automation hooks.
- **`src/index.ts`** — mounts router; starts `startAttendanceIgaScheduler()` on boot.
- **`web/js/`** — `api.js` client, `app.js` route, `views-stubs.js` admin UI (dashboard, config, imports, approvals, executions).

### TBD — 2026-07-16 — Workflow engine: definitions, event triggers, execution + run history

**Why** — Workflow Library and Event Triggers admin pages existed but workflows were never executed; frontend sent field names the API did not accept.

**What changed:**

- **`migrations/028_workflow_runs.sql`** — `workflow_runs` table for execution history.
- **`src/services/workflow-engine.ts`** — runs active `workflow_definitions` on platform events; step types: `NOTIFY`, `GRANT_BIRTHRIGHT`, `REVOKE_BIRTHRIGHT`, `WEBHOOK`.
- **`src/services/event-dispatcher.ts`** — `emitPlatformEvent()` fires `event_triggers` then starts matching workflows (fire-and-forget).
- **`src/api/config-workflows.ts`** — zod validation; accepts UI `steps` / `channel` / `target_url`; `GET /runs` endpoint.
- **Hooks** — FSM (`employee-state-machine.ts`), lifecycle (`user-lifecycle.ts`), access requests (`access-request-workflow.ts`).
- **`web/js/views-stubs.js`** — Workflow Library step builder + run history tab (replaces raw JSON textarea).

### TBD — 2026-06-08 — Google sync: scoped user lookup and outbound limits

**Why** — Sync with explicit Sync Users (e.g. `bipin.rai@lenskart.com`) reported 0 inbound users while outbound failed on 24 unrelated IdP employees (BIDIRECTIONAL tried to provision everyone).

**What changed:**

- **Fixed:** `src/services/google-directory-config.ts` — explicit Sync Users are fetched via `users.get` by email; reports not-found addresses; outbound skips employees outside scope (unless they already have a Google identity link).
- **Updated:** `src/services/google-sync.ts`, `src/api/iga.ts` — consume scoped user result; sync history shows not-found emails.
- **Updated:** `web/js/views-stubs.js` — Sync Users field hint (save before sync).

### TBD — 2026-06-08 — Google sync: fix outbound SQL column names

**Why** — Google Workspace connector sync failed after inbound user import with `Unknown column 'department' in 'field list'` because outbound reconcile queried non-existent `department` / `title` columns on `employees` (schema uses `dept_id` / `role`).

**What changed:**

- **Fixed:** `src/services/google-sync.ts` — outbound phase selects only existing columns (`emp_id`, `full_name`, `email_corp`, `ilg_state`).
- **Fixed:** `src/api/config-birthright.ts` — dry-run and run endpoints use `dept_id` instead of `department`.

### TBD — 2026-06-07 — Bulk user import (create/update + group assignment)

**Why** — Admins needed a single console workflow to create or update large user populations (up to 100,000 rows) and assign local group membership without one-by-one UI clicks.

**What changed:**

- **New:** `src/services/bulk-user-import.ts` — batch upsert employees by email with optional group membership (`INSERT IGNORE` into `group_members` for local groups only).
- **New:** `src/api/admin-bulk-users.ts` — `POST /api/admin/bulk-users/batch` (max 500 rows per request; `upsert` / `create` / `update` modes).
- **Updated:** `src/index.ts` — mounts `/api/admin/bulk-users`.
- **Updated:** `web/js/views-stubs.js` — **Bulk User Import** admin page: CSV upload/paste, chunked progress bar, error export.
- **Updated:** `web/js/app.js` — Identity sidebar route `bulkUsers`.
- **Updated:** `web/js/api.js` — `bulkUsersBatch()` client.
- **Updated:** `web/index.html` — asset cache version bump for deploy.

### TBD — 2026-06-07 — OIDC client delete removes registration from list

**Why** — Delete on the OIDC / OAuth Applications page only set `active = 0`, so clients stayed visible with status **Off** and appeared undeletable.

**What changed:**

- **Updated:** `src/api/config-oidc-clients.ts` — `DELETE /api/admin/oidc-clients/:id` now hard-deletes the client (and related `oauth_tokens` rows), matching SAML app delete behavior.

### TBD — 2026-06-07 — Defer MFA enrollment to next sign-in

**Why** — Users forced into login-time MFA setup had no way to exit the flow; they needed a clear path to complete setup on a later sign-in (with optional grace-period access).

**What changed:**

- **Updated:** `src/auth/local-auth.ts` — `POST /auth/local/login/mfa-enroll/defer` clears the enroll challenge; during `grace_period_hours` (Redis-tracked from first required login) issues a session, otherwise returns `{ deferred, session:false }`.
- **Updated:** `web/js/views-end-user.js` — enrollment step shows **Set up on next sign-in** (or **Continue without MFA for now** during grace).
- **Updated:** `web/js/api.js` — client helper for defer endpoint.

### TBD — 2026-06-07 — Login-time MFA enrollment for enforced users

**Why** — Users with MFA enforced by policy saw a dead-end error on the password step instead of being guided to enroll TOTP before sign-in.

**What changed:**

- **Updated:** `src/auth/local-auth.ts` — password OK + MFA required but not enrolled now returns `{enrollRequired, enrollChallengeId}` instead of HTTP 403; added Redis-backed `POST /auth/local/login/mfa-enroll` and `POST /auth/local/login/mfa-enroll/confirm` (no session cookie required until confirm succeeds).
- **Updated:** `web/js/views-end-user.js` — login flow renders inline QR enrollment step after password verification.
- **Updated:** `web/js/api.js` — client helpers for login-time MFA enrollment endpoints.

### TBD — 2026-06-07 — Avoid false adaptive blocks before MFA enrollment

**Why** — First-time users were sometimes blocked with `ADAPTIVE_BLOCKED` before they could enroll MFA because ip-api `hosting` networks were treated as TOR/proxy signals.

**What changed:**

- **Updated:** `src/services/adaptive-auth-engine.ts` now treats only ip-api `proxy` as TOR/proxy blocking signal (`TOR_PROXY` / `NETWORK_TYPE=TOR`).
- **Updated:** `src/services/adaptive-auth-engine.ts` now treats ip-api `hosting` as a lower-weight risk signal (`hosting_network`, +10) instead of immediate proxy-block behavior.
- **Outcome:** first-time enforced users can reach MFA enrollment-required flow in normal enterprise egress/NAT environments while retaining block behavior for anonymizing proxy traffic.

### TBD — 2026-06-07 — Exclude groups from MFA policy

**Why** — Security/ops teams needed a safe exception path to exempt selected groups from global/admin MFA enforcement without disabling adaptive MFA controls.

**What changed:**

- **Updated:** `web/js/views-stubs.js` — MFA policy UI now includes **Exclude Groups from Policy MFA** with group search and multi-select.
- **Updated:** `src/api/admin-users.ts` — `POST /api/admin/users/mfa-policy` now accepts `excluded_group_ids`.
- **Updated:** `src/auth/local-auth.ts` — login reads excluded groups from `mfa_policy`, checks `group_members`, and skips global/admin policy MFA for matched users (while still enforcing adaptive and per-user MFA policies).

### TBD — 2026-06-07 — MFA reset now forces re-enrollment consistently

**Why** — Admin “Reset MFA” UI was disabling existing MFA, but runtime login checks did not consistently enforce re-enrollment for the next sign-in. This created confusion for lost-device recovery.

**What changed:**

- **Updated:** `src/auth/local-auth.ts` — login now evaluates MFA policy requirements directly from `employees.mfa_enforced` and `mfa_policy` (`global_enforce`, `enforce_for_admins`) in addition to adaptive signals and existing enrollment state.
- **Updated:** `web/js/views-stubs.js` — admin reset actions now perform `disable + enforce` in one flow so reset always means “fresh enrollment required at next login”.
- **Updated:** `web/js/views-stubs.js` — admin disable actions now clear enforcement along with MFA disable so “Disable MFA” truly removes MFA requirement.

### TBD — 2026-06-07 — Migration runner compatibility for older MySQL variants

**Why** — Some environments failed to start because migration `026_mfa_enforce_policy.sql` uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which is not accepted by certain MySQL builds despite reporting 8.0-compatible behavior.

**What changed:**

- **Updated:** `src/db/migrate.ts` now retries migrations that fail with `ER_PARSE_ERROR` on `ADD COLUMN IF NOT EXISTS`.
- **Compatibility mode:** the fallback executes statements one-by-one and converts each `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` into:
  1. `information_schema.COLUMNS` existence check
  2. conditional `ALTER TABLE ... ADD COLUMN ...` only when the column is missing
- **Scope:** fallback is activated only for this specific parser error signature; all other migrations still run normally (single batch) and still fail-fast on real SQL errors.
- **Outcome:** fresh and older servers can apply migration 026 without manual DB patching, preventing startup crash loops and Cloudflare `521` host errors caused by failed boot.

### TBD — 2026-06-07 — Adaptive / risk-based authentication engine (live)

**Why** — The adaptive auth schema and policy table have existed since migration 006, but the evaluation engine was never wired into the login flow. The `/evaluate` endpoint only checked `IP_RANGE` conditions. This implements the full authentication logic matrix.

**What changed:**

- **New:** `src/services/adaptive-auth-engine.ts` — policy evaluation engine supporting 10 condition types (`IP_RANGE`, `NETWORK_TYPE`, `DEVICE_MANAGED`, `NEW_DEVICE`, `IMPOSSIBLE_TRAVEL`, `COUNTRY`, `USER_ROLE`, `RISK_SCORE`, `SENSITIVE_APP`, `TOR_PROXY`). Returns `ALLOW / MFA / STEP_UP / BLOCK`. Decision priority: `BLOCK > STEP_UP > MFA > ALLOW`. Privileged roles (`ADMIN`, `SUPER_ADMIN`, `IT_OPS`, `SECURITY`) always receive at least `MFA` as a hard override.
- **Updated:** `src/auth/local-auth.ts` — `POST /auth/local/login` now calls the adaptive engine after password verification. `BLOCK` → HTTP 403 `ADAPTIVE_BLOCKED`. `MFA`/`STEP_UP` → MFA challenge (including `stepUp: true` flag). `MFA_ENROLL_REQUIRED` returned when policy demands MFA but user hasn't enrolled TOTP.
- **Updated:** `src/api/config-adaptive-auth.ts` — `POST /evaluate` replaced with an engine-backed evaluation; accepts `empId` + context and returns `decision`, `riskScore`, `signals`, and `matchedPolicies`.
- **New migration 027** — adds `STEP_UP` to `adaptive_auth_policies.action` enum; seeds 11 default policies covering the full authentication logic matrix (see §5.6).
- **ARCHITECTURE.md §5.1** — risk-based step-up marked Live; §5.6 added with full matrix, condition types, risk signals, and login flow description.

### TBD — 2026-06-07 — Exclude suspended users from directory sync and portal access

**Why** — Disabled AD accounts and admin-suspended users were still appearing in Universal Directory and could regain portal access on AD login.

**What changed:**

- **`src/fsm/states.ts`** — `PORTAL_ACCESSIBLE_STATES` / `isPortalAccessible()` shared helper (`ACTIVE`, `REACTIVATED` only).
- **`src/services/ad-sync.ts`**, **`src/services/google-sync.ts`** — inbound sync skips creating new users when the source account is disabled/suspended; existing linked users are marked `SUSPENDED_AUTO` with `DISABLED` identity links.
- **`src/api/admin-users.ts`** — `GET /api/admin/users` defaults to portal-accessible states; `state=SUSPENDED` or `includeInactive=1` reveals suspended rows.
- **`src/services/user-lifecycle.ts`** — admin suspend/unsuspend/terminate use valid FSM states (`SUSPENDED_HR`, `DEPARTED`).
- **`src/services/ad-auth.ts`**, **`src/auth/local-auth.ts`**, **`src/auth/middleware.ts`** — login blocked for non-accessible `ilg_state`; removed AD-login auto-reactivation of suspended users.
- **`web/js/views-stubs.js`**, **`web/js/api.js`** — Universal Directory Users tab defaults to **Available** filter; **All states** opt-in via `includeInactive`.

### TBD — 2026-06-08 — MFA enforcement policy and per-user MFA management

**Why** — Admins needed a way to require MFA for specific users or globally, and to reset/disable MFA directly from the user profile panel without the user needing to act.

**What changed:**

- **Migration 026** — adds `employees.mfa_enforced`, `mfa_enforced_at`, `mfa_enforced_by` columns and a new `mfa_policy` table for global settings (global_enforce, enforce_for_admins, grace_period_hours, allowed_methods).
- **New API routes** (`/api/admin/users`):
  - `POST /:empId/mfa/enforce` — set or clear per-user MFA enforcement flag.
  - `GET  /mfa-policy` — read global MFA policy key/value settings.
  - `POST /mfa-policy` — update global MFA policy settings.
- **MFA Methods page** (`Authentication → Strong Auth Methods`) — redesigned with: global enforcement policy form, per-user MFA search with Enforce / Remove Enforcement / Reset / Disable buttons.
- **User Profile Panel → MFA tab** — added Enforce MFA, Remove Enforcement, and Reset MFA (force re-enroll) buttons alongside existing Disable and Enroll actions.

---

### TBD — 2026-06-07 — Separate portal administrator from job designation

**Why** — `employees.role` holds HR/job designation (e.g. "Senior Executive - Human Capital") from directory sync. Portal console access (ADMIN / SUPER_ADMIN) is a separate duty and must not overwrite or display as designation.

**What changed:**

- **`employees.role`** — job designation only (from AD/HRMS/Google sync); shown as **Designation** in user profiles.
- **`local_accounts.role`** — portal access when `ADMIN` or `SUPER_ADMIN`; assigned only from **Identity → Administrators** (add from directory or create local account).
- **`src/services/local-admin.ts`** — `getPortalRole`, `assignPortalRole`, `revokePortalRole`; administrators list reads `local_accounts` only.
- **`src/api/admin-users.ts`** — `PATCH /:empId/role` updates portal access in `local_accounts` only; API returns `portal_role` (not designation).
- **`src/auth/middleware.ts`**, **`src/services/ad-auth.ts`** — Google/AD login session role resolved from portal assignment in `local_accounts`.
- **`src/api/me.ts`** — exposes `session.portalRole` for frontend admin gating.
- **`web/js/ui.js`**, **`web/js/app.js`**, **`web/js/views-admin.js`**, **`web/js/views-stubs.js`**, **`web/js/views-end-user.js`** — admin UI uses `portalRole`; profiles show Designation + read-only Portal Administrator.

### f632254 — 2026-06-07 — Persist SPA route and search across page refresh

**Why** — Refreshing the console reset the active page/sub-tab and cleared in-progress search filters.

**What changed:**

- **`web/js/ui.js`** — `syncAppUrl()` / `getAppTab()` for URL-backed routing; `persistSearch()` dispatches `input` after restore so filters re-apply.
- **`web/js/app.js`** — router reads/writes `?v=` + `?tab=` on navigate and startup; sub-tab defaults for applications, settings, home, audit, directory sync.
- **`web/js/views-end-user.js`**, **`web/js/views-admin.js`**, **`web/js/views-stubs.js`** — settings, audit, directory sync, and home tabs sync URL; search boxes wired after listeners.
- **`web/index.html`** — cache-bust query string for refreshed assets.

---

### 43827f3 — 2026-06-07 — Session UI fixes, search persistence, agent cleanup

**Why** — Post-refactor verification found a sessions table column bug, stale docs/dead agent code, and missing Cloudflare-aware IP capture; search boxes lost typed text on refresh.

**What changed:**

- **`web/js/views-end-user.js`** — fix Settings → Sessions column order (Device, Location, IP).
- **`src/auth/local-auth.ts`**, **`src/auth/middleware.ts`** — use `getClientIp()` for session IP and auth logging.
- **`web/js/ui.js`**, **`web/js/app.js`**, **`web/js/views-admin.js`**, **`web/js/views-stubs.js`** — `persistSearch()` keeps filter text across page refresh via `sessionStorage`.
- **Removed** — `web/js/device-context.js`, `src/utils/device-context.ts`, `scripts/device-context-agent.mjs`, `scripts/install-device-agent*`, `scripts/start-device-agent.bat`; trimmed unused DNS helpers from **`src/utils/request-context.ts`**.

---

### 37be907 — 2026-06-07 — Gmail-style session attribution (device + location, no agent)

**Why** — Workstation agents and X-Forwarded-For reverse-DNS rarely populated session hostname/MAC reliably; operators still need readable device and location context like Gmail security alerts.

**What changed:**

- **`migrations/024_drop_client_mac.sql`**, **`migrations/025_session_geo_device.sql`** — drop `client_hostname`, `client_local_ip`, `client_mac`; add `device_info`, `geo_location`.
- **`src/utils/ua-parser.ts`** — lightweight User-Agent → `Browser · OS` string.
- **`src/utils/ip-geo.ts`** — async ip-api.com geolocation after session create.
- **`src/auth/session.ts`**, **`src/auth/local-auth.ts`**, **`src/auth/middleware.ts`** — store `device_info` at login; enrich `geo_location` in background; use `getClientIp()` for public IP.
- **`src/api/me-actions.ts`**, **`src/api/admin-users.ts`** — session APIs return `device_info` + `geo_location` (removed `POST /api/me/sessions/device-context`).
- **`web/js/views-stubs.js`**, **`web/js/views-end-user.js`** — Sessions tables show Device, Location, IP.

---

### (pending) — 2026-06-07 — Google login errors shown on portal login page

**Why** — Google OIDC failures returned raw JSON in the browser; users could not see why sign-in failed.

**What changed:**

- **`src/auth/login-redirect.ts`** — redirects auth failures to `/login?authError=<code>`.
- **`src/auth/middleware.ts`**, **`src/auth/login-routes.ts`** — Google callback/initiation use login redirect instead of JSON errors; successful callback redirects to `returnTo` (including `/`).
- **`web/js/views-end-user.js`** — maps `authError` codes to user-visible alert messages on the login page.

---

### (pending) — 2026-06-07 — Google connector modal: Portal sign-in tab

**Why** — Directory sync and portal Google OAuth were split across two admin screens; operators expected one Google Workspace configuration surface.

**What changed:**

- **`web/js/views-stubs.js`** — Google Workspace edit modal adds **Portal sign-in** tab; save persists connector + Google OIDC settings.
- **`src/api/config-general-settings.ts`** — `GET/PUT /google-oidc` allowed for `ADMIN`+.

---

### (pending) — 2026-06-07 — Multi-domain Google Workspace sync + portal login

**Why** — Lenskart operates multiple Google Workspace domains (`lenskart.com`, `lenskart.in`, `dealskart.in`, …) on one tenant; single-domain OIDC checks blocked users on secondary domains.

**What changed:**

- **`src/auth/google-domains.ts`** — shared parse/validate helpers for multi-domain allowlists.
- **`src/auth/google-oidc-config.ts`**, **`login-routes.ts`**, **`middleware.ts`** — merge Authentication + Directory connector domains; validate email domain on callback; omit Google `hd=` when multiple domains configured.
- **`src/services/google-directory-config.ts`**, **`src/api/iga.ts`**, **`web/js/views-stubs.js`** — connector **Workspace domains** field accepts one domain per line; same list drives portal login when OIDC domains are unset.
- **`migrations/022_google_oidc_multi_domain.sql`** — widen `general_settings.google_oidc_hosted_domain` to 1000 chars.
- **`web/js/views-admin.js`** — Authentication page uses multi-line domain editor.

---

### (pending) — 2026-06-07 — Fix SAML AuthnRequest Issuer parse on SSO resume (redirect binding)

**Why** — After portal login, `/saml/resume/:id` returned `Could not determine Service Provider from SAMLRequest` for Zoho and other SPs using HTTP-Redirect binding, because Issuer extraction only base64-decoded the request instead of DEFLATE-inflating it first.

**What changed:**

- **`src/saml/idp.ts`** — `decodeAuthnRequestXml()` handles redirect (deflate+base64) and post (base64 XML) bindings; `extractIssuerFromAuthnRequest()` uses it.
- **`src/api/saml.ts`** — normalizes stored query/body params; caches `spEntityId` in the pending Redis payload as a resume hint.

---

### (pending) — 2026-06-07 — `check-user-sso.sh` diagnostic for SP-initiated login

**Why** — Admins need a quick read-only check (employee, local account, Zoho policy grant, SAML keys) before testing Zoho SP-initiated SSO for a user.

**What changed:**

- **`scripts/check-user-sso.sh`** — `bash scripts/check-user-sso.sh <email> [app-slug]` prints pass/fail for SSO readiness.

---

### (pending) — 2026-06-07 — SP-initiated SSO redirects to portal login (local + Google)

**Why** — Unauthenticated users hitting `/saml/sso` (e.g. Zoho login page) were hard-redirected to `/auth/google`, which blocked local-password users and failed when Google OIDC was not configured.

**What changed:**

- **`src/api/saml.ts`** — unauthenticated SP-initiated SSO now redirects to `/login?returnTo=/saml/resume/<id>` instead of `/auth/google`.
- **`web/js/views-end-user.js`** — login page honors `returnTo` after local password / MFA success; Google button preserves `returnTo`; SSO resume shows “Sign in to continue to your application.”

---

### (pending) — 2026-06-07 — Admin GUI Google OIDC configuration with DB-backed overrides

**Why** — Google sign-in troubleshooting required SSH + `.env` edits for OAuth client fixes, and teams often had the OAuth web-client JSON downloaded from Google Cloud Console but no direct in-product place to apply it.

**What changed:**

- **`migrations/021_google_oidc_gui_settings.sql`** — adds `general_settings.google_oidc_client_id`, `google_oidc_client_secret`, `google_oidc_hosted_domain`.
- **`src/api/config-general-settings.ts`** — adds `GET/PUT /api/admin/general-settings/google-oidc`; `PUT` accepts direct fields or pasted OAuth JSON (`web.client_id`, `web.client_secret`).
- **`src/auth/google-oidc-config.ts`** — central effective-config resolver (`general_settings` override → `.env` fallback) + configured-state helper.
- **`src/auth/login-routes.ts`**, **`src/auth/middleware.ts`** — `/auth/google` + callback now use effective Google OIDC config from DB/env.
- **`web/js/views-admin.js`**, **`web/js/api.js`** — Authentication page now includes a Google OIDC form in GUI (client ID, secret, hosted domain, optional OAuth JSON paste).
- **`src/api/admin-dashboard.ts`** — dashboard Google OIDC status now reflects DB override + env fallback, not env-only.

---

### (pending) — 2026-06-07 — AD group sync auto-discovery + stronger member mapping

**Why** — AD group sync runs were importing users but returning 0 group imports in many setups because `syncGroups` was blank (treated as skip) and member resolution depended mostly on AD link/email fields.

**What changed:**

- **`src/services/group-sync.ts`** — AD group sync now defaults blank `syncGroups` to auto-discover up to 200 security groups (same behavior as `*`), improves same-name synced-group upsert, and resolves members by `employeeID` / UPN fallback.
- **`src/adapters/ad-adapter.ts`** — `listGroupMemberUsers()` now reads `userPrincipalName` and `employeeID` in addition to `sAMAccountName` / `mail`.
- **`src/services/ad-sync.ts`** — inbound run summary now reports AD group sync as auto-all mode when `syncGroups` is blank.
- **`web/js/views-stubs.js`** — AD connector scope hint updated: blank Sync Groups means auto-sync (up to 200 security groups).

---

### (pending) — 2026-06-07 — Migration 020: normalize Zoho slug/name variants for policy gating

**Why** — Some environments had Zoho Mail created as slug `zoho_mail` / name `Zoho_mail` instead of `zoho-mail`. Migrations `017/019` targeted `zoho-mail` only, so those variant rows remained `all_active=true` / `visibility='PUBLIC'`, causing users to see Zoho without explicit policy grants.

**What changed:**

- **`migrations/020_fix_zoho_slug_variants_restricted.sql`** — forces policy gating for Zoho slug/name variants by setting `saml_service_providers.entitlement_rule = {all_active:false}` and `applications.visibility = 'RESTRICTED'` for `zoho-mail`, `zoho_mail`, and normalized name `zoho mail`.

---

### (pending) — 2026-06-07 — Migration 019: force Zoho Mail policy-gated in DB

**Why** — Migration `017` ran on the server but its `WHERE JSON_EXTRACT(...) = true` clause did not match on the running MySQL version, leaving `applications.visibility = 'PUBLIC'` and `entitlement_rule.all_active = true`. The migration runner skips already-applied files by name even when content changes, so `017` can never re-run. `019` fixes the data unconditionally.

**What changed:**

- **`migrations/019_fix_zoho_restricted.sql`** — unconditionally sets `saml_service_providers.entitlement_rule = {all_active:false}` and `applications.visibility = 'RESTRICTED'` for `zoho-mail`.

---

### `633f23b` — 2026-06-07 — AD corporate login: UPN bind + circuit-breaker isolation

**Why** — AD password login still failed for synced users because verification only tried sAMAccountName/DN lookup, wrong-password attempts could trip the AD circuit breaker, and login required a pre-existing identity link.

**What changed:**

- **`src/adapters/ad-adapter.ts`** — direct UPN/email bind (`verifyUserCredentialsByEmail`); credential checks bypass circuit breaker; multi-principal bind fallback (UPN, mail, DN).
- **`src/services/ad-auth.ts`** — login retries configured/StartTLS/LDAPS; case-insensitive email lookup; identity-link auto-backfill after successful auth; redacted connector bind password falls back to `.env`.

---

### `07bc5c9` — 2026-06-07 — Application Access Policy: identity group assignments

**Why** — Admins created groups under **Identity → Groups** (e.g. "zoho mail") but the **Assign Application Access** modal only listed tag groups, so the group never appeared in the dropdown.

**What changed:**

- **`migrations/018_identity_group_app_access.sql`** — `app_access_assignments.assignment_type` adds `GROUP` (targets `groups.id` / `group_members`).
- **`src/services/app-access-policy.ts`** — policy checks and grants honor identity-group membership; validates assignment targets.
- **`src/api/config-app-access-policy.ts`** — assignments list resolves identity group names.
- **`web/js/views-stubs.js`** — group-based assignment dropdown lists **Identity Groups** and tag groups.

---

### `a046a59` — 2026-06-07 — Fix AD login stale hash + writeback retry exhaustion

**Why** — Two follow-up bugs: (1) users with an existing `local_accounts` row whose password changed in AD could not log in because the stale-hash check never fell through to AD auth; (2) the writeback retry loop re-threw any non-"requires LDAPS" error (e.g. connection refused on StartTLS attempt) instead of continuing to the LDAPS attempt, so only one of three modes was ever tried.

**What changed:**

- **`src/auth/local-auth.ts`** — try AD corporate auth when local hash verify fails (not only when account is absent).
- **`src/services/password-writeback.ts`** — all three connection-mode attempts (configured / StartTLS / LDAPS) now always run; error from each attempt is collected and the aggregate message is thrown only after all three fail.

---

### `e6b2ee2` — 2026-06-07 — AD-synced login + password writeback reliability

**Why** — Employees imported from AD could not sign in at `/login` (no `local_accounts` row) and admin password reset often failed to update AD when the connector used plain LDAP or identity links were missing.

**What changed:**

- **`src/services/ad-auth.ts`** — LDAP bind fallback for AD-synced employees; provisions `local_accounts` on first successful AD login.
- **`src/auth/local-auth.ts`** — tries AD corporate auth when no local account exists.
- **`src/adapters/ad-adapter.ts`** — `verifyUserCredentials()` for read-only AD password checks.
- **`src/services/password-writeback.ts`** — export `ensureWritebackIdentityLinks()`; AD writeback resets circuit breaker and retries StartTLS/LDAPS; clearer error when encryption is required.
- **`src/api/admin-users.ts`** — resolve identity links / emp_id migration before local reset + writeback.

---

### `4ba8522` — 2026-06-07 — AD password reset: verify with user bind after unicodePwd modify

**Why** — Admin reset showed AD SUCCESS while the domain password was unchanged; LDAP modify alone was not verified before reporting success.

**What changed:**

- **`src/adapters/ad-adapter.ts`** — after `unicodePwd` replace, bind as the target user on the same DC; fail writeback if verification bind fails.

---

### `2815b1f` — 2026-06-07 — Fix MySQL reserved word `system` breaking password writeback

**Why** — Password reset showed `WRITEBACK` SQL syntax error because `system` is reserved in MySQL 8+ and was not backtick-quoted in `getIdentityLinksForEmp` and related queries.

**What changed:**

- **`src/utils/outbox.ts`**, **`src/api/admin-users.ts`**, **`src/api/employees.ts`**, **`src/api/internal.ts`**, **`src/services/outbox-worker.ts`** — quote `` `system` `` column in all `identity_links` / `adapter_outbox` SQL.

---

### `c1ac5ec` — 2026-06-07 — Admin password reset: AD/Google writeback + persistent UI results

**Why** — Reset only updated Local when AD/Google identity links were missing; success/failure feedback flashed away because the profile drawer re-rendered the Password Reset tab immediately after reset.

**What changed:**

- **`src/services/password-writeback.ts`** — backfill AD and Google identity links from `email_corp` before writeback; SKIPPED rows when connectors are active but no directory user matches.
- **`src/services/google-sync.ts`** — `backfillGoogleIdentityLinkIfMissing()` (mirrors AD profile backfill).
- **`web/js/views-stubs.js`** — persist per-system reset results on the tab; background profile refresh only; surface API `results`/`summary` on HTTP 400.

---

### `07bc5c9` — 2026-06-07 — Fix app launcher showing apps without Application Access Policy grant

**Why** — Users such as `test.a` saw Zoho Mail on *All Applications* even when no assignment existed, because the seeded SAML app used `entitlement_rule.all_active = true` and the home page merged the full IGA catalog into launch tiles.

**What changed:**

- **`src/services/app-access-policy.ts`** — `appRequiresExplicitGrant()`, `canUserLaunchApp()`; mirrored SAML apps default to `visibility = RESTRICTED`.
- **`src/api/apps.ts`**, **`src/api/saml.ts`** — unified launch entitlement via `canUserLaunchApp`.
- **`web/js/views-end-user.js`** — home launcher lists only `GET /api/apps` results; catalog browse stays on *Request Access*.
- **`migrations/017_zoho_policy_gated_access.sql`** — Zoho Mail policy-gated (`RESTRICTED`, `all_active = false`).

---

### `60ec800` — 2026-06-07 — Admin password reset: local + AD/Google writeback fixes

**Why** — Password reset appeared to succeed but did not change login credentials; AD writeback searched by `employeeID` instead of identity link `external_id`, and Google writeback ignored connector admin impersonation.

**What changed:**

- **`src/api/admin-users.ts`** — `asyncHandler` on reset route; auto-provision `local_accounts` when missing; fail clearly when nothing updated; fix `password_writeback_log` column (`ts`).
- **`src/services/password-writeback.ts`** — use active AD/Google connector config; AD reset via `sAMAccountName` from identity link.
- **`src/adapters/ad-adapter.ts`** — `setUserPassword()` (LDAPS/StartTLS required).
- **`web/js/views-stubs.js`** — password tab clarifies local `/login` vs SSO targets.

---

### `ec07102` — 2026-06-07 — AD group directory sync: discovery + reporting

**Why** — AD connector sync imported users but groups never appeared; sync history had no group line because `syncGroups` was often unset and group LDAP lookup was limited to the user search base.

**What changed:**

- **`src/adapters/ad-adapter.ts`** — `findGroup` falls back to domain root; `listDirectoryGroups()` for `syncGroups = *`.
- **`src/services/group-sync.ts`** — resolve `*` / `ALL` to up to 200 security groups.
- **`src/services/ad-sync.ts`** — always append group sync status to inbound summary (including "skipped" when unset).
- **`web/js/views-stubs.js`** — AD connector **Sync Scope** tab with Sync Groups help text.

---

### `65a9351` — 2026-06-07 — Group members modal: fix emp_id collation mismatch

**Why** — `GET /api/admin/groups/:id` (Manage Members modal) failed with `ER_CANT_AGGREGATE_2COLLATIONS` because `group_members.emp_id` used `utf8mb4_0900_ai_ci` while `employees.emp_id` uses `utf8mb4_unicode_ci`.

**What changed:**

- **`migrations/016_group_members_collation_fix.sql`** — align `group_members.group_id` and `emp_id` to `utf8mb4_unicode_ci`.
- **`src/api/config-groups.ts`** — COLLATE on employees JOIN; defensive empty-member fallback; COLLATE on member-count subquery.

---

### `534b531` — 2026-06-07 — Groups list: fix connector_id collation mismatch

**Why** — `GET /api/admin/groups` failed with `ER_CANT_AGGREGATE_2COLLATIONS` because migration 014 added `groups.connector_id` with MySQL 8 default `utf8mb4_0900_ai_ci` while `connectors.id` uses `utf8mb4_unicode_ci`.

**What changed:**

- **`migrations/015_groups_collation_fix.sql`** — align `groups.connector_id` and `external_id` to `utf8mb4_unicode_ci`.
- **`src/api/config-groups.ts`** — COLLATE on connectors JOIN; treat collation errors as fallback to legacy list.

---

### `f15db28` — 2026-06-07 — Groups API: hardened list fallback

**Why** — `/api/admin/groups` could still return 500 when migration 014 columns were missing or the extended JOIN query failed on a long-lived DB volume.

**What changed:**

- **`src/api/config-groups.ts`** — extended list uses raw `query` with explicit fallback to legacy SQL; normalizes `member_count` / dates for JSON; lazy-imports sync service on `POST /sync` only.
- **`src/services/group-sync.ts`** — `isGroupSyncSchemaReady()` probes `SELECT source_system FROM groups LIMIT 0` instead of `information_schema` (never throws; treats probe errors as not ready).

---

### `e8d525f` — 2026-06-07 — Groups: member management + Google/AD directory sync

**Why** — Identity Groups page had no way to add members; operators expected groups to mirror Google Workspace and Active Directory.

**What changed:**

- **`migrations/014_group_directory_sync.sql`** — `groups.source_system`, `external_id`, `connector_id`, `last_synced_at`.
- **`src/services/group-sync.ts`** — mirrors configured Google / AD groups into `groups` + `group_members`; hooked into `google-sync` and `ad-sync`.
- **`src/adapters/ad-adapter.ts`** — `findGroup`, `listGroupMemberUsers` for AD group membership import.
- **`POST /api/admin/groups/sync`** — manual directory group sync from admin UI.
- **`web/js/views-stubs.js`** — Groups page: Manage Members (search + add/remove), Sync from Directory, source badges; AD connector **Sync Groups** field.

### `2de9f80` — 2026-06-07 — App Access Policy: populate application dropdown from SAML catalog

**Why** — Assign Application Access modal showed an empty application list because SAML SPs lived only in `saml_service_providers`, not `applications`.

**What changed:**

- **`src/services/app-access-policy.ts`** — `syncSamlAppsToCatalog()` mirrors SAML SPs into `applications` on read; `listAssignableApplications()` powers the admin dropdown.
- **`GET /api/admin/app-access-policy/applications`** — returns assignable apps for the policy UI.
- **`web/js/views-stubs.js`** — modal reloads catalog on open; empty-state hints for apps and tag groups.

### `91d4afa` — 2026-06-06 — Application Access Policy admin page

**Why** — Administrators needed a dedicated page to grant application access by user or tag group, configure group-access approval workflows, and retain an audit trail for requests, approvals, provisioning, and revocations.

**What changed:**

- **`migrations/013_app_access_policy.sql`** — `tag_groups`, `tag_group_members`, `app_access_assignments`, `app_group_access_workflows`, `app_access_audit_log`; extends `access_requests.item_type` with `APP_ACCESS`.
- **`src/services/app-access-policy.ts`** — assignments, workflow resolution, SAML policy entitlement checks, fulfillment, audit logging.
- **`src/api/config-app-access-policy.ts`** — admin REST API at `/api/admin/app-access-policy`.
- **`src/services/access-request-workflow.ts`** — `APP_ACCESS` uses configured workflows; fixes request status (`PENDING`) and approval decision values (`APPROVED`/`REJECTED`); provisions access on final approval.
- **`src/api/apps.ts`**, **`src/api/saml.ts`** — honour policy-based assignments alongside entitlement rules.
- **`web/js/views-stubs.js`** — **Application Access Policy** page (Assignment · Workflow · Audit tabs).
- **`web/js/api.js`**, **`web/js/app.js`** — route under **Access Model** + API client methods.

### `e54e47d` — 2026-06-06 — Persist SAML signing keys across container rebuilds

**Why** — Zoho SAML launch failed with signature verification mismatch because the IdP signing certificate rotated after API container recreation.

**What changed:**

- **`docker-compose.dev.yml`**, **`docker-compose.yml`**, **`docker-compose.prod.yml`** — mount named volume `saml-keys` at `/app/data/saml` for `lilg-api`.
- Added deployment/runbook notes that SAML key material must persist to keep SP trust intact.

### `9bc181e` — 2026-06-06 — User Directory: admin MFA management for local users

**Why** — Admins needed GUI controls to create local users and manage MFA setup directly from the Unified Directory profile drawer.

**What changed:**

- **`src/api/admin-users.ts`** — adds admin MFA endpoints per user (`/mfa`, `/mfa/enroll`, `/mfa/confirm`, `/mfa/disable`, `/mfa/regenerate-codes`) and includes `mfaStatus` in `GET /api/admin/users/:empId`.
- **`web/js/api.js`** — adds `adminMfa*` client methods.
- **`web/js/views-stubs.js`** — profile drawer adds new **MFA** tab with enrollment QR, confirm code, disable, and regenerate backup codes.

### `pending` — 2026-06-06 — Restrict IdP metadata to ADMIN+

**Why** — Regular users (USER role) could open `/saml/metadata` and see the metadata URL in Account → Capabilities and the profile dropdown.

**What changed:**

- **`GET /saml/metadata`** — requires authenticated ADMIN+ session (no longer public).
- **`GET /api/me`** — `capabilities.metadataUrl` omitted unless caller is ADMIN+.
- Profile dropdown and Account capabilities panel hide SAML metadata for non-admins automatically.

### `9599c4b` — 2026-06-06 — SAML SP registration: metadata XML upload

**Why** — Register SAML Application required hand-typing Entity ID and ACS URL; vendors (Zoho, AWS, etc.) provide a metadata XML file.

**What changed:**

- **`src/saml/parse-sp-metadata.ts`** — parses SP `EntityDescriptor` via samlify; prefers HTTP-POST ACS binding.
- **`POST /api/admin/saml-apps/parse-metadata`** — super-admin endpoint returns extracted fields.
- **`web/js/views-admin.js`** — Register/Edit SAML modal: upload `.xml` or paste metadata, auto-fills SP fields.
- **`web/js/views-stubs.js`** — SAML integration wizard SP step gets the same upload/paste control.

### `7ab97f3` — 2026-06-06 — Google connector UI: GOOGLE type alias + Sync Scope tab

**Why** — Seeded `google-workspace` connector uses `connector_type = GOOGLE`; the edit modal only registered fields under `GOOGLE_WORKSPACE`, so OU/group/user scope fields never appeared.

**What changed:**

- **`web/js/views-stubs.js`** — `normalizeConnectorType()` maps `GOOGLE` → `GOOGLE_WORKSPACE`; Connection / Sync Scope tabbed modal; cache-bust query string in `index.html`.
- **`src/api/iga.ts`** — connector test treats `GOOGLE` and `GOOGLE_WORKSPACE` identically.

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
