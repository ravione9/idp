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
  /** RelayState sent on IdP-initiated launch when the browser does not pass RelayState. */
  default_relay_state: string | null;
  nameid_format:   string;
  attribute_map:   Record<string, string> | null;
  /** Sign the Assertion (default true). */
  sign_assertions: boolean;
  /** Sign the Response / message (default true). */
  sign_response: boolean;
  /**
   * Employee field used as NameID value (default email_corp).
   * Must be one of SAML_MAPPABLE_FIELDS.
   */
  nameid_attribute: string | null;
  /** When true, merge DEFAULT_ATTRIBUTE_MAP under the SP attribute_map (default true). */
  merge_default_attrs: boolean;
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

/** Employee profile fields available for NameID / AttributeStatement mapping. */
export interface EmployeeSamlContext {
  emp_id:           string;
  employee_number:  string | null;
  full_name:        string;
  first_name:       string | null;
  last_name:        string | null;
  username:         string | null;
  email_corp:       string;
  email_personal:   string | null;
  dept_id:          string | null;
  role:             string | null;
  employment_type:  string;
  hrms_status:      string;
  ilg_state:        string;
  manager_emp_id:   string | null;
  mobile:           string | null;
  cost_center:      string | null;
  location:         string | null;
  city:             string | null;
  state:            string | null;
  country:          string | null;
  /** Active Directory objectGUID (canonical UUID) — required by Autodesk SSO. */
  ad_object_guid:   string | null;
}

/** Employee columns that may appear as attribute_map / nameid_attribute values. */
export const SAML_MAPPABLE_FIELD_OPTIONS: ReadonlyArray<{ field: string; label: string }> = [
  { field: 'email_corp',      label: 'Corporate email' },
  { field: 'email_personal',  label: 'Personal email' },
  { field: 'emp_id',          label: 'Employee ID (emp_id)' },
  { field: 'employee_number', label: 'Employee number' },
  { field: 'username',        label: 'Username' },
  { field: 'full_name',       label: 'Full name' },
  { field: 'first_name',      label: 'First name' },
  { field: 'last_name',       label: 'Last name' },
  { field: 'dept_id',         label: 'Department' },
  { field: 'role',            label: 'Title / designation' },
  { field: 'employment_type', label: 'Employment type' },
  { field: 'manager_emp_id',  label: 'Manager employee ID' },
  { field: 'mobile',          label: 'Mobile' },
  { field: 'cost_center',     label: 'Cost center' },
  { field: 'location',        label: 'Location' },
  { field: 'city',            label: 'City' },
  { field: 'state',           label: 'State' },
  { field: 'country',         label: 'Country' },
  { field: 'hrms_status',     label: 'HRMS status' },
  { field: 'ilg_state',       label: 'ILG state' },
  { field: 'ad_object_guid',  label: 'AD objectGUID' },
];

export const SAML_MAPPABLE_FIELD_SET = new Set(SAML_MAPPABLE_FIELD_OPTIONS.map((f) => f.field));

/**
 * Default SAML Attribute Name → employee field.
 * Include both `email`/`mail` and `displayName` — SentinelOne auto-provisioning
 * reads Mail + Display name from the assertion AttributeStatement.
 */
export const DEFAULT_ATTRIBUTE_MAP: Record<string, string> = {
  email:       'email_corp',
  mail:        'email_corp',
  employeeId:  'emp_id',
  displayName: 'full_name',
  firstName:   'first_name',
  lastName:    'last_name',
  objectGUID:  'ad_object_guid',
  department:  'dept_id',
  title:       'role',
};

/** ILG states that may receive SAML assertions. */
export const SAML_ALLOWED_ILG_STATES = new Set([
  'ACTIVE',
  'REACTIVATED',
]);
