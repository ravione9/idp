/**
 * App Discovery — shadow IT inventory from real signals only.
 *
 * Browsers do not expose HTTP disk cache or history to websites.
 * We collect portal-visible hints (referrer, third-party resource hosts,
 * launch destinations) and ingest them on admin scan — never a static SaaS wishlist.
 */
import { v4 as uuidv4 } from 'uuid';
import { execute, query, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

export type DiscoverySource = 'MANUAL' | 'CATALOG_GAP' | 'SSO_SIGNAL' | 'IMPORT' | 'BROWSER';
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

/** Optional name/risk enrichment when a browser reports a well-known host. */
const VENDOR_HINTS: { domain: string; name: string; category: string; risk: DiscoveryRisk; aliases?: string[] }[] = [
  { name: 'Slack', domain: 'slack.com', category: 'Collaboration', risk: 'MEDIUM' },
  { name: 'Microsoft 365', domain: 'microsoft.com', category: 'Productivity', risk: 'LOW', aliases: ['office.com', 'microsoftonline.com'] },
  { name: 'Google Workspace', domain: 'google.com', category: 'Productivity', risk: 'LOW', aliases: ['googleusercontent.com'] },
  { name: 'Salesforce', domain: 'salesforce.com', category: 'CRM', risk: 'HIGH', aliases: ['force.com'] },
  { name: 'ServiceNow', domain: 'servicenow.com', category: 'ITSM', risk: 'HIGH' },
  { name: 'Atlassian / Jira', domain: 'atlassian.com', category: 'DevOps', risk: 'MEDIUM', aliases: ['jira.com', 'bitbucket.org'] },
  { name: 'GitHub', domain: 'github.com', category: 'DevOps', risk: 'HIGH' },
  { name: 'GitLab', domain: 'gitlab.com', category: 'DevOps', risk: 'HIGH' },
  { name: 'Notion', domain: 'notion.so', category: 'Knowledge', risk: 'MEDIUM' },
  { name: 'Dropbox', domain: 'dropbox.com', category: 'Storage', risk: 'MEDIUM' },
  { name: 'Zoom', domain: 'zoom.us', category: 'Meetings', risk: 'MEDIUM' },
  { name: 'DocuSign', domain: 'docusign.com', category: 'Agreements', risk: 'HIGH' },
  { name: 'Okta', domain: 'okta.com', category: 'Identity', risk: 'HIGH' },
  { name: 'Stripe', domain: 'stripe.com', category: 'Payments', risk: 'HIGH' },
  { name: 'Zoho', domain: 'zoho.com', category: 'Suite', risk: 'MEDIUM', aliases: ['zoho.in', 'zoho.eu'] },
  { name: 'AWS Console', domain: 'aws.amazon.com', category: 'Cloud', risk: 'HIGH', aliases: ['amazonaws.com'] },
  { name: 'Azure Portal', domain: 'portal.azure.com', category: 'Cloud', risk: 'HIGH', aliases: ['azure.com'] },
];

/** CDNs / trackers — never treat as shadow-IT apps. */
const NOISE_SUFFIXES = [
  'gstatic.com', 'googleapis.com', 'google-analytics.com', 'googletagmanager.com',
  'cloudflare.com', 'cloudflareinsights.com', 'jsdelivr.net', 'unpkg.com',
  'cdnjs.cloudflare.com', 'bootstrapcdn.com', 'fontawesome.com', 'typekit.net',
  'hotjar.com', 'segment.com', 'sentry.io', 'newrelic.com', 'nr-data.net',
  'doubleclick.net', 'facebook.net', 'fbcdn.net', 'twitter.com', 'twimg.com',
  'linkedin.com', 'licdn.com', 'gravatar.com', 'wp.com', 'jquery.com',
  'localhost', '127.0.0.1',
];

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0] ?? d;
  d = d.split(':')[0] ?? d;
  if (d.startsWith('urn:')) return '';
  return d.replace(/^\.+|\.+$/g, '');
}

function registrableHint(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function isNoiseDomain(domain: string): boolean {
  if (!domain.includes('.')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return true;
  return NOISE_SUFFIXES.some((n) => domain === n || domain.endsWith(`.${n}`));
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

function titleFromDomain(domain: string): string {
  const hint = VENDOR_HINTS.find((v) => {
    const needles = [v.domain, ...(v.aliases ?? [])].map(normalizeDomain);
    return needles.some((n) => n && (domain === n || domain.endsWith(`.${n}`)));
  });
  if (hint) return hint.name;
  const base = registrableHint(domain).split('.')[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function vendorMeta(domain: string): { category: string | null; risk: DiscoveryRisk } {
  const hint = VENDOR_HINTS.find((v) => {
    const needles = [v.domain, ...(v.aliases ?? [])].map(normalizeDomain);
    return needles.some((n) => n && (domain === n || domain.endsWith(`.${n}`)));
  });
  return { category: hint?.category ?? null, risk: hint?.risk ?? 'UNKNOWN' };
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
    const matchSp = sps.find((s) => s.slug === a.slug);
    add(matchSp?.id ?? a.id, a.name, a.slug);
  }

  return [...byKey.values()];
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
  for (const v of VENDOR_HINTS) {
    const needles = [v.domain, ...(v.aliases ?? [])].map(normalizeDomain);
    if (!needles.some((n) => n && (domain === n || domain.endsWith(`.${n}`) || hint === n))) continue;
    for (const app of catalog) {
      for (const d of app.domains) {
        for (const n of needles) {
          if (!n) continue;
          if (d === n || d.endsWith(`.${n}`) || n.endsWith(`.${d}`)) return app;
        }
      }
      for (const t of tokensFromText(v.name)) {
        if (t.length < 4) continue;
        if (app.tokens.includes(t) || app.name.toLowerCase().includes(t)) return app;
      }
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

/** Persist domains observed in a user's browser (portal SPA or history extension). */
export async function recordBrowserAppSignals(
  empId: string,
  items: { domain: string; signalType?: string; hitCount?: number }[],
): Promise<{ accepted: number; skipped: number }> {
  let accepted = 0;
  let skipped = 0;
  // History extension may send up to 200 domains; portal referrer path stays small
  for (const item of items.slice(0, 200)) {
    const domain = normalizeDomain(item.domain);
    if (!domain || isNoiseDomain(domain)) {
      skipped += 1;
      continue;
    }
    const signalType = (item.signalType || 'referrer').slice(0, 40);
    const hits = Math.min(10_000, Math.max(1, Number(item.hitCount) || 1));
    try {
      await execute(
        `INSERT INTO browser_app_signals (emp_id, domain, signal_type, hit_count)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           hit_count = hit_count + VALUES(hit_count),
           last_seen_at = UTC_TIMESTAMP()`,
        [empId, domain, signalType, hits],
      );
      accepted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { accepted, skipped };
}

/**
 * Clean false-positive wishlist rows, reconcile catalog matches,
 * ingest browser signals into inventory.
 */
export async function runDiscoveryScan(actorEmpId: string): Promise<{
  removedNoise: number;
  reconciled: number;
  browserCreated: number;
  browserUpdated: number;
  created: number;
  updated: number;
}> {
  const catalog = await loadCatalogApps();

  // Wipe prior static wishlist dumps (never real usage)
  const noise = await execute(
    `DELETE FROM discovered_apps
      WHERE source = 'CATALOG_GAP'
        AND status = 'NEW'`,
    [],
  ).catch(() => ({ affectedRows: 0 }));
  const ssoNoise = await execute(
    `DELETE FROM discovered_apps WHERE source = 'SSO_SIGNAL'`,
    [],
  ).catch(() => ({ affectedRows: 0 }));
  const removedNoise = Number(noise.affectedRows ?? 0) + Number(ssoNoise.affectedRows ?? 0);

  // Reconcile open findings that are already onboarded
  const existing = await query<{ id: string; name: string; domain: string }>(
    `SELECT id, name, domain FROM discovered_apps
      WHERE status IN ('NEW', 'REVIEWING')`,
    [],
  );
  let reconciled = 0;
  for (const row of existing) {
    const match = discoveryMatchesCatalog(row, catalog);
    if (!match) continue;
    const appRow = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE slug = ? AND active = 1 LIMIT 1`,
      [match.slug],
    );
    await execute(
      `UPDATE discovered_apps
          SET status = 'SANCTIONED',
              risk_level = 'LOW',
              linked_app_id = COALESCE(?, linked_app_id),
              evidence_json = ?,
              updated_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [
        appRow?.id ?? null,
        JSON.stringify({ reconciledAt: new Date().toISOString(), matchedSlug: match.slug }),
        row.id,
      ],
    );
    reconciled += 1;
  }

  // Aggregate browser signals → discovered_apps (skip cataloged / noise)
  const signals = await query<{
    domain: string;
    hits: number;
    users: number;
    last_seen: string;
  }>(
    `SELECT domain,
            SUM(hit_count) AS hits,
            COUNT(DISTINCT emp_id) AS users,
            MAX(last_seen_at) AS last_seen
       FROM browser_app_signals
      GROUP BY domain
      HAVING hits > 0
      ORDER BY hits DESC
      LIMIT 500`,
    [],
  ).catch(() => []);

  let browserCreated = 0;
  let browserUpdated = 0;
  for (const sig of signals) {
    const domain = normalizeDomain(sig.domain);
    if (!domain || isNoiseDomain(domain)) continue;
    if (discoveryMatchesCatalog({ name: titleFromDomain(domain), domain }, catalog)) continue;

    const meta = vendorMeta(domain);
    const r = await upsertDiscoveredApp({
      name: titleFromDomain(domain),
      domain,
      category: meta.category,
      source: 'BROWSER',
      riskLevel: meta.risk,
      userCount: Number(sig.users) || 1,
      hitCount: Number(sig.hits) || 1,
      evidence: {
        from: 'browser_app_signals',
        lastSeen: sig.last_seen,
        note: 'Observed via portal browser signals (referrer / resources / launches). Not HTTP disk cache.',
      },
      notes: 'Observed from browser signals (portal session and/or history extension)',
      createdBy: actorEmpId,
    });
    if (r.created) browserCreated += 1;
    else browserUpdated += 1;
  }

  logger.info(
    {
      removedNoise,
      reconciled,
      browserCreated,
      browserUpdated,
      signalDomains: signals.length,
      actorEmpId,
    },
    'App discovery scan complete',
  );

  return {
    removedNoise,
    reconciled,
    browserCreated,
    browserUpdated,
    created: browserCreated,
    updated: reconciled + browserUpdated,
  };
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
