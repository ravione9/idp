-- 003_iga_foundation.sql — IGA + multi-protocol AM data model
-- Lays the schema for the platform vision (SSO + IGA) defined in ARCHITECTURE.md.
-- All DDL is idempotent. Foreign keys are added with permissive ON DELETE.

-- ===========================================================================
-- Generic application registry (protocol-agnostic).
-- The legacy saml_service_providers table remains, but new apps should be
-- registered here. A linking row in app_protocol_configs ties protocol
-- specifics to an application.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS applications (
    id              VARCHAR(36)     NOT NULL,
    slug            VARCHAR(80)     NOT NULL,
    name            VARCHAR(150)    NOT NULL,
    description     TEXT            DEFAULT NULL,
    icon_url        VARCHAR(512)    DEFAULT NULL,
    category        VARCHAR(50)     DEFAULT NULL,
    owner_emp_id    VARCHAR(20)     DEFAULT NULL,
    visibility      ENUM('PUBLIC','RESTRICTED') NOT NULL DEFAULT 'PUBLIC',
    sso_enabled     BOOL            NOT NULL DEFAULT 1,
    provisioning    BOOL            NOT NULL DEFAULT 0,
    risk_score      INT             NOT NULL DEFAULT 0,
    sort_order      INT             NOT NULL DEFAULT 0,
    active          BOOL            NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_app_slug (slug),
    KEY idx_app_owner (owner_emp_id),
    CONSTRAINT fk_app_owner FOREIGN KEY (owner_emp_id) REFERENCES employees (emp_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Protocol bindings — one application can have N protocol configurations
-- (e.g., both SAML for SSO and SCIM for provisioning).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS app_protocol_configs (
    id              VARCHAR(36)     NOT NULL,
    app_id          VARCHAR(36)     NOT NULL,
    protocol        ENUM('SAML','OIDC','OAUTH2','WS_FED','CAS','HEADER','BOOKMARK','SCIM') NOT NULL,
    config          JSON            NOT NULL,
    active          BOOL            NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_app_protocol (app_id, protocol),
    CONSTRAINT fk_apc_app FOREIGN KEY (app_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- OIDC clients (registered apps that authenticate via OIDC OP)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS oidc_clients (
    id                  VARCHAR(36)     NOT NULL,
    app_id              VARCHAR(36)     DEFAULT NULL,
    client_id           VARCHAR(120)    NOT NULL,
    client_secret_hash  VARCHAR(255)    DEFAULT NULL,
    client_type         ENUM('CONFIDENTIAL','PUBLIC') NOT NULL DEFAULT 'CONFIDENTIAL',
    redirect_uris       JSON            NOT NULL,
    post_logout_uris    JSON            DEFAULT NULL,
    grant_types         JSON            NOT NULL,
    response_types      JSON            NOT NULL,
    scopes              JSON            NOT NULL,
    token_endpoint_auth ENUM('client_secret_basic','client_secret_post','none','private_key_jwt') NOT NULL DEFAULT 'client_secret_basic',
    jwks_uri            VARCHAR(512)    DEFAULT NULL,
    require_pkce        BOOL            NOT NULL DEFAULT 1,
    active              BOOL            NOT NULL DEFAULT 1,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_oidc_client_id (client_id),
    KEY idx_oidc_app (app_id),
    CONSTRAINT fk_oidc_app FOREIGN KEY (app_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- OAuth/OIDC issued tokens (refresh + offline) — short-lived access tokens
-- are JWT and not stored.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS oauth_tokens (
    id              VARCHAR(36)     NOT NULL,
    type            ENUM('AUTHZ_CODE','REFRESH','ACCESS_REF') NOT NULL,
    client_id       VARCHAR(120)    NOT NULL,
    emp_id          VARCHAR(20)     NOT NULL,
    token_hash      VARCHAR(255)    NOT NULL,
    scope           VARCHAR(512)    DEFAULT NULL,
    nonce           VARCHAR(120)    DEFAULT NULL,
    redirect_uri    VARCHAR(512)    DEFAULT NULL,
    pkce_challenge  VARCHAR(120)    DEFAULT NULL,
    pkce_method     VARCHAR(10)     DEFAULT NULL,
    issued_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME        NOT NULL,
    revoked_at      DATETIME        DEFAULT NULL,
    last_used_at    DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_token_hash (token_hash),
    KEY idx_oauth_emp (emp_id),
    KEY idx_oauth_client (client_id),
    KEY idx_oauth_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Connectors — pluggable target-system adapters (HRMS, AD, Google, Slack, …)
-- The connector_type determines which adapter implementation runs.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS connectors (
    id                  VARCHAR(36)     NOT NULL,
    name                VARCHAR(100)    NOT NULL,
    slug                VARCHAR(50)     NOT NULL,
    connector_type      ENUM('SCIM','REST','LDAP','GOOGLE_WORKSPACE','ZOHO','SLACK','GITHUB','AD','HRMS','AWS_IAM','AZURE_AD','OKTA','SALESFORCE','JDBC','CUSTOM') NOT NULL,
    direction           ENUM('INBOUND','OUTBOUND','BIDIRECTIONAL') NOT NULL DEFAULT 'OUTBOUND',
    config              JSON            NOT NULL,
    secrets_ref         VARCHAR(512)    DEFAULT NULL,
    sync_mode           ENUM('REALTIME','SCHEDULED','MANUAL') NOT NULL DEFAULT 'SCHEDULED',
    sync_schedule       VARCHAR(100)    DEFAULT NULL,
    schema_version      INT             NOT NULL DEFAULT 1,
    status              ENUM('CONFIGURED','CONNECTED','ERROR','DISABLED') NOT NULL DEFAULT 'CONFIGURED',
    last_sync_at        DATETIME        DEFAULT NULL,
    last_error          TEXT            DEFAULT NULL,
    health_check_url    VARCHAR(512)    DEFAULT NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_connector_slug (slug),
    KEY idx_connector_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Connector run history — every reconciliation / sync run
-- ===========================================================================
CREATE TABLE IF NOT EXISTS connector_runs (
    id              VARCHAR(36)     NOT NULL,
    connector_id    VARCHAR(36)     NOT NULL,
    run_type        ENUM('FULL_SYNC','INCREMENTAL','RECONCILE','PROVISION','DEPROVISION') NOT NULL,
    status          ENUM('RUNNING','SUCCESS','FAILED','PARTIAL') NOT NULL DEFAULT 'RUNNING',
    started_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at        DATETIME        DEFAULT NULL,
    items_processed INT             NOT NULL DEFAULT 0,
    items_succeeded INT             NOT NULL DEFAULT 0,
    items_failed    INT             NOT NULL DEFAULT 0,
    error_summary   TEXT            DEFAULT NULL,
    payload         JSON            DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_run_connector (connector_id, started_at DESC),
    CONSTRAINT fk_cr_connector FOREIGN KEY (connector_id) REFERENCES connectors (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Entitlements — granular permissions inside an app (role, group, license, …)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS entitlements (
    id              VARCHAR(36)     NOT NULL,
    app_id          VARCHAR(36)     DEFAULT NULL,
    connector_id    VARCHAR(36)     DEFAULT NULL,
    name            VARCHAR(150)    NOT NULL,
    slug            VARCHAR(150)    NOT NULL,
    type            ENUM('ROLE','GROUP','PERMISSION','LICENSE','CAPABILITY') NOT NULL DEFAULT 'ROLE',
    description     TEXT            DEFAULT NULL,
    risk_score      INT             NOT NULL DEFAULT 0,
    is_birthright   BOOL            NOT NULL DEFAULT 0,
    birthright_rule JSON            DEFAULT NULL,
    requires_review BOOL            NOT NULL DEFAULT 0,
    external_id     VARCHAR(255)    DEFAULT NULL,
    metadata        JSON            DEFAULT NULL,
    active          BOOL            NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_ent_scope_slug (app_id, connector_id, slug),
    KEY idx_ent_app (app_id),
    KEY idx_ent_connector (connector_id),
    CONSTRAINT fk_ent_app FOREIGN KEY (app_id) REFERENCES applications (id) ON DELETE CASCADE,
    CONSTRAINT fk_ent_connector FOREIGN KEY (connector_id) REFERENCES connectors (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- User → entitlement assignments (the heart of access governance)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS user_entitlements (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    entitlement_id  VARCHAR(36)     NOT NULL,
    source          ENUM('BIRTHRIGHT','REQUEST','ROLE','MANUAL','RECONCILED') NOT NULL DEFAULT 'MANUAL',
    granted_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    granted_by      VARCHAR(20)     DEFAULT NULL,
    expires_at      DATETIME        DEFAULT NULL,
    revoked_at      DATETIME        DEFAULT NULL,
    revoked_by      VARCHAR(20)     DEFAULT NULL,
    revoke_reason   VARCHAR(255)    DEFAULT NULL,
    request_id      VARCHAR(36)     DEFAULT NULL,
    last_used_at    DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_ue_active (emp_id, entitlement_id, granted_at),
    KEY idx_ue_emp (emp_id),
    KEY idx_ue_ent (entitlement_id),
    KEY idx_ue_active_filter (emp_id, revoked_at),
    CONSTRAINT fk_ue_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE,
    CONSTRAINT fk_ue_ent FOREIGN KEY (entitlement_id) REFERENCES entitlements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Roles (business roles bundling entitlements) and role memberships
-- ===========================================================================
CREATE TABLE IF NOT EXISTS business_roles (
    id              VARCHAR(36)     NOT NULL,
    name            VARCHAR(150)    NOT NULL,
    slug            VARCHAR(80)     NOT NULL,
    description     TEXT            DEFAULT NULL,
    parent_role_id  VARCHAR(36)     DEFAULT NULL,
    auto_assign_rule JSON           DEFAULT NULL,
    risk_score      INT             NOT NULL DEFAULT 0,
    active          BOOL            NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_role_slug (slug),
    CONSTRAINT fk_role_parent FOREIGN KEY (parent_role_id) REFERENCES business_roles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_entitlements (
    role_id         VARCHAR(36)     NOT NULL,
    entitlement_id  VARCHAR(36)     NOT NULL,
    PRIMARY KEY (role_id, entitlement_id),
    CONSTRAINT fk_re_role FOREIGN KEY (role_id) REFERENCES business_roles (id) ON DELETE CASCADE,
    CONSTRAINT fk_re_ent FOREIGN KEY (entitlement_id) REFERENCES entitlements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    role_id         VARCHAR(36)     NOT NULL,
    granted_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    granted_by      VARCHAR(20)     DEFAULT NULL,
    expires_at      DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_role (emp_id, role_id),
    CONSTRAINT fk_ur_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE,
    CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES business_roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Access requests + multi-level approvals
-- ===========================================================================
CREATE TABLE IF NOT EXISTS access_requests (
    id              VARCHAR(36)     NOT NULL,
    requester_emp_id VARCHAR(20)    NOT NULL,
    target_emp_id   VARCHAR(20)     NOT NULL,
    item_type       ENUM('ENTITLEMENT','ROLE','APPLICATION') NOT NULL,
    item_ids        JSON            NOT NULL,
    justification   TEXT            DEFAULT NULL,
    status          ENUM('DRAFT','PENDING','APPROVED','REJECTED','FULFILLED','PARTIALLY_FULFILLED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    sla_due_at      DATETIME        DEFAULT NULL,
    valid_until     DATETIME        DEFAULT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at      DATETIME        DEFAULT NULL,
    fulfilled_at    DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_ar_requester (requester_emp_id, created_at DESC),
    KEY idx_ar_target (target_emp_id, created_at DESC),
    KEY idx_ar_status (status, created_at DESC),
    CONSTRAINT fk_ar_requester FOREIGN KEY (requester_emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE,
    CONSTRAINT fk_ar_target FOREIGN KEY (target_emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS access_request_approvals (
    id              VARCHAR(36)     NOT NULL,
    request_id      VARCHAR(36)     NOT NULL,
    level           INT             NOT NULL,
    approver_emp_id VARCHAR(20)     NOT NULL,
    decision        ENUM('PENDING','APPROVED','REJECTED','DELEGATED','SKIPPED') NOT NULL DEFAULT 'PENDING',
    decided_at      DATETIME        DEFAULT NULL,
    delegated_to    VARCHAR(20)     DEFAULT NULL,
    comment         TEXT            DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_ara_request (request_id, level),
    KEY idx_ara_approver (approver_emp_id, decision),
    CONSTRAINT fk_ara_request FOREIGN KEY (request_id) REFERENCES access_requests (id) ON DELETE CASCADE,
    CONSTRAINT fk_ara_approver FOREIGN KEY (approver_emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Access reviews / certification campaigns
-- ===========================================================================
CREATE TABLE IF NOT EXISTS access_review_campaigns (
    id              VARCHAR(36)     NOT NULL,
    name            VARCHAR(200)    NOT NULL,
    description     TEXT            DEFAULT NULL,
    scope           JSON            NOT NULL,
    reviewer_kind   ENUM('MANAGER','APP_OWNER','ROLE_OWNER','CUSTOM') NOT NULL DEFAULT 'MANAGER',
    start_date      DATETIME        NOT NULL,
    end_date        DATETIME        NOT NULL,
    status          ENUM('DRAFT','ACTIVE','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
    created_by      VARCHAR(20)     NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_arc_status (status, start_date DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS access_review_items (
    id              VARCHAR(36)     NOT NULL,
    campaign_id     VARCHAR(36)     NOT NULL,
    emp_id          VARCHAR(20)     NOT NULL,
    entitlement_id  VARCHAR(36)     DEFAULT NULL,
    role_id         VARCHAR(36)     DEFAULT NULL,
    reviewer_emp_id VARCHAR(20)     NOT NULL,
    decision        ENUM('PENDING','CERTIFY','REVOKE','DELEGATE') NOT NULL DEFAULT 'PENDING',
    decided_at      DATETIME        DEFAULT NULL,
    comment         TEXT            DEFAULT NULL,
    evidence        JSON            DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_ari_campaign (campaign_id, decision),
    KEY idx_ari_reviewer (reviewer_emp_id, decision),
    CONSTRAINT fk_ari_campaign FOREIGN KEY (campaign_id) REFERENCES access_review_campaigns (id) ON DELETE CASCADE,
    CONSTRAINT fk_ari_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Segregation of Duties (SoD) policies + violations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS sod_policies (
    id              VARCHAR(36)     NOT NULL,
    name            VARCHAR(200)    NOT NULL,
    description     TEXT            DEFAULT NULL,
    severity        ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'HIGH',
    enforcement     ENUM('PREVENT','REQUIRE_APPROVAL','ALERT','MONITOR') NOT NULL DEFAULT 'ALERT',
    conflict_groups JSON            NOT NULL,
    active          BOOL            NOT NULL DEFAULT 1,
    created_by      VARCHAR(20)     NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sod_violations (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    policy_id       VARCHAR(36)     NOT NULL,
    emp_id          VARCHAR(20)     NOT NULL,
    conflicting_ents JSON           NOT NULL,
    detected_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status          ENUM('OPEN','APPROVED_EXCEPTION','RESOLVED','SUPPRESSED') NOT NULL DEFAULT 'OPEN',
    exception_until DATETIME        DEFAULT NULL,
    exception_by    VARCHAR(20)     DEFAULT NULL,
    resolved_at     DATETIME        DEFAULT NULL,
    notes           TEXT            DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_sv_emp (emp_id, status),
    KEY idx_sv_policy (policy_id, status),
    CONSTRAINT fk_sv_policy FOREIGN KEY (policy_id) REFERENCES sod_policies (id) ON DELETE CASCADE,
    CONSTRAINT fk_sv_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Risk scoring — current per-user score + per-login risk events
-- ===========================================================================
CREATE TABLE IF NOT EXISTS risk_scores (
    emp_id          VARCHAR(20)     NOT NULL,
    score           INT             NOT NULL DEFAULT 0,
    factors         JSON            DEFAULT NULL,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (emp_id),
    CONSTRAINT fk_rs_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_risk_events (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     DEFAULT NULL,
    email           VARCHAR(255)    DEFAULT NULL,
    session_id      CHAR(36)        DEFAULT NULL,
    ip              VARCHAR(45)     DEFAULT NULL,
    user_agent      TEXT            DEFAULT NULL,
    country         VARCHAR(80)     DEFAULT NULL,
    score           INT             NOT NULL DEFAULT 0,
    factors         JSON            DEFAULT NULL,
    decision        ENUM('ALLOW','MFA','DENY','BLOCK') NOT NULL DEFAULT 'ALLOW',
    ts              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_lre_emp (emp_id, ts DESC),
    KEY idx_lre_decision (decision, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- WebAuthn credentials (passkeys) — enabled in a future migration once routes
-- exist. Schema is here so the migration order is stable.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id                  VARCHAR(255)    NOT NULL,
    emp_id              VARCHAR(20)     NOT NULL,
    public_key          BLOB            NOT NULL,
    counter             BIGINT          NOT NULL DEFAULT 0,
    transports          JSON            DEFAULT NULL,
    aaguid              VARCHAR(64)     DEFAULT NULL,
    name                VARCHAR(150)    DEFAULT NULL,
    last_used_at        DATETIME        DEFAULT NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_webauthn_emp (emp_id),
    CONSTRAINT fk_webauthn_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Compliance reports (recorded snapshots for SOX / GDPR / etc.)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS compliance_reports (
    id              VARCHAR(36)     NOT NULL,
    name            VARCHAR(200)    NOT NULL,
    framework       VARCHAR(50)     NOT NULL,
    generated_by    VARCHAR(20)     NOT NULL,
    generated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    period_start    DATE            NOT NULL,
    period_end      DATE            NOT NULL,
    payload         JSON            NOT NULL,
    artifact_url    VARCHAR(512)    DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_comp_framework (framework, generated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Notifications — outbox for emails / Slack / Teams alerts
-- ===========================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    channel         ENUM('EMAIL','SLACK','TEAMS','SMS','WEBHOOK','INAPP') NOT NULL,
    recipient       VARCHAR(255)    NOT NULL,
    template        VARCHAR(100)    NOT NULL,
    payload         JSON            NOT NULL,
    status          ENUM('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
    attempts        INT             NOT NULL DEFAULT 0,
    last_error      TEXT            DEFAULT NULL,
    related_kind    VARCHAR(40)     DEFAULT NULL,
    related_id      VARCHAR(64)     DEFAULT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at         DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_notif_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
