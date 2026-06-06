/* Admin views: Dashboard, SAML apps, App catalog, Connectors, Users, Admins,
   Reviews, SoD, Risk, Authentication, Audit, Reports. */
import { api } from './api.js?v=2026-06-07-groups-sync';
import { el, esc, fmtDate, fmtShortDate, ilgBadge, initials, build30DaySeries, renderLineChart, renderDonut } from './ui.js';
import { icon as svgIcon } from './icons.js';
import { viewOidcApps, viewPrebuiltApps } from './views-stubs.js?v=2026-06-07-c';

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

// Shared helpers (mirrors views-stubs.js — not yet in a shared module)
function openModal(html) {
  const bd = el(`<div class="modal-backdrop">${html}</div>`);
  bd.addEventListener('click', (e) => { if (e.target === bd) bd.remove(); });
  document.body.appendChild(bd);
  return bd;
}
function errHtml(msg) { return `<div class="alert alert-error">${esc(msg)}</div>`; }

async function parseSamlMetadataClient(metadata) {
  if (typeof api.parseSamlMetadata === 'function') {
    return api.parseSamlMetadata(metadata);
  }

  const res = await fetch('/api/admin/saml-apps/parse-metadata', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata }),
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error((body && (body.message || body.error)) || res.statusText);
  }
  return body;
}

function spMetadataUploadHtml(pfx) {
  return `
    <div class="span2 saml-reg-meta">
      <div class="saml-reg-panel">
        <span class="saml-reg-panel__title">Step 1 — Share our IdP trust with the vendor</span>
        <span class="saml-reg-panel__hint">
          Download and upload these in Zoho / AWS / GitHub so they accept signatures from this portal.
        </span>
        <div class="saml-reg-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="${pfx}-idp-meta-dl">⬇ IdP metadata.xml</button>
          <button type="button" class="btn btn-secondary btn-sm" id="${pfx}-idp-cert-dl">⬇ IdP certificate.pem</button>
          <a class="btn btn-secondary btn-sm" id="${pfx}-idp-meta-open" target="_blank" rel="noopener">Open metadata URL</a>
        </div>
      </div>

      <div class="saml-reg-panel">
        <span class="saml-reg-panel__title">Step 2 — Import their SP metadata (recommended)</span>
        <span class="saml-reg-panel__hint">
          Upload or paste the SP metadata XML from the vendor — Entity ID, ACS URL, and SLO will auto-fill.
        </span>
        <div id="${pfx}-meta-drop" class="saml-reg-drop">
          <div style="font-size:1.5rem;margin-bottom:0.35rem">📄</div>
          <label class="btn btn-primary btn-sm" style="cursor:pointer;margin:0">
            Choose metadata .xml file
            <input type="file" id="${pfx}-meta-file" accept=".xml,text/xml,application/xml" style="display:none">
          </label>
          <div class="muted" style="font-size:0.75rem;margin-top:0.5rem">or paste XML below</div>
        </div>
        <textarea class="form-textarea" id="${pfx}-meta-paste" rows="4" placeholder="&lt;EntityDescriptor xmlns=&quot;urn:oasis:names:tc:SAML:2.0:metadata&quot; entityID=&quot;...&quot;&gt;..."></textarea>
        <button type="button" class="btn btn-secondary btn-sm" id="${pfx}-meta-parse" style="margin-top:0.5rem">Parse metadata &amp; fill fields</button>
      </div>
    </div>
    <hr class="span2" style="border:none;border-top:1px solid var(--border);margin:0.15rem 0 0.35rem">
    <p class="saml-reg-section-title span2">Application details</p>`;
}

function bindSpMetadataUpload(bd, pfx, { errId, nameId, slugId, isEdit }) {
  const errEl = bd.querySelector(`#${errId}`);
  const fileEl = bd.querySelector(`#${pfx}-meta-file`);
  const pasteEl = bd.querySelector(`#${pfx}-meta-paste`);
  const parseBtn = bd.querySelector(`#${pfx}-meta-parse`);
  const idpMetaDownloadBtn = bd.querySelector(`#${pfx}-idp-meta-dl`);
  const idpCertDownloadBtn = bd.querySelector(`#${pfx}-idp-cert-dl`);
  const idpMetaOpenLink = bd.querySelector(`#${pfx}-idp-meta-open`);
  const idpMetaUrl = `${window.location.origin}/saml/metadata`;

  if (idpMetaOpenLink) {
    idpMetaOpenLink.href = idpMetaUrl;
  }

  function applyParsed(data) {
    if (data.entityId) bd.querySelector(`#${pfx}-entity`).value = data.entityId;
    if (data.acsUrl) bd.querySelector(`#${pfx}-acs`).value = data.acsUrl;
    if (data.sloUrl) bd.querySelector(`#${pfx}-slo`).value = data.sloUrl;
    if (data.nameidFormat) {
      const sel = bd.querySelector(`#${pfx}-nameid`);
      if (sel && [...sel.options].some((o) => o.value === data.nameidFormat)) {
        sel.value = data.nameidFormat;
      }
    }
    if (!isEdit && nameId) {
      const nameEl = bd.querySelector(`#${nameId}`);
      if (nameEl && !nameEl.value.trim()) {
        try {
          const host = new URL(data.entityId).hostname.replace(/^www\./, '');
          const part = host.split('.')[0] || '';
          if (part) nameEl.value = part.charAt(0).toUpperCase() + part.slice(1);
        } catch { /* ignore */ }
      }
    }
    if (!isEdit && slugId) {
      const slugEl = bd.querySelector(`#${slugId}`);
      const nameEl2 = nameId ? bd.querySelector(`#${nameId}`) : null;
      if (slugEl && !slugEl.value.trim() && nameEl2?.value.trim()) {
        slugEl.value = nameEl2.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
    }
    if (errEl) {
      errEl.innerHTML = '<div class="alert alert-success">Metadata parsed — review the fields below, then save.</div>';
    }
  }

  async function doParse(xml) {
    const trimmed = (xml || '').trim();
    if (!trimmed) {
      if (errEl) errEl.innerHTML = errHtml('Paste or upload SP metadata XML first.');
      return;
    }
    parseBtn.disabled = true;
    parseBtn.textContent = 'Parsing…';
    try {
      const r = await parseSamlMetadataClient(trimmed);
      applyParsed(r.data || r);
    } catch (e) {
      if (errEl) errEl.innerHTML = errHtml(e.message || 'Could not parse metadata.');
    }
    parseBtn.disabled = false;
    parseBtn.textContent = 'Parse metadata';
  }

  parseBtn.addEventListener('click', () => doParse(pasteEl.value));
  fileEl.addEventListener('change', async () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      pasteEl.value = text;
      await doParse(text);
    } catch (e) {
      if (errEl) errEl.innerHTML = errHtml('Could not read file: ' + e.message);
    }
    fileEl.value = '';
  });

  const dropEl = bd.querySelector(`#${pfx}-meta-drop`);
  if (dropEl) {
    dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.style.borderColor = 'var(--accent)'; });
    dropEl.addEventListener('dragleave', () => { dropEl.style.borderColor = 'var(--border)'; });
    dropEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropEl.style.borderColor = 'var(--border)';
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        pasteEl.value = text;
        await doParse(text);
      } catch (err) {
        if (errEl) errEl.innerHTML = errHtml('Could not read dropped file: ' + err.message);
      }
    });
  }

  if (idpMetaDownloadBtn) {
    idpMetaDownloadBtn.addEventListener('click', async () => {
      const oldLabel = idpMetaDownloadBtn.textContent;
      idpMetaDownloadBtn.disabled = true;
      idpMetaDownloadBtn.textContent = 'Downloading…';
      try {
        const res = await fetch('/saml/metadata', { credentials: 'include' });
        const xml = await res.text();
        if (!res.ok || !xml.includes('<EntityDescriptor')) {
          throw new Error('Could not fetch valid IdP metadata XML from /saml/metadata');
        }
        const blob = new Blob([xml], { type: 'application/samlmetadata+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'idp-metadata.xml';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        if (errEl) errEl.innerHTML = errHtml(e.message || 'Failed to download IdP metadata.');
      } finally {
        idpMetaDownloadBtn.disabled = false;
        idpMetaDownloadBtn.textContent = oldLabel || '⬇ Download our IdP metadata.xml';
      }
    });
  }

  if (idpCertDownloadBtn) {
    idpCertDownloadBtn.addEventListener('click', async () => {
      const oldLabel = idpCertDownloadBtn.textContent;
      idpCertDownloadBtn.disabled = true;
      idpCertDownloadBtn.textContent = 'Downloading…';
      try {
        const res = await fetch('/saml/metadata', { credentials: 'include' });
        const xml = await res.text();
        if (!res.ok || !xml.includes('<EntityDescriptor')) {
          throw new Error('Could not fetch valid IdP metadata XML from /saml/metadata');
        }

        const match = xml.match(/<[^>]*:?X509Certificate[^>]*>([\s\S]*?)<\/[^>]*:?X509Certificate>/i);
        if (!match) {
          throw new Error('No X.509 certificate found in IdP metadata');
        }
        const raw = (match[1] || '').replace(/\s+/g, '');
        const lines = raw.match(/.{1,64}/g);
        if (!lines || lines.length === 0) {
          throw new Error('Invalid X.509 certificate in IdP metadata');
        }
        const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;

        const blob = new Blob([pem], { type: 'application/x-pem-file;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'idp-certificate.pem';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        if (errEl) errEl.innerHTML = errHtml(e.message || 'Failed to download IdP certificate.');
      } finally {
        idpCertDownloadBtn.disabled = false;
        idpCertDownloadBtn.textContent = oldLabel || '⬇ Download our IdP certificate (.pem)';
      }
    });
  }
}

function header(title, subtitle, action = '') {
  return `<div class="page-header">
    <div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>
    ${action}</div>`;
}

function statCard(iconName, label, value, sub = '', cls = 'primary') {
  return `<div class="stat-card">
    <div class="stat-icon ${cls}">${svgIcon(iconName)}</div>
    <div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>
  </div>`;
}

/* ---------- Dashboard ---------- */
export async function viewDashboard(content) {
  content.replaceChildren(el(`<div><div class="loading-row"><span class="spinner"></span></div></div>`));
  let d, ts, ins;
  try {
    [d, ts, ins] = await Promise.all([
      api.dashboard(),
      api.dashboardSeries().catch(() => ({ logins: [], ssos: [] })),
      api.sessionsInsight().catch(() => ({ active: 0, expired: 0, revoked: 0 })),
    ]);
  } catch (err) {
    content.replaceChildren(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }
  const c = d.counts;
  const sys = d.system;

  const series = [build30DaySeries(ts.logins), build30DaySeries(ts.ssos)];
  const labels = series[0].map((p) => fmtShortDate(p.d));
  const lineSvg = renderLineChart({
    series: [series[0].map((p) => p.n), series[1].map((p) => p.n)],
    labels,
    colors: ['primary', 'accent'],
  });
  const donut = renderDonut(
    [
      { label: 'Active',  value: ins.active,  color: 'var(--success)' },
      { label: 'Expired', value: ins.expired, color: 'var(--text-dim)' },
      { label: 'Revoked', value: ins.revoked, color: 'var(--danger)' },
    ],
    'Total',
  );

  const recent = (d.recentAssertions || []).map((r) => `<tr>
    <td class="muted">${fmtDate(r.ts)}</td>
    <td class="cell-strong">${esc(r.sp_name)}</td>
    <td>${esc(r.emp_id)}</td>
    <td><span class="badge badge-info">${esc(r.binding)}</span></td>
  </tr>`).join('');
  const topApps = (d.topApps || []).map((a) => `<tr>
    <td class="cell-strong">${esc(a.name)}</td>
    <td><code>${esc(a.slug)}</code></td>
    <td>${a.n}</td>
  </tr>`).join('');

  const wrap = el(`<div>
    ${header('Dashboard', 'Overview of your identity and access management deployment')}

    <section class="stat-grid">
      ${statCard('users',       'Total users',       c.employees,                            `${c.activeEmployees} active`,    'primary')}
      ${statCard('saml',        'SAML apps',         c.activeSamlApps,                       `${c.samlApps} registered`,       'accent')}
      ${statCard('activity',    'Active sessions',   c.activeSessions,                       'across all users',               'success')}
      ${statCard('key',         'SSO logins (24h)',  c.assertions24h,                        `${c.assertions7d} in 7 days`,    'info')}
      ${statCard('check',       'Pending tasks',     c.pendingApprovals + c.pendingReviews,  'approvals + reviews',            'warning')}
      ${statCard('alert',       'SoD violations',    c.openSodViolations,                    'open',                           'danger')}
      ${statCard('shieldCheck', 'MFA enrolled',      c.mfaEnrolled,                          'admins',                         'purple')}
      ${statCard('userShield',  'Local admins',      c.localAdmins,                          'console accounts',               'teal')}
    </section>

    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title">Session overview</div>
          <div class="chart-meta">Last 30 days</div>
        </div>
        ${lineSvg}
        <div class="legend"><span><span class="swatch primary"></span>Logins</span><span><span class="swatch accent"></span>SSO assertions</span></div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title">Sessions insight</div>
        </div>
        <div class="donut-wrap">${donut}</div>
      </div>
    </div>

    <div class="grid-3">
      <div class="card" style="grid-column: span 2; min-width:0">
        <h2>Recent SSO activity</h2>
        <p class="subtitle" style="margin-bottom:0.75rem">Latest SAML assertions issued by the IdP</p>
        ${recent ? `<table><thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th></tr></thead><tbody>${recent}</tbody></table>` : `<div class="empty-state"><span class="empty-icon">⌖</span>No SSO assertions yet</div>`}
      </div>
      <div class="card">
        <h2>Top apps (7 days)</h2>
        ${topApps ? `<table><thead><tr><th>App</th><th>Slug</th><th>Logins</th></tr></thead><tbody>${topApps}</tbody></table>` : `<div class="empty-state">No data yet</div>`}
      </div>
      <div class="card" style="grid-column: span 3">
        <h2>System status</h2>
        <div class="grid-3" style="margin-top:0.75rem">
          <div class="kv"><div class="k">SAML IdP</div><div class="v">${sys.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
          <div class="kv"><div class="k">Public base URL</div><div class="v truncate">${esc(sys.publicBaseUrl || '—')}</div></div>
          <div class="kv"><div class="k">Metadata</div><div class="v">${sys.metadataUrl ? `<a href="${esc(sys.metadataUrl)}" target="_blank">Open</a>` : '—'}</div></div>
          <div class="kv"><div class="k">Google OIDC</div><div class="v">${sys.googleConfigured ? '<span class="badge badge-success">Configured</span>' : '<span class="badge badge-neutral">Not configured</span>'}</div></div>
          <div class="kv"><div class="k">Zoho Mail SAML</div><div class="v">${sys.zohoSamlConfigured ? '<span class="badge badge-success">Registered</span>' : '<span class="badge badge-neutral">Not registered</span>'}</div></div>
        </div>
      </div>
    </div>
  </div>`);
  content.replaceChildren(wrap);
}

/* ---------- Applications (unified: Catalog + SAML + OIDC) ---------- */
export async function viewApplications(me, content, initialTab = 'catalog') {
  const tabs = [
    { id: 'catalog',  label: 'Application Catalog' },
    { id: 'saml',     label: 'SAML Applications' },
    { id: 'oidc',     label: 'OIDC / OAuth' },
    { id: 'prebuilt', label: 'Pre-built Integrations' },
  ];
  const validTab = tabs.some((t) => t.id === initialTab) ? initialTab : 'catalog';

  const wrap = el(`<div>
    ${header('Applications', 'Application catalog, SAML service providers, OIDC / OAuth clients, and pre-built integrations')}
    <div class="inline-tabs" id="apps-tabs">
      ${tabs.map((t) => `<button type="button" class="inline-tab${t.id === validTab ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="apps-panel-catalog"></div>
    <div id="apps-panel-saml" hidden></div>
    <div id="apps-panel-oidc" hidden></div>
    <div id="apps-panel-prebuilt" hidden></div>
  </div>`);
  content.replaceChildren(wrap);

  const panels = {
    catalog:  wrap.querySelector('#apps-panel-catalog'),
    saml:     wrap.querySelector('#apps-panel-saml'),
    oidc:     wrap.querySelector('#apps-panel-oidc'),
    prebuilt: wrap.querySelector('#apps-panel-prebuilt'),
  };

  async function showTab(tabId) {
    wrap.querySelectorAll('#apps-tabs .inline-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    for (const [id, panel] of Object.entries(panels)) {
      panel.hidden = id !== tabId;
    }

    const qs = new URLSearchParams();
    qs.set('v', 'applications');
    if (tabId !== 'catalog') qs.set('tab', tabId);
    history.replaceState(null, '', `/?${qs}`);

    if (tabId === 'catalog' && !panels.catalog.dataset.loaded) {
      panels.catalog.dataset.loaded = '1';
      await viewIgaApps(panels.catalog, { embed: true });
    } else if (tabId === 'saml' && !panels.saml.dataset.loaded) {
      panels.saml.dataset.loaded = '1';
      await viewSamlApps(me, panels.saml, { embed: true });
    } else if (tabId === 'oidc' && !panels.oidc.dataset.loaded) {
      panels.oidc.dataset.loaded = '1';
      await viewOidcApps(panels.oidc, { embed: true });
    } else if (tabId === 'prebuilt' && !panels.prebuilt.dataset.loaded) {
      panels.prebuilt.dataset.loaded = '1';
      await viewPrebuiltApps(panels.prebuilt, { embed: true });
    }
  }

  wrap.querySelector('#apps-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) void showTab(btn.dataset.tab);
  });

  await showTab(validTab);
}

/* ---------- Application Catalog (IGA) ---------- */
export async function viewIgaApps(content, opts = {}) {
  const embed = !!opts.embed;
  const actionBtn = `<button class="btn btn-primary" id="ac-new-btn">+ Register App</button>`;
  const wrap = el(`<div>
    ${embed
      ? `<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">${actionBtn}</div>`
      : header('Application Catalog',
        'Protocol-agnostic registry. Each app may have one or more SAML / OIDC / SCIM bindings.',
        actionBtn)}
    <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:1.25rem">
      <input class="form-input" id="ac-search" placeholder="Search by name, slug, category…" style="max-width:280px;flex:1">
      <select class="form-select" id="ac-vis" style="max-width:150px">
        <option value="">All Visibility</option>
        <option value="PUBLIC">Public</option>
        <option value="RESTRICTED">Restricted</option>
      </select>
      <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.875rem">
        <input type="checkbox" id="ac-show-inactive"> Show inactive
      </label>
    </div>
    <div id="ac-list"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`);
  content.replaceChildren(wrap);

  let allApps = [];
  let searchQ = '';
  let visFilter = '';
  let showInactive = false;

  // ── App icon helper — coloured letter avatar, no external CDN ──────────────
  function appIcon(app) {
    const colours = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#6366f1'];
    const bg = colours[(app.name || ' ').charCodeAt(0) % colours.length];
    if (app.icon_url) {
      return `<img src="${esc(app.icon_url)}" width="36" height="36"
        style="border-radius:8px;object-fit:contain;flex-shrink:0"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div style="display:none;width:36px;height:36px;border-radius:8px;background:${bg};
          color:#fff;font-weight:700;font-size:1rem;align-items:center;justify-content:center;flex-shrink:0">
          ${esc((app.name||'?')[0].toUpperCase())}
        </div>`;
    }
    return `<div style="width:36px;height:36px;border-radius:8px;background:${bg};
      color:#fff;font-weight:700;font-size:1rem;display:flex;align-items:center;
      justify-content:center;flex-shrink:0">${esc((app.name||'?')[0].toUpperCase())}</div>`;
  }

  // ── SAML edit modal (for use within catalog) ───────────────────────────────
  function openSpModal(sp = null) {
    const isEdit = !!sp;
    const NAMEID_OPTIONS = [
      ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',    'Email Address'],
      ['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',      'Persistent'],
      ['urn:oasis:names:tc:SAML:2.0:nameid-format:transient',       'Transient'],
      ['urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',     'Unspecified'],
      ['urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName', 'X.509 Subject'],
    ];
    const curFormat = sp?.nameid_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
    const bd = openModal(`<div class="modal modal-saml-reg">
      <div class="modal-header"><h2>${isEdit ? 'Edit SAML Application' : 'Register SAML Application'}</h2></div>
      <div class="modal-body" style="max-height:78vh;overflow-y:auto;overflow-x:hidden">
        <div class="form-2col">
          ${spMetadataUploadHtml('csp')}
          <div class="form-group">
            <label class="form-label">Application Name <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="csp-name" value="${esc(sp?.name||'')}" placeholder="e.g. Zoho Mail">
          </div>
          <div class="form-group">
            <label class="form-label">Slug <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="csp-slug" value="${esc(sp?.slug||'')}"
              placeholder="e.g. zoho-mail" pattern="[a-z0-9-]+"
              ${isEdit ? 'readonly title="Slug cannot be changed after creation"' : ''}>
          </div>
          <div class="form-group span2">
            <label class="form-label">SP Entity ID <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="csp-entity" value="${esc(sp?.entity_id||'')}" placeholder="https://app.example.com/saml/metadata">
          </div>
          <div class="form-group span2">
            <label class="form-label">ACS URL <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="csp-acs" type="url" value="${esc(sp?.acs_url||'')}" placeholder="https://app.example.com/saml/acs">
          </div>
          <div class="form-group span2">
            <label class="form-label">SLO URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="csp-slo" type="url" value="${esc(sp?.slo_url||'')}" placeholder="https://app.example.com/saml/slo">
          </div>
          <div class="form-group span2">
            <label class="form-label">NameID Format</label>
            <select class="form-select" id="csp-nameid">
              ${NAMEID_OPTIONS.map(([v, l]) => `<option value="${esc(v)}" ${curFormat===v?'selected':''}>${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group span2">
            <label class="form-label">Icon URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="csp-icon" type="url" value="${esc(sp?.icon_url||'')}" placeholder="https://…/logo.png">
          </div>
        </div>
        <div id="csp-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="csp-save">${isEdit ? 'Save Changes' : 'Register'}</button>
        <button class="btn btn-secondary" id="csp-cancel">Cancel</button>
      </div>
    </div>`);

    bindSpMetadataUpload(bd, 'csp', { errId: 'csp-err', nameId: 'csp-name', slugId: 'csp-slug', isEdit });
    bd.querySelector('#csp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#csp-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#csp-save');
      const name     = bd.querySelector('#csp-name').value.trim();
      const slugRaw  = bd.querySelector('#csp-slug').value.trim();
      const slug     = isEdit ? slugRaw : slugRaw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      const entityId = bd.querySelector('#csp-entity').value.trim();
      const acsUrl   = bd.querySelector('#csp-acs').value.trim();
      const sloUrl   = bd.querySelector('#csp-slo').value.trim();
      const nameidFormat = bd.querySelector('#csp-nameid').value;
      const iconUrl  = bd.querySelector('#csp-icon').value.trim();

      if (!name)     { bd.querySelector('#csp-err').innerHTML = errHtml('Name is required.'); return; }
      if (!isEdit) {
        bd.querySelector('#csp-slug').value = slug;
        if (!slug) { bd.querySelector('#csp-err').innerHTML = errHtml('Slug is required (use lower-case letters, numbers, hyphen).'); return; }
      }
      if (!entityId) { bd.querySelector('#csp-err').innerHTML = errHtml('SP Entity ID is required.'); return; }
      if (!acsUrl)   { bd.querySelector('#csp-err').innerHTML = errHtml('ACS URL is required.'); return; }

      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Saving…' : 'Registering…';
      const data = { name, entityId, acsUrl, nameidFormat,
        sloUrl: sloUrl || undefined, iconUrl: iconUrl || undefined };
      if (!isEdit) data.slug = slug;

      try {
        if (isEdit) await api.updateSamlApp(sp.id, data);
        else        await api.createSamlApp(data);
        bd.remove();
        await loadApps();
      } catch (e) {
        const details = e?.body?.details;
        const detailMsg = Array.isArray(details)
          ? details.map((d) => d?.message).filter(Boolean).join('; ')
          : '';
        bd.querySelector('#csp-err').innerHTML = errHtml(detailMsg || e.message);
        saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Register';
      }
    });
  }

  // ── Render table ────────────────────────────────────────────────────────────
  function renderTable() {
    const q = searchQ.toLowerCase();
    const rows = allApps.filter(a =>
      (!q || (a.name||'').toLowerCase().includes(q) || (a.slug||'').toLowerCase().includes(q) || (a.category||'').toLowerCase().includes(q)) &&
      (!visFilter || a.visibility === visFilter) &&
      (showInactive || a.active)
    );

    if (!rows.length) {
      wrap.querySelector('#ac-list').innerHTML =
        `<div class="empty-state"><div class="empty-icon">▦</div>
         <p>${allApps.length ? 'No apps match the current filter.' : 'No applications registered yet.'}</p></div>`;
      return;
    }

    wrap.querySelector('#ac-list').innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Application</th><th>Type</th><th>Slug</th><th>Category</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${rows.map(a => {
              const typeBadge = a._type === 'SAML'
                ? '<span class="badge badge-info">SAML</span>'
                : a._type === 'OIDC'
                  ? '<span class="badge badge-purple">OIDC</span>'
                  : '<span class="badge badge-neutral">IGA</span>';
              return `<tr>
              <td>
                <div style="display:flex;align-items:center;gap:0.6rem">
                  ${appIcon(a)}
                  <span class="cell-strong">${esc(a.name)}</span>
                </div>
              </td>
              <td>${typeBadge}</td>
              <td><code style="font-size:0.78rem">${esc(a.slug||'—')}</code></td>
              <td class="muted" style="font-size:0.875rem">${esc(a.category || '—')}</td>
              <td>${a.active
                ? '<span class="badge badge-success">Active</span>'
                : '<span class="badge badge-neutral">Inactive</span>'}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-sm btn-secondary ac-edit"
                  data-id="${esc(String(a.id))}" data-type="${esc(a._type)}" title="Edit">✏️ Edit</button>
                <button class="btn btn-sm ${a.active?'btn-warning':'btn-success'} ac-toggle"
                  data-id="${esc(String(a.id))}" data-type="${esc(a._type)}" data-active="${a.active?'1':'0'}"
                  title="${a.active?'Deactivate':'Activate'}">${a.active?'Deactivate':'Activate'}</button>
                <button class="btn btn-sm btn-danger ac-del"
                  data-id="${esc(String(a.id))}" data-type="${esc(a._type)}" data-name="${esc(a.name)}" title="Delete">Delete</button>
              </td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    // Edit
    wrap.querySelectorAll('.ac-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const app = allApps.find(a => String(a.id) === btn.dataset.id && a._type === btn.dataset.type);
        if (!app) return;
        if (app._type === 'SAML') {
          openSpModal(app);
        } else if (app._type === 'OIDC') {
          alert('Edit OIDC apps in the OIDC / OAuth tab.');
        } else {
          openAppModal(app);
        }
      });
    });
    // Toggle active
    wrap.querySelectorAll('.ac-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active !== '1';
        if (!confirm(`${newActive?'Activate':'Deactivate'} this application?`)) return;
        try {
          if (btn.dataset.type === 'SAML') {
            await api.updateSamlApp(btn.dataset.id, { active: newActive });
          } else if (btn.dataset.type === 'OIDC') {
            await api.updateOidcClient(btn.dataset.id, { active: newActive });
          } else {
            await api.updateIgaApp(btn.dataset.id, { active: newActive });
          }
          await loadApps();
        } catch(e) { alert(e.message); }
      });
    });
    // Delete
    wrap.querySelectorAll('.ac-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Permanently delete "${btn.dataset.name}"?`)) return;
        btn.disabled = true; btn.textContent = 'Deleting…';
        try {
          if (btn.dataset.type === 'SAML') {
            await api.deactivateSamlApp(btn.dataset.id);
          } else if (btn.dataset.type === 'OIDC') {
            await api.deleteOidcClient(btn.dataset.id);
          } else {
            await api.deleteIgaApp(btn.dataset.id);
          }
          await loadApps();
        } catch(e) { alert(e.message); btn.disabled = false; btn.textContent = 'Delete'; }
      });
    });
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function loadApps() {
    wrap.querySelector('#ac-list').innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const [igaR, samlR, oidcR] = await Promise.all([
        api.igaApps().catch(() => ({ data: [] })),
        api.listSamlApps().catch(() => ({ data: [] })),
        api.listOidcClients().catch(() => ({ data: [] })),
      ]);
      const igaApps  = (igaR.data  || []).map(a => ({ ...a, _type: 'IGA'  }));
      const samlApps = (samlR.data || []).map(a => ({ ...a, _type: 'SAML', category: a.category || null, visibility: a.visibility || 'PUBLIC' }));
      const oidcApps = (oidcR.data || []).map(a => ({ ...a, _type: 'OIDC', category: a.category || null, visibility: a.visibility || 'PUBLIC', active: a.active !== undefined ? a.active : 1 }));
      allApps = [...igaApps, ...samlApps, ...oidcApps];
      renderTable();
    } catch(e) {
      wrap.querySelector('#ac-list').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    }
  }

  // ── Create / Edit modal ─────────────────────────────────────────────────────
  function openAppModal(app = null) {
    const isEdit = !!app;
    const bd = openModal(`<div class="modal" style="width:580px;max-width:96vw">
      <div class="modal-header"><h2>${isEdit ? 'Edit Application' : 'Register Application'}</h2></div>
      <div class="modal-body">
        <div class="form-2col">
          <div class="form-group">
            <label class="form-label">Application Name <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="ac-name" value="${esc(app?.name||'')}" placeholder="e.g. Slack">
          </div>
          <div class="form-group">
            <label class="form-label">Slug <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="ac-slug" value="${esc(app?.slug||'')}"
              placeholder="e.g. slack" pattern="[a-z0-9-]+"
              ${isEdit ? 'readonly title="Slug cannot be changed after creation"' : ''}>
          </div>
          <div class="form-group span2">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="ac-desc" rows="2">${esc(app?.description||'')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Category</label>
            <input class="form-input" id="ac-cat" value="${esc(app?.category||'')}" placeholder="e.g. Productivity">
          </div>
          <div class="form-group">
            <label class="form-label">Visibility</label>
            <select class="form-select" id="ac-vis-sel">
              <option value="PUBLIC"      ${(app?.visibility||'PUBLIC')==='PUBLIC'     ?'selected':''}>Public</option>
              <option value="RESTRICTED"  ${(app?.visibility)==='RESTRICTED'           ?'selected':''}>Restricted</option>
            </select>
          </div>
          <div class="form-group span2">
            <label class="form-label">Icon URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="ac-icon" value="${esc(app?.icon_url||'')}" type="url" placeholder="https://…/logo.png">
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
              <input type="checkbox" id="ac-sso" ${app?.sso_enabled||(!isEdit)?'checked':''}> SSO Enabled
            </label>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
              <input type="checkbox" id="ac-prov" ${app?.provisioning?'checked':''}> SCIM Provisioning
            </label>
          </div>
        </div>
        <div id="ac-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="ac-save">${isEdit?'Save Changes':'Register'}</button>
        <button class="btn btn-secondary" id="ac-cancel">Cancel</button>
      </div>
    </div>`);

    bd.querySelector('#ac-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#ac-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#ac-save');
      const name  = bd.querySelector('#ac-name').value.trim();
      const slug  = bd.querySelector('#ac-slug').value.trim();
      const desc  = bd.querySelector('#ac-desc').value.trim();
      const cat   = bd.querySelector('#ac-cat').value.trim();
      const vis   = bd.querySelector('#ac-vis-sel').value;
      const icon  = bd.querySelector('#ac-icon').value.trim();
      const sso   = bd.querySelector('#ac-sso').checked;
      const prov  = bd.querySelector('#ac-prov').checked;

      if (!name) { bd.querySelector('#ac-err').innerHTML = errHtml('Name is required.'); return; }
      if (!isEdit && !slug) { bd.querySelector('#ac-err').innerHTML = errHtml('Slug is required.'); return; }

      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Saving…' : 'Registering…';
      const data = { name, description: desc||undefined, category: cat||undefined,
        iconUrl: icon||undefined, visibility: vis, ssoEnabled: sso, provisioning: prov };
      if (!isEdit) data.slug = slug;

      try {
        if (isEdit) await api.updateIgaApp(app.id, data);
        else        await api.createIgaApp(data);
        bd.remove();
        await loadApps();
      } catch(e) {
        bd.querySelector('#ac-err').innerHTML = errHtml(e.message);
        saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Register';
      }
    });
  }

  // ── Wire filters + create button ────────────────────────────────────────────
  wrap.querySelector('#ac-new-btn').addEventListener('click', () => openAppModal());
  wrap.querySelector('#ac-search').addEventListener('input', (e) => { searchQ = e.target.value; renderTable(); });
  wrap.querySelector('#ac-vis').addEventListener('change', (e) => { visFilter = e.target.value; renderTable(); });
  wrap.querySelector('#ac-show-inactive').addEventListener('change', (e) => { showInactive = e.target.checked; renderTable(); });

  await loadApps();
}

/* ---------- SAML Applications (legacy CRUD) ---------- */
export async function viewSamlApps(me, content, opts = {}) {
  const embed = !!opts.embed;
  const isSuper = me.employee?.role === 'SUPER_ADMIN';

  const actionBtn = isSuper
    ? `<button class="btn btn-primary" id="sa-new-btn">+ Register SAML App</button>`
    : '';

  const wrap = el(`<div>
    ${embed
      ? (isSuper ? `<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">${actionBtn}</div>` : '')
      : header('SAML Applications', 'Service Providers registered with this Identity Provider', actionBtn)}
    <div id="sa-area"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`);
  content.replaceChildren(wrap);

  let resp, status;
  try {
    [resp, status] = await Promise.all([api.listSamlApps(), api.idpStatus().catch(() => ({}))]);
  } catch (err) {
    wrap.querySelector('#sa-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    return;
  }
  const apps = resp.data || [];

  const NAMEID_OPTIONS = [
    ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',       'Email Address'],
    ['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',         'Persistent'],
    ['urn:oasis:names:tc:SAML:2.0:nameid-format:transient',          'Transient'],
    ['urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',        'Unspecified'],
    ['urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName',    'X.509 Subject'],
  ];

  function openSpModal(sp = null) {
    const isEdit = !!sp;
    const curFormat = sp?.nameid_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
    const bd = openModal(`<div class="modal modal-saml-reg">
      <div class="modal-header"><h2>${isEdit ? 'Edit SAML Application' : 'Register SAML Application'}</h2></div>
      <div class="modal-body" style="max-height:78vh;overflow-y:auto;overflow-x:hidden">
        <div class="form-2col">
          ${spMetadataUploadHtml('sp')}
          <div class="form-group">
            <label class="form-label">Application Name <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="sp-name" value="${esc(sp?.name||'')}" placeholder="e.g. Zoho Mail">
          </div>
          <div class="form-group">
            <label class="form-label">Slug <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="sp-slug" value="${esc(sp?.slug||'')}"
              placeholder="e.g. zoho-mail" pattern="[a-z0-9-]+"
              ${isEdit ? 'readonly title="Slug cannot be changed after creation"' : ''}>
          </div>
          <div class="form-group span2">
            <label class="form-label">SP Entity ID <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="sp-entity" value="${esc(sp?.entity_id||'')}" placeholder="https://app.example.com/saml/metadata">
          </div>
          <div class="form-group span2">
            <label class="form-label">ACS URL <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="sp-acs" type="url" value="${esc(sp?.acs_url||'')}" placeholder="https://app.example.com/saml/acs">
          </div>
          <div class="form-group span2">
            <label class="form-label">SLO URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="sp-slo" type="url" value="${esc(sp?.slo_url||'')}" placeholder="https://app.example.com/saml/slo">
          </div>
          <div class="form-group span2">
            <label class="form-label">NameID Format</label>
            <select class="form-select" id="sp-nameid">
              ${NAMEID_OPTIONS.map(([v, l]) => `<option value="${esc(v)}" ${curFormat===v?'selected':''}>${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group span2">
            <label class="form-label">Icon URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="sp-icon" type="url" value="${esc(sp?.icon_url||'')}" placeholder="https://…/logo.png">
          </div>
        </div>
        <div id="sp-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="sp-save">${isEdit ? 'Save Changes' : 'Register'}</button>
        <button class="btn btn-secondary" id="sp-cancel">Cancel</button>
      </div>
    </div>`);

    bindSpMetadataUpload(bd, 'sp', { errId: 'sp-err', nameId: 'sp-name', slugId: 'sp-slug', isEdit });
    bd.querySelector('#sp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#sp-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#sp-save');
      const name     = bd.querySelector('#sp-name').value.trim();
      const slugRaw  = bd.querySelector('#sp-slug').value.trim();
      const slug     = isEdit ? slugRaw : slugRaw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      const entityId = bd.querySelector('#sp-entity').value.trim();
      const acsUrl   = bd.querySelector('#sp-acs').value.trim();
      const sloUrl   = bd.querySelector('#sp-slo').value.trim();
      const nameidFormat = bd.querySelector('#sp-nameid').value;
      const iconUrl  = bd.querySelector('#sp-icon').value.trim();

      if (!name)     { bd.querySelector('#sp-err').innerHTML = errHtml('Name is required.'); return; }
      if (!isEdit) {
        bd.querySelector('#sp-slug').value = slug;
        if (!slug) { bd.querySelector('#sp-err').innerHTML = errHtml('Slug is required (use lower-case letters, numbers, hyphen).'); return; }
      }
      if (!entityId) { bd.querySelector('#sp-err').innerHTML = errHtml('SP Entity ID is required.'); return; }
      if (!acsUrl)   { bd.querySelector('#sp-err').innerHTML = errHtml('ACS URL is required.'); return; }

      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Saving…' : 'Registering…';
      const data = { name, entityId, acsUrl, nameidFormat,
        sloUrl: sloUrl || undefined, iconUrl: iconUrl || undefined };
      if (!isEdit) data.slug = slug;

      try {
        if (isEdit) await api.updateSamlApp(sp.id, data);
        else        await api.createSamlApp(data);
        bd.remove();
        viewSamlApps(me, content, opts);
      } catch (e) {
        const details = e?.body?.details;
        const detailMsg = Array.isArray(details)
          ? details.map((d) => d?.message).filter(Boolean).join('; ')
          : '';
        bd.querySelector('#sp-err').innerHTML = errHtml(detailMsg || e.message);
        saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Register';
      }
    });
  }

  const tableBody = apps.length
    ? apps.map((sp) => `<tr>
        <td class="cell-strong">${esc(sp.name)}</td>
        <td><code style="font-size:0.78rem">${esc(sp.slug)}</code></td>
        <td class="truncate muted" style="font-size:0.85rem" title="${esc(sp.entity_id)}">${esc(sp.entity_id)}</td>
        <td class="truncate muted" style="font-size:0.85rem" title="${esc(sp.acs_url)}">${esc(sp.acs_url)}</td>
        <td>${sp.active
          ? '<span class="badge badge-success">Active</span>'
          : '<span class="badge badge-neutral">Disabled</span>'}</td>
        <td style="white-space:nowrap">${isSuper ? `
          <button class="btn btn-sm btn-secondary sp-edit" data-id="${esc(String(sp.id))}" title="Edit">✏️ Edit</button>
          <button class="btn btn-sm ${sp.active ? 'btn-warning' : 'btn-success'} sp-toggle"
            data-id="${esc(String(sp.id))}" data-active="${sp.active ? '1' : '0'}">${sp.active ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger sp-del"
            data-id="${esc(String(sp.id))}" data-name="${esc(sp.name)}">Delete</button>
        ` : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty-state"><span class="empty-icon">⛨</span>No SAML applications registered.</td></tr>`;

  wrap.querySelector('#sa-area').innerHTML = `
    ${status.metadataUrl ? `<div class="alert alert-info" style="margin-bottom:1.5rem">
      <div style="font-weight:500;margin-bottom:0.2rem">IdP metadata for SP onboarding</div>
      <a href="${esc(status.metadataUrl)}" target="_blank">${esc(status.metadataUrl)}</a>
    </div>` : ''}
    <div class="table-wrap">
      <div class="table-toolbar">
        <strong>Registered applications</strong>
        <span class="muted">${apps.length} total</span>
      </div>
      <table>
        <thead><tr>
          <th>Name</th><th>Slug</th><th>Entity ID</th><th>ACS URL</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>${tableBody}</tbody>
      </table>
    </div>`;

  // Wire edit buttons
  wrap.querySelectorAll('.sp-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sp = apps.find(a => String(a.id) === btn.dataset.id);
      if (sp) openSpModal(sp);
    });
  });

  // Wire enable/disable toggle buttons
  wrap.querySelectorAll('.sp-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newActive = btn.dataset.active !== '1';
      if (!confirm(`${newActive ? 'Enable' : 'Disable'} this application?`)) return;
      try {
        await api.updateSamlApp(btn.dataset.id, { active: newActive });
        viewSamlApps(me, content, opts);
      } catch (err) { alert(err.message); }
    });
  });

  // Wire delete buttons
  wrap.querySelectorAll('.sp-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Permanently delete "${btn.dataset.name}"?`)) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      try {
        await api.deactivateSamlApp(btn.dataset.id);
        viewSamlApps(me, content, opts);
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = 'Delete'; }
    });
  });

  // Wire register button
  if (isSuper) {
    wrap.querySelector('#sa-new-btn')?.addEventListener('click', () => openSpModal());
  }
}

/* ---------- Connectors ---------- */
export async function viewConnectors(content) {
  const wrap = el(`<div>${header('Connectors', 'Pluggable adapters to target systems (HRMS, AD, Google, Slack, AWS IAM, …)')}<div id="cn-list"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await api.igaConnectors();
    const rows = r.data || [];
    wrap.querySelector('#cn-list').innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Type</th><th>Direction</th><th>Sync mode</th><th>Status</th><th>Last sync</th></tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td class="cell-strong">${esc(c.name)}</td>
            <td><span class="badge badge-info">${esc(c.connector_type)}</span></td>
            <td>${esc(c.direction)}</td>
            <td>${esc(c.sync_mode)}</td>
            <td>${({CONFIGURED:'<span class="badge badge-neutral">Configured</span>',CONNECTED:'<span class="badge badge-success">Connected</span>',ERROR:'<span class="badge badge-danger">Error</span>',DISABLED:'<span class="badge badge-neutral">Disabled</span>'})[c.status] || esc(c.status)}</td>
            <td class="muted">${fmtDate(c.last_sync_at)}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">⇄</span>No connectors registered. Connector dispatcher ships in Phase 2.</div>`;
  } catch (err) {
    wrap.querySelector('#cn-list').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- Users ---------- */
export async function viewUsers(content) {
  const wrap = el(`<div>${header('Users', 'Employees synced from HRMS, plus local IdP administrators')}
    <div class="table-wrap" id="users-table">
      <div class="table-toolbar">
        <div class="search-input"><input id="user-search" type="search" placeholder="Search by name, email, employee ID…" /></div>
        <div style="display:flex;gap:0.5rem;align-items:center">
          <select id="state-filter" class="btn btn-secondary" style="padding:0.45rem 0.7rem">
            <option value="">All states</option><option value="ACTIVE">Active</option><option value="REACTIVATED">Reactivated</option>
            <option value="SUSPENDED_AUTO">Suspended (auto)</option><option value="PENDING_MGR">Pending manager</option>
            <option value="ESCALATED_HRBP">Escalated HRBP</option><option value="DEPARTED">Departed</option><option value="DEPROVISIONED">Deprovisioned</option>
          </select>
          <span id="users-count" class="muted"></span>
        </div>
      </div>
      <table><thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Type</th><th>State</th><th>Admin role</th><th>Last login</th></tr></thead>
        <tbody><tr><td colspan="7" class="loading-row"><span class="spinner"></span></td></tr></tbody></table>
    </div></div>`);
  content.replaceChildren(wrap);

  async function load(q = '', state = '') {
    try {
      const r = await api.listUsers(q, state);
      const rows = r.data || [];
      wrap.querySelector('tbody').innerHTML = rows.length
        ? rows.map((u) => `<tr>
          <td><div style="display:flex;align-items:center;gap:0.6rem">
            <span class="avatar" style="width:30px;height:30px;font-size:0.7rem">${esc(initials(u.full_name))}</span>
            <div><div class="cell-strong">${esc(u.full_name)}</div><div class="muted" style="font-size:0.75rem">${esc(u.emp_id)}</div></div>
          </div></td>
          <td>${esc(u.email_corp)}</td><td>${esc(u.dept_id || '—')}</td><td>${esc(u.employment_type || '—')}</td>
          <td>${ilgBadge(u.ilg_state)}</td>
          <td>${u.admin_role ? `<span class="badge badge-info">${esc(u.admin_role)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="muted">${fmtDate(u.last_login_at)}</td>
        </tr>`).join('')
        : `<tr><td colspan="7" class="empty-state"><span class="empty-icon">◍</span>No users found</td></tr>`;
      wrap.querySelector('#users-count').textContent = `${r.total} total`;
    } catch (err) {
      wrap.querySelector('tbody').innerHTML = `<tr><td colspan="7"><div class="alert alert-error">${esc(err.message)}</div></td></tr>`;
    }
  }
  let timer;
  const debounce = (fn) => (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), 250); };
  const search = wrap.querySelector('#user-search');
  const filter = wrap.querySelector('#state-filter');
  const reload = () => load(search.value, filter.value);
  search.addEventListener('input', debounce(reload));
  filter.addEventListener('change', reload);
  load();
}

/* ---------- Administrators ---------- */
export async function viewAdmins(content) {
  const wrap = el(`<div>${header('Administrators', 'Local accounts that can access this IdP console')}
    <details class="card" style="margin-bottom:1rem"><summary style="cursor:pointer;font-weight:600">Create local administrator</summary>
      <p class="subtitle" style="margin:0.5rem 0 1rem">Use sparingly. Prefer Google SSO for employees.</p>
      <div id="ca-error"></div>
      <form id="ca-form">
        <div class="grid-2">
          <div class="field"><label>Full name</label><input name="fullName" required /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password (min 10)</label><input name="password" type="password" minlength="10" required /></div>
          <div class="field"><label>Role</label><select name="role"><option value="ADMIN">ADMIN</option><option value="SUPER_ADMIN">SUPER_ADMIN</option></select></div>
        </div>
        <button type="submit" class="btn btn-primary">Create administrator</button>
      </form>
    </details>
    <div class="table-wrap"><div class="table-toolbar"><strong>Local administrators</strong></div>
      <table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody id="admins-tbody"><tr><td colspan="5" class="loading-row"><span class="spinner"></span></td></tr></tbody></table></div></div>`);
  content.replaceChildren(wrap);

  async function loadTable() {
    try {
      const r = await api.listLocalAdmins();
      const rows = r.data || [];
      wrap.querySelector('#admins-tbody').innerHTML = rows.length
        ? rows.map((a) => `<tr>
          <td class="cell-strong">${esc(a.email)}</td>
          <td><span class="badge badge-info">${esc(a.role)}</span></td>
          <td>${a.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td class="muted">${fmtDate(a.last_login_at)}</td>
          <td class="actions">${a.active ? `<button class="btn btn-sm btn-danger" data-id="${a.id}">Deactivate</button>` : ''}</td>
        </tr>`).join('')
        : `<tr><td colspan="5" class="empty-state">No local administrators</td></tr>`;
      wrap.querySelectorAll('[data-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this administrator?')) return;
          try { await api.deactivateAdmin(btn.dataset.id); loadTable(); }
          catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      wrap.querySelector('#admins-tbody').innerHTML = `<tr><td colspan="5"><div class="alert alert-error">${esc(err.message)}</div></td></tr>`;
    }
  }
  wrap.querySelector('#ca-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = wrap.querySelector('#ca-error');
    errEl.innerHTML = '';
    try {
      await api.createLocalAdmin(Object.fromEntries(new FormData(e.target)));
      errEl.innerHTML = `<div class="alert alert-success">Administrator created.</div>`;
      e.target.reset();
      loadTable();
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });
  loadTable();
}

/* ---------- Authentication ---------- */
export async function viewAuth(content) {
  const wrap = el(`<div>${header('Authentication', 'SAML Identity Provider and OIDC connection status')}<div id="auth-area"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  let s;
  try { s = await api.idpStatus(); }
  catch (err) { wrap.querySelector('#auth-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; return; }

  wrap.querySelector('#auth-area').innerHTML = `<div class="grid-3">
    <div class="card"><h2>SAML 2.0 Identity Provider</h2>
      <p class="subtitle" style="margin-bottom:1rem">Issues SAML assertions to registered Service Providers</p>
      <div class="kv-list">
        <div class="kv"><div class="k">Status</div><div class="v">${s.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
        <div class="kv"><div class="k">Public base URL</div><div class="v">${esc(s.publicBaseUrl || '—')}</div></div>
        <div class="kv"><div class="k">Entity ID</div><div class="v truncate" title="${esc(s.entityId || '')}">${esc(s.entityId || '—')}</div></div>
        <div class="kv"><div class="k">Metadata</div><div class="v">${s.metadataUrl ? `<a href="${esc(s.metadataUrl)}" target="_blank">Open</a>` : '—'}</div></div>
      </div>
      ${!s.samlEnabled ? `<div class="alert alert-warning" style="margin-top:1rem"><div>
        <div style="font-weight:500;margin-bottom:0.3rem">SAML keys missing</div>
        Run <code>bash scripts/gen-saml-dev-keys.sh</code>, paste <code>SAML_IDP_PRIVATE_KEY_PEM</code> and <code>SAML_IDP_CERT_PEM</code> into <code>.env</code>, then restart.</div></div>` : ''}
    </div>
    <div class="card"><h2>Inbound OIDC providers</h2>
      <p class="subtitle" style="margin-bottom:1rem">Federated login for end users</p>
      <div class="kv-list"><div class="kv"><div class="k">Google Workspace</div><div class="v"><a href="/auth/google">/auth/google</a></div></div></div>
      <p class="subtitle" style="margin-top:1rem">Configure <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_HOSTED_DOMAIN</code> in <code>.env</code>.</p>
      <p class="subtitle">Zoho Mail is consumed as a SAML application — see <a href="#" data-go="applications" data-tab="saml">SAML Applications</a>.</p>
    </div>
    <div class="card"><h2>Local password login</h2>
      <p class="subtitle" style="margin-bottom:1rem">Email + password administrators</p>
      <div class="kv-list">
        <div class="kv"><div class="k">Endpoint</div><div class="v"><code>POST /auth/local/login</code></div></div>
        <div class="kv"><div class="k">Master admin</div><div class="v">From <code>MASTER_ADMIN_EMAIL</code> in <code>.env</code></div></div>
      </div>
    </div></div>`;
  wrap.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = a.dataset.tab || null;
      window.LILG_NAV(a.dataset.go, tab ? { tab } : {});
    });
  });
}

/* ---------- Audit ---------- */
export async function viewAudit(content) {
  const wrap = el(`<div>${header('Audit Logs', 'SSO assertions and tamper-evident system audit trail')}
    <div class="tabs"><button class="tab active" data-tab="saml">SSO assertions</button><button class="tab" data-tab="system">System audit</button></div>
    <div id="aud"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  async function loadSaml() {
    const t = wrap.querySelector('#aud');
    t.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.samlAudit(); const rows = r.data || [];
      t.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th><th>Relay state</th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td class="muted">${fmtDate(r.ts)}</td>
              <td class="cell-strong">${esc(r.sp_name)}</td>
              <td>${esc(r.emp_name || r.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(r.emp_email || '')}</span></td>
              <td><span class="badge badge-info">${esc(r.binding)}</span></td>
              <td class="muted truncate" title="${esc(r.relay_state || '')}">${esc(r.relay_state || '—')}</td>
            </tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty-state"><span class="empty-icon">⌖</span>No SSO activity yet</div>`;
    } catch (err) {
      t.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }
  async function loadSystem() {
    const t = wrap.querySelector('#aud');
    t.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.systemAudit(); const rows = r.data || [];
      t.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>${rows.map((r) => `<tr><td class="muted">${fmtDate(r.ts)}</td><td class="cell-strong">${esc(r.actor)}</td><td><code>${esc(r.action)}</code></td><td>${esc(r.target)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty-state">No audit entries yet</div>`;
    } catch (err) { t.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  }
  wrap.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    if (tab.dataset.tab === 'saml') loadSaml(); else loadSystem();
  }));
  loadSaml();
}

/* ---------- Reviews / SoD / Risk / Reports ---------- */
async function simpleTable(content, title, subtitle, fetchFn, columns, render, emptyText, emptyIcon) {
  const wrap = el(`<div>${header(title, subtitle)}<div id="t-area"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await fetchFn(); const rows = r.data || [];
    const head = `<thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const body = rows.length
      ? rows.map((row) => `<tr>${render(row)}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="empty-state"><span class="empty-icon">${emptyIcon}</span>${esc(emptyText)}</td></tr>`;
    wrap.querySelector('#t-area').innerHTML = `<div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`;
  } catch (err) {
    wrap.querySelector('#t-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

export async function viewReviews(content) {
  const statusBadge = s => ({
    DRAFT:     '<span class="badge badge-neutral">Draft</span>',
    ACTIVE:    '<span class="badge badge-success">Active</span>',
    COMPLETED: '<span class="badge badge-info">Completed</span>',
    CANCELLED: '<span class="badge badge-danger">Cancelled</span>',
  })[s] || esc(s);

  content.replaceChildren(el(`<div>
    ${header('Access Reviews', 'Certification campaigns — managers and app owners certify or revoke access',
      `<button class="btn btn-primary" id="new-rev-btn">+ New Campaign</button>`)}
    <div id="rev-list"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`));
  const wrap = content.firstChild;
  const errEl = html => `<div class="alert alert-error">${esc(html)}</div>`;

  async function load() {
    try {
      const r = await api.igaReviews();
      const rows = r.data || [];
      if (!rows.length) {
        wrap.querySelector('#rev-list').innerHTML = `<div class="empty-state"><div class="empty-icon">✓</div><p>No campaigns yet. Click "+ New Campaign" to create the first certification campaign.</p></div>`;
        return;
      }
      wrap.querySelector('#rev-list').innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Scope</th><th>Reviewer</th><th>Period</th><th>Status</th><th>Items</th><th>Pending</th><th></th></tr></thead>
        <tbody>${rows.map(c => `<tr>
          <td class="cell-strong">${esc(c.name)}</td>
          <td class="muted">${esc(c.scope||'—')}</td>
          <td><span class="badge badge-neutral">${esc(c.reviewer_kind||'—')}</span></td>
          <td class="muted" style="font-size:0.8rem">${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}</td>
          <td>${statusBadge(c.status)}</td>
          <td>${c.item_count ?? 0}</td>
          <td>${c.pending_count > 0 ? `<span class="badge badge-warning">${c.pending_count}</span>` : (c.pending_count ?? 0)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary view-items-btn" data-id="${esc(String(c.id))}" data-name="${esc(c.name)}" data-status="${esc(c.status||'')}">View Items</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`;

      wrap.querySelectorAll('.view-items-btn').forEach(btn => {
        btn.addEventListener('click', () => openItemsModal(btn.dataset.id, btn.dataset.name));
      });
    } catch(e) { wrap.querySelector('#rev-list').innerHTML = errEl(e.message); }
  }

  async function openItemsModal(campaignId, campaignName) {
    const decBadge = d => ({
      PENDING:  '<span class="badge badge-warning">Pending</span>',
      CERTIFY:  '<span class="badge badge-success">Certified</span>',
      REVOKE:   '<span class="badge badge-danger">Revoked</span>',
      EXCEPTION:'<span class="badge badge-info">Exception</span>',
    })[d] || `<span class="badge badge-neutral">${esc(d||'—')}</span>`;

    const bd = el(`<div class="modal-backdrop"><div class="modal" style="max-width:860px;width:95vw">
      <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">Items — ${esc(campaignName)}</h2>
        <button class="btn btn-sm btn-secondary" id="items-close">✕</button>
      </div>
      <div class="modal-body" id="items-body"><div class="loading-row"><span class="spinner"></span></div></div>
    </div></div>`);
    document.body.appendChild(bd);
    bd.querySelector('#items-close').addEventListener('click', () => bd.remove());
    bd.addEventListener('click', e => { if (e.target === bd) bd.remove(); });

    try {
      const r = await api.igaReviewItems(campaignId);
      const rows = r.data || [];
      if (!rows.length) {
        bd.querySelector('#items-body').innerHTML = `<div class="empty-state"><p>No items in this campaign yet.</p></div>`;
        return;
      }
      const pending = rows.filter(r => r.decision === 'PENDING');
      const decided = rows.filter(r => r.decision !== 'PENDING');
      bd.querySelector('#items-body').innerHTML = `
        <div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap">
          <span class="badge badge-warning">${pending.length} pending</span>
          <span class="badge badge-success">${rows.filter(r=>r.decision==='CERTIFY').length} certified</span>
          <span class="badge badge-danger">${rows.filter(r=>r.decision==='REVOKE').length} revoked</span>
        </div>
        <div id="items-msg" style="margin-bottom:0.75rem"></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Subject</th><th>Access Item</th><th>Reviewer</th><th>Decision</th><th>Actions</th></tr></thead>
          <tbody id="items-tbody">${rows.map(i => `<tr data-iid="${esc(String(i.id))}">
            <td class="cell-strong">${esc(i.subject_name||i.emp_id||'—')}<br><span class="muted" style="font-size:0.75rem">${esc(i.subject_email||'')}</span></td>
            <td>${esc(i.entitlement_name||i.role_name||'—')}</td>
            <td class="muted" style="font-size:0.85rem">${esc(i.reviewer_name||i.reviewer_emp_id||'—')}</td>
            <td>${decBadge(i.decision)}</td>
            <td style="white-space:nowrap">${i.decision === 'PENDING' ? `
              <button class="btn btn-sm btn-success item-certify" data-iid="${esc(String(i.id))}">✓</button>
              <button class="btn btn-sm btn-danger item-revoke" style="margin-left:0.25rem" data-iid="${esc(String(i.id))}">✗</button>
            ` : `<span class="muted" style="font-size:0.8rem">${fmtDate(i.decided_at)||'—'}</span>`}</td>
          </tr>`).join('')}</tbody></table></div>`;

      async function decide(itemId, decision) {
        try {
          await api.submitReviewDecision(campaignId, itemId, decision);
          bd.querySelector('#items-msg').innerHTML = `<div class="alert alert-success">Decision recorded.</div>`;
          const row = bd.querySelector(`tr[data-iid="${itemId}"]`);
          if (row) {
            row.querySelector('td:nth-child(4)').innerHTML = decBadge(decision);
            row.querySelector('td:nth-child(5)').innerHTML = `<span class="muted" style="font-size:0.8rem">Just now</span>`;
          }
        } catch(e) { bd.querySelector('#items-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
      }
      bd.querySelectorAll('.item-certify').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.iid, 'CERTIFY')));
      bd.querySelectorAll('.item-revoke').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.iid, 'REVOKE')));
    } catch(e) { bd.querySelector('#items-body').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
  }

  wrap.querySelector('#new-rev-btn').addEventListener('click', () => {
    const today = new Date().toISOString().slice(0,10);
    const end = new Date(); end.setMonth(end.getMonth()+1);
    const endStr = end.toISOString().slice(0,10);
    const bd = el(`<div class="modal-backdrop"><div class="modal">
      <div class="modal-header"><h2>New Certification Campaign</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Campaign Name</label><input class="form-input" id="nrc-name" placeholder="Q2 2026 Access Review"></div>
        <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="nrc-desc" rows="2"></textarea></div>
        <div class="form-group"><label class="form-label">Scope</label><select class="form-select" id="nrc-scope">
          <option value="ALL_USERS">All Users</option>
          <option value="HIGH_RISK">High Risk Users</option>
          <option value="APP_SPECIFIC">App Specific</option>
          <option value="ROLE_SPECIFIC">Role Specific</option>
        </select></div>
        <div class="form-group"><label class="form-label">Reviewer Kind</label><select class="form-select" id="nrc-rev">
          <option value="MANAGER">Manager</option>
          <option value="APP_OWNER">App Owner</option>
          <option value="ROLE_OWNER">Role Owner</option>
        </select></div>
        <div class="form-group" style="display:flex;gap:0.75rem">
          <div style="flex:1"><label class="form-label">Start Date</label><input class="form-input" id="nrc-start" type="date" value="${today}"></div>
          <div style="flex:1"><label class="form-label">End Date</label><input class="form-input" id="nrc-end" type="date" value="${endStr}"></div>
        </div>
        <div id="nrc-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="nrc-save">Create Campaign</button>
        <button class="btn btn-secondary" id="nrc-cancel">Cancel</button>
      </div>
    </div></div>`);
    document.body.appendChild(bd);
    bd.querySelector('#nrc-cancel').addEventListener('click', () => bd.remove());
    bd.addEventListener('click', e => { if (e.target === bd) bd.remove(); });
    bd.querySelector('#nrc-save').addEventListener('click', async () => {
      const data = {
        name:        bd.querySelector('#nrc-name').value.trim(),
        description: bd.querySelector('#nrc-desc').value,
        scope:       bd.querySelector('#nrc-scope').value,
        reviewerKind: bd.querySelector('#nrc-rev').value,
        startDate:   bd.querySelector('#nrc-start').value,
        endDate:     bd.querySelector('#nrc-end').value,
      };
      if (!data.name) { bd.querySelector('#nrc-err').innerHTML = `<div class="alert alert-error">Name required</div>`; return; }
      const btn = bd.querySelector('#nrc-save');
      btn.disabled = true; btn.textContent = 'Creating…';
      try { await api.createAccessReview(data); bd.remove(); await load(); }
      catch(e) { bd.querySelector('#nrc-err').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; btn.disabled=false; btn.textContent='Create Campaign'; }
    });
  });

  await load();
}

export async function viewSod(content) {
  const sevBadge = s => ({
    LOW:      '<span class="badge badge-neutral">Low</span>',
    MEDIUM:   '<span class="badge badge-info">Medium</span>',
    HIGH:     '<span class="badge badge-warning">High</span>',
    CRITICAL: '<span class="badge badge-danger">Critical</span>',
  })[s] || esc(s||'—');

  content.replaceChildren(el(`<div>
    ${header('Segregation of Duties', 'Toxic combinations and policy violations', `<button class="btn btn-primary" id="new-sod-btn">+ New Policy</button>`)}
    <h3 class="section-title">Open violations</h3>
    <div id="sod-msg" style="margin-bottom:0.75rem"></div>
    <div id="sod-v"><div class="loading-row"><span class="spinner"></span></div></div>
    <h3 class="section-title" style="margin-top:1.5rem">Policies</h3>
    <div id="sod-p"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`));
  const wrap = content.firstChild;

  async function loadViolations() {
    try {
      const v = await api.igaSodViolations();
      const rows = v.data || [];
      if (!rows.length) {
        wrap.querySelector('#sod-v').innerHTML = `<div class="card empty-state"><span class="empty-icon">✓</span>No open violations — all identities are compliant.</div>`;
        return;
      }
      wrap.querySelector('#sod-v').innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Severity</th><th>Policy</th><th>Employee</th><th>Detected</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-vid="${esc(String(r.id))}">
          <td>${sevBadge(r.severity)}</td>
          <td class="cell-strong">${esc(r.policy_name||'—')}</td>
          <td>${esc(r.emp_name || r.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(r.email_corp || '')}</span></td>
          <td class="muted">${fmtDate(r.detected_at)}</td>
          <td><button class="btn btn-sm btn-warning remediate-btn" data-vid="${esc(String(r.id))}">Remediate</button></td>
        </tr>`).join('')}</tbody></table></div>`;

      wrap.querySelectorAll('.remediate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Mark this violation as remediated/resolved?')) return;
          btn.disabled = true; btn.textContent = 'Remediating…';
          try {
            await api.igaRemediateSod(btn.dataset.vid);
            wrap.querySelector('#sod-msg').innerHTML = `<div class="alert alert-success">Violation resolved.</div>`;
            await loadViolations();
          } catch(e) {
            wrap.querySelector('#sod-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
            btn.disabled = false; btn.textContent = 'Remediate';
          }
        });
      });
    } catch(err) { wrap.querySelector('#sod-v').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  }

  async function loadPolicies() {
    try {
      const p = await api.igaSodPolicies();
      const rows = p.data || [];
      if (!rows.length) {
        wrap.querySelector('#sod-p').innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><p>No SoD policies defined. Click "+ New Policy" to create one.</p></div>`;
        return;
      }
      wrap.querySelector('#sod-p').innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Severity</th><th>Enforcement</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="cell-strong">${esc(r.name)}</td>
          <td>${sevBadge(r.severity)}</td>
          <td><span class="badge badge-neutral">${esc(r.enforcement||'—')}</span></td>
          <td>${r.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary toggle-pol" data-id="${esc(String(r.id))}" data-active="${r.active?'1':'0'}">${r.active ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-sm btn-danger del-pol" style="margin-left:0.25rem" data-id="${esc(String(r.id))}">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`;

      wrap.querySelectorAll('.toggle-pol').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active === '1' ? 0 : 1;
          try { await api.updateSodPolicy(btn.dataset.id, { active: newActive }); await loadPolicies(); }
          catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.del-pol').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this SoD policy?')) return;
          try { await api.deleteSodPolicy(btn.dataset.id); await loadPolicies(); }
          catch(e) { alert(e.message); }
        });
      });
    } catch(err) { wrap.querySelector('#sod-p').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  }

  wrap.querySelector('#new-sod-btn').addEventListener('click', () => {
    const bd = el(`<div class="modal-backdrop"><div class="modal">
      <div class="modal-header"><h2>New SoD Policy</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Policy Name</label><input class="form-input" id="sp-name" placeholder="Finance + IT Admin conflict"></div>
        <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="sp-desc" rows="2"></textarea></div>
        <div class="form-group"><label class="form-label">Severity</label><select class="form-select" id="sp-sev">
          <option value="LOW">Low</option><option value="MEDIUM">Medium</option>
          <option value="HIGH" selected>High</option><option value="CRITICAL">Critical</option>
        </select></div>
        <div class="form-group"><label class="form-label">Enforcement</label><select class="form-select" id="sp-enf">
          <option value="ADVISORY">Advisory (warn only)</option>
          <option value="BLOCKING">Blocking (prevent grant)</option>
        </select></div>
        <div class="form-group"><label class="form-label">Conflict Groups (JSON)</label>
          <textarea class="form-textarea" id="sp-groups" rows="4" placeholder='[["entitlement-id-1","entitlement-id-2"],["role-id-a","role-id-b"]]'></textarea>
          <p class="muted" style="font-size:0.78rem;margin-top:0.25rem">Array of pairs — each pair is a set of entitlement/role IDs that conflict with each other.</p>
        </div>
        <div id="sp-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="sp-save">Create Policy</button>
        <button class="btn btn-secondary" id="sp-cancel">Cancel</button>
      </div>
    </div></div>`);
    document.body.appendChild(bd);
    bd.querySelector('#sp-cancel').addEventListener('click', () => bd.remove());
    bd.addEventListener('click', e => { if (e.target === bd) bd.remove(); });
    bd.querySelector('#sp-save').addEventListener('click', async () => {
      let conflictGroups;
      try { conflictGroups = JSON.parse(bd.querySelector('#sp-groups').value || '[]'); }
      catch { bd.querySelector('#sp-err').innerHTML = `<div class="alert alert-error">Conflict Groups must be valid JSON</div>`; return; }
      const data = {
        name:          bd.querySelector('#sp-name').value.trim(),
        description:   bd.querySelector('#sp-desc').value,
        severity:      bd.querySelector('#sp-sev').value,
        enforcement:   bd.querySelector('#sp-enf').value,
        conflictGroups,
      };
      if (!data.name) { bd.querySelector('#sp-err').innerHTML = `<div class="alert alert-error">Name required</div>`; return; }
      const btn = bd.querySelector('#sp-save');
      btn.disabled = true; btn.textContent = 'Creating…';
      try { await api.createSodPolicy(data); bd.remove(); await loadPolicies(); }
      catch(e) { bd.querySelector('#sp-err').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; btn.disabled=false; btn.textContent='Create Policy'; }
    });
  });

  loadViolations();
  loadPolicies();
}

export async function viewRisk(content) {
  const wrap = el(`<div>${header('Risk Dashboard', 'Login risk events and identities scoring above threshold')}<div id="rk"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await api.igaRisk();
    wrap.querySelector('#rk').innerHTML = `
      <section class="stat-grid">
        ${statCard('alert',       'Identities at risk',     (r.topRisk || []).length,                'score ≥ 50', 'warning')}
        ${statCard('shieldCheck', 'MFA challenged (24h)',   r.counters?.mfaChallengeLast24h ?? 0,    '',           'info')}
        ${statCard('lock',        'Logins denied (24h)',    r.counters?.deniedLast24h ?? 0,          '',           'danger')}
      </section>
      <h3 class="section-title">High-risk identities</h3>
      ${(r.topRisk || []).length
        ? `<div class="table-wrap"><table><thead><tr><th>Identity</th><th>Email</th><th>Score</th><th>Last evaluated</th></tr></thead>
            <tbody>${r.topRisk.map((u) => `<tr>
              <td class="cell-strong">${esc(u.full_name || u.emp_id)}</td>
              <td>${esc(u.email_corp || '')}</td>
              <td><span class="badge ${u.score >= 80 ? 'badge-danger' : (u.score >= 60 ? 'badge-warning' : 'badge-info')}">${u.score}</span></td>
              <td class="muted">${fmtDate(u.updated_at)}</td>
            </tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty-state"><span class="empty-icon">◆</span>No risk scores computed yet. Risk engine runs in Phase 3.</div>`}`;
  } catch (err) { wrap.querySelector('#rk').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
}

export async function viewReports(content) {
  await simpleTable(
    content, 'Compliance Reports', 'SOX, GDPR, HIPAA evidence — generated snapshots',
    () => api.igaReports(),
    ['Name', 'Framework', 'Period', 'Generated', 'Artifact'],
    (r) => `<td class="cell-strong">${esc(r.name)}</td>
      <td><span class="badge badge-info">${esc(r.framework || '—')}</span></td>
      <td class="muted">${esc(r.period || '—')}</td>
      <td class="muted">${r.generated_at ? fmtDate(r.generated_at) : '—'}</td>
      <td>${r.artifact_url ? `<a href="${esc(r.artifact_url)}" target="_blank" class="btn btn-sm btn-secondary">Download</a>` : '—'}</td>`,
  );
}
