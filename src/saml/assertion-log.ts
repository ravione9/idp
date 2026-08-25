/**
 * Persist issued SAML assertions for Audit Logs and SSO Reports.
 */
import zlib from 'node:zlib';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { logSamlAssertionProvision } from '../services/app-provision-log.js';

export type SamlAssertionBinding = 'REDIRECT' | 'POST' | 'IDP_INITIATED';

export async function logSamlAssertion(params: {
  spId:        string;
  empId:       string;
  binding:     SamlAssertionBinding;
  relayState?: string;
  requestId?:  string | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO saml_assertion_log (sp_id, emp_id, binding, relay_state, request_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        params.spId,
        params.empId,
        params.binding,
        params.relayState ?? null,
        params.requestId ?? null,
      ],
    );
    void logSamlAssertionProvision(params).catch((err) =>
      logger.warn({ err, spId: params.spId }, 'Failed to log SAML assertion provision'),
    );
  } catch (err) {
    logger.warn({ err, spId: params.spId, empId: params.empId }, 'Failed to log SAML assertion');
  }
}

export function samlBindingFromFlow(binding: 'redirect' | 'post'): SamlAssertionBinding {
  return binding === 'redirect' ? 'REDIRECT' : 'POST';
}

/** Extract AuthnRequest ID from a base64 SAMLRequest parameter (best-effort). */
export function extractRequestIdFromAuthnRequest(samlRequestEncoded: string | undefined): string | null {
  if (!samlRequestEncoded) return null;
  try {
    const decoded = Buffer.from(samlRequestEncoded, 'base64');
    let xml: string;
    try {
      xml = zlib.inflateRawSync(decoded).toString('utf8');
    } catch {
      xml = decoded.toString('utf8');
    }
    const match = xml.match(/<(?:saml2?:)?AuthnRequest[^>]*\sID="([^"]+)"/i);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
