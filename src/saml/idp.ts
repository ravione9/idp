/**
 * LILG — SAML 2.0 Identity Provider
 * Issues signed assertions to registered Service Providers for authenticated employees.
 */

import zlib from 'node:zlib';
import * as saml from 'samlify';
import { config, isSamlEnabled } from '../config.js';
import logger from '../utils/logger.js';
import type { EmployeeSamlContext, SamlServiceProviderRow } from './types.js';
import { DEFAULT_ATTRIBUTE_MAP, SAML_MAPPABLE_FIELD_SET } from './types.js';

// Relax XML schema validation (SP metadata varies widely across vendors)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(saml as any).setSchemaValidator({ validate: () => true });

let idpInstance: saml.IdentityProviderInstance | null = null;

/**
 * Custom login-response template (do not use saml.SamlLib at module load — ESM interop).
 *
 * - `{InResponseToAttr}` → ` InResponseTo="…"` or empty (never InResponseTo="").
 * - `{AttributeStatement}` / `{AuthnStatement}` filled in customTagReplacement.
 * - Do NOT pass `attributes: []` to IdentityProvider — that bakes an empty
 *   `<AttributeStatement/>` into the template and fails saml-schema-protocol-2.0.xsd.
 */
const LOGIN_RESPONSE_TEMPLATE_CONTEXT =
  '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}"{InResponseToAttr}>' +
  '<saml:Issuer>{Issuer}</saml:Issuer>' +
  '<samlp:Status><samlp:StatusCode Value="{StatusCode}"></samlp:StatusCode></samlp:Status>' +
  '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{AssertionID}" Version="2.0" IssueInstant="{IssueInstant}">' +
  '<saml:Issuer>{Issuer}</saml:Issuer>' +
  '<saml:Subject>' +
  '<saml:NameID Format="{NameIDFormat}">{NameID}</saml:NameID>' +
  '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
  '<saml:SubjectConfirmationData NotOnOrAfter="{SubjectConfirmationDataNotOnOrAfter}" Recipient="{SubjectRecipient}"{InResponseToAttr}></saml:SubjectConfirmationData>' +
  '</saml:SubjectConfirmation>' +
  '</saml:Subject>' +
  '<saml:Conditions NotBefore="{ConditionsNotBefore}" NotOnOrAfter="{ConditionsNotOnOrAfter}">' +
  '<saml:AudienceRestriction><saml:Audience>{Audience}</saml:Audience></saml:AudienceRestriction>' +
  '</saml:Conditions>' +
  '{AttributeStatement}{AuthnStatement}' +
  '</saml:Assertion>' +
  '</samlp:Response>';

/**
 * Fill login-response template tags.
 *
 * Do NOT use samlify's optional-leading-quote regex (`("?){Tag}`): when a raw
 * fragment placeholder sits immediately after a quoted attribute —
 * `Destination="{Destination}"{InResponseToAttr}` — the Destination closing
 * quote is mistaken for an attribute opener and the fragment's quotes become
 * `&quot;…&quot;`, which fails saml-schema-protocol-2.0.xsd (SentinelOne SSO Test).
 *
 * Match `="{Tag}"` for attribute values; bare `{Tag}` for element text or raw XML.
 */
const RAW_XML_TEMPLATE_TAGS = new Set([
  'AttributeStatement',
  'AuthnStatement',
  'InResponseToAttr',
]);

function replaceTagsByValue(rawXml: string, tagValues: Record<string, string>): string {
  let out = rawXml;
  const tags = Object.keys(tagValues).sort((a, b) => b.length - a.length);
  for (const tag of tags) {
    const value = tagValues[tag] ?? '';
    out = out.split(`="{${tag}}"`).join(`="${escapeXml(value)}"`);
    if (RAW_XML_TEMPLATE_TAGS.has(tag)) {
      out = out.split(`{${tag}}`).join(value);
    } else {
      out = out.split(`{${tag}}`).join(escapeXml(value));
    }
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

function empFieldValue(emp: EmployeeSamlContext, field: string): string {
  if (!SAML_MAPPABLE_FIELD_SET.has(field)) return '';
  const val = emp[field as keyof EmployeeSamlContext];
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  return s;
}

function buildSp(sp: SamlServiceProviderRow): saml.ServiceProviderInstance {
  const slo = sp.slo_url
    ? [{ Binding: saml.Constants.namespace.binding.redirect, Location: sp.slo_url }]
    : [];

  // Never emit an unsigned Response — if both toggles are off, keep Assertion signed.
  let wantAssertionsSigned = sp.sign_assertions !== false;
  let wantMessageSigned = sp.sign_response !== false;
  if (!wantAssertionsSigned && !wantMessageSigned) {
    logger.warn({ slug: sp.slug }, 'SAML SP disabled both signatures; forcing Assertion signing');
    wantAssertionsSigned = true;
  }

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
    wantAssertionsSigned,
    wantMessageSigned,
    // Explicit signature placement (Issuer → Signature) for strict SP validators.
    signatureConfig: {
      prefix: 'ds',
      location: {
        reference: "/*[local-name(.)='Response']/*[local-name(.)='Issuer']",
        action: 'after',
      },
    },
  });
}

function buildUserInfo(emp: EmployeeSamlContext, sp: SamlServiceProviderRow): {
  email: string;
  attributes: Record<string, string>;
} {
  const map: Record<string, string> = sp.merge_default_attrs !== false
    ? { ...DEFAULT_ATTRIBUTE_MAP, ...(sp.attribute_map ?? {}) }
    : { ...(sp.attribute_map ?? {}) };
  const attributes: Record<string, string> = {};

  for (const [samlName, empField] of Object.entries(map)) {
    if (!samlName?.trim() || !empField?.trim()) continue;
    if (!SAML_MAPPABLE_FIELD_SET.has(empField)) {
      logger.warn({ slug: sp.slug, samlName, empField }, 'Skipping unknown SAML attribute map field');
      continue;
    }
    const val = empFieldValue(emp, empField);
    if (val) attributes[samlName.trim()] = val;
  }

  // Soft-fill common auto-provision attrs when defaults are merged.
  if (sp.merge_default_attrs !== false) {
    if (emp.email_corp) {
      attributes['email'] ??= emp.email_corp;
      attributes['mail'] ??= emp.email_corp;
    }
    if (emp.full_name) {
      attributes['displayName'] ??= emp.full_name;
    }
  }

  const nameidField =
    sp.nameid_attribute && SAML_MAPPABLE_FIELD_SET.has(sp.nameid_attribute)
      ? sp.nameid_attribute
      : 'email_corp';
  const nameId = empFieldValue(emp, nameidField) || emp.email_corp;

  return {
    email: nameId,
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
        `<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
        `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>` +
        `</saml:Attribute>`,
    )
    .join('');
  return `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>`;
}

/** Remove schema-invalid empty AttributeStatement nodes if any slip in. */
function stripEmptyAttributeStatements(xml: string): string {
  return xml
    .replace(/<saml:AttributeStatement\s*\/>/g, '')
    .replace(/<saml:AttributeStatement[^>]*>\s*<\/saml:AttributeStatement>/g, '');
}

/** xs:NCName — InResponseTo must match or the SP XSD validator rejects the Response. */
function toInResponseToAttr(requestId: string): string {
  const id = requestId.trim();
  if (!id) return '';
  if (!/^[A-Za-z_][\w.-]*$/.test(id)) {
    logger.warn({ requestId: id }, 'AuthnRequest ID is not a valid NCName; omitting InResponseTo');
    return '';
  }
  return ` InResponseTo="${escapeXml(id)}"`;
}

interface SamlRequestInfo {
  extract?: { request?: { id?: string } };
}

/**
 * samlify customTagReplacement: fill AuthnStatement + AttributeStatement.
 * Must return `{ id, context }` when loginResponseTemplate is set.
 */
function createLoginResponseTagReplacement(
  idp: saml.IdentityProviderInstance,
  sp: SamlServiceProviderRow,
  userInfo: { email: string; attributes: Record<string, string> },
  requestInfo: SamlRequestInfo | null,
): (template: string) => { id: string; context: string } {
  return (template: string) => {
    const idpSetting = idp.entitySetting as { generateID: () => string };
    const id = idpSetting.generateID();
    const assertionId = idpSetting.generateID();
    const sessionIndex = idpSetting.generateID();
    // Prefer registry values — metadata getters can return undefined for binding keys.
    const acs = sp.acs_url?.trim() || '';
    const spEntityID = sp.entity_id?.trim() || '';
    const issuer = asMetaString(idp.entityMeta.getEntityID());
    if (!acs || !spEntityID) {
      throw new Error('SAML SP is missing acs_url or entity_id');
    }
    const nowTime = new Date();
    const now = toSamlDateTime(nowTime);
    const fiveMinutesLater = toSamlDateTime(new Date(nowTime.getTime() + 5 * 60 * 1000));
    const inResponseToAttr = toInResponseToAttr(requestInfo?.extract?.request?.id ?? '');
    const attributeStatement = buildAttributeStatement(userInfo.attributes);
    const authnStatement = buildAuthnStatement(now, sessionIndex);

    logger.info(
      {
        sp: sp.slug,
        attrCount: Object.keys(userInfo.attributes).length,
        hasAttributeStatement: attributeStatement.length > 0,
        hasInResponseTo: inResponseToAttr.length > 0,
        acsHost: (() => { try { return new URL(acs).host; } catch { return 'invalid'; } })(),
      },
      'Building SAML login response',
    );

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
      NameIDFormat: sp.nameid_format,
      NameID: userInfo.email || '',
      InResponseToAttr: inResponseToAttr,
      AttributeStatement: attributeStatement,
      AuthnStatement: authnStatement,
    };

    return {
      id,
      context: stripEmptyAttributeStatements(replaceTagsByValue(template, tvalue)),
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

  // samlify ≥2.13 types RequestInfo strictly; runtime still accepts FlowResult.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await idp.createLoginResponse(
    spInstance,
    flowResult as any,
    'post',
    userInfo,
    createLoginResponseTagReplacement(idp, input.sp, userInfo, flowResult as SamlRequestInfo),
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

  // Pass {} not null — samlify default params do not apply when null is explicit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await idp.createLoginResponse(
    spInstance,
    {} as any,
    'post',
    userInfo,
    createLoginResponseTagReplacement(idp, sp, userInfo, null),
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
