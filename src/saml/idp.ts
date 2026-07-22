/**
 * LILG — SAML 2.0 Identity Provider
 * Issues signed assertions to registered Service Providers for authenticated employees.
 */

import zlib from 'node:zlib';
import * as saml from 'samlify';
import { config, isSamlEnabled } from '../config.js';
import logger from '../utils/logger.js';
import type { EmployeeSamlContext, SamlServiceProviderRow } from './types.js';
import { DEFAULT_ATTRIBUTE_MAP } from './types.js';

// Relax XML schema validation (SP metadata varies widely across vendors)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(saml as any).setSchemaValidator({ validate: () => true });

let idpInstance: saml.IdentityProviderInstance | null = null;

/**
 * samlify's default login response leaves `{AuthnStatement}` empty. WebSSO SPs
 * (SentinelOne, Shibboleth, etc.) reject assertions without AuthnStatement.
 *
 * Hardcode the template (same as samlify's defaultLoginResponseTemplate) rather
 * than reading `saml.SamlLib` at module load — under Node ESM interop in Docker,
 * `import * as saml` often has SamlLib undefined on the namespace object.
 * AttributeStatement is folded into `{AuthnStatement}` so entity-idp's empty
 * attributes[] bake-in cannot leave a bare `<AttributeStatement/>`.
 */
// `{InResponseToAttr}` is either ` InResponseTo="…"` or empty. Unsolicited
// (IdP-initiated) responses must omit InResponseTo entirely — an empty
// InResponseTo="" is rejected by SentinelOne and other WebSSO SPs.
const LOGIN_RESPONSE_TEMPLATE_CONTEXT =
  '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}"{InResponseToAttr}><saml:Issuer>{Issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="{StatusCode}"/></samlp:Status><saml:Assertion xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{AssertionID}" Version="2.0" IssueInstant="{IssueInstant}"><saml:Issuer>{Issuer}</saml:Issuer><saml:Subject><saml:NameID Format="{NameIDFormat}">{NameID}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="{SubjectConfirmationDataNotOnOrAfter}" Recipient="{SubjectRecipient}"{InResponseToAttr}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="{ConditionsNotBefore}" NotOnOrAfter="{ConditionsNotOnOrAfter}"><saml:AudienceRestriction><saml:Audience>{Audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>{AuthnStatement}</saml:Assertion></samlp:Response>';

/** Mirror samlify SamlLib.replaceTagsByValue (quote-aware XML escape). Longest tags first avoids NameID vs NameIDFormat collisions. */
function replaceTagsByValue(rawXml: string, tagValues: Record<string, string>): string {
  let out = rawXml;
  const tags = Object.keys(tagValues).sort((a, b) => b.length - a.length);
  for (const tag of tags) {
    const value = tagValues[tag] ?? '';
    out = out.replace(new RegExp(`("?)\\{${tag}\\}`, 'g'), (_m, quote: string) =>
      quote ? `${quote}${escapeXml(value)}` : value,
    );
  }
  return out;
}

function toSamlDateTime(d: Date): string {
  // Some SP XSD validators are picky about fractional seconds.
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getIdp(): saml.IdentityProviderInstance {
  if (!isSamlEnabled()) {
    throw new Error('SAML IdP is not configured');
  }
  if (!idpInstance) {
    const s = config.saml!;
    idpInstance = saml.IdentityProvider({
      entityID:     s.entityId,
      privateKey:   s.privateKeyPem,
      signingCert:  s.certPem,
      isAssertionEncrypted: false,
      wantAuthnRequestsSigned: false,
      // Do not pass attributes: [] — samlify would bake an empty AttributeStatement
      // into the template (schema-invalid). Attributes are injected via customTagReplacement.
      loginResponseTemplate: {
        context: LOGIN_RESPONSE_TEMPLATE_CONTEXT,
      },
      singleSignOnService: [
        {
          Binding:  saml.Constants.namespace.binding.redirect,
          Location: `${s.baseUrl}/saml/sso`,
        },
        {
          Binding:  saml.Constants.namespace.binding.post,
          Location: `${s.baseUrl}/saml/sso`,
        },
      ],
      nameIDFormat: [
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      ],
    });
  }
  return idpInstance;
}

function buildSp(sp: SamlServiceProviderRow): saml.ServiceProviderInstance {
  const slo = sp.slo_url
    ? [{ Binding: saml.Constants.namespace.binding.redirect, Location: sp.slo_url }]
    : [];

  return saml.ServiceProvider({
    entityID: sp.entity_id,
    assertionConsumerService: [
      {
        Binding:  saml.Constants.namespace.binding.post,
        Location: sp.acs_url,
      },
    ],
    singleLogoutService: slo,
    nameIDFormat: [sp.nameid_format],
  });
}

function buildUserInfo(emp: EmployeeSamlContext, sp: SamlServiceProviderRow): {
  email: string;
  attributes: Record<string, string>;
} {
  const map = { ...DEFAULT_ATTRIBUTE_MAP, ...(sp.attribute_map ?? {}) };
  const attributes: Record<string, string> = {};

  for (const [samlName, empField] of Object.entries(map)) {
    if (!samlName || !empField) continue;
    const val = emp[empField as keyof EmployeeSamlContext];
    if (val !== null && val !== undefined && String(val).length > 0) {
      attributes[samlName] = String(val);
    }
  }

  // Always release mail + displayName for auto-provisioning SPs (e.g. SentinelOne).
  if (emp.email_corp) {
    attributes['email'] ??= emp.email_corp;
    attributes['mail'] ??= emp.email_corp;
  }
  if (emp.full_name) {
    attributes['displayName'] ??= emp.full_name;
  }

  return {
    email: emp.email_corp,
    attributes,
  };
}

export function getIdpMetadataXml(): string {
  const xml = getIdp().getMetadata().trim();
  if (xml.startsWith('<?xml')) {
    return xml;
  }
  // Some SP validators expect an explicit XML declaration.
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

export type SamlBinding = 'redirect' | 'post';

export interface SamlLoginInput {
  sp:           SamlServiceProviderRow;
  emp:          EmployeeSamlContext;
  binding:      SamlBinding;
  query?:       Record<string, string>;
  body?:        Record<string, string>;
  relayState?:  string;
}

interface SamlPostResult {
  context:         string;
  entityEndpoint:  string;
  relayState?:     string;
}

/** Build HTML auto-post form for HTTP-POST assertion consumer. */
export function buildSamlPostForm(result: SamlPostResult): string {
  const action = result.entityEndpoint;
  const samlResponse = result.context;
  const relay = result.relayState ?? '';
  const relayInput = relay
    ? `<input type="hidden" name="RelayState" value="${escapeHtml(relay)}" />`
    : '';

  return `<!DOCTYPE html>
<html><head><title>Redirecting…</title></head>
<body onload="document.forms[0].submit()">
<noscript><p>Continue to sign in.</p><button type="submit">Continue</button></noscript>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="SAMLResponse" value="${escapeHtml(samlResponse)}" />
${relayInput}
</form>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXml(s: string): string {
  return escapeHtml(s);
}

/** samlify metadata getters are typed as `string | string[]`. */
function asMetaString(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function buildAuthnStatement(authnInstant: string, sessionIndex: string): string {
  return (
    `<saml:AuthnStatement AuthnInstant="${escapeXml(authnInstant)}" SessionIndex="${escapeXml(sessionIndex)}">` +
    `<saml:AuthnContext>` +
    `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
    `</saml:AuthnContext>` +
    `</saml:AuthnStatement>`
  );
}

function buildAttributeStatement(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes).filter(
    ([name, value]) => name.length > 0 && value.length > 0,
  );
  // Never emit an empty AttributeStatement — SAML XSD requires ≥1 Attribute child.
  if (entries.length === 0) return '';
  const attrs = entries
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">` +
        `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>` +
        `</saml:Attribute>`,
    )
    .join('');
  return `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>`;
}

interface SamlRequestInfo {
  extract?: { request?: { id?: string } };
}

/**
 * samlify customTagReplacement: fill AuthnStatement (+ attributes) for WebSSO SPs.
 * Must return `{ id, context }` when loginResponseTemplate is set.
 */
function createLoginResponseTagReplacement(
  idp: saml.IdentityProviderInstance,
  spInstance: saml.ServiceProviderInstance,
  userInfo: { email: string; attributes: Record<string, string> },
  requestInfo: SamlRequestInfo | null,
  nameIdFormat: string,
): (template: string) => { id: string; context: string } {
  return (template: string) => {
    const idpSetting = idp.entitySetting as { generateID: () => string };
    const id = idpSetting.generateID();
    const assertionId = idpSetting.generateID();
    const sessionIndex = idpSetting.generateID();
    const acs = asMetaString(spInstance.entityMeta.getAssertionConsumerService('post'));
    const spEntityID = asMetaString(spInstance.entityMeta.getEntityID());
    const issuer = asMetaString(idp.entityMeta.getEntityID());
    const nowTime = new Date();
    const now = toSamlDateTime(nowTime);
    const fiveMinutesLater = toSamlDateTime(new Date(nowTime.getTime() + 5 * 60 * 1000));
    const inResponseTo = requestInfo?.extract?.request?.id?.trim() ?? '';
    // Omit attribute for IdP-initiated (unsolicited) responses — do not emit InResponseTo="".
    const inResponseToAttr = inResponseTo
      ? ` InResponseTo="${escapeXml(inResponseTo)}"`
      : '';
    const attributeStatement = buildAttributeStatement(userInfo.attributes);

    const tvalue: Record<string, string> = {
      ID: id,
      AssertionID: assertionId,
      Destination: acs,
      Audience: spEntityID,
      EntityID: spEntityID,
      SubjectRecipient: acs,
      Issuer: issuer,
      IssueInstant: now,
      AssertionConsumerServiceURL: acs,
      StatusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      ConditionsNotBefore: now,
      ConditionsNotOnOrAfter: fiveMinutesLater,
      SubjectConfirmationDataNotOnOrAfter: fiveMinutesLater,
      NameIDFormat: nameIdFormat,
      NameID: userInfo.email || '',
      InResponseToAttr: inResponseToAttr,
      AuthnStatement: buildAuthnStatement(now, sessionIndex) + attributeStatement,
    };

    return {
      id,
      context: replaceTagsByValue(template, tvalue),
    };
  };
}

/**
 * SP-initiated SSO: parse AuthnRequest and return HTML auto-post form to ACS.
 */
export async function createSpInitiatedLoginResponse(input: SamlLoginInput): Promise<string> {
  const idp = getIdp();
  const spInstance = buildSp(input.sp);
  const userInfo = buildUserInfo(input.emp, input.sp);

  const requestContainer =
    input.binding === 'redirect'
      ? { query: input.query ?? {} }
      : { body: input.body ?? {} };

  const flowResult = await idp.parseLoginRequest(spInstance, input.binding, requestContainer);

  const result = await idp.createLoginResponse(
    spInstance,
    flowResult,
    'post',
    userInfo,
    createLoginResponseTagReplacement(
      idp,
      spInstance,
      userInfo,
      flowResult as SamlRequestInfo,
      input.sp.nameid_format,
    ),
    false,
    input.relayState ?? '',
  ) as SamlPostResult;

  return buildSamlPostForm(result);
}

/**
 * IdP-initiated SSO: build assertion without an incoming AuthnRequest.
 */
export async function createIdpInitiatedLoginResponse(
  sp: SamlServiceProviderRow,
  emp: EmployeeSamlContext,
  relayState = '',
): Promise<string> {
  const idp = getIdp();
  const spInstance = buildSp(sp);
  const userInfo = buildUserInfo(emp, sp);

  const result = await idp.createLoginResponse(
    spInstance,
    null as unknown as Record<string, unknown>,
    'post',
    userInfo,
    createLoginResponseTagReplacement(idp, spInstance, userInfo, null, sp.nameid_format),
    false,
    relayState,
  ) as SamlPostResult;

  return buildSamlPostForm(result);
}

/** Decode SAML AuthnRequest parameter to XML (redirect = deflate+base64, post = base64). */
export function decodeAuthnRequestXml(samlRequestEncoded: string): string | null {
  try {
    const decoded = Buffer.from(samlRequestEncoded, 'base64');

    // HTTP-Redirect binding: DEFLATE (raw) then base64 (SAML 2.0 §3.4.4)
    try {
      const xml = zlib.inflateRawSync(decoded).toString('utf8');
      if (xml.includes('AuthnRequest') || xml.includes('Issuer')) return xml;
    } catch {
      // not deflate-compressed
    }

    // HTTP-POST binding: base64-encoded XML
    const plain = decoded.toString('utf8');
    if (plain.includes('AuthnRequest') || plain.includes('Issuer')) return plain;

    return null;
  } catch (err) {
    logger.warn({ err }, 'Failed to decode SAML AuthnRequest');
    return null;
  }
}

/** Extract Issuer (SP entity ID) from a SAML AuthnRequest parameter. */
export function extractIssuerFromAuthnRequest(samlRequestEncoded: string): string | null {
  try {
    const xml = decodeAuthnRequestXml(samlRequestEncoded);
    if (!xml) return null;
    // Strip comments so a forged <!-- <Issuer>evil</Issuer> --> cannot win first-match
    const cleaned = xml.replace(/<!--[\s\S]*?-->/g, '');
    // Prefer Issuer that appears inside AuthnRequest (not Response wrappers)
    const inRequest = cleaned.match(
      /<AuthnRequest\b[\s\S]*?<(?:saml2?:)?Issuer\b[^>]*>([^<]+)<\/(?:saml2?:)?Issuer>/i,
    );
    if (inRequest?.[1]) return inRequest[1].trim();
    const match = cleaned.match(/<(?:saml2?:)?Issuer\b[^>]*>([^<]+)<\/(?:saml2?:)?Issuer>/i);
    return match?.[1]?.trim() ?? null;
  } catch (err) {
    logger.warn({ err }, 'Failed to parse SAML AuthnRequest for Issuer');
    return null;
  }
}
