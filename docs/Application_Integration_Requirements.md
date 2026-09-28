# Application Integration Requirements — Lenskart IdP

**Audience:** Application / SaaS owners who need SSO (and optional provisioning) against Lenskart IdP  
**IdP base URL (example):** `https://idp.lenskart.com` (use your environment’s `PUBLIC_BASE_URL`)  
**Protocols supported:** SAML 2.0 · OIDC / OAuth 2.0 · Outbound SCIM 2.0 (optional)

This document lists what **your application must provide and support**. IdP admin steps (registering the app, access policy) are noted briefly so you know what to expect.

---

## 1. Choose a protocol

| Use case | Recommended protocol | Optional lifecycle |
|----------|----------------------|--------------------|
| Classic enterprise SaaS (Slack-style, Zoho, Autodesk, etc.) | **SAML 2.0** | **SCIM 2.0** (app hosts SCIM; IdP calls it) |
| Modern web / API apps, Grafana, custom portals | **OIDC** (authorization code + PKCE) | Optional **OIDC + SCIM** for auto create/disable |
| Auto create / disable accounts in the SaaS | **SAML + SCIM** or **OIDC + SCIM** | App must host SCIM Users API |
| HR pushing users *into* the IdP | — | **Not available** (inbound SCIM server is roadmap) |

You can register **SAML only**, **OIDC only**, **SAML + SCIM**, or **OIDC + SCIM**. OIDC and SAML are separate registrations in Admin; SCIM attaches to the mirrored catalog application either way.

---

## 2. SAML 2.0 — requirements from the application (SP)

Lenskart IdP is the **Identity Provider**. Your app is the **Service Provider (SP)**.

### 2.1 Values you must give IdP admins

| Requirement | Required | Notes |
|-------------|----------|--------|
| **SP Entity ID** | Yes | Your SAML EntityID (often a URN or HTTPS URL) |
| **ACS URL** | Yes | Assertion Consumer Service — must accept **HTTP-POST** |
| **Application display name** | Yes | Shown on the user portal |
| **SP metadata XML** | Recommended | Speeds onboarding; IdP can parse Entity ID + ACS (+ SLO if present) |

### 2.2 Values you receive from IdP (configure in your app)

| Setting in your app | Value |
|---------------------|--------|
| **IdP Entity ID** | `{BASE}/saml/metadata` |
| **IdP SSO URL** | `{BASE}/saml/sso` |
| **IdP metadata / X.509 certificate** | Download from IdP Admin (metadata requires an admin session; you typically get a file, not a public URL) |
| **NameID format** (default) | `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` |
| **NameID value** (default) | Corporate email (`email_corp`) |

`{BASE}` = IdP public base URL (e.g. `https://idp.lenskart.com`).

### 2.3 Protocol capabilities your app must support

| Capability | Required by IdP |
|------------|-----------------|
| Consume SAML 2.0 **Response** via **HTTP-POST** to ACS | **Yes** |
| Trust IdP signing certificate (RSA-SHA256) | **Yes** |
| Signed assertion and/or signed response | **Yes** (both enabled by default) |
| SP-initiated SSO (`AuthnRequest` to IdP SSO URL) | Supported (Redirect or POST) |
| IdP-initiated SSO (portal tile → ACS) | Supported |
| Encrypted assertions | **Not used** — do not require encryption |
| Signed AuthnRequest from SP | **Not required** |
| Single Logout (SLO) | SLO URL may be stored; **IdP SLO is not implemented** — do not depend on SAML logout |

### 2.4 Attributes typically sent (customize per app)

Default NameID: **email**.

When default attribute merge is on, assertions commonly include:

| SAML attribute | Source (typical) |
|----------------|------------------|
| `email` / `mail` | Corporate email |
| `firstName` / `lastName` | Employee name |
| `displayName` | Full name |
| `employeeId` | Employee ID |
| `department` / `title` | Directory fields |
| `objectGUID` | AD object GUID (needs AD sync) |

IdP admins can remap attributes to match your vendor’s exact names (e.g. Autodesk requires case-sensitive `firstName`, `lastName`, `email`, `objectGUID`).

### 2.5 Optional fields you may provide

| Field | When to use |
|-------|-------------|
| **Default RelayState** | Deep link after IdP-initiated login |
| **SLO URL** | Informational only today |
| Preferred **NameID format** / attribute | If you need username or employee ID instead of email |
| Attribute schema document | So IdP can build a correct `attribute_map` |

### 2.6 Access & MFA (what your users will experience)

- Users sign in to the IdP with **Lenskart AD password** or **Google Workspace**, then reach your app.
- Only employees in **ACTIVE / REACTIVATED** state get assertions.
- Access is normally via **Application Access Policy** (user/group grant) or “allow all users” — not “everyone with a directory account” by default.
- **Critical apps** can require MFA at launch even if the portal session already exists.

### 2.7 SAML checklist (application side)

- [ ] Provide Entity ID + ACS URL (POST), preferably SP metadata XML  
- [ ] Import IdP metadata / certificate and SSO URL  
- [ ] Confirm NameID = email (or request a different mapping)  
- [ ] Confirm required attributes and exact attribute names  
- [ ] Test SP-initiated and (if needed) IdP-initiated login  
- [ ] Confirm whether SCIM provisioning is also required (see §3)

---

## 3. SCIM 2.0 — requirements from the application (with SAML)

For lifecycle, the IdP is a **SCIM client**. **Your application must host a SCIM 2.0 server**.

> There is **no** inbound SCIM API on the IdP for apps to push users into Lenskart IdP.

### 3.1 Values you must give IdP admins

| Requirement | Required | Notes |
|-------------|----------|--------|
| **SCIM base URL** | Yes | e.g. `https://api.example.com/scim/v2` |
| **Bearer token** | Yes | Long-lived token IdP sends as `Authorization: Bearer …` |
| **Users path** | Optional | Default `/Users` (full URL = base + path) |
| **Deprovision mode** | Optional | Default: **PATCH** `active: false`; some apps (e.g. Slack) use **DELETE** |

### 3.2 What your SCIM API must support

| Operation | Purpose |
|-----------|---------|
| **GET** Users with filter (and/or search) | Find existing user by email / `userName` |
| **POST** `/Users` | Create user when access is granted |
| **PATCH** user | Reactivate or set `active: false` on revoke |
| **DELETE** user | Only if you require hard delete (e.g. Slack) |

**Auth:** Bearer token  
**Content-Type / Accept:** `application/scim+json`

### 3.3 User payload the IdP sends on create (typical)

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "user@lenskart.com",
  "name": { "formatted": "Full Name" },
  "displayName": "Full Name",
  "active": true,
  "emails": [
    { "value": "user@lenskart.com", "primary": true, "type": "work" }
  ]
}
```

### 3.4 What SCIM does *not* cover today

- Group / entitlement SCIM sync from IdP to your app  
- Inbound SCIM into the IdP  
- Arbitrary vendor extensions beyond Users create / lookup / deactivate (or delete)

SSO still uses **SAML** (or OIDC). SCIM only creates/disables the account in your product when IdP access is granted or revoked.

### 3.5 SCIM checklist (application side)

- [ ] Expose SCIM 2.0 Users API over HTTPS  
- [ ] Issue a bearer token for Lenskart IdP  
- [ ] Support filter/search by email or `userName`  
- [ ] Support create + deactivate (or delete)  
- [ ] Share base URL + token + deprovision preference with IdP admins  
- [ ] Coordinate with SAML (or OIDC) so login and provisioning use the same email identity  

---

## 4. OIDC / OAuth 2.0 — requirements from the application (RP)

Lenskart IdP is the **OpenID Provider**. Your app is the **Relying Party (RP)**.

### 4.1 Values you must give IdP admins

| Requirement | Required | Notes |
|-------------|----------|--------|
| **Redirect URI(s)** | Yes | HTTPS; must match authorize requests exactly |
| **Application name** | Yes | |
| **Client type** | Yes | **Confidential** (server apps) or **Public** (SPA/native — PKCE mandatory) |
| **Scopes needed** | Recommended | At least `openid`; usually also `email`, `profile` |
| **Portal launch URL** | Optional | Where the portal tile sends the browser (vendor OAuth start URL) |

### 4.2 Values you receive from IdP

| Setting in your app | Value |
|---------------------|--------|
| **Issuer / Discovery** | `{BASE}/.well-known/openid-configuration` |
| **JWKS** | `{BASE}/.well-known/jwks.json` |
| **Authorization** | `{BASE}/oauth/authorize` |
| **Token** | `{BASE}/oauth/token` |
| **UserInfo** | `{BASE}/oauth/userinfo` |
| **Client ID** | Issued at registration |
| **Client secret** | Issued once for confidential clients (store securely) |

### 4.3 Protocol capabilities your app must support

| Capability | Required |
|------------|----------|
| Authorization **code** flow | **Yes** (only `response_type=code`) |
| **PKCE S256** | **Yes** for public clients; strongly expected for confidential too |
| Token endpoint auth | `client_secret_basic` or `client_secret_post` (confidential) |
| Validate ID/access tokens with **RS256** + JWKS | **Yes** |
| Refresh tokens | If you need offline access — request `offline_access` / refresh grant |
| Implicit / hybrid flows | **Not supported** |
| `private_key_jwt` | Not fully supported — use client secret |

### 4.4 Claims you can expect

| Claim | Typical meaning |
|-------|-----------------|
| `sub` | Stable employee id (`emp_id`) |
| `email` | Corporate email |
| `email_verified` | Boolean |
| `name` / `given_name` / `family_name` | Display / name parts |
| `preferred_username` | Usually email local-part |
| `emp_id` / `role` | Lenskart-specific |

Token lifetimes (approximate): authorization code ~10 min; access/ID token ~1 hour; refresh ~30 days (when issued).

**Note:** There is no standard `groups` claim/scope in the current OP discovery set. Use Application Access Policy on the IdP for who may launch the app.

### 4.5 Access & MFA

Same as SAML: portal session, ACTIVE/REACTIVATED users, Application Access Policy (or allow-all), optional critical-app MFA at authorize time.

### 4.6 OIDC checklist (application side)

- [ ] Implement authorization code + PKCE (S256)  
- [ ] Register all production (and staging) redirect URIs  
- [ ] Load discovery document and JWKS from IdP  
- [ ] Store client secret securely (confidential clients)  
- [ ] Request scopes: `openid email profile` (+ `offline_access` if needed)  
- [ ] Map `sub` / `email` into your local user model  
- [ ] Test authorize → token → UserInfo (and refresh if used)  

### 4.7 Can OIDC auto-disable users in the application?

**OIDC login alone — no. OIDC + SCIM — yes.**

| Mechanism | Creates / disables account in your app? |
|-----------|----------------------------------------|
| **OIDC login only** | **No.** Authenticates and issues tokens. Your app may JIT-create a user on first login. Revoking IdP access does **not** call your app. |
| **OIDC + SCIM** | **Yes.** Same outbound SCIM engine as SAML: IdP calls your SCIM Users API on Application Access Policy grant/revoke (create / deactivate or delete). |
| **SAML alone (no SCIM)** | **No** remote disable — SSO only. |

**Configure in IdP:** Admin → Applications → **OIDC / OAuth** → Edit app → **Enable SCIM provisioning** (base URL + bearer token + deprovision mode). Requires your app to expose SCIM 2.0 Users (see §3).

**Still true without SCIM:** user cannot get new tokens after access revoke, but an existing local account in your product stays active until you disable it (via SCIM or your own admin).

---

## 5. Side-by-side summary

| Topic | SAML SP | OIDC RP | SCIM (app server) |
|-------|---------|---------|-------------------|
| You provide | Entity ID, ACS URL | Redirect URIs, client type | SCIM base URL, bearer token |
| You receive | IdP metadata, SSO URL, cert | Discovery, client id/secret, JWKS | Provision/deprovision calls from IdP |
| Login binding | HTTP-POST to ACS | Auth code + PKCE | N/A (lifecycle only) |
| Lifecycle | Optional SCIM on SAML app | Optional SCIM on OIDC app | Create / deactivate / delete |
| Primary user key | Email NameID (default) | `sub` + `email` | `userName` / email |
| Signing | Trust IdP X.509 | Validate RS256 JWT | HTTPS + Bearer |
| Groups in token/assertion | Via custom attributes if mapped | Not in default claims | Not provisioned as Groups |

---

## 6. Information to send IdP admins (copy-paste template)

```text
Application name:
Environment (prod/stage):
Protocol: [ ] SAML  [ ] OIDC  [ ] SAML + SCIM  [ ] OIDC + SCIM

--- If SAML ---
SP Entity ID:
ACS URL (HTTPS, POST):
SP metadata XML: [attach or link]
NameID preference: email (default) / other:
Required attributes (exact names):
Default RelayState (optional):
Critical app (MFA at every launch): yes/no

--- If OIDC ---
Redirect URIs (one per line):
Client type: confidential / public
Scopes: openid email profile [offline_access]
Portal launch URL (optional):

--- If SCIM (with SAML or OIDC) ---
SCIM base URL:
Bearer token: [secure channel]
Users path (if not /Users):
Deprovision: PATCH active=false / DELETE

Technical contact:
Go-live target date:
```

---

## 7. Related internal docs

| Doc | Purpose |
|-----|---------|
| `ARCHITECTURE.md` §6 / §6.4a | Living IdP implementation detail |
| Admin → SAML Applications | Register SP, attributes, SCIM, access |
| Admin → OIDC / OAuth | Register RP clients |
| Admin → Application Access Policy | Who can launch the app |

For questions on attribute mapping or vendor-specific quirks (Autodesk, Slack, Grafana, etc.), involve IdP admins before go-live so mappings and access policy are ready.
