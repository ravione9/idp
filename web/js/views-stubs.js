/* Scaffolded views — accurate feature catalogue modelled on miniOrange + SailPoint.
 * Each view shows a "feature card": status badge, description, list of capabilities,
 * and the supporting database/API state.
 */
import { el, esc } from './ui.js';

const STATUS_BADGE = {
  live:        '<span class="badge badge-success">● Live</span>',
  data:        '<span class="badge badge-info">◍ Schema + read API</span>',
  scaffolded:  '<span class="badge badge-warning">◐ Scaffolded</span>',
  planned:     '<span class="badge badge-neutral">○ Planned</span>',
};

export function renderFeaturePage(content, cfg) {
  /* cfg: { title, subtitle, status, summary, capabilities[], inspiredBy[], roadmap?, ctas?[] } */
  const wrap = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>${esc(cfg.title)}</h1>
          <p class="subtitle">${esc(cfg.subtitle)}</p>
        </div>
        <div>${STATUS_BADGE[cfg.status] || ''}</div>
      </div>

      <div class="grid-3">
        <div class="card" style="grid-column: span 2; min-width:0">
          <h2>About this capability</h2>
          <p class="subtitle" style="margin-top:0.5rem;line-height:1.7">${esc(cfg.summary)}</p>

          ${cfg.capabilities ? `
            <h3 class="section-title">Capabilities</h3>
            <ul style="list-style:none;padding:0;display:grid;gap:0.5rem">
              ${cfg.capabilities.map((c) => `<li style="display:flex;gap:0.5rem;align-items:flex-start">
                <span style="color:var(--accent);font-weight:700">›</span>
                <span>${esc(c)}</span>
              </li>`).join('')}
            </ul>` : ''}

          ${cfg.ctas && cfg.ctas.length ? `
            <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap">
              ${cfg.ctas.map((c) => `<a class="btn btn-secondary btn-sm" href="${esc(c.href)}" ${c.external ? 'target="_blank" rel="noopener"' : ''}>${esc(c.label)}</a>`).join('')}
            </div>` : ''}
        </div>

        <div class="card">
          <h2>Modelled after</h2>
          <ul style="list-style:none;padding:0;margin-top:0.5rem;display:grid;gap:0.4rem">
            ${(cfg.inspiredBy || []).map((p) => `<li><span class="badge badge-neutral">${esc(p)}</span></li>`).join('')}
          </ul>
          ${cfg.roadmap ? `<p class="subtitle" style="margin-top:1rem">Ships in <strong>${esc(cfg.roadmap)}</strong>. See <code>ARCHITECTURE.md §15 Roadmap</code>.</p>` : ''}
        </div>
      </div>
    </div>
  `);
  content.replaceChildren(wrap);
}

/* ============================================================
   IDENTITY & USERS (miniOrange: Users / Groups / System Users)
   ============================================================ */
export const viewGroups = (content) => renderFeaturePage(content, {
  title:    'Groups',
  subtitle: 'Logical groupings of identities for entitlement assignment and notifications',
  status:   'planned',
  summary:  'Groups bundle identities (employees and external) so entitlements can be assigned by membership instead of individually. Static groups are managed manually; dynamic groups are populated by attribute rules (department, location, role) and re-evaluated on identity events.',
  capabilities: [
    'Static and dynamic (attribute-rule-based) group membership',
    'Nested group hierarchy',
    'Group-driven entitlement provisioning',
    'Notification distribution lists',
    'Inbound sync from Active Directory / Google Workspace / Zoho People',
  ],
  inspiredBy: ['miniOrange Groups', 'SailPoint Identity Profiles', 'Okta Groups'],
  roadmap:    'Phase 2',
});

export const viewSystemUsers = (content) => renderFeaturePage(content, {
  title:    'System / Privileged Users',
  subtitle: 'Service accounts and shared credentials with elevated rights',
  status:   'planned',
  summary:  'Distinct from human identities — system users are non-human accounts (service principals, API clients, robotic accounts) requiring stronger controls: scheduled rotation, just-in-time elevation, and full session recording.',
  capabilities: [
    'Service-account inventory across cloud providers',
    'Credential vault with per-secret access policies',
    'Just-in-time (JIT) elevation with auto-expiry',
    'Session recording for SSH / RDP / database',
    'Owner certification of service accounts',
    'Discovery scans for orphaned service identities',
  ],
  inspiredBy: ['miniOrange PAM', 'CyberArk', 'BeyondTrust', 'SailPoint Privileged Accounts'],
  roadmap:    'Phase 5',
});

export const viewIdentityProfiles = (content) => renderFeaturePage(content, {
  title:    'Identity Profiles',
  subtitle: 'Source-of-truth definitions for each identity population',
  status:   'planned',
  summary:  'An identity profile maps an authoritative source (HRMS, contractor portal, partner directory) to attributes and lifecycle policies. It controls how an identity is created, what attributes it carries, and which lifecycle events apply.',
  capabilities: [
    'Multiple authoritative sources (employees, contractors, partners, customers)',
    'Attribute mapping and transformation',
    'Lifecycle state machine per profile',
    'Birthright access tied to profile membership',
    'Scope-based delegated administration',
  ],
  inspiredBy: ['SailPoint IdentityNow Identity Profiles'],
  roadmap:    'Phase 2',
});

/* ============================================================
   AUTHENTICATION (miniOrange-style fan of MFA methods, adaptive,
   password policies, login customization)
   ============================================================ */
export const viewMfaMethods = (content) => renderFeaturePage(content, {
  title:    'Strong Authentication Methods',
  subtitle: 'Multi-factor and passwordless options end users can enrol',
  status:   'data',
  summary:  'Each method is a pluggable factor. Per-tenant policy decides which factors are mandatory, which are optional, and which qualify for passwordless. TOTP is live; the rest are scaffolded with schema or planned for Phase 3.',
  capabilities: [
    'Time-based OTP (TOTP) — Google Authenticator / Authy / 1Password — LIVE',
    'Backup codes (single-use, hashed) — LIVE',
    'WebAuthn / FIDO2 / Passkeys — schema in migration 003',
    'Email OTP — Phase 3',
    'SMS OTP — Phase 3 (carrier integration)',
    'Push notification (mobile companion app) — Phase 5',
    'YubiKey / hardware tokens — Phase 5',
    'PKI / smart card — Phase 5',
    'Magic-link login (passwordless) — Phase 3',
    'Security questions — Phase 3',
  ],
  inspiredBy: ['miniOrange Strong Auth Method', 'Okta Verify', 'Duo'],
  roadmap:    'Phase 3 for the remainder',
  ctas: [{ label: 'Enrol my TOTP →', href: '/?v=settings' }],
});

export const viewAdaptiveAuth = (content) => renderFeaturePage(content, {
  title:    'Adaptive Authentication',
  subtitle: 'Risk-based policies that decide allow / step-up / deny per login',
  status:   'data',
  summary:  'Each login is scored against a set of risk factors (geo-velocity, IP reputation, device fingerprint, time of day, behavioural anomaly). The policy engine maps the score to one of four decisions. Schema and audit table are live (`login_risk_events`); the engine and policy editor ship in Phase 3.',
  capabilities: [
    'Geo-velocity (impossible-travel) detection',
    'IP allow / deny lists and country-level rules',
    'Device fingerprint + new-device challenge',
    'Time-of-day / business-hours rules',
    'Velocity (rapid login attempts) detection',
    'Behavioural baseline (per-user model)',
    'Risk score → ALLOW / MFA / DENY / BLOCK',
    'Per-application risk thresholds',
  ],
  inspiredBy: ['miniOrange Adaptive Authentication', 'Okta Risk Engine', 'Microsoft Entra Conditional Access'],
  roadmap:    'Phase 3',
});

export const viewPasswordPolicies = (content) => renderFeaturePage(content, {
  title:    'Password Policies',
  subtitle: 'Complexity, rotation, history and lockout rules for local accounts',
  status:   'scaffolded',
  summary:  'Local accounts already have minimum-length enforcement (10 chars) and password history (`local_password_history`). Full policy authoring (per-population complexity, rotation interval, lockout threshold) and admin reset flow ship in Phase 3.',
  capabilities: [
    'Minimum length & character classes — current floor: 10 chars',
    'Password history (no reuse of last N) — table exists',
    'Rotation interval (mandatory change every N days)',
    'Account lockout after N failed attempts (data in `auth_attempts`)',
    'Self-service password reset via email link',
    'Admin-initiated reset with one-time token',
    'Breach check against HaveIBeenPwned (optional)',
  ],
  inspiredBy: ['miniOrange Password Policy', 'NIST 800-63B'],
  roadmap:    'Phase 3',
});

export const viewLoginCustomization = (content) => renderFeaturePage(content, {
  title:    'Login Customization',
  subtitle: 'Brand the sign-in page per tenant, audience or application',
  status:   'planned',
  summary:  'White-label the sign-in experience: corporate logo, accent colour, hero copy, terms-of-service link, support contact. Per-application or per-host customization for B2B / B2C / B2E.',
  capabilities: [
    'Logo, favicon, accent colour, hero image',
    'Per-application branding (RelayState-driven)',
    'Per-tenant theme for multi-tenant deployments',
    'Custom terms-of-service & privacy links',
    'Self-service registration toggle (CIAM)',
    'Locale support / RTL',
  ],
  inspiredBy: ['miniOrange Branding', 'Auth0 Universal Login', 'Okta Brands'],
  roadmap:    'Phase 4',
});

/* ============================================================
   APPLICATIONS (extra protocol surfaces)
   ============================================================ */
export const viewOidcApps = (content) => renderFeaturePage(content, {
  title:    'OIDC / OAuth 2.0 Applications',
  subtitle: 'Apps that consume Lenskart IdP as an OpenID Connect / OAuth issuer',
  status:   'data',
  summary:  'Schema for OIDC clients (`oidc_clients`) and issued tokens (`oauth_tokens`) is in migration 003. The discovery document, /authorize, /token, /userinfo and JWKS endpoints ship in Phase 3.',
  capabilities: [
    'OIDC discovery: /.well-known/openid-configuration',
    'Authorization Code + PKCE flow (public + confidential clients)',
    'Refresh tokens with rotation',
    'JWT id_token signed RS256, separate JWKS endpoint',
    'Front-channel and back-channel logout',
    'Dynamic client registration (RFC 7591)',
    'Per-client scope policies and consent prompt',
  ],
  inspiredBy: ['Okta OIDC', 'Auth0', 'Keycloak', 'miniOrange OIDC Provider'],
  roadmap:    'Phase 3',
});

export const viewAppDiscovery = (content) => renderFeaturePage(content, {
  title:    'Application Discovery',
  subtitle: 'Find SaaS apps your employees use that aren\'t federated yet',
  status:   'planned',
  summary:  'Crawl Google Workspace logs, browser proxy logs, and CASB feeds to surface unsanctioned ("shadow") applications. Each discovered app is suggested for SSO onboarding.',
  capabilities: [
    'Ingest from Google Workspace / Microsoft 365 audit logs',
    'Browser-extension-driven discovery',
    'Risk score per discovered app',
    'One-click "register as SAML / OIDC" workflow',
    'Suppression list for personal / SaaS-by-design apps',
  ],
  inspiredBy: ['miniOrange Discovery', 'Microsoft Defender for Cloud Apps', 'Netskope CASB'],
  roadmap:    'Phase 5',
});

/* ============================================================
   CONNECTIONS (sources / connectors detail)
   ============================================================ */
export const viewDirectorySync = (content) => renderFeaturePage(content, {
  title:    'Directory Sync',
  subtitle: 'Authoritative inbound sync from AD / LDAP / Google / Workday',
  status:   'data',
  summary:  'Connectors are persisted in `connectors`, with `connector_runs` for run history. Each run is dispatched via `adapter_outbox`. The execution layer for SCIM / Google Workspace / AD ships in Phase 2.',
  capabilities: [
    'Active Directory / LDAP via ldapts',
    'Google Workspace Directory API (already wired in src/adapters)',
    'Zoho People SCIM (outbound provisioning only)',
    'Workday SCIM (planned)',
    'Real-time + scheduled cron + manual triggers',
    'Reconciliation (drift detection)',
    'Schema mapping per connector',
  ],
  inspiredBy: ['miniOrange Directory Sync', 'SailPoint Sources', 'Okta Universal Directory'],
  roadmap:    'Phase 2 (executor) — schema is live',
});

/* ============================================================
   ACCESS MODEL
   ============================================================ */
export const viewRoles = (content) => renderFeaturePage(content, {
  title:    'Business Roles',
  subtitle: 'Bundles of entitlements that can be assigned to identities',
  status:   'data',
  summary:  'Tables `business_roles`, `role_entitlements`, `user_roles` are live in migration 003. Role mining (suggesting roles from existing entitlement patterns) and the role-engineering UI ship in Phase 2.',
  capabilities: [
    'Hierarchical roles (parent / child)',
    'Auto-assign rules (attribute-driven)',
    'Role mining (clustering of similar entitlement sets)',
    'Role certification campaigns',
    'Risk score per role',
    'SoD-aware role composition',
  ],
  inspiredBy: ['SailPoint Roles', 'Saviynt RBAC', 'miniOrange Role Management'],
  roadmap:    'Phase 2',
});

export const viewBirthright = (content) => renderFeaturePage(content, {
  title:    'Birthright Rules',
  subtitle: 'Access automatically granted on identity creation or attribute change',
  status:   'data',
  summary:  'Each entitlement has `is_birthright` and `birthright_rule` columns. The lifecycle engine evaluates rules on Joiner / Mover events and pushes provisioning jobs into `adapter_outbox`. The evaluator ships in Phase 2.',
  capabilities: [
    'Rule editor (department / role / location / type predicates)',
    'Trigger on Joiner / Mover / Leaver events',
    'Auto-revoke on attribute change',
    'Dry-run mode against current population',
    'Audit trail of every birthright grant/revoke',
  ],
  inspiredBy: ['SailPoint Birthright Profiles', 'Saviynt Birthright', 'Okta Lifecycle'],
  roadmap:    'Phase 2',
});

/* ============================================================
   PRIVILEGED ACCESS MANAGEMENT (miniOrange PAM)
   ============================================================ */
export const viewPamResources = (content) => renderFeaturePage(content, {
  title:    'Privileged Resources',
  subtitle: 'Servers, databases, network devices and SaaS admin consoles brokered by the IdP',
  status:   'planned',
  summary:  'Resources are the targets of privileged access. Each resource has a connector type (SSH / RDP / DB / web), a vault entry (or JIT credential), and an access policy. End users request just-in-time access with a justification.',
  capabilities: [
    'SSH / RDP / Windows / Database / Web targets',
    'Per-resource access policies',
    'Just-in-time credential injection (no password sharing)',
    'Recording (terminal / video) for audit',
    'Bastion host integration',
    'Policy-driven approval before connection',
  ],
  inspiredBy: ['miniOrange PAM Resources', 'CyberArk PSM', 'BeyondTrust PRA'],
  roadmap:    'Phase 5',
});

export const viewPamSessions = (content) => renderFeaturePage(content, {
  title:    'Privileged Sessions',
  subtitle: 'Live and historical PAM session monitoring',
  status:   'planned',
  summary:  'Every privileged connection is logged, with optional recording. Real-time monitoring lets a SOC operator terminate a suspicious session.',
  capabilities: [
    'Live session list with terminate action',
    'Searchable session history',
    'Keystroke + screen recording playback',
    'Command-level audit log',
    'Anomaly alerts (off-hours, unusual targets)',
  ],
  inspiredBy: ['miniOrange PAM Session Management'],
  roadmap:    'Phase 5',
});

export const viewPamVault = (content) => renderFeaturePage(content, {
  title:    'Credential Vault',
  subtitle: 'Encrypted vault for shared and machine credentials',
  status:   'planned',
  summary:  'Secrets are encrypted at rest with per-tenant KMS keys. JIT injection means humans never see the raw credential.',
  capabilities: [
    'AES-256 envelope encryption (KMS-rooted)',
    'Per-secret access policies',
    'Auto-rotation schedules',
    'Check-out / check-in workflow',
    'Audit of every secret access',
    'Integration with HashiCorp Vault / AWS Secrets Manager',
  ],
  inspiredBy: ['miniOrange Vault', 'HashiCorp Vault', 'CyberArk PVWA'],
  roadmap:    'Phase 5',
});

/* ============================================================
   WORKFLOWS & AUTOMATION
   ============================================================ */
export const viewWorkflowLibrary = (content) => renderFeaturePage(content, {
  title:    'Workflow Library',
  subtitle: 'Pre-built and custom workflows for IGA automation',
  status:   'planned',
  summary:  'Tables `workflow_definitions` and `workflow_runs` already exist (legacy schema). The visual builder, marketplace of pre-built workflows, and per-step audit trail ship in Phase 4.',
  capabilities: [
    'Visual builder (DAG of steps)',
    'Approval, condition, branch, loop, wait, http, script steps',
    'Marketplace of pre-built workflows (joiner, leaver, certification)',
    'Versioning + dry-run',
    'Per-run timeline & step inspector',
  ],
  inspiredBy: ['SailPoint Workflows', 'Saviynt Workflow', 'Okta Workflows'],
  roadmap:    'Phase 4',
});

export const viewEventTriggers = (content) => renderFeaturePage(content, {
  title:    'Event Triggers',
  subtitle: 'Subscribe workflows or webhooks to identity events',
  status:   'planned',
  summary:  'Wire events (joiner, leaver, role change, MFA enrolment, suspicious login) to webhooks, Slack/Teams notifications or workflow runs.',
  capabilities: [
    'Catalogue of system events',
    'Filter expressions per subscription',
    'Webhook delivery with retry + signing',
    'Slack / Teams / Email destinations',
    'Replay history',
  ],
  inspiredBy: ['SailPoint Event Triggers', 'Okta Event Hooks'],
  roadmap:    'Phase 4',
});

export const viewNotifications = (content) => renderFeaturePage(content, {
  title:    'Notifications',
  subtitle: 'Email / Slack / Teams / SMS templates and delivery state',
  status:   'data',
  summary:  'Outbox table `notifications` is live (migration 003). Template editor, channel adapters and digest scheduler ship in Phase 4.',
  capabilities: [
    'Channels: email, Slack, Teams, SMS, webhook, in-app',
    'Per-template variables + locale',
    'Digest scheduling (immediate, daily, weekly)',
    'Failure tracking + retry',
    'Delivery audit per recipient',
  ],
  inspiredBy: ['SailPoint Notifications', 'miniOrange notifications'],
  roadmap:    'Phase 4',
});

/* ============================================================
   REPORTS
   ============================================================ */
export const viewSsoReports = (content) => renderFeaturePage(content, {
  title:    'SSO Reports',
  subtitle: 'Login + assertion analytics across applications and identities',
  status:   'data',
  summary:  'Source data lives in `auth_attempts` and `saml_assertion_log`. The dashboard already exposes daily counts; full report builder with filters, scheduled email delivery and CSV export ships in Phase 5.',
  capabilities: [
    'Logins per app, per identity, per binding',
    'Failed login + lockout report',
    'Idle / dormant identity report',
    'Application adoption (% of entitled users that signed in)',
    'Custom date ranges + group-by',
    'Scheduled CSV / PDF email delivery',
  ],
  inspiredBy: ['miniOrange Reports', 'SailPoint IdentityNow Reports'],
  roadmap:    'Phase 5',
});

/* ============================================================
   SETTINGS / SYSTEM
   ============================================================ */
export const viewGeneralSettings = (content) => renderFeaturePage(content, {
  title:    'General Settings',
  subtitle: 'System-wide configuration: timezone, contact, defaults',
  status:   'planned',
  summary:  'Currently driven entirely by environment variables (see `ARCHITECTURE.md §10`). The runtime settings UI ships in Phase 4.',
  capabilities: [
    'Display name + support email',
    'Default session TTL',
    'Default cookie attributes',
    'Internal token rotation schedule',
    'Feature toggles per tenant',
  ],
  inspiredBy: ['miniOrange Settings', 'SailPoint Global'],
  roadmap:    'Phase 4',
});

export const viewBranding = (content) => renderFeaturePage(content, {
  title:    'Branding',
  subtitle: 'Theme, logo, colours and email-template customization',
  status:   'planned',
  summary:  'Customize the end-user experience. Tokenized CSS variables make the colour palette swappable; email templates use Handlebars.',
  capabilities: [
    'Logo + favicon + accent colour',
    'Login page hero copy and image',
    'Email template editor with preview',
    'Per-tenant theme overrides',
    'Footer text & links (legal, support)',
  ],
  inspiredBy: ['miniOrange Customization', 'Auth0 Branding'],
  roadmap:    'Phase 4',
});

export const viewLicense = (content) => renderFeaturePage(content, {
  title:    'License',
  subtitle: 'Active feature plan, identity counts and entitlement quotas',
  status:   'planned',
  summary:  'When this is operated as a multi-tenant or licensed offering, the license panel surfaces seat usage, expiry and feature gating.',
  capabilities: [
    'Feature flags (SSO, MFA, IGA, PAM)',
    'Active identity count vs entitled count',
    'Expiry alerts + renewal contact',
    'Audit of license-bound feature toggles',
  ],
  inspiredBy: ['miniOrange License', 'SailPoint Tenant Settings'],
  roadmap:    'Phase 5',
});

export const viewTickets = (content) => renderFeaturePage(content, {
  title:    'Tickets',
  subtitle: 'Help-desk tickets created by end-users from the portal',
  status:   'planned',
  summary:  'In-product ticketing for password reset, MFA reset, application access and account problems. Optional one-way bridge to ServiceNow / Jira.',
  capabilities: [
    'Categories: password / MFA / access / account',
    'SLA timer per category',
    'Knowledge-base suggestions before submit',
    'Bridge to ServiceNow / Jira / Freshservice',
    'In-app + email replies',
  ],
  inspiredBy: ['miniOrange Tickets'],
  roadmap:    'Phase 5',
});

export const viewSystemHealth = (content) => renderFeaturePage(content, {
  title:    'System Health',
  subtitle: 'Runtime telemetry: DB, Redis, outbox queue, connector status',
  status:   'data',
  summary:  'Existing endpoints `/healthz`, `/readyz`, `/metrics`, `/diagz` already provide most of this. The unified panel ships in Phase 4.',
  capabilities: [
    'Liveness / readiness / DB / Redis status',
    'Outbox queue depth + backlog age',
    'Connector run summaries',
    'API p50 / p95 / p99 latency',
    'Migration version + checksum verification',
  ],
  inspiredBy: ['SailPoint Active Queues', 'Okta Health'],
  roadmap:    'Phase 4',
  ctas: [
    { label: '/healthz', href: '/healthz', external: true },
    { label: '/readyz',  href: '/readyz',  external: true },
    { label: '/diagz',   href: '/diagz',   external: true },
    { label: '/metrics', href: '/metrics', external: true },
  ],
});
