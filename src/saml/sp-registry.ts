/**
 * LILG — SAML Service Provider registry (MySQL-backed)
 */

import { query, queryOne } from '../db/connection.js';
import type { EntitlementRule, EmployeeSamlContext, SamlServiceProviderRow } from './types.js';

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

function asBool(raw: unknown, defaultValue: boolean): boolean {
  if (raw === null || raw === undefined) return defaultValue;
  if (typeof raw === 'boolean') return raw;
  return Number(raw) === 1;
}

function mapRow(row: Record<string, unknown>): SamlServiceProviderRow {
  return {
    id:                 row['id'] as string,
    name:               row['name'] as string,
    slug:               row['slug'] as string,
    entity_id:          row['entity_id'] as string,
    acs_url:            row['acs_url'] as string,
    slo_url:            (row['slo_url'] as string | null) ?? null,
    nameid_format:      row['nameid_format'] as string,
    attribute_map:      parseJson<Record<string, string>>(row['attribute_map']),
    sign_assertions:    asBool(row['sign_assertions'], true),
    sign_response:      asBool(row['sign_response'], true),
    nameid_attribute:   (row['nameid_attribute'] as string | null) ?? null,
    merge_default_attrs: asBool(row['merge_default_attrs'], true),
    entitlement_rule:   parseJson<EntitlementRule>(row['entitlement_rule']),
    icon_url:           (row['icon_url'] as string | null) ?? null,
    sort_order:         Number(row['sort_order']),
    active:             Number(row['active']),
  };
}

const SP_SELECT = `
  SELECT id, name, slug, entity_id, acs_url, slo_url, nameid_format,
         attribute_map, sign_assertions, sign_response, nameid_attribute,
         merge_default_attrs, entitlement_rule, icon_url, sort_order, active
    FROM saml_service_providers`;

export async function getActiveServiceProviders(): Promise<SamlServiceProviderRow[]> {
  const rows = await query<Record<string, unknown>>(
    `${SP_SELECT}
      WHERE active = 1
      ORDER BY sort_order ASC, name ASC`,
    [],
  );
  return rows.map(mapRow);
}

export async function getServiceProviderBySlug(slug: string): Promise<SamlServiceProviderRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `${SP_SELECT}
      WHERE slug = ? AND active = 1`,
    [slug],
  );
  return row ? mapRow(row) : null;
}

export async function getServiceProviderByEntityId(entityId: string): Promise<SamlServiceProviderRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `${SP_SELECT}
      WHERE entity_id = ? AND active = 1`,
    [entityId],
  );
  return row ? mapRow(row) : null;
}

export async function getEmployeeForSaml(empId: string): Promise<EmployeeSamlContext | null> {
  return queryOne<EmployeeSamlContext>(
    `SELECT emp_id, employee_number, full_name, first_name, last_name, username,
            email_corp, email_personal, dept_id, role, employment_type, hrms_status, ilg_state,
            manager_emp_id, mobile, cost_center, location, city, state, country
       FROM employees WHERE emp_id = ?`,
    [empId],
  );
}
