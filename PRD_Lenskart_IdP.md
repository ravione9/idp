# Product Requirements Document — Lenskart IdP (LILG)

| | |
|---|---|
| **Product** | Lenskart Identity Provider — Enterprise SSO, Identity Governance & Privileged Access ("LILG") |
| **Document owner** | DevOps / IT Infrastructure — Lenskart |
| **Status** | Living document |
| **Version** | 1.1 — July 29, 2026 (data tier moved in-cluster; multi-client packaging decisions locked) |
| **Production target** | `idp.lenskart.com` |
| **Related docs** | `ARCHITECTURE.md` (technical source of truth), `HA_Kubernetes_Architecture.md`, `HA_Fix_Implementation_Guide.md`, `K8s_Deployment_Guide.md` |

---

## 1. Executive summary

Lenskart IdP is an in-house enterprise identity platform that consolidates three product categories — normally bought as separate commercial products — into one system:

1. **Access Management (AM)** — single sign-on for all enterprise applications via SAML 2.0 and OIDC/OAuth 2.0, with multi-method MFA and adaptive, risk-based authentication (modelled on Okta, OneLogin, miniOrange).
2. **Identity Governance & Administration (IGA)** — joiner/mover/leaver lifecycle automation driven by the HRMS feed, access requests with approvals, access-review campaigns, segregation-of-duties enforcement, and compliance reporting (modelled on SailPoint, Saviynt).
3. **Privileged Access Management (PAM)** — credential vault, privileged resource inventory, and (planned) just-in-time elevation and session recording (modelled on CyberArk, BeyondTrust).

The platform replaces per-app credential sprawl and manual on/off-boarding with a single governed identity fabric: every Lenskart employee gets one identity, one login, one place to request access — and IT gets one place to grant, review, revoke, and prove compliance.

## 2. Problem statement

Before this platform, Lenskart's identity landscape had these gaps:

- **Credential sprawl** — every SaaS and internal app maintained its own accounts and passwords; no central SSO. Password reuse and phishing exposure scaled with the app count.
- **Manual lifecycle** — onboarding and offboarding were ticket-driven. Leavers could retain live access to email, VPN, and internal systems for days after exit — the single largest insider-risk exposure.
- **No access governance** — no systematic answer to "who has access to what, who approved it, and is it still appropriate?" Audit requests required manual evidence gathering across systems.
- **No privileged-access control** — shared admin credentials in spreadsheets/browsers, with no vault, rotation, or usage trail.
- **Commercial alternatives** (Okta + SailPoint + CyberArk) cost hundreds of thousands of dollars annually at Lenskart's headcount, with per-user pricing that penalizes retail-scale workforces.

## 3. Goals & success metrics

| # | Goal | Metric | Target |
|---|---|---|---|
| G1 | Single sign-on for all corporate apps | Apps behind IdP SSO | 100% of SaaS/internal apps onboarded (Zoho Mail live; Darwinbox, ServiceNow, Google Workspace next) |
| G2 | Automated leaver revocation | Time from HRMS exit event to all-system access revocation | < 15 minutes, zero manual steps |
| G3 | MFA everywhere | Active workforce with ≥1 strong factor enrolled | > 95% |
| G4 | Provable compliance | Time to produce access-review / audit evidence | Hours, not weeks; every assertion and login attempt in tamper-evident audit log |
| G5 | Platform availability | IdP uptime (it gates every other app's login) | ≥ 99.9% (HA on Kubernetes — see Part IV docs) |
| G6 | Cost | Licence spend vs commercial stack | ~$0 licence cost; infra + maintenance only |

## 4. Non-goals

- **Customer identity (CIAM)** — this platform serves the workforce (employees, contractors, partners). Lenskart customer-facing login is out of scope.
- **Replacing HRMS** — the HRMS (Darwinbox/Zoho People) remains the source of truth for employment facts; the IdP consumes its feed.
- **Being an email/collaboration provider** — Zoho Mail, Google Workspace, etc. remain the providers; the IdP federates into them.
- **Network access control (NAC)** — RADIUS AAA for VPN is in scope; switch-port/802.1X NAC is not.

## 5. Users & personas

| Persona | Description | Primary needs |
|---|---|---|
| **End user** (employee/contractor) | Any Lenskart workforce member | One login for everything; app launcher portal; self-service password change, MFA enrolment, session management, access requests, personal credential vault |
| **IT administrator** | Runs the IdP day-to-day | Admin console: SAML/OIDC app registry, user management, MFA policy, connector configuration, workflow builder, diagnostics |
| **Manager / App owner** | Approves access | Approval queue for access requests; access-review (certification) campaigns |
| **Security / Compliance officer** | Audits and governs | Audit logs, SoD violations, risk scores, compliance reports, session/login forensics |
| **Super admin** | Privileged operations | PAM vault, privileged resource inventory, master configuration |
| **HR system** (machine) | Lifecycle driver | HRMS feed → joiner/mover/leaver events via SQS/SFTP |

## 6. Scope & phasing

Delivery is phased; the database schema deliberately runs ahead of service code so each phase "flips features on."

| Phase | Scope | Status |
|---|---|---|
| **1 — SSO MVP** | SAML 2.0 IdP, local + Google OIDC sign-in, TOTP MFA, session management, Zoho Mail SP, audit log, migration runner | ✅ Live |
| **2 — IGA Foundation** | IGA schema + APIs, access-request workflow with approval chains, birthright engine, AD & Google Workspace sync, password writeback, user lifecycle (suspend/terminate), access reviews, SoD evaluator, notifications, workflow engine | ✅ Complete |
| **3 — Modern AM** | OIDC/OAuth 2.0 Authorization Server, WebAuthn/passkeys, email/SMS OTP, RADIUS AAA (VPN), Redis-backed rate limiting | ✅ Largely complete (WS-Fed/header SSO planned) |
| **4 — Productionize** | `idp.lenskart.com` on HA Kubernetes: multi-replica API, migration Job, managed MySQL/Redis, TLS at edge, secrets management, monitoring | 🔄 In progress (code-side multi-replica safety ✅; deploy-time work per K8s Deployment Guide) |
| **5 — Advanced IGA/PAM** | Credential vault ✅, personal vault ✅, app discovery MVP ✅; JIT elevation, session recording, SCIM server, identity warehouse, SIEM streaming | 🔄 Partial |

## 7. Functional requirements

Priorities: **M**ust / **S**hould / **C**ould (MoSCoW). "Live" indicates already implemented.

### 7.1 Authentication & sessions

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-A1 | Local username/password login with bcrypt-hashed credentials and password history | M | Live |
| FR-A2 | Inbound federation: Google Workspace OIDC sign-in | M | Live |
| FR-A3 | MFA methods: TOTP, backup codes, email OTP, SMS OTP, WebAuthn/passkeys | M | Live |
| FR-A4 | MFA policy engine: per-user enforcement, per-group policies, group exclusions | M | Live |
| FR-A5 | Adaptive authentication: risk engine returns ALLOW / MFA / STEP_UP / DENY per login (geo-velocity, IP rules, device) | S | Partial |
| FR-A6 | Sessions in MySQL + Redis with idle and absolute timeouts (sliding window), HMAC-signed cookies | M | Live |
| FR-A7 | Session attribution: device (User-Agent), public IP, geolocation per session; user-visible session list with revocation | S | Live |
| FR-A8 | Login rate limiting, cluster-safe (Redis-backed), fail-open on Redis outage | M | Live |
| FR-A9 | Account lockout policy from `auth_attempts` history | S | Planned |
| FR-A10 | Master admin bootstrap from environment on startup | M | Live |

### 7.2 Single sign-on (IdP)

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-S1 | SAML 2.0 IdP: SP-initiated and IdP-initiated flows, signed assertions, metadata endpoint | M | Live |
| FR-S2 | SP registry: admin CRUD for SAML applications, SP metadata import, per-app entitlement gating | M | Live |
| FR-S3 | OIDC/OAuth 2.0 Authorization Server: discovery, JWKS, authorization code + PKCE, refresh tokens, UserInfo, admin client registry | M | Live |
| FR-S4 | Application launcher portal ("My Applications" tile grid) filtered by user entitlements | M | Live |
| FR-S5 | WS-Federation and header-based SSO for legacy apps | C | Planned |
| FR-S6 | RADIUS AAA for VPN: REST interface for FreeRADIUS + optional native UDP PAP listener; VPN profiles | S | Live |
| FR-S7 | Every issued assertion/token and login attempt written to the audit log | M | Live |

### 7.3 Identity lifecycle & governance

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-G1 | HRMS-driven joiner/mover/leaver state machine; lifecycle events recorded | M | Live |
| FR-G2 | Adapter outbox with retry/back-off, dead-letter, leader-elected worker; adapters for Google Workspace, Zoho, Active Directory | M | Live |
| FR-G3 | Directory sync (AD + Google): inbound import with suspended-account rules, outbound provisioning, group harvest into entitlement catalogue | M | Live |
| FR-G4 | Password writeback to AD (LDAPS) and Google on change/reset | S | Live |
| FR-G5 | Birthright access engine: rule-based (dept/type/role/group) auto-grant and revoke on JOINER/LEAVER | M | Live |
| FR-G6 | Self-service access requests: SoD pre-check → multi-level approval chain → SLA deadlines → automated fulfilment | M | Live |
| FR-G7 | Access-review campaigns (ALL_USERS / APP_SPECIFIC / HIGH_RISK scopes); REVOKE decisions trigger entitlement revocation; auto-close | M | Live |
| FR-G8 | Segregation-of-Duties: policies, evaluation on every grant, violation records, full-scan | M | Live |
| FR-G9 | Workflow engine: admin-built workflows (NOTIFY, GRANT/REVOKE_BIRTHRIGHT, WEBHOOK) fired by platform events; run history | S | Live |
| FR-G10 | Notification dispatcher: email, Slack, Teams, in-app | S | Live |
| FR-G11 | User lifecycle admin actions: suspend / unsuspend / terminate with session revocation and outbox DISABLE/ENABLE ops | M | Live |
| FR-G12 | Compliance reports with evidence retention; framework packs (SOX/GDPR/HIPAA/PCI) | S | Partial |
| FR-G13 | Tamper-evident, hash-chained audit trail | M | Live |
| FR-G14 | Risk scoring per identity and per login | S | Partial |
| FR-G15 | SCIM 2.0 inbound server (HRMS push) | C | Planned |

### 7.4 Privileged access management

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-P1 | Credential vault with AES-GCM sealed secrets and checkout flow (SUPER_ADMIN) | S | Live |
| FR-P2 | Personal credential vault per end user | S | Live |
| FR-P3 | Privileged resource / system-account inventory | S | Live |
| FR-P4 | JIT elevation with auto-expiry; session recording and playback | C | Planned |

### 7.5 Administration & self-service

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-M1 | Admin web console: users, apps, connectors, policies, workflows, reports, diagnostics, system health | M | Live |
| FR-M2 | Self-service portal: password change, MFA enrolment, sessions, access requests, vault, app launcher | M | Live |
| FR-M3 | RBAC + ABAC policy engine for admin surface | M | Live |
| FR-M4 | Login-page customization (logo, theme, copy) | C | Partial |
| FR-M5 | App discovery: browser-extension signals to find unsanctioned SaaS | C | MVP live |

## 8. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | **Availability** — the IdP gates every downstream login | ≥ 99.9%; multi-AZ Kubernetes, ≥3 API replicas, PDB `minAvailable: 2`, leader-elected worker; in-cluster 3-node Percona XtraDB (Galera, zero-data-loss node failure) + Redis with persistent AOF (see HA docs) |
| NFR-2 | **Horizontal scalability** | Stateless API pods (sessions in MySQL/Redis); HPA 3→6 replicas; DB pool sizing bounded by MySQL `max_connections`; DB pods on a dedicated tainted node group |
| NFR-3 | **Consistency at N replicas** | Single SAML/OIDC signing cert cluster-wide (Secret-injected); migrations serialized (Job + `GET_LOCK`); schedulers single-fire via Redis locks; global rate limits |
| NFR-4 | **Security** | TLS everywhere (edge-terminated); HttpOnly/Secure/SameSite cookies; bcrypt; AES-GCM sealed secrets; zod-validated config; non-root containers; etcd secret encryption; least-privilege RBAC/IRSA |
| NFR-5 | **Auditability** | Hash-chained audit log; every assertion, login, admin action, and outbox operation recorded; Prometheus metrics (`/metrics`, token-gated) |
| NFR-6 | **Recoverability** | In-cluster Percona XtraDB backups to S3-compatible storage (nightly, 7-day retention) with quarterly restore drills; pre-deploy backups before migrations; SAML-cert Secret backup per environment; DNS-level rollback to legacy origin during soak |
| NFR-7 | **Performance** | Login (post-MFA) p95 < 800 ms; SAML assertion issuance p95 < 300 ms server-side; portal initial load < 2 s on corporate network |
| NFR-8 | **Deployability** | Single Docker image; Helm chart with per-client values; single-tier docker-compose remains fully supported for dev/small installs |
| NFR-9 | **Multi-client packaging** | Fully self-contained per cluster: Helm chart + per-client values; signing certs auto-generated in-cluster (bootstrap Job); data tier in-cluster via operators (Percona XtraDB, Bitnami Redis) — no cloud-managed-service or external secret-store dependency |
| NFR-10 | **Observability** | `/healthz` (liveness), `/readyz` (DB+Redis readiness), `/diagz` (migration/table diagnostics), Prometheus metrics with outbox-depth and DB-pool alerts |

## 9. System context (summary)

Browser SPA (vanilla JS) → Express API (Node 22/TypeScript) exposing `/auth/*`, `/api/*`, `/saml/*`, `/oidc/*` → MySQL 8 (identities, sessions, IGA schema, audit) + Redis 7 (session cache, MFA challenges, rate limits, scheduler/leader locks) → outbox worker dispatching to Google/Zoho/AD adapters via SQS. Full diagrams and component detail live in `ARCHITECTURE.md` §2 and the HA architecture doc.

## 10. Dependencies & integrations

| Dependency | Role | Direction |
|---|---|---|
| HRMS (Darwinbox / Zoho People) | Employment source of truth | Inbound (SQS events / SFTP feed) |
| Google Workspace | Inbound OIDC IdP + outbound directory provisioning target | Both |
| Zoho | SAML SP (Mail) + SCIM provisioning target | Outbound |
| Active Directory | Directory sync, password writeback, group harvest | Both |
| AWS SQS | HRMS event + adapter queues | Infra |
| SMTP / Slack / Teams | Notification channels | Outbound |
| FreeRADIUS / VPN concentrator | AAA client | Inbound |
| Cloudflare | DNS, WAF, edge TLS | Infra |

## 11. Rollout plan

1. **Soak on Kubernetes** (current) — deploy per `K8s_Deployment_Guide.md`; share the data tier with the legacy host so DNS rollback is lossless; run the 10-point verification checklist.
2. **Cut over `idp.lenskart.com`** — Cloudflare → ALB; keep legacy host warm 1–2 weeks.
3. **SP onboarding wave** — Darwinbox HRMS, ServiceNow, Google Workspace (as SP), then internal apps; each onboarding is config-only (SP registry + entitlements).
4. **MFA enforcement ramp** — enrol-by-date policy per department; group policies already supported.
5. **Governance activation** — first access-review campaign, SoD policy set, compliance report cadence.
6. **Multi-client packaging** — Helm chart + per-client values; in-cluster keygen (Fix 1-ALT) for non-AWS clients.

## 12. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| IdP outage blocks all app logins | Company-wide | HA topology (multi-AZ, ≥3 replicas, Galera synchronous DB failover); DNS rollback path; break-glass master admin |
| Self-managed data tier failure (in-cluster DB) | Data loss / extended outage | Percona operator (never raw StatefulSets); 3-node quorum discipline; nightly S3 backups with quarterly restore drills; PVC disk alerts at 70%; dedicated tainted node group so app autoscaling can't evict DB pods |
| SAML cert divergence across replicas | Silent partial SSO failure | Secret-injected single cert; keygen Job immutability; fingerprint check in deploy verification |
| HRMS feed errors propagate (mass suspends) | Wrong access removal | Lifecycle FSM guards, dry-run for birthright, suspend (reversible) vs terminate separation, audit trail |
| Migration failure during deploy | Blocked rollout | Pre-upgrade Job halts rollout before pods change; `GET_LOCK` defense; pre-deploy RDS snapshot |
| Adapter API quota exhaustion (Google/Zoho) | Provisioning stalls | Outbox back-off + per-system concurrency semaphore; leader-elected single drainer; queue-depth alerting |
| Vanilla-JS SPA maintainability | Slowing feature velocity | Planned React + Vite + TypeScript migration (Phase 4) |
| Single team owns a security-critical platform | Bus factor | `ARCHITECTURE.md` change-log discipline; this PRD; runbooks; standard K8s tooling |

## 13. Open questions

1. Which compliance framework packs (SOX/GDPR/HIPAA/PCI) are actually required by Lenskart audit, and in what order?
2. Target date and owner for the React frontend migration (Phase 4)?
3. Does the multi-client offering require tenant-level branding/white-labelling beyond login customization?
4. SLA commitment for the access-request approval chain (current default SLA deadlines vs business expectation)?
5. Is SCIM inbound (FR-G15) required before Darwinbox onboarding, or does the SQS/SFTP feed suffice?

## 14. Glossary

**IdP** — Identity Provider. **SP** — Service Provider (an app consuming SSO). **IGA** — Identity Governance & Administration. **PAM** — Privileged Access Management. **JML** — Joiner/Mover/Leaver. **SoD** — Segregation of Duties. **Birthright access** — entitlements granted automatically by rule on joining. **Outbox** — transactional queue table drained by the worker to push changes to external systems. **HRMS** — Human Resources Management System.
