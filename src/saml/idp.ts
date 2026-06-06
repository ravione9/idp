/**
 * LILG — SAML 2.0 Identity Provider
 * Issues signed assertions to registered Service Providers for authenticated employees.
 */

import * as saml from 'samlify';
import { config, isSamlEnabled } from '../config.js';
import logger from '../utils/logger.js';
import type { EmployeeSamlContext, SamlServiceProviderRow } from './types.js';
import { DEFAULT_ATTRIBUTE_MAP } from './types.js';

// Relax XML schema validation (SP metadata varies widely across vendors)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(saml as any).setSchemaValidator({ validate: () => true });

let idpInstance: saml.IdentityProviderInstance | null = null;

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
    const val = emp[empField as keyof EmployeeSamlContext];
    if (val !== null && val !== undefined && String(val).length > 0) {
      attributes[samlName] = String(val);
    }
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
    undefined,
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
    undefined,
    false,
    relayState,
  ) as SamlPostResult;

  return buildSamlPostForm(result);
}

/** Extract Issuer (SP entity ID) from a base64 SAML AuthnRequest (redirect binding). */
export function extractIssuerFromAuthnRequest(samlRequestB64: string): string | null {
  try {
    const inflated = Buffer.from(samlRequestB64, 'base64');
    const xml = inflated.toString('utf8');
    const match = xml.match(/<(?:saml2?:)?Issuer[^>]*>([^<]+)<\/(?:saml2?:)?Issuer>/i);
    return match?.[1]?.trim() ?? null;
  } catch (err) {
    logger.warn({ err }, 'Failed to parse SAML AuthnRequest for Issuer');
    return null;
  }
}
