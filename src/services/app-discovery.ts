/**
 * App Discovery — shadow IT inventory from manual entry, known-SaaS catalog gaps,
 * and SSO usage signals (registered SPs with traffic vs unsanctioned candidates).
 */
import { v4 as uuidv4 } from 'uuid';
import { execute, query, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

export type DiscoverySource = 'MANUAL' | 'CATALOG_GAP' | 'SSO_SIGNAL' | 'IMPORT';
export type DiscoveryStatus = 'NEW' | 'REVIEWING' | 'SANCTIONED' | 'IGNORED';
export type DiscoveryRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export interface DiscoveredAppRow {
  id: string;
  name: string;
  domain: string;
  category: string | null;
  source: DiscoverySource;
  status: DiscoveryStatus;
  risk_level: DiscoveryRisk;
  user_count: number;
  hit_count: number;
  first_seen_at: string;
  last_seen_at: string;
  evidence_json: unknown;
  notes: string | null;
  linked_app_id: string | null;
  created_by: string | null;
  updated_at: string;
  linked_app_name?: string | null;
}

/** Common SaaS domains — used for catalog-gap scan (not an exhaustive list). */
const KNOWN_SAAS: { name: string; domain: string; category: string; risk: DiscoveryRisk }[] = [
  { name: 'Slack', domain: 'slack.com', category: 'Collaboration', risk: 'MEDIUM' },
  { name: 'Microsoft 365', domain: 'microsoft.com', category: 'Productivity', risk: 'LOW' },
  { name: 'Google Workspace', domain: 'google.com', category: 'Productivity', risk: 'LOW' },
  { name: 'Salesforce', domain: 'salesforce.com', category: 'CRM', risk: 'HIGH' },
  { name: 'ServiceNow', domain: 'servicenow.com', category: 'ITSM', risk: 'HIGH' },
  { name: 'Atlassian / Jira', domain: 'atlassian.com', category: 'DevOps', risk: 'MEDIUM' },
  { name: 'GitHub', domain: 'github.com', category: 'DevOps', risk: 'HIGH' },
  { name: 'GitLab', domain: 'gitlab.com', category: 'DevOps', risk: 'HIGH' },
  { name: 'Notion', domain: 'notion.so', category: 'Knowledge', risk: 'MEDIUM' },
  { name: 'Dropbox', domain: 'dropbox.com', category: 'Storage', risk: 'MEDIUM' },
  { name: 'Box', domain: 'box.com', category: 'Storage', risk: 'MEDIUM' },
  { name: 'Zoom', domain: 'zoom.us', category: 'Meetings', risk: 'MEDIUM' },
  { name: 'DocuSign', domain: 'docusign.com', category: 'Agreements', risk: 'HIGH' },
  { name: 'HubSpot', domain: 'hubspot.com', category: 'CRM', risk: 'MEDIUM' },
  { name: 'Zendesk', domain: 'zendesk.com', category: 'Support', risk: 'MEDIUM' },
  { name: 'Okta', domain: 'okta.com', category: 'Identity', risk: 'HIGH' },
  { name: '1Password', domain: '1password.com', category: 'Security', risk: 'HIGH' },
  { name: 'LastPass', domain: 'lastpass.com', category: 'Security', risk: 'HIGH' },
  { name: 'Canva', domain: 'canva.com', category: 'Design', risk: 'LOW' },
  { name: 'Figma', domain: 'figma.com', category: 'Design', risk: 'MEDIUM' },
  { name: 'Asana', domain: 'asana.com', category: 'Work Mgmt', risk: 'LOW' },
  { name: 'Monday.com', domain: 'monday.com', category: 'Work Mgmt', risk: 'LOW' },
  { name: 'Trello', domain: 'trello.com', category: 'Work Mgmt', risk: 'LOW' },
  { name: 'Airtable', domain: 'airtable.com', category: 'Data', risk: 'MEDIUM' },
  { name: 'Tableau', domain: 'tableau.com', category: 'Analytics', risk: 'MEDIUM' },
  { name: 'Snowflake', domain: 'snowflake.com', category: 'Data', risk: 'HIGH' },
  { name: 'AWS Console', domain: 'aws.amazon.com', category: 'Cloud', risk: 'HIGH' },
  { name: 'Azure Portal', domain: 'portal.azure.com', category: 'Cloud', risk: 'HIGH' },
  { name: 'Cloudflare', domain: 'cloudflare.com', category: 'Network', risk: 'MEDIUM' },
  { name: 'Datadog', domain: 'datadoghq.com', category: 'Observability', risk: 'MEDIUM' },
  { name: 'PagerDuty', domain: 'pagerduty.com', category: 'Ops', risk: 'MEDIUM' },
  { name: 'Twilio', domain: 'twilio.com', category: 'Comms', risk: 'MEDIUM' },
  { name: 'SendGrid', domain: 'sendgrid.com', category: 'Email', risk: 'MEDIUM' },
  { name: 'Mailchimp', domain: 'mailchimp.com', category: 'Marketing', risk: 'LOW' },
  { name: 'Shopify', domain: 'shopify.com', category: 'Commerce', risk: 'MEDIUM' },
  { name: 'Stripe', domain: 'stripe.com', category: 'Payments', risk: 'HIGH' },
  { name: 'Zoho', domain: 'zoho.com', category: 'Suite', risk: 'MEDIUM' },
  { name: 'Freshworks', domain: 'freshworks.com', category: 'Support', risk: 'MEDIUM' },
  { name: 'ManageEngine', domain: 'manageengine.com', category: 'IT', risk: 'MEDIUM' },
  { name: 'Endpoint Central', domain: 'endpointcentral.com', category: 'Endpoint', risk: 'HIGH' },
];

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0] ?? d;
  d = d.split(':')[0] ?? d;
  return d.replace(/^\.+|\.+$/g, '');
}

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || `app-${Date.now().toString(36)}`;
}

async function sanctionedDomains(): Promise<Set<string>> {
  const rows = await query<{ domain: string }>(
    `SELECT LOWER(TRIM(domain)) AS domain FROM (
       SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(REPLACE(acs_url,'https://',''),'http://',''),'/',1),':',1) AS domain
         FROM saml_service_providers WHERE active = 1
       UNION
       SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(REPLACE(entity_id,'https://',''),'http://',''),'/',1),':',1)
         FROM saml_service_providers WHERE active = 1
       UNION
       SELECT LOWER(slug) FROM applications WHERE active = 1
       UNION
       SELECT LOWER(SUBSTRING_INDEX(name, ' ', 1)) FROM applications WHERE active = 1
     ) x
     WHERE domain IS NOT NULL AND domain != '' AND domain NOT LIKE '% %'`,
    [],
  ).catch(() => [] as { domain: string }[]);

  const set = new Set<string>();
  for (const r of rows) {
    const d = normalizeDomain(r.domain);
    if (d && d.includes('.')) set.add(d);
  }
  // Also match known apps already in catalog by name/domain overlap
  const apps = await query<{ name: string; slug: string }>(
    `SELECT name, slug FROM applications WHERE active = 1`,
    [],
  ).catch(() => [] as { name: string; slug: string }[]);
  for (const a of apps) {
    set.add(normalizeDomain(a.slug));
    const n = a.name.toLowerCase();
    for (const k of KNOWN_SAAS) {
      if (n.includes(k.name.toLowerCase().split(' ')[0]!) || n.includes(k.domain.split('.')[0]!)) {
        set.add(k.domain);
      }
    }
  }
  return set;
}

export async function listDiscoveredApps(opts: {
  status?: string;
  source?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: DiscoveredAppRow[]; total: number }> {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') {
    where.push('d.status = ?');
    params.push(opts.status);
  }
  if (opts.source && opts.source !== 'all') {
    where.push('d.source = ?');
    params.push(opts.source);
  }
  if (opts.q?.trim()) {
    where.push('(d.name LIKE ? OR d.domain LIKE ? OR d.category LIKE ?)');
    const like = `%${opts.q.trim()}%`;
    params.push(like, like, like);
  }
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM discovered_apps d WHERE ${where.join(' AND ')}`,
    params,
  );
  const rows = await query<DiscoveredAppRow>(
    `SELECT d.*, a.name AS linked_app_name
       FROM discovered_apps d
       LEFT JOIN applications a ON a.id = d.linked_app_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        FIELD(d.status, 'NEW', 'REVIEWING', 'SANCTIONED', 'IGNORED'),
        FIELD(d.risk_level, 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'),
        d.last_seen_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { data: rows, total: Number(totalRow?.n ?? 0) };
}

export async function getDiscoveryStats(): Promise<{
  total: number;
  newCount: number;
  reviewing: number;
  sanctioned: number;
  ignored: number;
  highRisk: number;
}> {
  const row = await queryOne<{
    total: number;
    newCount: number;
    reviewing: number;
    sanctioned: number;
    ignored: number;
    highRisk: number;
  }>(
    `SELECT COUNT(*) AS total,
            SUM(status = 'NEW') AS newCount,
            SUM(status = 'REVIEWING') AS reviewing,
            SUM(status = 'SANCTIONED') AS sanctioned,
            SUM(status = 'IGNORED') AS ignored,
            SUM(risk_level = 'HIGH' AND status IN ('NEW','REVIEWING')) AS highRisk
       FROM discovered_apps`,
    [],
  );
  return {
    total: Number(row?.total ?? 0),
    newCount: Number(row?.newCount ?? 0),
    reviewing: Number(row?.reviewing ?? 0),
    sanctioned: Number(row?.sanctioned ?? 0),
    ignored: Number(row?.ignored ?? 0),
    highRisk: Number(row?.highRisk ?? 0),
  };
}

export async function upsertDiscoveredApp(params: {
  name: string;
  domain: string;
  category?: string | null;
  source: DiscoverySource;
  riskLevel?: DiscoveryRisk;
  userCount?: number;
  hitCount?: number;
  evidence?: Record<string, unknown>;
  notes?: string | null;
  createdBy?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const domain = normalizeDomain(params.domain);
  if (!domain || !domain.includes('.')) {
    throw new Error('A valid domain is required (e.g. slack.com)');
  }
  const existing = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM discovered_apps WHERE domain = ? LIMIT 1`,
    [domain],
  );
  if (existing) {
    await execute(
      `UPDATE discovered_apps SET
         name = ?,
         category = COALESCE(?, category),
         risk_level = COALESCE(?, risk_level),
         user_count = GREATEST(user_count, ?),
         hit_count = hit_count + ?,
         last_seen_at = UTC_TIMESTAMP(),
         evidence_json = COALESCE(?, evidence_json),
         notes = COALESCE(?, notes),
         updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [
        params.name,
        params.category ?? null,
        params.riskLevel ?? null,
        params.userCount ?? 0,
        Math.max(1, params.hitCount ?? 1),
        params.evidence ? JSON.stringify(params.evidence) : null,
        params.notes ?? null,
        existing.id,
      ],
    );
    return { id: existing.id, created: false };
  }

  const id = uuidv4();
  await execute(
    `INSERT INTO discovered_apps
       (id, name, domain, category, source, status, risk_level, user_count, hit_count,
        evidence_json, notes, created_by)
     VALUES (?, ?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.name,
      domain,
      params.category ?? null,
      params.source,
      params.riskLevel ?? 'UNKNOWN',
      params.userCount ?? 0,
      params.hitCount ?? 1,
      params.evidence ? JSON.stringify(params.evidence) : null,
      params.notes ?? null,
      params.createdBy ?? null,
    ],
  );
  return { id, created: true };
}

export async function updateDiscoveredApp(
  id: string,
  patch: {
    status?: DiscoveryStatus;
    riskLevel?: DiscoveryRisk;
    notes?: string | null;
    name?: string;
    category?: string | null;
  },
): Promise<void> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM discovered_apps WHERE id = ?`, [id]);
  if (!row) throw new Error('Discovered app not found');
  await execute(
    `UPDATE discovered_apps SET
       status = COALESCE(?, status),
       risk_level = COALESCE(?, risk_level),
       notes = COALESCE(?, notes),
       name = COALESCE(?, name),
       category = COALESCE(?, category),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [
      patch.status ?? null,
      patch.riskLevel ?? null,
      patch.notes !== undefined ? patch.notes : null,
      patch.name ?? null,
      patch.category !== undefined ? patch.category : null,
      id,
    ],
  );
}

/**
 * Scan for unsanctioned SaaS:
 * 1) Known SaaS catalog gaps (not in applications / SAML registry)
 * 2) SSO signals — registered SPs with recent assertions tagged as sanctioned usage
 */
export async function runDiscoveryScan(actorEmpId: string): Promise<{
  catalogGaps: number;
  ssoSignals: number;
  created: number;
  updated: number;
}> {
  const sanctioned = await sanctionedDomains();
  let created = 0;
  let updated = 0;
  let catalogGaps = 0;
  let ssoSignals = 0;

  for (const saas of KNOWN_SAAS) {
    if (sanctioned.has(saas.domain)) continue;
    // Partial match: if any sanctioned domain ends with this domain or vice versa
    let covered = false;
    for (const s of sanctioned) {
      if (s === saas.domain || s.endsWith(`.${saas.domain}`) || saas.domain.endsWith(`.${s}`)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;

    catalogGaps += 1;
    const r = await upsertDiscoveredApp({
      name: saas.name,
      domain: saas.domain,
      category: saas.category,
      source: 'CATALOG_GAP',
      riskLevel: saas.risk,
      evidence: { scan: 'known_saas_catalog', scannedAt: new Date().toISOString() },
      createdBy: actorEmpId,
    });
    if (r.created) created += 1;
    else updated += 1;
  }

  // SSO usage signals — apps already registered that have login traffic (mark as seen / reinforce)
  const ssoUsage = await query<{
    sp_id: string;
    name: string;
    entity_id: string;
    acs_url: string;
    hits: number;
    users: number;
  }>(
    `SELECT sp.id AS sp_id, sp.name, sp.entity_id, sp.acs_url,
            COUNT(l.id) AS hits,
            COUNT(DISTINCT l.emp_id) AS users
       FROM saml_service_providers sp
       LEFT JOIN saml_assertion_log l
         ON l.sp_id = sp.id AND l.ts > UTC_TIMESTAMP() - INTERVAL 90 DAY
      WHERE sp.active = 1
      GROUP BY sp.id, sp.name, sp.entity_id, sp.acs_url
      HAVING hits > 0
      ORDER BY hits DESC
      LIMIT 100`,
    [],
  ).catch(() => []);

  for (const sp of ssoUsage) {
    const domain = normalizeDomain(sp.acs_url || sp.entity_id);
    if (!domain.includes('.')) continue;
    ssoSignals += 1;
    // Record as sanctioned usage signal only if not already in discovered as NEW gap
    // Prefer linking — upsert with low risk when it's a known SP
    const r = await upsertDiscoveredApp({
      name: sp.name,
      domain,
      category: 'SSO',
      source: 'SSO_SIGNAL',
      riskLevel: 'LOW',
      userCount: Number(sp.users),
      hitCount: Number(sp.hits),
      evidence: {
        scan: 'saml_assertion_log_90d',
        spId: sp.sp_id,
        hits: Number(sp.hits),
        users: Number(sp.users),
      },
      createdBy: actorEmpId,
    });
    // Auto-mark SSO signals as SANCTIONED (already in IdP)
    await execute(
      `UPDATE discovered_apps SET status = 'SANCTIONED', risk_level = 'LOW'
        WHERE id = ? AND status = 'NEW' AND source = 'SSO_SIGNAL'`,
      [r.id],
    );
    if (r.created) created += 1;
    else updated += 1;
  }

  logger.info({ catalogGaps, ssoSignals, created, updated, actorEmpId }, 'App discovery scan complete');
  return { catalogGaps, ssoSignals, created, updated };
}

/** Promote a discovered app into the IGA applications catalog. */
export async function promoteDiscoveredApp(
  id: string,
  actorEmpId: string,
): Promise<{ appId: string; slug: string }> {
  const disc = await queryOne<DiscoveredAppRow>(
    `SELECT * FROM discovered_apps WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!disc) throw new Error('Discovered app not found');
  if (disc.linked_app_id) {
    const linked = await queryOne<{ slug: string }>(
      `SELECT slug FROM applications WHERE id = ?`,
      [disc.linked_app_id],
    );
    return { appId: disc.linked_app_id, slug: linked?.slug ?? '' };
  }

  let slug = slugFromName(disc.name);
  const clash = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
    [slug],
  );
  if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  const appId = uuidv4();
  await execute(
    `INSERT INTO applications
       (id, slug, name, description, category, visibility, sso_enabled, provisioning, active)
     VALUES (?, ?, ?, ?, ?, 'RESTRICTED', 0, 0, 1)`,
    [
      appId,
      slug,
      disc.name,
      `Promoted from App Discovery (${disc.domain}). Complete SAML/OIDC registration under Applications.`,
      disc.category ?? 'Discovered',
    ],
  );

  await execute(
    `UPDATE discovered_apps
        SET status = 'SANCTIONED', linked_app_id = ?, updated_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [appId, id],
  );

  logger.info({ id, appId, slug, actorEmpId }, 'Discovered app promoted to catalog');
  return { appId, slug };
}

export async function deleteDiscoveredApp(id: string): Promise<void> {
  const result = await execute(`DELETE FROM discovered_apps WHERE id = ?`, [id]);
  if (Number(result.affectedRows ?? 0) === 0) throw new Error('Discovered app not found');
}
