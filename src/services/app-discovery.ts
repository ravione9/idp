/**
 * App Discovery — shadow IT inventory.
 *
 * Scan does NOT dump a static SaaS wishlist into the DB (that produced false "NEW" rows).
 * Instead it:
 *  1) Reconciles existing discoveries against registered SAML / catalog apps
 *  2) Returns catalog-gap *suggestions* (known SaaS not in catalog) without auto-inserting
 *  3) Leaves MANUAL / IMPORT findings intact for admin review
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

export interface CatalogSuggestion {
  name: string;
  domain: string;
  category: string;
  risk: DiscoveryRisk;
  reason: string;
}

type KnownSaas = {
  name: string;
  domain: string;
  category: string;
  risk: DiscoveryRisk;
  /** Extra host suffixes / tokens that mean this vendor is already onboarded */
  aliases?: string[];
};

const KNOWN_SAAS: KnownSaas[] = [
  { name: 'Slack', domain: 'slack.com', category: 'Collaboration', risk: 'MEDIUM' },
  { name: 'Microsoft 365', domain: 'microsoft.com', category: 'Productivity', risk: 'LOW', aliases: ['office.com', 'microsoftonline.com', 'live.com'] },
  { name: 'Google Workspace', domain: 'google.com', category: 'Productivity', risk: 'LOW', aliases: ['googleusercontent.com', 'googleapis.com'] },
  { name: 'Salesforce', domain: 'salesforce.com', category: 'CRM', risk: 'HIGH', aliases: ['force.com'] },
  { name: 'ServiceNow', domain: 'servicenow.com', category: 'ITSM', risk: 'HIGH' },
  { name: 'Atlassian / Jira', domain: 'atlassian.com', category: 'DevOps', risk: 'MEDIUM', aliases: ['jira.com', 'bitbucket.org', 'trello.com'] },
  { name: 'GitHub', domain: 'github.com', category: 'DevOps', risk: 'HIGH' },
  { name: 'GitLab', domain: 'gitlab.com', category: 'DevOps', risk: 'HIGH' },
  { name: 'Notion', domain: 'notion.so', category: 'Knowledge', risk: 'MEDIUM' },
  { name: 'Dropbox', domain: 'dropbox.com', category: 'Storage', risk: 'MEDIUM' },
  { name: 'Box', domain: 'box.com', category: 'Storage', risk: 'MEDIUM' },
  { name: 'Zoom', domain: 'zoom.us', category: 'Meetings', risk: 'MEDIUM' },
  { name: 'DocuSign', domain: 'docusign.com', category: 'Agreements', risk: 'HIGH', aliases: ['docusign.net'] },
  { name: 'HubSpot', domain: 'hubspot.com', category: 'CRM', risk: 'MEDIUM' },
  { name: 'Zendesk', domain: 'zendesk.com', category: 'Support', risk: 'MEDIUM' },
  { name: 'Okta', domain: 'okta.com', category: 'Identity', risk: 'HIGH', aliases: ['oktapreview.com'] },
  { name: '1Password', domain: '1password.com', category: 'Security', risk: 'HIGH' },
  { name: 'LastPass', domain: 'lastpass.com', category: 'Security', risk: 'HIGH' },
  { name: 'Canva', domain: 'canva.com', category: 'Design', risk: 'LOW' },
  { name: 'Figma', domain: 'figma.com', category: 'Design', risk: 'MEDIUM' },
  { name: 'Asana', domain: 'asana.com', category: 'Work Mgmt', risk: 'LOW' },
  { name: 'Monday.com', domain: 'monday.com', category: 'Work Mgmt', risk: 'LOW' },
  { name: 'Airtable', domain: 'airtable.com', category: 'Data', risk: 'MEDIUM' },
  { name: 'Tableau', domain: 'tableau.com', category: 'Analytics', risk: 'MEDIUM' },
  { name: 'Snowflake', domain: 'snowflake.com', category: 'Data', risk: 'HIGH' },
  { name: 'AWS Console', domain: 'aws.amazon.com', category: 'Cloud', risk: 'HIGH', aliases: ['amazonaws.com'] },
  { name: 'Azure Portal', domain: 'portal.azure.com', category: 'Cloud', risk: 'HIGH', aliases: ['azure.com', 'microsoftazuread-sso.com'] },
  { name: 'Cloudflare', domain: 'cloudflare.com', category: 'Network', risk: 'MEDIUM' },
  { name: 'Datadog', domain: 'datadoghq.com', category: 'Observability', risk: 'MEDIUM' },
  { name: 'PagerDuty', domain: 'pagerduty.com', category: 'Ops', risk: 'MEDIUM' },
  { name: 'Twilio', domain: 'twilio.com', category: 'Comms', risk: 'MEDIUM' },
  { name: 'Stripe', domain: 'stripe.com', category: 'Payments', risk: 'HIGH' },
  { name: 'Zoho', domain: 'zoho.com', category: 'Suite', risk: 'MEDIUM', aliases: ['zoho.in', 'zoho.eu', 'zoho.com.au', 'zohocloud.ca'] },
  { name: 'Freshworks', domain: 'freshworks.com', category: 'Support', risk: 'MEDIUM', aliases: ['freshdesk.com', 'freshservice.com'] },
  {
    name: 'ManageEngine / Endpoint Central',
    domain: 'manageengine.com',
    category: 'Endpoint',
    risk: 'HIGH',
    aliases: ['endpointcentral.com', 'zoho.com', 'uems.manageengine.com'],
  },
];

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0] ?? d;
  d = d.split(':')[0] ?? d;
  // bare entity IDs like "zoho.com" stay; urn:… entity IDs → empty
  if (d.startsWith('urn:')) return '';
  return d.replace(/^\.+|\.+$/g, '');
}

/** eTLD+1-ish: accounts.zoho.in → zoho.in ; foo.bar.slack.com → slack.com */
function registrableHint(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  // keep last 2; for .co.uk-style we'd need a list — good enough for SaaS hosts
  return parts.slice(-2).join('.');
}

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || `app-${Date.now().toString(36)}`;
}

function tokensFromText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]+/g, ' ')
    .split(/[\s._-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

type CatalogApp = {
  id: string;
  name: string;
  slug: string;
  domains: string[];
  tokens: string[];
};

async function loadCatalogApps(): Promise<CatalogApp[]> {
  const sps = await query<{
    id: string;
    name: string;
    slug: string;
    entity_id: string;
    acs_url: string;
  }>(
    `SELECT id, name, slug, entity_id, acs_url
       FROM saml_service_providers WHERE active = 1`,
    [],
  ).catch(() => []);

  const apps = await query<{ id: string; name: string; slug: string }>(
    `SELECT id, name, slug FROM applications WHERE active = 1`,
    [],
  ).catch(() => []);

  const byKey = new Map<string, CatalogApp>();

  const add = (id: string, name: string, slug: string, extraDomains: string[] = []) => {
    const key = id || slug;
    const existing = byKey.get(key);
    const domains = new Set<string>(existing?.domains ?? []);
    for (const raw of [slug, ...extraDomains]) {
      const d = normalizeDomain(raw);
      if (d) {
        domains.add(d);
        const hint = registrableHint(d);
        if (hint) domains.add(hint);
      }
    }
    // slug without dots still useful as token
    const tokens = new Set<string>(existing?.tokens ?? []);
    for (const t of tokensFromText(`${name} ${slug}`)) tokens.add(t);
    byKey.set(key, {
      id,
      name,
      slug,
      domains: [...domains],
      tokens: [...tokens],
    });
  };

  for (const sp of sps) {
    add(sp.id, sp.name, sp.slug, [sp.entity_id, sp.acs_url]);
  }
  for (const a of apps) {
    // Prefer application UUID when both exist — use slug match to merge later
    const matchSp = sps.find((s) => s.slug === a.slug);
    add(matchSp?.id ?? a.id, a.name, a.slug);
  }

  return [...byKey.values()];
}

function vendorCoveredByCatalog(saas: KnownSaas, catalog: CatalogApp[]): CatalogApp | null {
  const needles = new Set<string>([
    saas.domain,
    registrableHint(saas.domain),
    ...(saas.aliases ?? []).map(normalizeDomain),
  ]);
  const nameTokens = tokensFromText(saas.name);

  for (const app of catalog) {
    for (const d of app.domains) {
      for (const n of needles) {
        if (!n) continue;
        if (d === n || d.endsWith(`.${n}`) || n.endsWith(`.${d}`)) return app;
      }
    }
    // name / slug token overlap (e.g. "Zoho Mail" covers Zoho; "Endpoint Central" covers ManageEngine)
    for (const t of nameTokens) {
      if (t.length < 4) continue;
      if (app.tokens.includes(t) || app.name.toLowerCase().includes(t) || app.slug.includes(t)) {
        return app;
      }
    }
  }
  return null;
}

function discoveryMatchesCatalog(
  disc: { name: string; domain: string },
  catalog: CatalogApp[],
): CatalogApp | null {
  const domain = normalizeDomain(disc.domain);
  const hint = registrableHint(domain);
  for (const app of catalog) {
    for (const d of app.domains) {
      if (d === domain || d === hint || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`)) {
        return app;
      }
    }
    const dt = tokensFromText(disc.name);
    for (const t of dt) {
      if (t.length < 4) continue;
      if (app.tokens.includes(t) || app.name.toLowerCase().includes(t)) return app;
    }
  }
  // known-vendor alias bridge
  for (const saas of KNOWN_SAAS) {
    const needles = [saas.domain, ...(saas.aliases ?? [])].map(normalizeDomain);
    if (needles.some((n) => n && (domain === n || domain.endsWith(`.${n}`) || hint === n))) {
      return vendorCoveredByCatalog(saas, catalog);
    }
  }
  return null;
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
  status?: DiscoveryStatus;
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
        Math.max(0, params.hitCount ?? 0),
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.name,
      domain,
      params.category ?? null,
      params.source,
      params.status ?? 'NEW',
      params.riskLevel ?? 'UNKNOWN',
      params.userCount ?? 0,
      params.hitCount ?? 0,
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
 * Reconcile inventory + compute catalog-gap suggestions (not auto-inserted).
 * Also removes prior auto-inserted CATALOG_GAP noise that was never reviewed.
 */
export async function runDiscoveryScan(actorEmpId: string): Promise<{
  catalogGaps: number;
  reconciled: number;
  removedNoise: number;
  suggestions: CatalogSuggestion[];
  created: number;
  updated: number;
}> {
  const catalog = await loadCatalogApps();

  // Remove false-positive wishlist rows from the first MVP scan (never manually reviewed)
  const noise = await execute(
    `DELETE FROM discovered_apps
      WHERE source = 'CATALOG_GAP'
        AND status = 'NEW'
        AND (notes IS NULL OR notes = '')
        AND (created_by IS NULL OR created_by = ?)`,
    [actorEmpId],
  ).catch(() => ({ affectedRows: 0 }));
  // Also clear SSO_SIGNAL rows — registered SPs are not "discovered" shadow IT
  const ssoNoise = await execute(
    `DELETE FROM discovered_apps WHERE source = 'SSO_SIGNAL'`,
    [],
  ).catch(() => ({ affectedRows: 0 }));
  const removedNoise = Number(noise.affectedRows ?? 0) + Number(ssoNoise.affectedRows ?? 0);

  // Reconcile remaining discoveries against catalog
  const existing = await query<{ id: string; name: string; domain: string; status: string; linked_app_id: string | null }>(
    `SELECT id, name, domain, status, linked_app_id FROM discovered_apps
      WHERE status IN ('NEW', 'REVIEWING')`,
    [],
  );
  let reconciled = 0;
  for (const row of existing) {
    const match = discoveryMatchesCatalog(row, catalog);
    if (!match) continue;
    // Prefer applications.id when slug matches
    const appRow = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE slug = ? AND active = 1 LIMIT 1`,
      [match.slug],
    );
    const linkedId = appRow?.id ?? null;
    await execute(
      `UPDATE discovered_apps
          SET status = 'SANCTIONED',
              risk_level = 'LOW',
              linked_app_id = COALESCE(?, linked_app_id),
              evidence_json = ?,
              updated_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [
        linkedId,
        JSON.stringify({ reconciledAt: new Date().toISOString(), matchedSlug: match.slug }),
        row.id,
      ],
    );
    reconciled += 1;
  }

  // Suggestions only — not written until admin imports them
  const suggestions: CatalogSuggestion[] = [];
  for (const saas of KNOWN_SAAS) {
    if (vendorCoveredByCatalog(saas, catalog)) continue;
    const already = await queryOne<{ id: string }>(
      `SELECT id FROM discovered_apps WHERE domain = ? LIMIT 1`,
      [saas.domain],
    );
    if (already) continue;
    suggestions.push({
      name: saas.name,
      domain: saas.domain,
      category: saas.category,
      risk: saas.risk,
      reason: 'Not found in SAML apps or Application Catalog',
    });
  }

  logger.info(
    {
      catalogGaps: suggestions.length,
      reconciled,
      removedNoise,
      catalogSize: catalog.length,
      actorEmpId,
    },
    'App discovery scan complete',
  );

  return {
    catalogGaps: suggestions.length,
    reconciled,
    removedNoise,
    suggestions,
    created: 0,
    updated: reconciled,
  };
}

/** Import selected catalog-gap suggestions into the discovery inventory. */
export async function importCatalogSuggestions(
  items: { name: string; domain: string; category?: string; risk?: DiscoveryRisk }[],
  actorEmpId: string,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  const catalog = await loadCatalogApps();
  for (const item of items) {
    const domain = normalizeDomain(item.domain);
    const saas = KNOWN_SAAS.find((k) => k.domain === domain)
      ?? { name: item.name, domain, category: item.category ?? 'SaaS', risk: item.risk ?? 'UNKNOWN' as DiscoveryRisk };
    if (vendorCoveredByCatalog(saas as KnownSaas, catalog)) {
      skipped += 1;
      continue;
    }
    const r = await upsertDiscoveredApp({
      name: item.name,
      domain,
      category: item.category ?? null,
      source: 'CATALOG_GAP',
      riskLevel: item.risk ?? 'UNKNOWN',
      notes: 'Imported from catalog-gap suggestions',
      createdBy: actorEmpId,
      hitCount: 0,
    });
    if (r.created) created += 1;
    else skipped += 1;
  }
  return { created, skipped };
}

/** Promote a discovered app into the IGA applications catalog. */
export async function promoteDiscoveredApp(
  id: string,
  _actorEmpId: string,
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

  // If already registered under SAML / catalog, just link — don't create a duplicate
  const catalog = await loadCatalogApps();
  const match = discoveryMatchesCatalog(disc, catalog);
  if (match) {
    const appRow = await queryOne<{ id: string; slug: string }>(
      `SELECT id, slug FROM applications WHERE slug = ? AND active = 1 LIMIT 1`,
      [match.slug],
    );
    if (appRow) {
      await execute(
        `UPDATE discovered_apps
            SET status = 'SANCTIONED', linked_app_id = ?, risk_level = 'LOW', updated_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [appRow.id, id],
      );
      return { appId: appRow.id, slug: appRow.slug };
    }
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

  logger.info({ id, appId, slug }, 'Discovered app promoted to catalog');
  return { appId, slug };
}

export async function deleteDiscoveredApp(id: string): Promise<void> {
  const result = await execute(`DELETE FROM discovered_apps WHERE id = ?`, [id]);
  if (Number(result.affectedRows ?? 0) === 0) throw new Error('Discovered app not found');
}
