// =============================================================================
// LILG — SAML types
// =============================================================================

export interface SamlServiceProviderRow {
  id:              string;
  name:            string;
  slug:            string;
  entity_id:       string;
  acs_url:         string;
  slo_url:         string | null;
  nameid_format:   string;
  attribute_map:   Record<string, string> | null;
  entitlement_rule: EntitlementRule | null;
  icon_url:        string | null;
  sort_order:      number;
  active:          number;
}

/** JSON stored on saml_service_providers.entitlement_rule */
export interface EntitlementRule {
  /** When true (default), any employee with ACTIVE ilg + ACTIVE hrms may access. */
  all_active?: boolean;
  /** User must hold at least one of these roles (hierarchy-aware). */
  roles?: string[];
  employment_types?: string[];
  dept_ids?: string[];
  /** Block SSO for these ILG states even if otherwise eligible. */
  deny_ilg_states?: string[];
}

export interface EmployeeSamlContext {
  emp_id:          string;
  full_name:       string;
  email_corp:      string;
  dept_id:         string | null;
  role:            string | null;
  employment_type: string;
  hrms_status:     string;
  ilg_state:       string;
}

export const DEFAULT_ATTRIBUTE_MAP: Record<string, string> = {
  email:       'email_corp',
  employeeId:  'emp_id',
  displayName: 'full_name',
  department:  'dept_id',
  title:       'role',
};

/** ILG states that may receive SAML assertions. */
export const SAML_ALLOWED_ILG_STATES = new Set([
  'ACTIVE',
  'REACTIVATED',
]);
