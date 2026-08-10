/**
 * Google Workspace → local employee attribute extraction + mapping.
 * Respects directory_attr_maps and directory_sync_settings.
 */
import type { admin_directory_v1 } from 'googleapis';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';

export type LocalAttrKey =
  | 'employee_number'
  | 'dept_id'
  | 'role'
  | 'cost_center'
  | 'location'
  | 'manager_emp_id'
  | 'mobile'
  | 'office_address'
  | 'photo_url'
  | 'first_name'
  | 'last_name'
  | 'email_corp'
  | 'full_name';

export interface DirectoryAttrMapRow {
  id: number;
  source_system: string;
  source_attr: string;
  local_attr: string;
  enabled: number;
  sort_order: number;
}

export interface GoogleSyncSettings {
  source_system: string;
  sync_employee_id: number;
  sync_department: number;
  sync_designation: number;
  sync_manager: number;
  sync_cost_center: number;
  sync_mobile: number;
  sync_location: number;
  sync_profile_photo: number;
  sync_office_address: number;
  frequency: string;
  disable_deleted: number;
}

export interface ExtractedAttrs {
  employee_number?: string;
  dept_id?: string;
  role?: string;
  cost_center?: string;
  location?: string;
  manager_email?: string;
  mobile?: string;
  office_address?: string;
  photo_url?: string;
  first_name?: string;
  last_name?: string;
  email_corp?: string;
  full_name?: string;
}

/** Max string lengths — conservative so sync succeeds even before migration 061 is applied. */
export const EMPLOYEE_ATTR_LIMITS: Partial<Record<LocalAttrKey, number>> = {
  employee_number: 64,
  dept_id: 50,
  role: 100,
  cost_center: 80,
  location: 200,
  mobile: 40,
  photo_url: 500,
  first_name: 100,
  last_name: 100,
  full_name: 255,
  email_corp: 255,
};

function truncateAttr(key: LocalAttrKey, value: string): string {
  const max = EMPLOYEE_ATTR_LIMITS[key];
  if (!max || value.length <= max) return value;
  logger.warn({ field: key, length: value.length, max }, 'Google sync: truncating attribute value');
  return value.slice(0, max);
}

/** Trim string attrs to DB column limits so one long title does not fail the whole run. */
export function sanitizeExtractedAttrs(attrs: ExtractedAttrs): ExtractedAttrs {
  const out: ExtractedAttrs = { ...attrs };
  for (const key of Object.keys(out) as Array<keyof ExtractedAttrs>) {
    const val = out[key];
    if (typeof val !== 'string' || !val) continue;
    const max = EMPLOYEE_ATTR_LIMITS[key as LocalAttrKey];
    if (!max || val.length <= max) {
      (out as Record<string, string>)[key] = val.trim();
      continue;
    }
    (out as Record<string, string>)[key] = truncateAttr(key as LocalAttrKey, val.trim());
  }
  return out;
}

const DEFAULT_MAPS: Array<{ source_attr: string; local_attr: LocalAttrKey; sort_order: number }> = [
  { source_attr: 'employeeId', local_attr: 'employee_number', sort_order: 10 },
  { source_attr: 'organizations.department', local_attr: 'dept_id', sort_order: 20 },
  { source_attr: 'organizations.title', local_attr: 'role', sort_order: 30 },
  { source_attr: 'organizations.costCenter', local_attr: 'cost_center', sort_order: 40 },
  { source_attr: 'organizations.location', local_attr: 'location', sort_order: 50 },
  { source_attr: 'manager', local_attr: 'manager_emp_id', sort_order: 60 },
  { source_attr: 'phones', local_attr: 'mobile', sort_order: 70 },
  { source_attr: 'addresses', local_attr: 'office_address', sort_order: 80 },
  { source_attr: 'thumbnailPhotoUrl', local_attr: 'photo_url', sort_order: 90 },
  { source_attr: 'name.givenName', local_attr: 'first_name', sort_order: 100 },
  { source_attr: 'name.familyName', local_attr: 'last_name', sort_order: 110 },
  { source_attr: 'primaryEmail', local_attr: 'email_corp', sort_order: 120 },
];

const SETTINGS_TO_LOCAL: Record<string, keyof GoogleSyncSettings> = {
  employee_number: 'sync_employee_id',
  dept_id: 'sync_department',
  role: 'sync_designation',
  manager_emp_id: 'sync_manager',
  cost_center: 'sync_cost_center',
  mobile: 'sync_mobile',
  location: 'sync_location',
  photo_url: 'sync_profile_photo',
  office_address: 'sync_office_address',
};

export async function getGoogleSyncSettings(): Promise<GoogleSyncSettings> {
  const row = await queryOne<GoogleSyncSettings>(
    `SELECT * FROM directory_sync_settings WHERE source_system = 'GOOGLE' LIMIT 1`,
    [],
  );
  if (row) return row;
  return {
    source_system: 'GOOGLE',
    sync_employee_id: 1,
    sync_department: 1,
    sync_designation: 1,
    sync_manager: 1,
    sync_cost_center: 1,
    sync_mobile: 1,
    sync_location: 1,
    sync_profile_photo: 1,
    sync_office_address: 1,
    frequency: 'manual',
    disable_deleted: 0,
  };
}

export async function saveGoogleSyncSettings(
  patch: Partial<GoogleSyncSettings>,
  updatedBy: string | null,
): Promise<GoogleSyncSettings> {
  const cur = await getGoogleSyncSettings();
  const next = { ...cur, ...patch, source_system: 'GOOGLE' as const };
  await execute(
    `INSERT INTO directory_sync_settings
       (source_system, sync_employee_id, sync_department, sync_designation, sync_manager,
        sync_cost_center, sync_mobile, sync_location, sync_profile_photo, sync_office_address,
        frequency, disable_deleted, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       sync_employee_id = VALUES(sync_employee_id),
       sync_department = VALUES(sync_department),
       sync_designation = VALUES(sync_designation),
       sync_manager = VALUES(sync_manager),
       sync_cost_center = VALUES(sync_cost_center),
       sync_mobile = VALUES(sync_mobile),
       sync_location = VALUES(sync_location),
       sync_profile_photo = VALUES(sync_profile_photo),
       sync_office_address = VALUES(sync_office_address),
       frequency = VALUES(frequency),
       disable_deleted = VALUES(disable_deleted),
       updated_by = VALUES(updated_by)`,
    [
      'GOOGLE',
      next.sync_employee_id ? 1 : 0,
      next.sync_department ? 1 : 0,
      next.sync_designation ? 1 : 0,
      next.sync_manager ? 1 : 0,
      next.sync_cost_center ? 1 : 0,
      next.sync_mobile ? 1 : 0,
      next.sync_location ? 1 : 0,
      next.sync_profile_photo ? 1 : 0,
      next.sync_office_address ? 1 : 0,
      next.frequency || 'manual',
      next.disable_deleted ? 1 : 0,
      updatedBy,
    ],
  );
  return getGoogleSyncSettings();
}

export async function listGoogleAttrMaps(): Promise<DirectoryAttrMapRow[]> {
  try {
    const rows = await query<DirectoryAttrMapRow>(
      `SELECT id, source_system, source_attr, local_attr, enabled, sort_order
         FROM directory_attr_maps
        WHERE source_system = 'GOOGLE'
        ORDER BY sort_order ASC, id ASC`,
      [],
    );
    if (rows.length) return rows;
  } catch (err) {
    logger.warn({ err }, 'directory_attr_maps unavailable — using defaults');
  }
  return DEFAULT_MAPS.map((m, i) => ({
    id: i + 1,
    source_system: 'GOOGLE',
    source_attr: m.source_attr,
    local_attr: m.local_attr,
    enabled: 1,
    sort_order: m.sort_order,
  }));
}

export async function saveGoogleAttrMaps(
  maps: Array<{ source_attr: string; local_attr: string; enabled?: boolean | undefined; sort_order?: number | undefined }>,
): Promise<DirectoryAttrMapRow[]> {
  let order = 10;
  for (const m of maps) {
    const src = m.source_attr.trim();
    const local = m.local_attr.trim();
    if (!src || !local) continue;
    await execute(
      `INSERT INTO directory_attr_maps (source_system, source_attr, local_attr, enabled, sort_order)
       VALUES ('GOOGLE', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         local_attr = VALUES(local_attr),
         enabled = VALUES(enabled),
         sort_order = VALUES(sort_order)`,
      [src, local, m.enabled === false ? 0 : 1, m.sort_order ?? order],
    );
    order += 10;
  }
  return listGoogleAttrMaps();
}

function primaryOrg(gUser: admin_directory_v1.Schema$User): admin_directory_v1.Schema$UserOrganization | undefined {
  const orgs = gUser.organizations ?? [];
  return orgs.find((o: admin_directory_v1.Schema$UserOrganization) => o.primary) ?? orgs[0];
}

function readCustomSchemaField(schema: Record<string, unknown>, field: string): string | undefined {
  const v = schema[field];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && 'value' in (v as object)) {
    const val = String((v as { value?: unknown }).value ?? '').trim();
    if (val) return val;
  }
  return undefined;
}

function extractCustomSchemaAttr(gUser: admin_directory_v1.Schema$User, sourceAttr: string): string | undefined {
  const schemas = gUser.customSchemas ?? {};
  if (sourceAttr.includes('.')) {
    const [schemaName, ...rest] = sourceAttr.split('.');
    const field = rest.join('.');
    const schema = schemas[schemaName];
    if (schema && typeof schema === 'object') {
      return readCustomSchemaField(schema as Record<string, unknown>, field);
    }
    return undefined;
  }
  for (const schema of Object.values(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    const hit = readCustomSchemaField(schema as Record<string, unknown>, sourceAttr);
    if (hit) return hit;
  }
  return undefined;
}

/** Best-effort department from Google org data or OU path. */
function extractDepartment(gUser: admin_directory_v1.Schema$User): string | undefined {
  const orgs = gUser.organizations ?? [];
  for (const o of orgs) {
    const d = o.department?.trim() || o.name?.trim() || o.description?.trim();
    if (d) return d;
  }
  const ou = (gUser.orgUnitPath || '').replace(/^\/+/, '').trim();
  if (!ou || ou === '/') return undefined;
  // Prefer leaf OU as department (e.g. "/Lenskart/Retail/Store Ops" → "Store Ops")
  const leaf = ou.split('/').filter(Boolean).pop();
  return leaf || ou;
}

function extractTitle(gUser: admin_directory_v1.Schema$User): string | undefined {
  const orgs = gUser.organizations ?? [];
  for (const o of orgs) {
    const t = o.title?.trim();
    if (t) return t;
  }
  return undefined;
}

function extractEmployeeId(gUser: admin_directory_v1.Schema$User): string | undefined {
  const g = gUser as admin_directory_v1.Schema$User & { employeeId?: string | null };
  if (g.employeeId?.trim()) return g.employeeId.trim();

  const ext = g.externalIds ?? [];
  const preferredTypes = ['organization', 'employee', 'work', 'custom'];
  for (const type of preferredTypes) {
    const hit = ext.find((x: admin_directory_v1.Schema$UserExternalId) => (x.type || '').toLowerCase() === type)?.value?.trim();
    if (hit) return hit;
  }
  const any = ext.find((x: admin_directory_v1.Schema$UserExternalId) => x.value?.trim())?.value?.trim();
  if (any) return any;

  // Custom schema fallback: Employee_ID / employeeId style keys
  const schemas = g.customSchemas ?? {};
  for (const schema of Object.values(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (!/employee.?id|emp.?id|employee.?number|staff.?id|worker.?id/i.test(k)) continue;
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object' && 'value' in (v as object)) {
        const val = String((v as { value?: unknown }).value ?? '').trim();
        if (val) return val;
      }
    }
  }

  // Some tenants store HR id on the primary org record.
  const org = primaryOrg(gUser);
  const orgId = (org as admin_directory_v1.Schema$UserOrganization & { employeeId?: string })?.employeeId?.trim();
  if (orgId) return orgId;

  return undefined;
}

function extractSourceValue(gUser: admin_directory_v1.Schema$User, sourceAttr: string): string | undefined {
  const org = primaryOrg(gUser);
  switch (sourceAttr) {
    case 'employeeId':
      return extractEmployeeId(gUser);
    case 'organizations.department':
      return extractDepartment(gUser);
    case 'organizations.title':
      return extractTitle(gUser) || org?.title?.trim() || undefined;
    case 'organizations.costCenter':
      return org?.costCenter?.trim()
        || (gUser.organizations ?? []).map((o: admin_directory_v1.Schema$UserOrganization) => o.costCenter?.trim()).find(Boolean)
        || undefined;
    case 'organizations.location':
      return org?.location?.trim()
        || (gUser.organizations ?? []).map((o: admin_directory_v1.Schema$UserOrganization) => o.location?.trim()).find(Boolean)
        || undefined;
    case 'orgUnitPath': {
      const ou = (gUser.orgUnitPath || '').trim();
      return ou && ou !== '/' ? ou : undefined;
    }
    case 'manager': {
      const rel = (gUser.relations ?? []).find((r: admin_directory_v1.Schema$UserRelation) => (r.type || '').toLowerCase() === 'manager');
      return rel?.value?.trim().toLowerCase() || undefined;
    }
    case 'phones': {
      const phones = gUser.phones ?? [];
      const mobile = phones.find((p: admin_directory_v1.Schema$UserPhone) => (p.type || '').toLowerCase() === 'mobile')
        ?? phones.find((p: admin_directory_v1.Schema$UserPhone) => p.primary)
        ?? phones[0];
      return mobile?.value?.trim() || undefined;
    }
    case 'addresses': {
      const addrs = gUser.addresses ?? [];
      const primary = addrs.find((a: admin_directory_v1.Schema$UserAddress) => a.primary) ?? addrs[0];
      return primary?.formatted?.trim()
        || [primary?.streetAddress, primary?.locality, primary?.region, primary?.postalCode, primary?.country]
          .filter(Boolean).join(', ') || undefined;
    }
    case 'thumbnailPhotoUrl':
      return gUser.thumbnailPhotoUrl?.trim() || undefined;
    case 'name.givenName':
      return gUser.name?.givenName?.trim() || undefined;
    case 'name.familyName':
      return gUser.name?.familyName?.trim() || undefined;
    case 'name.fullName':
      return gUser.name?.fullName?.trim() || undefined;
    case 'primaryEmail':
      return (gUser.primaryEmail ?? '').trim().toLowerCase() || undefined;
    default:
      return extractCustomSchemaAttr(gUser, sourceAttr);
  }
}

/** Extract mapped attributes from a Google Directory user. */
export async function extractGoogleAttrs(
  gUser: admin_directory_v1.Schema$User,
  maps?: DirectoryAttrMapRow[],
  settings?: GoogleSyncSettings,
): Promise<ExtractedAttrs> {
  const attrMaps = maps ?? await listGoogleAttrMaps();
  const syncSettings = settings ?? await getGoogleSyncSettings();
  const out: ExtractedAttrs = {};

  for (const map of attrMaps) {
    if (!map.enabled) continue;
    const local = map.local_attr as LocalAttrKey;
    const settingKey = SETTINGS_TO_LOCAL[local];
    if (settingKey && !syncSettings[settingKey]) continue;

    const raw = extractSourceValue(gUser, map.source_attr);
    if (!raw) continue;

    if (local === 'manager_emp_id') {
      out.manager_email = raw;
      continue;
    }
    (out as Record<string, string>)[local] = raw;
  }

  // Always keep a display name
  const composedName = gUser.name?.fullName?.trim()
    || [out.first_name, out.last_name].filter(Boolean).join(' ')
    || (gUser.primaryEmail ?? '').split('@')[0]
    || '';
  if (!out.full_name && composedName) out.full_name = composedName;
  if (!out.email_corp && gUser.primaryEmail) {
    out.email_corp = gUser.primaryEmail.trim().toLowerCase();
  }
  if (out.full_name) {
    const parts = out.full_name.trim().split(/\s+/);
    if (!out.first_name && parts[0]) out.first_name = parts[0];
    if (!out.last_name && parts.length > 1) out.last_name = parts.slice(1).join(' ');
  }

  // Always attempt core HR fields from Google even when attr maps omit them.
  if (syncSettings.sync_employee_id && !out.employee_number) {
    const id = extractEmployeeId(gUser);
    if (id) out.employee_number = id;
  }
  if (syncSettings.sync_department && !out.dept_id) {
    const dept = extractDepartment(gUser);
    if (dept) out.dept_id = dept;
  }
  if (syncSettings.sync_department && !out.dept_id) {
    const ou = extractSourceValue(gUser, 'orgUnitPath');
    if (ou) out.dept_id = ou.split('/').filter(Boolean).pop() || ou;
  }
  if (syncSettings.sync_designation && !out.role) {
    const title = extractTitle(gUser);
    if (title) out.role = title;
  }

  return sanitizeExtractedAttrs(out);
}

/** Resolve manager email → local emp_id (Google relation stores email). */
export async function resolveManagerEmpId(managerEmail?: string): Promise<string | null> {
  if (!managerEmail) return null;
  const row = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE email_corp = ? LIMIT 1`,
    [managerEmail.trim().toLowerCase()],
  );
  return row?.emp_id ?? null;
}

export interface ApplyAttrsResult {
  updated: boolean;
  changes: Record<string, { old: unknown; new: unknown }>;
}

function normAttrValue(v: unknown): string {
  return String(v ?? '').trim();
}

/** Apply extracted attrs onto an existing employee (updates only changed fields). */
export async function applyAttrsToEmployee(
  empId: string,
  attrs: ExtractedAttrs,
  opts: { syncSettings?: GoogleSyncSettings; resolveManager?: boolean; googleSourceOfTruth?: boolean } = {},
): Promise<ApplyAttrsResult> {
  const settings = opts.syncSettings ?? await getGoogleSyncSettings();
  const current = await queryOne<Record<string, unknown>>(
    `SELECT emp_id, full_name, first_name, last_name, email_corp, employee_number,
            dept_id, role, cost_center, location, mobile, office_address, photo_url,
            manager_emp_id
       FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!current) return { updated: false, changes: {} };

  let managerEmpId: string | null | undefined;
  if (opts.resolveManager !== false && attrs.manager_email && settings.sync_manager) {
    managerEmpId = await resolveManagerEmpId(attrs.manager_email);
  }

  const candidates: Array<[string, unknown]> = [];
  if (attrs.full_name) candidates.push(['full_name', attrs.full_name]);
  if (attrs.first_name) candidates.push(['first_name', attrs.first_name]);
  if (attrs.last_name) candidates.push(['last_name', attrs.last_name]);
  if (attrs.employee_number && settings.sync_employee_id) {
    candidates.push(['employee_number', attrs.employee_number]);
  }
  if (attrs.dept_id && settings.sync_department) candidates.push(['dept_id', attrs.dept_id]);
  if (attrs.role && settings.sync_designation) candidates.push(['role', attrs.role]);
  if (attrs.cost_center && settings.sync_cost_center) candidates.push(['cost_center', attrs.cost_center]);
  if (attrs.location && settings.sync_location) candidates.push(['location', attrs.location]);
  if (attrs.mobile && settings.sync_mobile) candidates.push(['mobile', attrs.mobile]);
  if (attrs.office_address && settings.sync_office_address) candidates.push(['office_address', attrs.office_address]);
  if (attrs.photo_url && settings.sync_profile_photo) candidates.push(['photo_url', attrs.photo_url]);
  if (managerEmpId !== undefined && settings.sync_manager) {
    candidates.push(['manager_emp_id', managerEmpId]);
  }

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [col, val] of candidates) {
    if (val === undefined || val === null || val === '') continue;
    const limit = EMPLOYEE_ATTR_LIMITS[col as LocalAttrKey];
    const normalized = typeof val === 'string' && limit
      ? truncateAttr(col as LocalAttrKey, val)
      : val;
    const old = current[col];
    if (normAttrValue(old) === normAttrValue(normalized)) continue;
    if (opts.googleSourceOfTruth && normAttrValue(normalized) === '') continue;
    changes[col] = { old: old ?? null, new: normalized };
    sets.push(`${col} = ?`);
    params.push(normalized);
  }

  sets.push('attrs_synced_at = UTC_TIMESTAMP()', `sync_status = 'SYNCED'`, 'updated_at = UTC_TIMESTAMP()');

  if (Object.keys(changes).length === 0) {
    await execute(
      `UPDATE employees SET attrs_synced_at = UTC_TIMESTAMP(), sync_status = 'SYNCED', updated_at = UTC_TIMESTAMP()
        WHERE emp_id = ?`,
      [empId],
    );
    return { updated: false, changes: {} };
  }

  try {
    await execute(
      `UPDATE employees SET ${sets.join(', ')} WHERE emp_id = ?`,
      [...params, empId],
    );
    return { updated: true, changes };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = err instanceof Error ? err.message : String(err);
    const dropManager = changes.manager_emp_id !== undefined
      && (code === 'ER_NO_REFERENCED_ROW_2' || /manager|foreign key|too long/i.test(msg));
    if (!dropManager) throw err;

    logger.warn({ empId, err: msg }, 'Google sync: retrying attr update without manager_emp_id');
    delete changes.manager_emp_id;
    const retrySets: string[] = [];
    const retryParams: unknown[] = [];
    for (const [col, val] of candidates) {
      if (col === 'manager_emp_id' || val === undefined || val === null || val === '') continue;
      if (!(col in changes)) continue;
      const limit = EMPLOYEE_ATTR_LIMITS[col as LocalAttrKey];
      const normalized = typeof val === 'string' && limit
        ? truncateAttr(col as LocalAttrKey, val)
        : val;
      retrySets.push(`${col} = ?`);
      retryParams.push(normalized);
    }
    retrySets.push('attrs_synced_at = UTC_TIMESTAMP()', `sync_status = 'SYNCED'`, 'updated_at = UTC_TIMESTAMP()');
    if (retrySets.length <= 3) {
      return { updated: false, changes: {} };
    }
    await execute(
      `UPDATE employees SET ${retrySets.join(', ')} WHERE emp_id = ?`,
      [...retryParams, empId],
    );
    return { updated: true, changes };
  }
}

export async function writeDirectoryUserAudit(entry: {
  empId?: string | null;
  action: string;
  adminEmpId?: string | null;
  source?: string | null;
  changedFields?: string[];
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO directory_user_audit
         (emp_id, action, admin_emp_id, source, changed_fields, old_values, new_values, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.empId ?? null,
        entry.action,
        entry.adminEmpId ?? null,
        entry.source ?? null,
        entry.changedFields ? JSON.stringify(entry.changedFields) : null,
        entry.oldValues ? JSON.stringify(entry.oldValues) : null,
        entry.newValues ? JSON.stringify(entry.newValues) : null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err, action: entry.action }, 'directory_user_audit write failed');
  }
}

export const GOOGLE_SOURCE_ATTR_OPTIONS = [
  'employeeId',
  'organizations.department',
  'organizations.title',
  'organizations.costCenter',
  'organizations.location',
  'orgUnitPath',
  'manager',
  'phones',
  'addresses',
  'thumbnailPhotoUrl',
  'name.givenName',
  'name.familyName',
  'name.fullName',
  'primaryEmail',
];

export const LOCAL_ATTR_OPTIONS = [
  { value: 'employee_number', label: 'Employee ID' },
  { value: 'dept_id', label: 'Department' },
  { value: 'role', label: 'Designation' },
  { value: 'cost_center', label: 'Cost Center' },
  { value: 'location', label: 'Location' },
  { value: 'manager_emp_id', label: 'Manager' },
  { value: 'mobile', label: 'Mobile Number' },
  { value: 'office_address', label: 'Office Address' },
  { value: 'photo_url', label: 'Profile Photo' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'email_corp', label: 'Email' },
  { value: 'full_name', label: 'Display Name' },
];
