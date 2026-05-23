/**
 * LILG — SAML Service Provider registry (MySQL-backed)
 */

import { query, queryOne } from '../db/connection.js';
import type { EntitlementRule, SamlServiceProviderRow } from './types.js';

function parseJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function mapRow(row: Record<string, unknown>): SamlServiceProviderRow {
  return {
    id:               row['id'] as string,
    name:             row['name'] as string,
    slug:             row['slug'] as string,
    entity_id:        row['entity_id'] as string,
    acs_url:          row['acs_url'] as string,
    slo_url:          (row['slo_url'] as string | null) ?? null,
    nameid_format:    row['nameid_format'] as string,
    attribute_map:    parseJson<Record<string, string>>(row['attribute_map']),
    entitlement_rule: parseJson<EntitlementRule>(row['entitlement_rule']),
    icon_url:         (row['icon_url'] as string | null) ?? null,
    sort_order:       Number(row['sort_order']),
    active:           Number(row['active']),
  };
}

export async function getActiveServiceProviders(): Promise<SamlServiceProviderRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, name, slug, entity_id, acs_url, slo_url, nameid_format,
            attribute_map, entitlement_rule, icon_url, sort_order, active
       FROM saml_service_providers
      WHERE active = 1
      ORDER BY sort_order ASC, name ASC`,
    [],
  );
  return rows.map(mapRow);
}

export async function getServiceProviderBySlug(slug: string): Promise<SamlServiceProviderRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT id, name, slug, entity_id, acs_url, slo_url, nameid_format,
            attribute_map, entitlement_rule, icon_url, sort_order, active
       FROM saml_service_providers
      WHERE slug = ? AND active = 1`,
    [slug],
  );
  return row ? mapRow(row) : null;
}

export async function getServiceProviderByEntityId(entityId: string): Promise<SamlServiceProviderRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT id, name, slug, entity_id, acs_url, slo_url, nameid_format,
            attribute_map, entitlement_rule, icon_url, sort_order, active
       FROM saml_service_providers
      WHERE entity_id = ? AND active = 1`,
    [entityId],
  );
  return row ? mapRow(row) : null;
}

export async function getEmployeeForSaml(empId: string): Promise<import('./types.js').EmployeeSamlContext | null> {
  return queryOne<import('./types.js').EmployeeSamlContext>(
    `SELECT emp_id, full_name, email_corp, dept_id, role, employment_type, hrms_status, ilg_state
       FROM employees WHERE emp_id = ?`,
    [empId],
  );
}
