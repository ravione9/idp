/* Admin views: Dashboard, SAML apps, App catalog, Connectors, Users, Admins,
   Reviews, SoD, Risk, Authentication, Audit, Reports. */
import { api } from './api-admin.js';
import { el, esc, fmtDate, fmtShortDate, ilgBadge, initials, build30DaySeries, renderLineChart, renderDonut, persistSearch, syncAppUrl, isPortalSuperAdmin } from './ui.js';
import { icon as svgIcon } from './icons.js';
import { viewOidcApps, viewPrebuiltApps, viewAppDiscovery, viewSsoReports } from './views-stubs.js';

// Shared helpers (mirrors views-stubs.js — not yet in a shared module)
function openModal(html) {
  const bd = el(`<div class="modal-backdrop">${html}</div>`);
  // Do not close on backdrop click — only Cancel / Close / explicit actions dismiss.
  document.body.appendChild(bd);
  return bd;
}
function errHtml(msg) { return `<div class="alert alert-error">${esc(msg)}</div>`; }

let _samlAttrFieldsCache = null;
async function loadSamlAttributeFields() {
  if (_samlAttrFieldsCache) return _samlAttrFieldsCache;
  try {
    const res = await api.samlAttributeFields();
    _samlAttrFieldsCache = {
      fields: res.fields || [],
      defaultAttributeMap: res.defaultAttributeMap || {},
    };
  } catch {
    _samlAttrFieldsCache = {
      fields: [
        { field: 'email_corp', label: 'Corporate email' },
        { field: 'full_name', label: 'Full name' },
        { field: 'emp_id', label: 'Employee ID (emp_id)' },
        { field: 'dept_id', label: 'Department' },
        { field: 'role', label: 'Title / designation' },
      ],
      defaultAttributeMap: {},
    };
  }
  return _samlAttrFieldsCache;
}

function empFieldOptionsHtml(fields, selected) {
  return fields.map((f) =>
    `<option value="${esc(f.field)}" ${selected === f.field ? 'selected' : ''}>${esc(f.label)}</option>`,
  ).join('');
}

function samlAttrMapRowsFromSp(sp, defaults) {
  const map = sp?.attribute_map && typeof sp.attribute_map === 'object' && Object.keys(sp.attribute_map).length
    ? sp.attribute_map
    : (defaults || {});
  const entries = Object.entries(map);
  return entries.length ? entries : [['', 'email_corp']];
}

function samlAttrMapEditorHtml(pfx, rows, fields) {
  const fieldOpts = empFieldOptionsHtml(fields, '');
  const body = rows.map(([samlName, empField], i) => `
    <div class="saml-attr-row" data-i="${i}" style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center">
      <input class="form-input saml-attr-name" placeholder="SAML attribute (e.g. mail)" value="${esc(samlName || '')}">
      <select class="form-select saml-attr-field">${empFieldOptionsHtml(fields, empField || 'email_corp')}</select>
      <button type="button" class="btn btn-secondary btn-sm saml-attr-del" title="Remove">✕</button>
    </div>`).join('');
  return `
    <div class="form-group span2 saml-attr-editor">
      <label class="form-label">Attribute mapping</label>
      <p class="muted" style="font-size:0.82rem;margin:0 0 8px">
        Map assertion attributes to IdP employee fields. Leave empty rows out — defaults merge unless disabled below.
      </p>
      <div id="${pfx}-attr-rows">${body}</div>
      <button type="button" class="btn btn-secondary btn-sm" id="${pfx}-attr-add">+ Add attribute</button>
      <template id="${pfx}-attr-tpl">
        <div class="saml-attr-row" style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center">
          <input class="form-input saml-attr-name" placeholder="SAML attribute (e.g. mail)" value="">
          <select class="form-select saml-attr-field">${fieldOpts.replace('selected', '')}</select>
          <button type="button" class="btn btn-secondary btn-sm saml-attr-del" title="Remove">✕</button>
        </div>
      </template>
    </div>`;
}

function samlSigningHtml(pfx, sp) {
  const signA = sp?.sign_assertions !== false && sp?.sign_assertions !== 0;
  const signR = sp?.sign_response !== false && sp?.sign_response !== 0;
  const mergeD = sp?.merge_default_attrs !== false && sp?.merge_default_attrs !== 0;
  return `
    <div class="form-group span2">
      <label class="form-label">Signed response</label>
      <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.9rem">
          <input type="checkbox" id="${pfx}-sign-assert" ${signA ? 'checked' : ''}> Sign Assertion
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.9rem">
          <input type="checkbox" id="${pfx}-sign-resp" ${signR ? 'checked' : ''}> Sign Response
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.9rem">
          <input type="checkbox" id="${pfx}-merge-defaults" ${mergeD ? 'checked' : ''}> Merge default attributes
        </label>
      </div>
      <p class="muted" style="font-size:0.78rem;margin:6px 0 0">
        Enterprise SPs (e.g. SentinelOne) typically need both signatures. At least Assertion signing is enforced.
      </p>
    </div>`;
}

function bindSamlAttrEditor(bd, pfx) {
  const rowsEl = bd.querySelector(`#${pfx}-attr-rows`);
  const tpl = bd.querySelector(`#${pfx}-attr-tpl`);
  bd.querySelector(`#${pfx}-attr-add`)?.addEventListener('click', () => {
    if (!tpl || !rowsEl) return;
    rowsEl.appendChild(tpl.content.cloneNode(true));
  });
  rowsEl?.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('.saml-attr-del');
    if (!btn) return;
    const row = btn.closest('.saml-attr-row');
    if (row && rowsEl.querySelectorAll('.saml-attr-row').length > 1) row.remove();
    else if (row) {
      row.querySelector('.saml-attr-name').value = '';
    }
  });
}

function collectSamlAttrMap(bd, pfx) {
  const map = {};
  bd.querySelectorAll(`#${pfx}-attr-rows .saml-attr-row`).forEach((row) => {
    const name = row.querySelector('.saml-attr-name')?.value?.trim();
    const field = row.querySelector('.saml-attr-field')?.value?.trim();
    if (name && field) map[name] = field;
  });
  return map;
}

function samlRedirectUrlFieldHtml(pfx, value) {
  return `
          <div class="form-group span2">
            <label class="form-label">Default redirect URL (RelayState) <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="${pfx}-relay" type="url" value="${esc(value || '')}"
              placeholder="https://app.example.com/home">
            <p class="muted" style="font-size:0.78rem;margin-top:0.35rem">
              Sent as SAML <code>RelayState</code> when users launch from the portal. Use the post-login landing page URL your vendor provides (e.g. Autodesk deep link).
            </p>
          </div>`;
}

function collectSamlSpExtras(bd, pfx) {
  return {
    attributeMap: collectSamlAttrMap(bd, pfx),
    nameidAttribute: bd.querySelector(`#${pfx}-nameid-attr`)?.value || 'email_corp',
    signAssertions: !!bd.querySelector(`#${pfx}-sign-assert`)?.checked,
    signResponse: !!bd.querySelector(`#${pfx}-sign-resp`)?.checked,
    mergeDefaultAttrs: !!bd.querySelector(`#${pfx}-merge-defaults`)?.checked,
  };
}

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
        <p class="muted" style="font-size:0.72rem;margin:0.35rem 0 0">Must be SP SAML metadata (<code>EntityDescriptor</code>). Not a license key or IdP certificate.</p>
        <button type="button" class="btn btn-secondary btn-sm" id="${pfx}-meta-parse" style="margin-top:0.5rem">Parse metadata &amp; fill fields</button>
        <div id="${pfx}-meta-err" style="margin-top:0.5rem"></div>
      </div>
    </div>
    <hr class="span2" style="border:none;border-top:1px solid var(--border);margin:0.15rem 0 0.35rem">
    <p class="saml-reg-section-title span2">Application details</p>`;
}

function bindSpMetadataUpload(bd, pfx, { errId, nameId, slugId, isEdit }) {
  const errEl = bd.querySelector(`#${errId}`);
  const metaErrEl = bd.querySelector(`#${pfx}-meta-err`);
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

  function showParseMsg(html, ok = false) {
    const box = metaErrEl || errEl;
    if (!box) return;
    box.innerHTML = ok
      ? `<div class="alert alert-success">${html}</div>`
      : errHtml(html);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    showParseMsg('Metadata parsed — review the fields below, then save.', true);
  }

  async function doParse(xml) {
    const trimmed = (xml || '').trim();
    if (!trimmed) {
      showParseMsg('Paste or upload SP metadata XML first.');
      return;
    }
    parseBtn.disabled = true;
    parseBtn.textContent = 'Parsing…';
    try {
      const r = await parseSamlMetadataClient(trimmed);
      applyParsed(r.data || r);
    } catch (e) {
      showParseMsg(e.message || 'Could not parse metadata.');
    }
    parseBtn.disabled = false;
    parseBtn.textContent = 'Parse metadata & fill fields';
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
      showParseMsg('Could not read file: ' + e.message);
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
  return `<div class="page-header page-header--compact">
    <div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>
    ${action ? `<div class="page-header-actions">${action}</div>` : ''}
  </div>`;
}

function statCard(iconName, label, value, sub = '', cls = 'primary', navKey = '', navTab = '') {
  const clickable = navKey
    ? ` stat-card-action" data-nav="${esc(navKey)}"${navTab ? ` data-tab="${esc(navTab)}"` : ''} role="link" tabindex="0" title="Open ${esc(label)}`
    : '';
  return `<div class="stat-card${clickable}">
    <div class="stat-icon ${cls}">${svgIcon(iconName)}</div>
    <div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>
  </div>`;
}

function bindStatCardNav(root) {
  root.querySelectorAll('.stat-card-action[data-nav]').forEach((card) => {
    const go = () => {
      if (!window.LILG_NAV) return;
      const tab = card.dataset.tab;
      window.LILG_NAV(card.dataset.nav, tab ? { tab } : {});
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
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

  const wrap = el(`<div class="ent-page">
    ${header('Dashboard', 'Overview of your identity and access management deployment')}

    <section class="stat-grid">
      ${statCard('users',       'Total users',       c.employees,                            `${c.activeEmployees} active`,    'primary', 'users')}
      ${statCard('saml',        'SAML apps',         c.activeSamlApps,                       `${c.samlApps} registered`,       'accent',  'applications', 'saml')}
      ${statCard('oidc',        'OIDC / OAuth apps', c.activeOidcClients ?? 0,               `${c.oidcClients ?? 0} registered`, 'purple', 'applications', 'oidc')}
      ${statCard('activity',    'Active sessions',   c.activeSessions,                       'across all users',               'success')}
      ${statCard('key',         'SSO logins (24h)',  c.assertions24h,                        `${c.assertions7d} in 7 days`,    'info',    'audit')}
      ${statCard('check',       'Pending tasks',     c.pendingApprovals + c.pendingReviews,  `${c.pendingApprovals} approvals · ${c.pendingReviews} reviews`, 'warning', 'tasks')}
      ${statCard('alert',       'SoD violations',    c.openSodViolations,                    'open',                           'danger',  'sod')}
      ${statCard('shieldCheck', 'MFA enrolled',      c.mfaEnrolled,                          'admins',                         'purple',  'mfaMethods')}
      ${statCard('userShield',  'Local admins',      c.localAdmins,                          'console accounts',               'teal',    'admins')}
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

    <div class="grid-main-side">
      <div class="card">
        <h2>Recent SSO activity</h2>
        <p class="subtitle" style="margin-bottom:0.75rem">Latest SAML assertions issued by the IdP</p>
        ${recent ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th></tr></thead><tbody>${recent}</tbody></table></div>` : `<div class="empty-state"><span class="empty-icon">⌖</span>No SSO assertions yet</div>`}
      </div>
      <div class="card">
        <h2>Top apps (7 days)</h2>
        ${topApps ? `<div class="table-wrap"><table><thead><tr><th>App</th><th>Slug</th><th>Logins</th></tr></thead><tbody>${topApps}</tbody></table></div>` : `<div class="empty-state">No data yet</div>`}
      </div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h2>System status</h2>
      <div class="kv-list" style="margin-top:0.75rem">
        <div class="kv"><div class="k">SAML IdP</div><div class="v">${sys.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
        <div class="kv"><div class="k">Public base URL</div><div class="v truncate" title="${esc(sys.publicBaseUrl || '')}">${esc(sys.publicBaseUrl || '—')}</div></div>
        <div class="kv"><div class="k">Metadata</div><div class="v">${sys.metadataUrl ? `<a href="${esc(sys.metadataUrl)}" target="_blank">Open</a>` : '—'}</div></div>
        <div class="kv"><div class="k">Google OIDC</div><div class="v">${sys.googleConfigured ? '<span class="badge badge-success">Configured</span>' : '<span class="badge badge-neutral">Not configured</span>'}</div></div>
        <div class="kv"><div class="k">Zoho Mail SAML</div><div class="v">${sys.zohoSamlConfigured ? '<span class="badge badge-success">Registered</span>' : '<span class="badge badge-neutral">Not registered</span>'}</div></div>
      </div>
    </div>
  </div>`);
  bindStatCardNav(wrap);
  content.replaceChildren(wrap);
}

/* ---------- Applications (unified: Catalog + SAML + OIDC) ---------- */
export async function viewApplications(me, content, initialTab = 'catalog') {
  const tabs = [
    { id: 'catalog',   label: 'Application Catalog' },
    { id: 'saml',      label: 'SAML Applications' },
    { id: 'oidc',      label: 'OIDC / OAuth' },
    { id: 'prebuilt',  label: 'Pre-built Integrations' },
    { id: 'discovery', label: 'App Discovery' },
  ];
  const validTab = tabs.some((t) => t.id === initialTab) ? initialTab : 'catalog';

  const wrap = el(`<div>
    ${header('Applications', 'Catalog, SAML, and OIDC / OAuth app integrations')}
    <div class="inline-tabs" id="apps-tabs">
      ${tabs.map((t) => `<button type="button" class="inline-tab${t.id === validTab ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="apps-panel-catalog"></div>
    <div id="apps-panel-saml" hidden></div>
    <div id="apps-panel-oidc" hidden></div>
    <div id="apps-panel-prebuilt" hidden></div>
    <div id="apps-panel-discovery" hidden></div>
  </div>`);
  content.replaceChildren(wrap);

  const panels = {
    catalog:   wrap.querySelector('#apps-panel-catalog'),
    saml:      wrap.querySelector('#apps-panel-saml'),
    oidc:      wrap.querySelector('#apps-panel-oidc'),
    prebuilt:  wrap.querySelector('#apps-panel-prebuilt'),
    discovery: wrap.querySelector('#apps-panel-discovery'),
  };

  async function showTab(tabId) {
    wrap.querySelectorAll('#apps-tabs .inline-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    for (const [id, panel] of Object.entries(panels)) {
      panel.hidden = id !== tabId;
    }

    syncAppUrl('applications', tabId, 'catalog');

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
    } else if (tabId === 'discovery' && !panels.discovery.dataset.loaded) {
      panels.discovery.dataset.loaded = '1';
      await viewAppDiscovery(panels.discovery, { embed: true });
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
  async function openSpModal(sp = null) {
    const isEdit = !!sp;
    const NAMEID_OPTIONS = [
      ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',    'Email Address'],
      ['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',      'Persistent'],
      ['urn:oasis:names:tc:SAML:2.0:nameid-format:transient',       'Transient'],
      ['urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',     'Unspecified'],
      ['urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName', 'X.509 Subject'],
    ];
    const { fields, defaultAttributeMap } = await loadSamlAttributeFields();
    const curFormat = sp?.nameid_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
    const curNameidAttr = sp?.nameid_attribute || 'email_corp';
    const attrRows = samlAttrMapRowsFromSp(sp, defaultAttributeMap);
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
          ${samlRedirectUrlFieldHtml('csp', sp?.default_relay_state)}
          <div class="form-group">
            <label class="form-label">NameID Format</label>
            <select class="form-select" id="csp-nameid">
              ${NAMEID_OPTIONS.map(([v, l]) => `<option value="${esc(v)}" ${curFormat===v?'selected':''}>${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">NameID value (employee field)</label>
            <select class="form-select" id="csp-nameid-attr">
              ${empFieldOptionsHtml(fields, curNameidAttr)}
            </select>
          </div>
          ${samlAttrMapEditorHtml('csp', attrRows, fields)}
          ${samlSigningHtml('csp', sp)}
          <div class="form-group span2">
            <label class="form-label">Icon URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="csp-icon" type="url" value="${esc(sp?.icon_url||'')}" placeholder="https://…/logo.png">
          </div>
          <div class="form-group span2">
            <label class="mfa-toggle-row" style="display:flex;gap:0.55rem;align-items:flex-start;cursor:pointer;margin:0">
              <input type="checkbox" id="csp-require-mfa" ${sp?.require_mfa ? 'checked' : ''} style="margin-top:0.2rem">
              <span>
                <strong>Critical application — require MFA at launch</strong>
                <span class="muted" style="display:block;font-size:0.8rem;font-weight:400">Users must complete MFA again before SSO into this app (controlled by Strong Auth → Application-level MFA).</span>
              </span>
            </label>
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
    bindSamlAttrEditor(bd, 'csp');
    bd.querySelector('#csp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#csp-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#csp-save');
      const name     = bd.querySelector('#csp-name').value.trim();
      const slugRaw  = bd.querySelector('#csp-slug').value.trim();
      const slug     = isEdit ? slugRaw : slugRaw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      const entityId = bd.querySelector('#csp-entity').value.trim();
      const acsUrl   = bd.querySelector('#csp-acs').value.trim();
      const sloUrl   = bd.querySelector('#csp-slo').value.trim();
      const defaultRelayState = bd.querySelector('#csp-relay')?.value.trim() || null;
      const nameidFormat = bd.querySelector('#csp-nameid').value;
      const iconUrl  = bd.querySelector('#csp-icon').value.trim();
      const extras = collectSamlSpExtras(bd, 'csp');

      if (!name)     { bd.querySelector('#csp-err').innerHTML = errHtml('Name is required.'); return; }
      if (!isEdit) {
        bd.querySelector('#csp-slug').value = slug;
        if (!slug) { bd.querySelector('#csp-err').innerHTML = errHtml('Slug is required (use lower-case letters, numbers, hyphen).'); return; }
      }
      if (!entityId) { bd.querySelector('#csp-err').innerHTML = errHtml('SP Entity ID is required.'); return; }
      if (!acsUrl)   { bd.querySelector('#csp-err').innerHTML = errHtml('ACS URL is required.'); return; }

      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Saving…' : 'Registering…';
      const data = { name, entityId, acsUrl, nameidFormat,
        sloUrl: sloUrl || undefined, defaultRelayState, iconUrl: iconUrl || undefined,
        requireMfa: !!bd.querySelector('#csp-require-mfa')?.checked,
        ...extras };
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
  persistSearch(wrap.querySelector('#ac-search'), 'ac-catalog');

  await loadApps();
}

/* ---------- SAML Applications (legacy CRUD) ---------- */
export async function viewSamlApps(me, content, opts = {}) {
  const embed = !!opts.embed;
  const isSuper = isPortalSuperAdmin(me);

  const actionBtn = isSuper
    ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end">
         <button class="btn btn-secondary" id="sa-enable-all-jit" title="Enable Request Access (JIT) for all active SAML apps">Enable Request Access (all)</button>
         <button class="btn btn-primary" id="sa-new-btn">+ Register SAML App</button>
       </div>`
    : '';

  const wrap = el(`<div>
    ${embed
      ? (isSuper ? `<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">${actionBtn}</div>` : '')
      : header('SAML Applications', 'Connected SSO apps — register SPs and enable IGA Request Access so users can request SSO', actionBtn)}
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

  async function openSpModal(sp = null) {
    const isEdit = !!sp;
    const { fields, defaultAttributeMap } = await loadSamlAttributeFields();
    const curFormat = sp?.nameid_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
    const curNameidAttr = sp?.nameid_attribute || 'email_corp';
    const attrRows = samlAttrMapRowsFromSp(sp, defaultAttributeMap);
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
          ${samlRedirectUrlFieldHtml('sp', sp?.default_relay_state)}
          <div class="form-group">
            <label class="form-label">NameID Format</label>
            <select class="form-select" id="sp-nameid">
              ${NAMEID_OPTIONS.map(([v, l]) => `<option value="${esc(v)}" ${curFormat===v?'selected':''}>${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">NameID value (employee field)</label>
            <select class="form-select" id="sp-nameid-attr">
              ${empFieldOptionsHtml(fields, curNameidAttr)}
            </select>
          </div>
          ${samlAttrMapEditorHtml('sp', attrRows, fields)}
          ${samlSigningHtml('sp', sp)}
          <div class="form-group span2">
            <label class="form-label">Icon URL <span class="muted" style="font-weight:400">(optional)</span></label>
            <input class="form-input" id="sp-icon" type="url" value="${esc(sp?.icon_url||'')}" placeholder="https://…/logo.png">
          </div>
          <div class="form-group span2">
            <label class="mfa-toggle-row" style="display:flex;gap:0.55rem;align-items:flex-start;cursor:pointer;margin:0">
              <input type="checkbox" id="sp-require-mfa" ${sp?.require_mfa ? 'checked' : ''} style="margin-top:0.2rem">
              <span>
                <strong>Critical application — require MFA at launch</strong>
                <span class="muted" style="display:block;font-size:0.8rem;font-weight:400">Users must complete MFA again before SSO into this app (Strong Auth → Application-level MFA).</span>
              </span>
            </label>
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
    bindSamlAttrEditor(bd, 'sp');
    bd.querySelector('#sp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#sp-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#sp-save');
      const name     = bd.querySelector('#sp-name').value.trim();
      const slugRaw  = bd.querySelector('#sp-slug').value.trim();
      const slug     = isEdit ? slugRaw : slugRaw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      const entityId = bd.querySelector('#sp-entity').value.trim();
      const acsUrl   = bd.querySelector('#sp-acs').value.trim();
      const sloUrl   = bd.querySelector('#sp-slo').value.trim();
      const defaultRelayState = bd.querySelector('#sp-relay')?.value.trim() || null;
      const nameidFormat = bd.querySelector('#sp-nameid').value;
      const iconUrl  = bd.querySelector('#sp-icon').value.trim();
      const extras = collectSamlSpExtras(bd, 'sp');

      if (!name)     { bd.querySelector('#sp-err').innerHTML = errHtml('Name is required.'); return; }
      if (!isEdit) {
        bd.querySelector('#sp-slug').value = slug;
        if (!slug) { bd.querySelector('#sp-err').innerHTML = errHtml('Slug is required (use lower-case letters, numbers, hyphen).'); return; }
      }
      if (!entityId) { bd.querySelector('#sp-err').innerHTML = errHtml('SP Entity ID is required.'); return; }
      if (!acsUrl)   { bd.querySelector('#sp-err').innerHTML = errHtml('ACS URL is required.'); return; }

      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Saving…' : 'Registering…';
      const data = { name, entityId, acsUrl, nameidFormat,
        sloUrl: sloUrl || undefined, defaultRelayState, iconUrl: iconUrl || undefined,
        requireMfa: !!bd.querySelector('#sp-require-mfa')?.checked,
        ...extras };
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
        <td>${sp.request_access
          ? '<span class="badge badge-success" title="Users can request SSO via Request Access">Request Access</span>'
          : '<span class="badge badge-neutral" title="Not in Request Access catalog">SSO only</span>'}
          ${sp.require_mfa ? ' <span class="badge badge-warning" title="Fresh MFA required at launch">MFA</span>' : ''}</td>
        <td style="white-space:nowrap">${isSuper ? `
          <button class="btn btn-sm btn-secondary sp-edit" data-id="${esc(String(sp.id))}" title="Edit">✏️ Edit</button>
          ${!sp.request_access ? `<button class="btn btn-sm btn-primary sp-enable-jit"
            data-id="${esc(String(sp.id))}" data-name="${esc(sp.name)}" title="Enable IGA Request Access (JIT)">Enable Request Access</button>` : ''}
          <button class="btn btn-sm ${sp.active ? 'btn-warning' : 'btn-success'} sp-toggle"
            data-id="${esc(String(sp.id))}" data-active="${sp.active ? '1' : '0'}">${sp.active ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger sp-del"
            data-id="${esc(String(sp.id))}" data-name="${esc(sp.name)}">Delete</button>
        ` : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="empty-state"><span class="empty-icon">⛨</span>No SAML applications registered.</td></tr>`;

  wrap.querySelector('#sa-area').innerHTML = `
    ${status.metadataUrl ? `<div class="alert alert-info" style="margin-bottom:1.5rem">
      <div style="font-weight:500;margin-bottom:0.2rem">IdP metadata for SP onboarding</div>
      <a href="${esc(status.metadataUrl)}" target="_blank">${esc(status.metadataUrl)}</a>
      <div class="muted" style="margin-top:0.5rem;font-size:0.85rem">New apps get Request Access (JIT) automatically. Existing apps: use <strong>Enable Request Access</strong> so users can request SSO from My Portal.</div>
    </div>` : ''}
    <div class="table-wrap">
      <div class="table-toolbar">
        <strong>Registered applications</strong>
        <span class="muted">${apps.length} total</span>
      </div>
      <table>
        <thead><tr>
          <th>Name</th><th>Slug</th><th>Entity ID</th><th>ACS URL</th><th>Status</th><th>IGA</th><th>Actions</th>
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

  wrap.querySelectorAll('.sp-enable-jit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Enable Request Access for "${btn.dataset.name}"?\n\nUsers will see this app under Request Access and can request SSO (manager → admin approval).`)) return;
      btn.disabled = true; btn.textContent = 'Enabling…';
      try {
        await api.enableSamlRequestAccess(btn.dataset.id);
        viewSamlApps(me, content, opts);
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = 'Enable Request Access'; }
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
    wrap.querySelector('#sa-enable-all-jit')?.addEventListener('click', async () => {
      if (!confirm('Enable Request Access (JIT) for all active SAML applications?\n\nCreates a default manager→admin workflow where missing and marks apps requestable.')) return;
      const btn = wrap.querySelector('#sa-enable-all-jit');
      btn.disabled = true; btn.textContent = 'Enabling…';
      try {
        const r = await api.enableAllSamlRequestAccess();
        alert(`Done: ${r.enabled ?? 0} app(s) enabled` +
          (r.createdWorkflows ? ` (${r.createdWorkflows} new workflow(s))` : '') +
          (r.errors?.length ? `\n\nErrors:\n${r.errors.join('\n')}` : ''));
        viewSamlApps(me, content, opts);
      } catch (err) {
        alert(err.message);
        btn.disabled = false; btn.textContent = 'Enable Request Access (all)';
      }
    });
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
      <table><thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Type</th><th>State</th><th>Portal access</th><th>Last login</th></tr></thead>
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
            <div><div class="cell-strong">${esc(u.full_name)}</div><div class="muted" style="font-size:0.75rem">${esc(u.employee_number || u.emp_id)}</div></div>
          </div></td>
          <td>${esc(u.email_corp)}</td><td>${esc(u.dept_id || '—')}</td><td>${esc(u.employment_type || '—')}</td>
          <td>${ilgBadge(u.ilg_state)}</td>
          <td>${u.portal_role ? `<span class="badge badge-info">${esc(u.portal_role)}</span>` : '<span class="muted">—</span>'}</td>
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
  persistSearch(search, 'admin-users');
  if (!search.value) reload();
}

/* ---------- Administrators ---------- */
export async function viewAdmins(content) {
  const wrap = el(`<div class="ent-page">
    ${header(
      'Administrators & Roles',
      'Assign console roles and create custom roles with per-module Read / Write access',
      '<button type="button" class="btn btn-primary btn-sm" id="afd-focus-btn">+ Add from Directory</button>',
    )}

    <div class="alert alert-info" style="font-size:0.85rem;margin-bottom:1rem">
      <strong>No Privileged Access (PAM) role</strong> — PAM is not designed yet and cannot be granted.
      Built-in roles: <strong>Super Admin</strong>, <strong>Admin</strong>, <strong>Application Contributor</strong>, <strong>User and Group Manager</strong>, plus custom roles below.
    </div>

    <div class="card" id="afd-card" style="margin-bottom:1rem;border-left:3px solid var(--primary,#2563eb)">
      <h3 style="margin:0 0 0.25rem;font-size:1rem">Add from Directory</h3>
      <p class="subtitle" style="margin:0 0 1rem">Search any employee synced from AD or Google and assign a portal role.</p>
      <div id="afd-area">
        <div style="display:flex;gap:0.6rem;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:220px;margin:0">
            <label>Search employee (name or email)</label>
            <input id="afd-search" class="form-control" placeholder="e.g. mohit.sharma@lenskart.in" autocomplete="off" />
          </div>
          <div class="field" style="margin:0;min-width:220px">
            <label>Portal role</label>
            <select id="afd-role" class="form-select"><option value="">Loading…</option></select>
          </div>
          <button id="afd-btn" class="btn btn-primary" disabled>Assign role</button>
        </div>
        <div id="afd-results" style="margin-top:0.5rem"></div>
        <div id="afd-msg" style="margin-top:0.4rem;font-size:0.85rem"></div>
      </div>
    </div>

    <details class="card" style="margin-bottom:1rem">
      <summary style="cursor:pointer;font-weight:600">Create new local administrator account</summary>
      <p class="subtitle" style="margin:0.5rem 0 1rem">Creates a new employee record + password login. Prefer adding from directory.</p>
      <div id="ca-error"></div>
      <form id="ca-form">
        <div class="grid-2">
          <div class="field"><label>Full name</label><input name="fullName" required /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password (min 10)</label><input name="password" type="password" minlength="10" required /></div>
          <div class="field"><label>Role</label><select name="role" id="ca-role"><option value="">Loading…</option></select></div>
        </div>
        <button type="submit" class="btn btn-primary">Create administrator</button>
      </form>
    </details>

    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap">
        <div>
          <h2 style="margin:0">Custom Roles</h2>
          <p class="subtitle" style="margin:0.35rem 0 0">Create a role and grant module Read / Write. PAM modules are not available.</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="cr-new-btn">+ New Custom Role</button>
      </div>
      <div id="cr-list" style="margin-top:1rem"><div class="loading-row"><span class="spinner"></span></div></div>
    </div>

    <div class="table-wrap">
      <div class="table-toolbar"><strong id="admins-count">Administrators</strong></div>
      <table><thead><tr><th>Name / Email</th><th>Role</th><th>Type</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody id="admins-tbody"><tr><td colspan="6" class="loading-row"><span class="spinner"></span></td></tr></tbody></table>
    </div>
  </div>`);
  content.replaceChildren(wrap);

  let portalRoles = [];
  let portalModules = [];

  function roleOptionsHtml(selected = 'pr-admin') {
    const system = portalRoles.filter((r) => r.is_system && r.active);
    const custom = portalRoles.filter((r) => !r.is_system && r.active);
    return [
      ...system.map((r) => `<option value="${esc(r.id)}" ${r.id === selected || r.role_key === selected ? 'selected' : ''}>${esc(r.name)}</option>`),
      custom.length ? `<optgroup label="Custom roles">${custom.map((r) => `<option value="${esc(r.id)}" ${r.id === selected ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</optgroup>` : '',
    ].join('');
  }

  function permSummary(perms) {
    const keys = Object.keys(perms || {}).filter((k) => perms[k].read || perms[k].write);
    if (!keys.length) return '<span class="muted">No modules</span>';
    return keys.map((k) => {
      const p = perms[k];
      const rw = p.write ? 'R/W' : 'R';
      return `<span class="badge badge-neutral" style="margin:0.1rem">${esc(k)} ${rw}</span>`;
    }).join(' ');
  }

  async function loadRoles() {
    try {
      const [rolesRes, modRes] = await Promise.all([
        api.listPortalRoles(),
        api.listPortalModules().catch(() => ({ data: [] })),
      ]);
      portalRoles = rolesRes.data || [];
      portalModules = modRes.data || [];
      wrap.querySelector('#afd-role').innerHTML = roleOptionsHtml('pr-admin');
      wrap.querySelector('#ca-role').innerHTML = roleOptionsHtml('pr-admin');
      renderCustomRoles();
    } catch (err) {
      wrap.querySelector('#cr-list').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  function renderCustomRoles() {
    const custom = portalRoles.filter((r) => !r.is_system);
    const system = portalRoles.filter((r) => r.is_system);
    wrap.querySelector('#cr-list').innerHTML = `
      <p class="muted" style="font-size:0.8rem;margin:0 0 0.75rem">Built-in (read-only): ${system.map((r) => esc(r.name)).join(' · ')}</p>
      ${custom.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Modules</th><th>Status</th><th></th></tr></thead>
        <tbody>${custom.map((r) => `<tr>
          <td class="cell-strong">${esc(r.name)}<div class="muted" style="font-size:0.75rem">${esc(r.description || '')}</div></td>
          <td>${permSummary(r.permissions)}</td>
          <td>${r.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary cr-edit" data-id="${esc(r.id)}">Edit</button>
            <button class="btn btn-sm btn-danger cr-del" data-id="${esc(r.id)}">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty-state"><p>No custom roles yet. Click "+ New Custom Role" to create one with module Read/Write.</p></div>'}`;

    wrap.querySelectorAll('.cr-edit').forEach((btn) => {
      btn.addEventListener('click', () => openRoleModal(portalRoles.find((r) => r.id === btn.dataset.id)));
    });
    wrap.querySelectorAll('.cr-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this custom role?')) return;
        try { await api.deletePortalRole(btn.dataset.id); await loadRoles(); }
        catch (e) { alert(e.message); }
      });
    });
  }

  function openRoleModal(existing = null) {
    const isEdit = !!existing;
    const perms = existing?.permissions || {};
    const rows = (portalModules.length
      ? portalModules
      : [
        { key: 'overview', label: 'Overview' }, { key: 'identity_users', label: 'Users / Identities' },
        { key: 'identity_groups', label: 'Groups' }, { key: 'applications', label: 'Applications' },
        { key: 'authentication', label: 'Authentication' }, { key: 'connections', label: 'Directory Sync' },
        { key: 'access_model', label: 'Access Model' }, { key: 'governance', label: 'Identity Governance' },
        { key: 'workflows', label: 'Workflows' }, { key: 'reports', label: 'Reports' },
        { key: 'settings', label: 'Settings' }, { key: 'administrators', label: 'Administrators' },
      ]).map((m) => {
      const p = perms[m.key] || {};
      return `<tr>
        <td>${esc(m.label || m.key)}</td>
        <td style="text-align:center"><input type="checkbox" class="cr-r" data-mod="${esc(m.key)}" ${p.read || p.write ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" class="cr-w" data-mod="${esc(m.key)}" ${p.write ? 'checked' : ''}></td>
      </tr>`;
    }).join('');

    const bd = openModal(`<div class="modal modal-wide"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Custom Role</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="cr-name" value="${esc(existing?.name || '')}"></div>
        <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="cr-desc" value="${esc(existing?.description || '')}"></div>
        <p class="muted" style="font-size:0.8rem;margin:0 0 0.5rem">Module access — Write implies Read. PAM is not listed (not available).</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Module</th><th>Read</th><th>Write</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div id="cr-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="cr-save">${isEdit ? 'Save' : 'Create'}</button>
        <button class="btn btn-secondary" id="cr-cancel">Cancel</button>
      </div></div>`);

    bd.querySelectorAll('.cr-w').forEach((w) => {
      w.addEventListener('change', () => {
        if (w.checked) {
          const r = bd.querySelector(`.cr-r[data-mod="${w.dataset.mod}"]`);
          if (r) r.checked = true;
        }
      });
    });
    bd.querySelector('#cr-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#cr-save').addEventListener('click', async () => {
      const name = bd.querySelector('#cr-name').value.trim();
      if (!name) { bd.querySelector('#cr-err').innerHTML = errHtml('Name is required'); return; }
      const permissions = [...bd.querySelectorAll('.cr-r')].map((r) => {
        const w = bd.querySelector(`.cr-w[data-mod="${r.dataset.mod}"]`);
        return { moduleKey: r.dataset.mod, canRead: r.checked || !!w?.checked, canWrite: !!w?.checked };
      }).filter((p) => p.canRead || p.canWrite);
      if (!permissions.length) { bd.querySelector('#cr-err').innerHTML = errHtml('Select at least one module'); return; }
      try {
        if (isEdit) await api.updatePortalRole(existing.id, { name, description: bd.querySelector('#cr-desc').value, permissions });
        else await api.createPortalRole({ name, description: bd.querySelector('#cr-desc').value, permissions });
        bd.remove();
        await loadRoles();
      } catch (e) { bd.querySelector('#cr-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#cr-new-btn').addEventListener('click', () => openRoleModal(null));

  async function loadTable() {
    try {
      const r = await api.listLocalAdmins();
      const rows = r.data || [];
      wrap.querySelector('#admins-count').textContent = `Administrators (${rows.length})`;
      wrap.querySelector('#admins-tbody').innerHTML = rows.length
        ? rows.map((a) => `<tr>
            <td>
              <div class="cell-strong">${esc(a.full_name || a.email)}</div>
              <div class="muted" style="font-size:0.75rem">${esc(a.email)}</div>
            </td>
            <td><span class="badge badge-info">${esc(a.role_name || a.role)}</span></td>
            <td>${a.has_local_account
              ? '<span class="badge badge-neutral">Local</span>'
              : '<span class="badge badge-primary">SSO</span>'}</td>
            <td>${a.active
              ? '<span class="badge badge-success">Active</span>'
              : '<span class="badge badge-neutral">Inactive</span>'}</td>
            <td class="muted">${fmtDate(a.last_login_at)}</td>
            <td class="actions">
              ${a.has_local_account && a.active
                ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${a.id}">Deactivate</button>`
                : `<button class="btn btn-sm btn-warning" data-action="remove" data-emp="${esc(a.emp_id)}">Remove role</button>`}
            </td>
          </tr>`).join('')
        : `<tr><td colspan="6" class="empty-state">No administrators yet</td></tr>`;

      wrap.querySelectorAll('[data-action="deactivate"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this local administrator account?')) return;
          try { await api.deactivateAdmin(btn.dataset.id); loadTable(); }
          catch (err) { alert(err.message); }
        });
      });
      wrap.querySelectorAll('[data-action="remove"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove portal role from this user? They will become a regular user.')) return;
          try { await api.updateUserRole(btn.dataset.emp, 'USER'); loadTable(); }
          catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      wrap.querySelector('#admins-tbody').innerHTML =
        `<tr><td colspan="6"><div class="alert alert-error">${esc(err.message)}</div></td></tr>`;
    }
  }

  // ── Add from Directory ───────────────────────────────────────────────────
  const afdCard    = wrap.querySelector('#afd-card');
  const afdSearch  = wrap.querySelector('#afd-search');
  const afdResults = wrap.querySelector('#afd-results');
  const afdBtn     = wrap.querySelector('#afd-btn');
  const afdRole    = wrap.querySelector('#afd-role');
  const afdMsg     = wrap.querySelector('#afd-msg');
  let selectedEmp  = null;
  let searchTimer  = null;

  wrap.querySelector('#afd-focus-btn')?.addEventListener('click', () => {
    afdCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    afdSearch?.focus();
  });

  function setMsg(text, isError = false) {
    afdMsg.textContent = text;
    afdMsg.style.color = isError ? 'var(--color-danger,#dc2626)' : 'var(--color-success,#16a34a)';
  }

  function selectEmployee(emp) {
    selectedEmp = emp;
    afdSearch.value = `${emp.full_name} — ${emp.email_corp}`;
    afdResults.innerHTML = '';
    afdBtn.disabled = false;
    afdMsg.textContent = '';
  }

  afdSearch.addEventListener('input', () => {
    selectedEmp = null;
    afdBtn.disabled = true;
    afdMsg.textContent = '';
    clearTimeout(searchTimer);
    const q = afdSearch.value.trim();
    if (q.length < 2) { afdResults.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await api.listUsersUnified(q, '', '', 10, 0);
        const taken = new Set(['ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM']);
        const items = (r.data || []).filter(u => !taken.has(u.portal_role));
        if (!items.length) {
          afdResults.innerHTML = `<div class="muted" style="padding:0.4rem 0;font-size:0.85rem">No matching users found (existing portal operators are hidden)</div>`;
          return;
        }
        afdResults.innerHTML = `<div class="search-dropdown" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;max-height:220px;overflow-y:auto">
          ${items.map(u => `
            <div class="search-dropdown-item" data-emp='${JSON.stringify({emp_id:u.emp_id,full_name:u.full_name,email_corp:u.email_corp})}'
              style="padding:0.55rem 0.8rem;cursor:pointer;display:flex;align-items:center;gap:0.6rem;border-bottom:1px solid var(--border,#e5e7eb)">
              <span class="avatar" style="width:28px;height:28px;font-size:0.7rem;flex-shrink:0">${esc((u.full_name||'?').charAt(0).toUpperCase())}</span>
              <div>
                <div style="font-weight:600;font-size:0.875rem">${esc(u.full_name||u.emp_id)}</div>
                <div class="muted" style="font-size:0.75rem">${esc(u.email_corp||'')} · ${esc(u.emp_id)}</div>
              </div>
            </div>`).join('')}
        </div>`;
        afdResults.querySelectorAll('.search-dropdown-item').forEach(item => {
          item.addEventListener('mouseenter', () => item.style.background = 'var(--hover-bg,#f3f4f6)');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => selectEmployee(JSON.parse(item.dataset.emp)));
        });
      } catch (e) {
        afdResults.innerHTML = `<div class="muted" style="font-size:0.85rem;padding:0.3rem 0">Search failed: ${esc(e.message)}</div>`;
      }
    }, 300);
  });

  afdBtn.addEventListener('click', async () => {
    if (!selectedEmp) return;
    afdBtn.disabled = true;
    setMsg('Assigning…');
    try {
      const roleId = afdRole.value;
      const roleLabel = afdRole.selectedOptions[0]?.textContent || roleId;
      await api.updateUserRole(selectedEmp.emp_id, roleId);
      setMsg(`✓ ${selectedEmp.full_name} is now ${roleLabel}`);
      afdSearch.value = '';
      afdResults.innerHTML = '';
      selectedEmp = null;
      loadTable();
    } catch (e) {
      setMsg('Failed: ' + e.message, true);
      afdBtn.disabled = false;
    }
  });

  wrap.querySelector('#ca-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = wrap.querySelector('#ca-error');
    errEl.innerHTML = '';
    try {
      await api.createLocalAdmin(Object.fromEntries(new FormData(e.target)));
      errEl.innerHTML = `<div class="alert alert-success">Administrator created.</div>`;
      e.target.reset();
      wrap.querySelector('#ca-role').innerHTML = roleOptionsHtml('pr-admin');
      loadTable();
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  await loadRoles();
  loadTable();
}

/* ---------- Authentication ---------- */
export async function viewAuth(content) {
  const wrap = el(`<div>${header('Authentication', 'SAML Identity Provider and OIDC connection status')}<div id="auth-area"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  let s;
  let google = null;
  let googleLoadError = '';
  try {
    [s, google] = await Promise.all([
      api.idpStatus(),
      api.getGoogleOidcSettings().catch((err) => {
        googleLoadError = err?.message || 'Could not load Google OIDC settings.';
        return null;
      }),
    ]);
  }
  catch (err) { wrap.querySelector('#auth-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; return; }

  const redirectUri = `${window.location.origin}/auth/google/callback`;
  const sourceLabel = (k) => {
    if (!google?.source || !google.source[k]) return '—';
    if (google.source[k] === 'connector') {
      return '<span class="badge badge-info">Directory connector</span>';
    }
    return google.source[k] === 'db'
      ? '<span class="badge badge-info">DB override</span>'
      : '<span class="badge badge-neutral">.env</span>';
  };
  const domainsDisplay = (google?.hostedDomains?.length ? google.hostedDomains : [google?.hostedDomain].filter(Boolean)).join(', ');

  wrap.querySelector('#auth-area').innerHTML = `<div class="ent-page">
    <div class="grid-2 auth-config-row">
      <div class="ent-panel">
        <div class="ent-panel-head">
          <div class="panel-meta">
            <h2>SAML 2.0 Identity Provider</h2>
            <p class="subtitle">Issues SAML assertions to registered Service Providers</p>
          </div>
        </div>
        <div class="ent-panel-body">
          <div class="kv-list">
            <div class="kv"><div class="k">Status</div><div class="v">${s.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
            <div class="kv"><div class="k">Public base URL</div><div class="v">${esc(s.publicBaseUrl || '—')}</div></div>
            <div class="kv"><div class="k">Entity ID</div><div class="v">${esc(s.entityId || '—')}</div></div>
            <div class="kv"><div class="k">Metadata</div><div class="v">${s.metadataUrl ? `<a href="${esc(s.metadataUrl)}" target="_blank" rel="noopener">Open metadata</a>` : '—'}</div></div>
          </div>
          ${!s.samlEnabled ? `<div class="alert alert-warning" style="margin-top:1rem"><div>
            <div style="font-weight:600;margin-bottom:0.3rem">SAML keys missing</div>
            Run <code>bash scripts/gen-saml-dev-keys.sh</code>, paste <code>SAML_IDP_PRIVATE_KEY_PEM</code> and <code>SAML_IDP_CERT_PEM</code> into <code>.env</code>, then restart.</div></div>` : ''}
        </div>
      </div>
      <div class="ent-panel">
        <div class="ent-panel-head">
          <div class="panel-meta">
            <h2>Local password login</h2>
            <p class="subtitle">Email + password administrators</p>
          </div>
        </div>
        <div class="ent-panel-body">
          <div class="kv-list">
            <div class="kv"><div class="k">Endpoint</div><div class="v"><code>POST /auth/local/login</code></div></div>
            <div class="kv"><div class="k">Master admin</div><div class="v">From <code>MASTER_ADMIN_EMAIL</code> in <code>.env</code></div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="ent-panel">
      <div class="ent-panel-head">
        <div class="panel-meta">
          <h2>Inbound OIDC providers</h2>
          <p class="subtitle">Google Workspace federated login for end users</p>
        </div>
      </div>
      <div class="ent-panel-body">
        <div class="auth-oidc-split">
          <div>
            <div class="kv-list">
              <div class="kv"><div class="k">Login endpoint</div><div class="v"><code>/auth/google</code></div></div>
              <div class="kv"><div class="k">Redirect URI</div><div class="v"><code>${esc(redirectUri)}</code></div></div>
              <div class="kv"><div class="k">Configured</div><div class="v">${google?.configured ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-warning">No</span>'}</div></div>
              <div class="kv"><div class="k">Client ID source</div><div class="v">${sourceLabel('clientId')}</div></div>
              <div class="kv"><div class="k">Client secret source</div><div class="v">${sourceLabel('clientSecret')}</div></div>
              <div class="kv"><div class="k">Hosted domains</div><div class="v">${esc(domainsDisplay || '—')}</div></div>
              <div class="kv"><div class="k">Domain source</div><div class="v">${sourceLabel('hostedDomain')}</div></div>
            </div>
            ${googleLoadError ? `<div class="alert alert-warning" style="margin-top:1rem">${esc(googleLoadError)}</div>` : ''}
          </div>
          ${google ? `
          <div class="config-form-panel">
            <h3>Google OIDC settings</h3>
            <form id="auth-google-form">
              <div class="form-group">
                <label class="form-label">OAuth Client ID</label>
                <input class="form-input" id="auth-google-client-id" value="${esc(google.clientId || '')}" placeholder="123456.apps.googleusercontent.com">
              </div>
              <div class="form-group">
                <label class="form-label">OAuth Client Secret</label>
                <input class="form-input" id="auth-google-client-secret" type="password" placeholder="${google.hasClientSecret ? 'Saved (leave blank to keep current)' : 'GOCSPX-...'}">
              </div>
              <div class="form-group">
                <label class="form-label">Workspace domains</label>
                <textarea class="form-textarea" id="auth-google-hosted-domain" rows="3" placeholder="lenskart.com&#10;lenskart.in&#10;dealskart.in">${esc((google.hostedDomains?.length ? google.hostedDomains.join('\n') : google.hostedDomain) || '')}</textarea>
                <p class="form-hint">One domain per line (or comma-separated). Same list as Directory Sync → Google Workspace.</p>
              </div>
              <div class="form-group">
                <label class="form-label">OAuth JSON (optional)</label>
                <textarea class="form-textarea" id="auth-google-json" rows="4" placeholder='Paste downloaded OAuth client JSON (contains web.client_id + web.client_secret)'></textarea>
              </div>
              <div id="auth-google-msg"></div>
              <button class="btn btn-primary" id="auth-google-save" type="submit">Save Google OIDC Settings</button>
            </form>
          </div>` : ''}
        </div>
        <p class="card-footnote">Zoho Mail is consumed as a SAML application — see <a href="#" data-go="applications" data-tab="saml">SAML Applications</a>.</p>
      </div>
    </div>
  </div>`;
  wrap.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = a.dataset.tab || null;
      window.LILG_NAV(a.dataset.go, tab ? { tab } : {});
    });
  });

  const googleForm = wrap.querySelector('#auth-google-form');
  if (googleForm) {
    googleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = wrap.querySelector('#auth-google-msg');
      const saveBtn = wrap.querySelector('#auth-google-save');
      const clientId = wrap.querySelector('#auth-google-client-id').value.trim();
      const clientSecret = wrap.querySelector('#auth-google-client-secret').value.trim();
      const hostedDomain = wrap.querySelector('#auth-google-hosted-domain').value.trim();
      const oauthClientJson = wrap.querySelector('#auth-google-json').value.trim();

      if (!clientId && !oauthClientJson) {
        msg.innerHTML = `<div class="alert alert-error">Enter OAuth Client ID or paste OAuth JSON.</div>`;
        return;
      }
      if (!hostedDomain) {
        msg.innerHTML = `<div class="alert alert-error">Enter at least one Workspace domain.</div>`;
        return;
      }

      const payload = { clientId, hostedDomain };
      if (clientSecret) payload.clientSecret = clientSecret;
      if (oauthClientJson) payload.oauthClientJson = oauthClientJson;

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      msg.innerHTML = '';
      try {
        await api.saveGoogleOidcSettings(payload);
        msg.innerHTML = `<div class="alert alert-success">Google OIDC settings saved.</div>`;
        await viewAuth(content);
      } catch (err) {
        msg.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to save Google OIDC settings.')}</div>`;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Google OIDC Settings';
      }
    });
  }
}

/* ---------- Audit ---------- */
function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function auditFilterBar(fieldsHtml, extras = '') {
  return `<div class="ent-panel audit-filter-panel">
    <div class="ent-panel-head">
      <div class="panel-meta">
        <h2>Filters</h2>
        <p class="subtitle">Date range, search, and export for compliance evidence</p>
      </div>
      <div class="audit-preset-row">
        <button type="button" class="btn btn-sm btn-secondary audit-preset" data-days="7">7d</button>
        <button type="button" class="btn btn-sm btn-secondary audit-preset" data-days="30">30d</button>
        <button type="button" class="btn btn-sm btn-secondary audit-preset" data-days="90">90d</button>
      </div>
    </div>
    <div class="ent-panel-body">
      <div class="audit-filter-grid">
        <div class="form-group">
          <label class="form-label">From</label>
          <input type="date" class="form-input audit-from" value="${esc(isoDateDaysAgo(30))}">
        </div>
        <div class="form-group">
          <label class="form-label">To</label>
          <input type="date" class="form-input audit-to" value="${esc(todayIso())}">
        </div>
        ${fieldsHtml}
      </div>
      <div class="audit-filter-actions">
        <button type="button" class="btn btn-primary audit-apply">Apply filters</button>
        <button type="button" class="btn btn-secondary audit-reset">Reset</button>
        <button type="button" class="btn btn-secondary audit-export">Export CSV</button>
        ${extras}
        <span class="muted audit-meta-count" style="margin-left:auto;font-size:0.8rem"></span>
      </div>
    </div>
  </div>`;
}
async function downloadAuditCsv(url, filename) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error || body.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg || 'Export failed');
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

export async function viewAudit(content, initialTab = 'saml') {
  const tabs = ['saml', 'system', 'auth', 'sessions', 'sso', 'provisioning'];
  const validTab = tabs.includes(initialTab) ? initialTab : 'saml';
  const wrap = el(`<div class="ent-page">${header('Audit & SSO Reports', 'Low-level audit trails, login forensics, session history, and SSO analytics for compliance')}
    <div class="inline-tabs" id="audit-tabs" style="margin-bottom:1rem">
      <button type="button" class="inline-tab${validTab === 'saml' ? ' active' : ''}" data-tab="saml">SSO assertions</button>
      <button type="button" class="inline-tab${validTab === 'system' ? ' active' : ''}" data-tab="system">System audit</button>
      <button type="button" class="inline-tab${validTab === 'auth' ? ' active' : ''}" data-tab="auth">Auth attempts</button>
      <button type="button" class="inline-tab${validTab === 'sessions' ? ' active' : ''}" data-tab="sessions">Sessions</button>
      <button type="button" class="inline-tab${validTab === 'sso' ? ' active' : ''}" data-tab="sso">SSO analytics</button>
      <button type="button" class="inline-tab${validTab === 'provisioning' ? ' active' : ''}" data-tab="provisioning">User provisioning log</button>
    </div>
    <div id="aud-summary" class="stat-grid audit-summary-grid" style="margin-bottom:1rem"></div>
    <div id="aud-saml" ${validTab !== 'saml' ? 'hidden' : ''}><div class="loading-row"><span class="spinner"></span></div></div>
    <div id="aud-system" ${validTab !== 'system' ? 'hidden' : ''}></div>
    <div id="aud-auth" ${validTab !== 'auth' ? 'hidden' : ''}></div>
    <div id="aud-sessions" ${validTab !== 'sessions' ? 'hidden' : ''}></div>
    <div id="aud-sso" ${validTab !== 'sso' ? 'hidden' : ''}></div>
    <div id="aud-provisioning" ${validTab !== 'provisioning' ? 'hidden' : ''}></div>
  </div>`);
  content.replaceChildren(wrap);
  const panels = {
    saml: wrap.querySelector('#aud-saml'),
    system: wrap.querySelector('#aud-system'),
    auth: wrap.querySelector('#aud-auth'),
    sessions: wrap.querySelector('#aud-sessions'),
    sso: wrap.querySelector('#aud-sso'),
    provisioning: wrap.querySelector('#aud-provisioning'),
  };
  const state = {
    saml: { from: isoDateDaysAgo(30), to: todayIso(), q: '', app: '', binding: '', offset: 0, limit: 50 },
    system: { from: isoDateDaysAgo(30), to: todayIso(), q: '', actor: '', action: '', offset: 0, limit: 50 },
    auth: { from: isoDateDaysAgo(30), to: todayIso(), q: '', ip: '', success: '', reason: '', offset: 0, limit: 50 },
    sessions: { from: isoDateDaysAgo(30), to: todayIso(), q: '', ip: '', status: '', iss: '', offset: 0, limit: 50 },
    provisioning: { from: isoDateDaysAgo(30), to: todayIso(), q: '', app: '', action: '', status: '', offset: 0, limit: 50 },
  };

  async function refreshSummary(from, to) {
    const box = wrap.querySelector('#aud-summary');
    try {
      const r = await api.auditSummary({ from, to });
      const d = r.data || {};
      box.innerHTML = `
        ${statCard('saml', 'SSO assertions', d.ssoAssertions ?? 0, 'in selected range', 'primary')}
        ${statCard('list', 'System events', d.systemAuditEvents ?? 0, 'tamper-evident log', 'info')}
        ${statCard('alert', 'Failed logins', d.failedLogins ?? 0, 'auth attempts', 'danger')}
        ${statCard('key', 'Sessions created', d.sessionsCreated ?? 0, `${d.sessionsActive ?? 0} active now`, 'success')}`;
    } catch {
      box.innerHTML = '';
    }
  }

  function readFilters(panel, kind) {
    const from = panel.querySelector('.audit-from')?.value || state[kind].from;
    const to = panel.querySelector('.audit-to')?.value || state[kind].to;
    Object.assign(state[kind], { from, to });
    if (kind === 'saml') {
      state.saml.q = panel.querySelector('.audit-q')?.value.trim() || '';
      state.saml.app = panel.querySelector('.audit-app')?.value.trim() || '';
      state.saml.binding = panel.querySelector('.audit-binding')?.value || '';
    } else if (kind === 'system') {
      state.system.q = panel.querySelector('.audit-q')?.value.trim() || '';
      state.system.actor = panel.querySelector('.audit-actor')?.value.trim() || '';
      state.system.action = panel.querySelector('.audit-action')?.value.trim() || '';
    } else if (kind === 'auth') {
      state.auth.q = panel.querySelector('.audit-q')?.value.trim() || '';
      state.auth.ip = panel.querySelector('.audit-ip')?.value.trim() || '';
      state.auth.success = panel.querySelector('.audit-success')?.value || '';
      state.auth.reason = panel.querySelector('.audit-reason')?.value.trim() || '';
    } else if (kind === 'sessions') {
      state.sessions.q = panel.querySelector('.audit-q')?.value.trim() || '';
      state.sessions.ip = panel.querySelector('.audit-ip')?.value.trim() || '';
      state.sessions.status = panel.querySelector('.audit-status')?.value || '';
      state.sessions.iss = panel.querySelector('.audit-iss')?.value || '';
    } else if (kind === 'provisioning') {
      state.provisioning.q = panel.querySelector('.audit-q')?.value.trim() || '';
      state.provisioning.app = panel.querySelector('.audit-app')?.value.trim() || '';
      state.provisioning.action = panel.querySelector('.audit-action')?.value || '';
      state.provisioning.status = panel.querySelector('.audit-status')?.value || '';
    }
    return state[kind];
  }

  function wireFilterChrome(panel, kind, reload) {
    panel.querySelectorAll('.audit-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const days = Number(btn.dataset.days) || 30;
        panel.querySelector('.audit-from').value = isoDateDaysAgo(days);
        panel.querySelector('.audit-to').value = todayIso();
        state[kind].offset = 0;
        void reload();
      });
    });
    panel.querySelector('.audit-apply')?.addEventListener('click', () => {
      state[kind].offset = 0;
      void reload();
    });
    panel.querySelector('.audit-reset')?.addEventListener('click', () => {
      state[kind] = {
        ...state[kind],
        from: isoDateDaysAgo(30), to: todayIso(), q: '', app: '', binding: '', actor: '', action: '', ip: '',
        success: '', reason: '', status: '', iss: '', offset: 0,
      };
      void reload(true);
    });
    panel.querySelector('.audit-export')?.addEventListener('click', async () => {
      const f = readFilters(panel, kind);
      const params = { from: f.from, to: f.to, limit: '10000' };
      if (kind === 'saml') {
        if (f.q) params.q = f.q;
        if (f.app) params.app = f.app;
        if (f.binding) params.binding = f.binding;
      } else if (kind === 'system') {
        if (f.q) params.q = f.q;
        if (f.actor) params.actor = f.actor;
        if (f.action) params.action = f.action;
      } else if (kind === 'sessions') {
        if (f.q) params.q = f.q;
        if (f.ip) params.ip = f.ip;
        if (f.status) params.status = f.status;
        if (f.iss) params.iss = f.iss;
      } else if (kind === 'provisioning') {
        if (f.q) params.q = f.q;
        if (f.app) params.app = f.app;
        if (f.action) params.action = f.action;
        if (f.status) params.status = f.status;
      } else {
        if (f.q) params.q = f.q;
        if (f.ip) params.ip = f.ip;
        if (f.success) params.success = f.success;
        if (f.reason) params.reason = f.reason;
      }
      const pathKind = kind === 'auth' ? 'auth-attempts'
        : kind === 'system' ? 'system'
        : kind === 'sessions' ? 'sessions'
        : kind === 'provisioning' ? 'app-provisioning'
        : 'saml';
      try {
        await downloadAuditCsv(api.auditExportUrl(pathKind, params), `${pathKind}-${f.from}-${f.to}.csv`);
      } catch (err) {
        alert(err.message || 'Export failed');
      }
    });
  }

  function pagerHtml(meta, offset, limit) {
    const total = meta?.total ?? 0;
    const page = Math.floor(offset / limit) + 1;
    const pages = Math.max(1, Math.ceil(total / limit));
    return `<div class="audit-pager">
      <button type="button" class="btn btn-sm btn-secondary audit-prev" ${offset <= 0 ? 'disabled' : ''}>Previous</button>
      <span class="muted">Page ${page} of ${pages} · ${total} total</span>
      <button type="button" class="btn btn-sm btn-secondary audit-next" ${offset + limit >= total ? 'disabled' : ''}>Next</button>
    </div>`;
  }

  async function loadSaml(rebuild = false) {
    const t = panels.saml;
    if (rebuild || !t.querySelector('.audit-filter-panel')) {
      t.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">User / email</label>
          <input class="form-input audit-q" placeholder="name or email" value="${esc(state.saml.q)}"></div>
        <div class="form-group"><label class="form-label">Application</label>
          <input class="form-input audit-app" placeholder="app name or slug" value="${esc(state.saml.app)}"></div>
        <div class="form-group"><label class="form-label">Binding</label>
          <select class="form-select audit-binding">
            <option value="">All</option>
            <option value="POST" ${state.saml.binding === 'POST' ? 'selected' : ''}>POST</option>
            <option value="REDIRECT" ${state.saml.binding === 'REDIRECT' ? 'selected' : ''}>REDIRECT</option>
            <option value="IDP_INITIATED" ${state.saml.binding === 'IDP_INITIATED' ? 'selected' : ''}>IDP_INITIATED</option>
          </select></div>`)}
        <div class="audit-table-area"><div class="loading-row"><span class="spinner"></span></div></div>`;
      wireFilterChrome(t, 'saml', (rb) => loadSaml(!!rb));
    }
    const area = t.querySelector('.audit-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const f = readFilters(t, 'saml');
      await refreshSummary(f.from, f.to);
      const params = { from: f.from, to: f.to, limit: String(f.limit), offset: String(f.offset) };
      if (f.q) params.q = f.q;
      if (f.app) params.app = f.app;
      if (f.binding) params.binding = f.binding;
      const r = await api.samlAudit(params);
      const rows = r.data || [];
      const meta = r.meta || {};
      t.querySelector('.audit-meta-count').textContent = `${meta.total ?? rows.length} matching assertions`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th><th>Request ID</th><th>Relay state</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.ts)}</td>
              <td class="cell-strong">${esc(row.sp_name)}<br><span class="muted" style="font-size:0.75rem">${esc(row.sp_slug || '')}</span></td>
              <td>${esc(row.emp_name || row.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(row.emp_email || '')}</span></td>
              <td><span class="badge badge-info">${esc(row.binding)}</span></td>
              <td class="muted truncate" title="${esc(row.request_id || '')}">${esc(row.request_id || '—')}</td>
              <td class="muted truncate" title="${esc(row.relay_state || '')}">${esc(row.relay_state || '—')}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(meta, f.offset, f.limit)}`
        : `<div class="card empty-state"><span class="empty-icon">⌖</span>No SSO assertions for this filter</div>`;
      area.querySelector('.audit-prev')?.addEventListener('click', () => {
        state.saml.offset = Math.max(0, state.saml.offset - state.saml.limit);
        void loadSaml();
      });
      area.querySelector('.audit-next')?.addEventListener('click', () => {
        state.saml.offset += state.saml.limit;
        void loadSaml();
      });
    } catch (err) {
      area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function loadSystem(rebuild = false) {
    const t = panels.system;
    if (rebuild || !t.querySelector('.audit-filter-panel')) {
      t.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">Search</label>
          <input class="form-input audit-q" placeholder="actor, action, target, payload" value="${esc(state.system.q)}"></div>
        <div class="form-group"><label class="form-label">Actor</label>
          <input class="form-input audit-actor" placeholder="emp id / system" value="${esc(state.system.actor)}"></div>
        <div class="form-group"><label class="form-label">Action</label>
          <input class="form-input audit-action" placeholder="e.g. MFA_DISABLE" value="${esc(state.system.action)}"></div>`,
        `<button type="button" class="btn btn-sm btn-secondary" id="audit-verify-chain">Verify integrity</button>`)}
        <div id="audit-integrity-msg"></div>
        <div class="audit-table-area"><div class="loading-row"><span class="spinner"></span></div></div>`;
      wireFilterChrome(t, 'system', (rb) => loadSystem(!!rb));
      t.querySelector('#audit-verify-chain')?.addEventListener('click', async () => {
        const msg = t.querySelector('#audit-integrity-msg');
        msg.innerHTML = `<div class="muted" style="padding:0.5rem 0">Verifying hash chain…</div>`;
        try {
          const r = await api.auditIntegrity(2000);
          const d = r.data || {};
          msg.innerHTML = d.valid
            ? `<div class="alert alert-success">Hash chain intact — checked ${d.checked} rows.</div>`
            : `<div class="alert alert-error">Integrity failure at id ${esc(String(d.firstInvalidId))} (checked ${d.checked}).</div>`;
        } catch (err) {
          msg.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
        }
      });
    }
    const area = t.querySelector('.audit-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const f = readFilters(t, 'system');
      await refreshSummary(f.from, f.to);
      const params = { from: f.from, to: f.to, limit: String(f.limit), offset: String(f.offset) };
      if (f.q) params.q = f.q;
      if (f.actor) params.actor = f.actor;
      if (f.action) params.action = f.action;
      const r = await api.systemAudit(params);
      const rows = r.data || [];
      const meta = r.meta || {};
      t.querySelector('.audit-meta-count').textContent = `${meta.total ?? rows.length} matching events`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
            <tbody>${rows.map((row, idx) => {
              let payload = row.payload;
              if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch { /* keep string */ }
              }
              const payloadStr = payload == null ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
              return `<tr>
                <td class="muted">${fmtDate(row.ts)}</td>
                <td class="cell-strong">${esc(row.actor)}</td>
                <td><code>${esc(row.action)}</code></td>
                <td>${esc(row.target || '—')}</td>
                <td>${payloadStr
                  ? `<button type="button" class="btn btn-sm btn-secondary audit-payload-btn" data-idx="${idx}">View</button>
                     <pre class="audit-payload is-hidden" data-payload-idx="${idx}">${esc(payloadStr)}</pre>`
                  : '<span class="muted">—</span>'}</td>
              </tr>`;
            }).join('')}</tbody></table></div>${pagerHtml(meta, f.offset, f.limit)}`
        : `<div class="card empty-state">No audit entries for this filter</div>`;
      area.querySelectorAll('.audit-payload-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pre = area.querySelector(`[data-payload-idx="${btn.dataset.idx}"]`);
          if (!pre) return;
          pre.classList.toggle('is-hidden');
          btn.textContent = pre.classList.contains('is-hidden') ? 'View' : 'Hide';
        });
      });
      area.querySelector('.audit-prev')?.addEventListener('click', () => {
        state.system.offset = Math.max(0, state.system.offset - state.system.limit);
        void loadSystem();
      });
      area.querySelector('.audit-next')?.addEventListener('click', () => {
        state.system.offset += state.system.limit;
        void loadSystem();
      });
    } catch (err) {
      area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function loadAuth(rebuild = false) {
    const t = panels.auth;
    if (rebuild || !t.querySelector('.audit-filter-panel')) {
      t.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">Email</label>
          <input class="form-input audit-q" placeholder="user@lenskart.com" value="${esc(state.auth.q)}"></div>
        <div class="form-group"><label class="form-label">IP</label>
          <input class="form-input audit-ip" placeholder="client IP" value="${esc(state.auth.ip)}"></div>
        <div class="form-group"><label class="form-label">Result</label>
          <select class="form-select audit-success">
            <option value="">All</option>
            <option value="1" ${state.auth.success === '1' ? 'selected' : ''}>Success</option>
            <option value="0" ${state.auth.success === '0' ? 'selected' : ''}>Failed</option>
          </select></div>
        <div class="form-group"><label class="form-label">Reason</label>
          <input class="form-input audit-reason" placeholder="invalid_password, mfa_required…" value="${esc(state.auth.reason)}"></div>`)}
        <div class="audit-table-area"><div class="loading-row"><span class="spinner"></span></div></div>`;
      wireFilterChrome(t, 'auth', (rb) => loadAuth(!!rb));
    }
    const area = t.querySelector('.audit-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const f = readFilters(t, 'auth');
      await refreshSummary(f.from, f.to);
      const params = { from: f.from, to: f.to, limit: String(f.limit), offset: String(f.offset) };
      if (f.q) params.q = f.q;
      if (f.ip) params.ip = f.ip;
      if (f.success) params.success = f.success;
      if (f.reason) params.reason = f.reason;
      const r = await api.authAttemptsAudit(params);
      const rows = r.data || [];
      const meta = r.meta || {};
      t.querySelector('.audit-meta-count').textContent = `${meta.total ?? rows.length} matching attempts`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Email</th><th>IP</th><th>Result</th><th>Reason</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.ts)}</td>
              <td class="cell-strong">${esc(row.email || '—')}</td>
              <td class="muted" style="font-family:var(--mono,monospace)">${esc(row.ip || '—')}</td>
              <td>${row.success ? '<span class="badge badge-success">Success</span>' : '<span class="badge badge-danger">Failed</span>'}</td>
              <td><code>${esc(row.reason || '—')}</code></td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(meta, f.offset, f.limit)}`
        : `<div class="card empty-state">No auth attempts for this filter</div>`;
      area.querySelector('.audit-prev')?.addEventListener('click', () => {
        state.auth.offset = Math.max(0, state.auth.offset - state.auth.limit);
        void loadAuth();
      });
      area.querySelector('.audit-next')?.addEventListener('click', () => {
        state.auth.offset += state.auth.limit;
        void loadAuth();
      });
    } catch (err) {
      area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  function sessionStatusBadge(status) {
    if (status === 'active') return '<span class="badge badge-success">Active</span>';
    if (status === 'revoked') return '<span class="badge badge-danger">Revoked</span>';
    if (status === 'expired') return '<span class="badge badge-neutral">Expired</span>';
    return `<span class="badge badge-neutral">${esc(status || '—')}</span>`;
  }

  function fmtDurationMinutes(mins) {
    const n = Number(mins);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  async function loadSessions(rebuild = false) {
    const t = panels.sessions;
    if (rebuild || !t.querySelector('.audit-filter-panel')) {
      t.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">User / email</label>
          <input class="form-input audit-q" placeholder="name, email, emp id" value="${esc(state.sessions.q)}"></div>
        <div class="form-group"><label class="form-label">IP</label>
          <input class="form-input audit-ip" placeholder="client IP" value="${esc(state.sessions.ip)}"></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select class="form-select audit-status">
            <option value="">All</option>
            <option value="active" ${state.sessions.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="revoked" ${state.sessions.status === 'revoked' ? 'selected' : ''}>Revoked</option>
            <option value="expired" ${state.sessions.status === 'expired' ? 'selected' : ''}>Expired</option>
          </select></div>
        <div class="form-group"><label class="form-label">Issuer</label>
          <select class="form-select audit-iss">
            <option value="">All</option>
            <option value="local" ${state.sessions.iss === 'local' ? 'selected' : ''}>local</option>
            <option value="google" ${state.sessions.iss === 'google' ? 'selected' : ''}>google</option>
          </select></div>`)}
        <div class="audit-table-area"><div class="loading-row"><span class="spinner"></span></div></div>`;
      wireFilterChrome(t, 'sessions', (rb) => loadSessions(!!rb));
    }
    const area = t.querySelector('.audit-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const f = readFilters(t, 'sessions');
      await refreshSummary(f.from, f.to);
      const params = { from: f.from, to: f.to, limit: String(f.limit), offset: String(f.offset) };
      if (f.q) params.q = f.q;
      if (f.ip) params.ip = f.ip;
      if (f.status) params.status = f.status;
      if (f.iss) params.iss = f.iss;
      const r = await api.sessionsAudit(params);
      const rows = r.data || [];
      const meta = r.meta || {};
      t.querySelector('.audit-meta-count').textContent = `${meta.total ?? rows.length} matching sessions`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr>
              <th>Created</th><th>User</th><th>Status</th><th>Issuer</th><th>IP</th>
              <th>Device / Geo</th><th>Last active</th><th>Duration</th><th></th>
            </tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted" style="white-space:nowrap">${fmtDate(row.created_at)}</td>
              <td class="cell-strong">${esc(row.emp_name || row.emp_id || '—')}<br>
                <span class="muted" style="font-size:0.75rem">${esc(row.email || row.emp_email || '')}</span><br>
                <code style="font-size:0.7rem">${esc(String(row.session_id || '').slice(0, 8))}…</code>
              </td>
              <td>${sessionStatusBadge(row.status)}</td>
              <td><span class="badge badge-neutral">${esc(row.iss || '—')}</span><br>
                <span class="muted" style="font-size:0.75rem">${esc(row.role || '')}</span></td>
              <td class="muted" style="font-family:var(--mono,monospace);font-size:0.8rem">${esc(row.ip || '—')}</td>
              <td class="muted" style="font-size:0.8rem;max-width:180px">
                ${esc(row.device_info || '—')}<br>${esc(row.geo_location || '')}
              </td>
              <td class="muted" style="white-space:nowrap;font-size:0.8rem">${fmtDate(row.last_active_at)}</td>
              <td class="muted">${esc(fmtDurationMinutes(row.duration_minutes))}</td>
              <td>${row.status === 'active'
                ? `<button type="button" class="btn btn-sm btn-danger sess-revoke" data-id="${esc(String(row.session_id))}">Revoke</button>`
                : ''}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(meta, f.offset, f.limit)}`
        : `<div class="card empty-state"><span class="empty-icon">◎</span>No sessions for this filter</div>`;
      area.querySelectorAll('.sess-revoke').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Force-logout this session? The user will need to sign in again.')) return;
          try {
            await api.revokeAuditSession(btn.dataset.id);
            void loadSessions();
          } catch (err) {
            alert(err.message || 'Revoke failed');
          }
        });
      });
      area.querySelector('.audit-prev')?.addEventListener('click', () => {
        state.sessions.offset = Math.max(0, state.sessions.offset - state.sessions.limit);
        void loadSessions();
      });
      area.querySelector('.audit-next')?.addEventListener('click', () => {
        state.sessions.offset += state.sessions.limit;
        void loadSessions();
      });
    } catch (err) {
      area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  function provStatusBadge(status) {
    if (status === 'SUCCESS') return '<span class="badge badge-success">Success</span>';
    if (status === 'FAILED') return '<span class="badge badge-danger">Failed</span>';
    if (status === 'SKIPPED') return '<span class="badge badge-neutral">Skipped</span>';
    return `<span class="badge badge-neutral">${esc(status || '—')}</span>`;
  }

  function provActionBadge(action) {
    if (action === 'PROVISION') return '<span class="badge badge-success">Provision</span>';
    if (action === 'DEPROVISION') return '<span class="badge badge-danger">Deprovision</span>';
    return `<span class="badge badge-info">${esc(action || '—')}</span>`;
  }

  function formatJsonCell(raw) {
    if (raw == null || raw === '') return '—';
    let obj = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch { return esc(raw); }
    }
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return `<code class="muted" style="font-size:0.72rem;white-space:pre-wrap;display:block;max-width:220px">${esc(s)}</code>`;
  }

  async function loadProvisioning(rebuild = false) {
    const t = panels.provisioning;
    if (rebuild || !t.querySelector('.audit-filter-panel')) {
      t.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">User / email</label>
          <input class="form-input audit-q" placeholder="name, email, endpoint" value="${esc(state.provisioning.q)}"></div>
        <div class="form-group"><label class="form-label">Application</label>
          <input class="form-input audit-app" placeholder="app name or slug" value="${esc(state.provisioning.app)}"></div>
        <div class="form-group"><label class="form-label">Action</label>
          <select class="form-select audit-action">
            <option value="">All</option>
            <option value="PROVISION" ${state.provisioning.action === 'PROVISION' ? 'selected' : ''}>Provision</option>
            <option value="DEPROVISION" ${state.provisioning.action === 'DEPROVISION' ? 'selected' : ''}>Deprovision</option>
          </select></div>
        <div class="form-group"><label class="form-label">Result</label>
          <select class="form-select audit-status">
            <option value="">All</option>
            <option value="SUCCESS" ${state.provisioning.status === 'SUCCESS' ? 'selected' : ''}>Success</option>
            <option value="FAILED" ${state.provisioning.status === 'FAILED' ? 'selected' : ''}>Failed</option>
            <option value="SKIPPED" ${state.provisioning.status === 'SKIPPED' ? 'selected' : ''}>Skipped</option>
          </select></div>`)}
        <p class="muted" style="font-size:0.8rem;margin:0 0 0.75rem">For <strong>SAML apps</strong> (e.g. Slack): access grant/revoke is logged with the SP ACS URL; each SSO login logs a <code>SAML_ASSERTION</code> row when the assertion is POSTed to the application. SCIM apps log outbound API calls when SCIM provisioning is enabled.</p>
        <div class="audit-table-area"><div class="loading-row"><span class="spinner"></span></div></div>`;
      wireFilterChrome(t, 'provisioning', (rb) => loadProvisioning(!!rb));
    }
    const area = t.querySelector('.audit-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const f = readFilters(t, 'provisioning');
      await refreshSummary(f.from, f.to);
      const params = { from: f.from, to: f.to, limit: String(f.limit), offset: String(f.offset) };
      if (f.q) params.q = f.q;
      if (f.app) params.app = f.app;
      if (f.action) params.action = f.action;
      if (f.status) params.status = f.status;
      const r = await api.appProvisionAudit(params);
      const rows = r.data || [];
      const meta = r.meta || {};
      t.querySelector('.audit-meta-count').textContent = `${meta.total ?? rows.length} provision events`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Action</th><th>Application</th><th>User</th><th>Source</th><th>Endpoint</th><th>Result</th><th>Detail</th><th>Response</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.created_at)}</td>
              <td>${provActionBadge(row.action)}</td>
              <td class="cell-strong">${esc(row.app_name || '—')}<br><span class="muted" style="font-size:0.75rem">${esc(row.app_slug || '')}</span></td>
              <td>${esc(row.emp_name || row.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(row.emp_email || '')}</span></td>
              <td><span class="badge badge-neutral">${esc(row.source || '—')}</span></td>
              <td><span class="badge badge-info">${esc(row.http_method || '—')}</span><br><span class="muted truncate" style="font-size:0.72rem;font-family:var(--mono,monospace)" title="${esc(row.endpoint || '')}">${esc(row.endpoint || '—')}</span></td>
              <td>${provStatusBadge(row.status)}${row.status_code ? `<br><span class="muted">${esc(String(row.status_code))}</span>` : ''}</td>
              <td class="muted" style="font-size:0.78rem">${esc(row.detail || '—')}</td>
              <td>${formatJsonCell(row.response_body)}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(meta, f.offset, f.limit)}`
        : `<div class="card empty-state"><span class="empty-icon">⌖</span>No provisioning events for this filter</div>`;
      area.querySelector('.audit-prev')?.addEventListener('click', () => {
        state.provisioning.offset = Math.max(0, state.provisioning.offset - state.provisioning.limit);
        void loadProvisioning();
      });
      area.querySelector('.audit-next')?.addEventListener('click', () => {
        state.provisioning.offset += state.provisioning.limit;
        void loadProvisioning();
      });
    } catch (err) {
      area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function showTab(name) {
    wrap.querySelectorAll('#audit-tabs .inline-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    for (const [id, panel] of Object.entries(panels)) panel.hidden = id !== name;
    syncAppUrl('audit', name, 'saml');
    if (name === 'saml') await loadSaml(true);
    else if (name === 'system') await loadSystem(true);
    else if (name === 'auth') await loadAuth(true);
    else if (name === 'sessions') await loadSessions(true);
    else if (name === 'sso') {
      panels.sso.innerHTML = '';
      await viewSsoReports(panels.sso, { embed: true });
    }
    else if (name === 'provisioning') await loadProvisioning(true);
  }
  wrap.querySelector('#audit-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) void showTab(btn.dataset.tab);
  });
  await showTab(validTab);
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
          <option value="ALERT">Alert (warn)</option>
          <option value="MONITOR">Monitor only</option>
          <option value="REQUIRE_APPROVAL">Require approval</option>
          <option value="PREVENT">Prevent grant</option>
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
    bd.querySelector('#sp-save').addEventListener('click', async () => {
      let conflictGroups;
      try { conflictGroups = JSON.parse(bd.querySelector('#sp-groups').value || '[]'); }
      catch { bd.querySelector('#sp-err').innerHTML = `<div class="alert alert-error">Conflict Groups must be valid JSON</div>`; return; }
      const data = {
        name:          bd.querySelector('#sp-name').value.trim(),
        description:   bd.querySelector('#sp-desc').value,
        severity:      bd.querySelector('#sp-sev').value,
        enforcement:   bd.querySelector('#sp-enf').value,
        conflict_groups: conflictGroups,
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
        : `<div class="card empty-state"><span class="empty-icon">◆</span>No risk scores yet. Attendance-based suspensions are owned by <strong>Attendance IGA</strong> when enabled; legacy <code>/risk-scan</code> is skipped in that mode.</div>`}`;
  } catch (err) { wrap.querySelector('#rk').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
}

/* ---------- Enterprise Reports Hub ---------- */
const REPORT_CATALOG = [
  { key: 'govReports', tab: 'inventory',  icon: 'key',         title: 'Access inventory',     desc: 'Who has which apps, roles, and entitlements', cat: 'Identity' },
  { key: 'govReports', tab: 'mfa',        icon: 'fingerprint', title: 'MFA coverage',         desc: 'Enrollment gaps across active identities', cat: 'Identity' },
  { key: 'govReports', tab: 'lifecycle',  icon: 'refresh',     title: 'Lifecycle events',     desc: 'Suspend, terminate, rehire, mover evidence', cat: 'Identity' },
  { key: 'govReports', tab: 'requests',   icon: 'check',       title: 'Access requests',      desc: 'Volume, SLA breaches, and outcomes', cat: 'Governance' },
  { key: 'govReports', tab: 'certs',      icon: 'certificate', title: 'Certifications',       desc: 'Campaign completion and revoke rates', cat: 'Governance' },
  { key: 'govReports', tab: 'sod',        icon: 'split',       title: 'SoD violations',       desc: 'Toxic combinations and exceptions', cat: 'Governance' },
  { key: 'govReports', tab: 'appaccess',  icon: 'catalog',     title: 'App access changes',   desc: 'Assign / revoke / approve audit trail', cat: 'Governance' },
  { key: 'audit',      tab: 'saml',       icon: 'saml',        title: 'SSO assertions',       desc: 'SAML assertion log with CSV export', cat: 'Auth & SSO' },
  { key: 'audit',      tab: 'system',     icon: 'list',        title: 'System audit',         desc: 'Tamper-evident hash-chained audit log', cat: 'Auth & SSO' },
  { key: 'audit',      tab: 'auth',       icon: 'lock',        title: 'Auth attempts',        desc: 'Login forensics and failure reasons', cat: 'Auth & SSO' },
  { key: 'audit',      tab: 'sessions',   icon: 'activity',    title: 'Sessions',             desc: 'Portal session history and force-logout', cat: 'Auth & SSO' },
  { key: 'audit',      tab: 'sso',        icon: 'dashboard',   title: 'SSO analytics',        desc: 'Adoption, dormant users, failed logins', cat: 'Auth & SSO' },
  { key: 'reports',    tab: '',           icon: 'certificate', title: 'Compliance evidence',  desc: 'SOX / GDPR / HIPAA / PCI JSON snapshots', cat: 'Compliance' },
];

export async function viewReportsHub(content) {
  content.replaceChildren(el(`<div class="ent-page"><div class="loading-row"><span class="spinner"></span></div></div>`));
  let ov;
  try {
    ov = await api.reportsOverview({ days: '30' });
  } catch (err) {
    content.replaceChildren(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }
  const d = ov.data || {};
  const k = d.kpis || {};
  const series = d.series || { logins: [], sso: [], failed: [] };
  const loginS = build30DaySeries(series.logins);
  const ssoS = build30DaySeries(series.sso);
  const failS = build30DaySeries(series.failed);
  const labels = loginS.map((p) => fmtShortDate(p.d));
  const lineSvg = renderLineChart({
    series: [loginS.map((p) => p.n), ssoS.map((p) => p.n), failS.map((p) => p.n)],
    labels,
    colors: ['primary', 'accent', 'danger'],
  });
  const reqSlices = (d.accessRequestsByStatus || []).map((s) => ({
    label: s.status,
    value: s.n,
    color: ({ PENDING: 'var(--warning)', APPROVED: 'var(--success)', FULFILLED: 'var(--success)', REJECTED: 'var(--danger)', CANCELLED: 'var(--text-dim)' })[s.status] || 'var(--info)',
  }));
  const donut = renderDonut(reqSlices.length ? reqSlices : [{ label: 'None', value: 1, color: 'var(--text-dim)' }], 'Requests');
  const topApps = (d.topApps || []).map((a) => `<tr>
    <td class="cell-strong">${esc(a.name)}</td>
    <td><code>${esc(a.slug)}</code></td>
    <td>${a.n}</td>
  </tr>`).join('');
  const camps = (d.certificationCampaigns || []).map((c) => `<tr>
    <td class="cell-strong">${esc(c.name)}</td>
    <td><span class="badge badge-info">${esc(c.status)}</span></td>
    <td>${c.completionPct}%</td>
    <td class="muted">${c.certified} certify · ${c.revoked} revoke · ${c.pending} pending</td>
  </tr>`).join('');

  const catalogByCat = {};
  for (const r of REPORT_CATALOG) {
    (catalogByCat[r.cat] ||= []).push(r);
  }
  const catalogHtml = Object.entries(catalogByCat).map(([cat, items]) => `
    <div class="report-cat">
      <h3 class="report-cat-title">${esc(cat)}</h3>
      <div class="report-catalog-grid">
        ${items.map((r) => `
          <button type="button" class="report-catalog-card" data-nav="${esc(r.key)}" data-tab="${esc(r.tab || '')}">
            <span class="report-catalog-icon">${svgIcon(r.icon)}</span>
            <span class="report-catalog-body">
              <span class="report-catalog-title">${esc(r.title)}</span>
              <span class="report-catalog-desc">${esc(r.desc)}</span>
            </span>
          </button>`).join('')}
      </div>
    </div>`).join('');

  const wrap = el(`<div class="ent-page">
    ${header('Reports Overview', 'Enterprise identity reporting — KPIs, trends, and the full report catalog')}
    <section class="stat-grid">
      ${statCard('users', 'Active users', k.activeUsers ?? 0, `${k.dormantUsers ?? 0} dormant (30d)`, 'primary')}
      ${statCard('fingerprint', 'MFA coverage', `${k.mfaCoveragePct ?? 0}%`, `${k.mfaCovered ?? 0} enrolled`, 'purple', 'govReports', 'mfa')}
      ${statCard('saml', 'SSO assertions', k.ssoAssertions ?? 0, 'last 30 days', 'accent', 'audit', 'saml')}
      ${statCard('alert', 'Failed logins', k.failedLogins ?? 0, 'last 30 days', 'danger', 'audit', 'auth')}
      ${statCard('activity', 'Active sessions', k.activeSessions ?? 0, 'live now', 'success', 'audit', 'sessions')}
      ${statCard('check', 'Pending requests', k.pendingAccessRequests ?? 0, 'awaiting approval', 'warning', 'govReports', 'requests')}
      ${statCard('certificate', 'Review items', k.pendingReviewItems ?? 0, 'pending certify/revoke', 'info', 'govReports', 'certs')}
      ${statCard('split', 'SoD open', k.openSodViolations ?? 0, 'violations', 'danger', 'govReports', 'sod')}
      ${statCard('key', 'App assignments', k.activeAppAssignments ?? 0, 'active grants', 'teal', 'govReports', 'inventory')}
    </section>

    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title">Authentication & SSO trend</div>
          <div class="chart-meta">Last 30 days</div>
        </div>
        ${lineSvg}
        <div class="legend">
          <span><span class="swatch primary"></span>Successful logins</span>
          <span><span class="swatch accent"></span>SSO assertions</span>
          <span><span class="swatch danger"></span>Failed logins</span>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-header"><div class="chart-title">Access requests (30d)</div></div>
        <div class="donut-wrap">${donut}</div>
      </div>
    </div>

    <div class="grid-main-side" style="margin-top:1rem">
      <div class="card">
        <h2>Top applications</h2>
        <p class="subtitle" style="margin-bottom:0.75rem">SSO assertions in the last 30 days</p>
        ${topApps
          ? `<div class="table-wrap"><table><thead><tr><th>App</th><th>Slug</th><th>Logins</th></tr></thead><tbody>${topApps}</tbody></table></div>`
          : `<div class="empty-state">No SSO data yet</div>`}
      </div>
      <div class="card">
        <h2>Certification campaigns</h2>
        <p class="subtitle" style="margin-bottom:0.75rem">Completion posture</p>
        ${camps
          ? `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Done</th><th>Breakdown</th></tr></thead><tbody>${camps}</tbody></table></div>`
          : `<div class="empty-state">No campaigns yet</div>`}
      </div>
    </div>

    <section class="report-catalog" style="margin-top:1.5rem">
      <h2 style="margin-bottom:0.25rem">Report catalog</h2>
      <p class="subtitle" style="margin-bottom:1rem">Open any report with filters and CSV export for auditors</p>
      ${catalogHtml}
    </section>
  </div>`);
  content.replaceChildren(wrap);

  wrap.querySelectorAll('.report-catalog-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (!window.LILG_NAV) return;
      const tab = card.dataset.tab;
      window.LILG_NAV(card.dataset.nav, tab ? { tab } : {});
    });
  });
  bindStatCardNav(wrap);
}

/* ---------- Identity & Access governance reports ---------- */
export async function viewGovReports(content, initialTab = 'inventory') {
  const tabs = [
    { id: 'inventory', label: 'Access inventory' },
    { id: 'mfa', label: 'MFA coverage' },
    { id: 'lifecycle', label: 'Lifecycle' },
    { id: 'requests', label: 'Access requests' },
    { id: 'certs', label: 'Certifications' },
    { id: 'sod', label: 'SoD violations' },
    { id: 'appaccess', label: 'App access changes' },
  ];
  const validTab = tabs.some((t) => t.id === initialTab) ? initialTab : 'inventory';
  const wrap = el(`<div class="ent-page">
    ${header('Identity & Access Reports', 'Governance evidence — inventory, MFA, lifecycle, requests, certifications, and SoD')}
    <div class="inline-tabs" id="gov-tabs" style="margin-bottom:1rem">
      ${tabs.map((t) => `<button type="button" class="inline-tab${t.id === validTab ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="gov-panel"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`);
  content.replaceChildren(wrap);
  const panel = wrap.querySelector('#gov-panel');
  let active = validTab;
  const state = {
    inventory: { q: '', kind: '', department: '', offset: 0, limit: 50 },
    mfa: { q: '', enrolled: '', offset: 0, limit: 50 },
    lifecycle: { from: isoDateDaysAgo(90), to: todayIso(), q: '', eventType: '', offset: 0, limit: 50 },
    requests: { from: isoDateDaysAgo(90), to: todayIso(), q: '', status: '', offset: 0, limit: 50 },
    certs: { status: '', offset: 0, limit: 50 },
    sod: { q: '', status: 'OPEN', severity: '', offset: 0, limit: 50 },
    appaccess: { from: isoDateDaysAgo(90), to: todayIso(), q: '', action: '', offset: 0, limit: 50 },
  };

  wrap.querySelectorAll('#gov-tabs .inline-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      active = btn.dataset.tab;
      wrap.querySelectorAll('#gov-tabs .inline-tab').forEach((b) => b.classList.toggle('active', b === btn));
      syncAppUrl('govReports', active, 'inventory');
      void loadTab(true);
    });
  });

  function pagerHtml(meta, offset, limit) {
    const total = meta?.total ?? 0;
    const page = Math.floor(offset / limit) + 1;
    const pages = Math.max(1, Math.ceil(total / limit));
    return `<div class="audit-pager">
      <button type="button" class="btn btn-sm btn-secondary gov-prev" ${offset <= 0 ? 'disabled' : ''}>Previous</button>
      <span class="muted">Page ${page} of ${pages} · ${total} total</span>
      <button type="button" class="btn btn-sm btn-secondary gov-next" ${offset + limit >= total ? 'disabled' : ''}>Next</button>
    </div>`;
  }

  async function exportCsv(kind, params) {
    try {
      await downloadAuditCsv(api.reportExportUrl(kind, { ...params, limit: '10000' }), `${kind}.csv`);
    } catch (err) {
      alert(err.message || 'Export failed');
    }
  }

  async function loadInventory(rebuild) {
    const s = state.inventory;
    if (rebuild || !panel.querySelector('.gov-inv-filters')) {
      panel.innerHTML = `<div class="ent-panel gov-inv-filters">
        <div class="ent-panel-body">
          <div class="audit-filter-grid">
            <div class="form-group"><label class="form-label">Search</label>
              <input class="form-input gov-q" placeholder="user, email, access name" value="${esc(s.q)}"></div>
            <div class="form-group"><label class="form-label">Kind</label>
              <select class="form-select gov-kind">
                <option value="">All</option>
                <option value="APP" ${s.kind === 'APP' ? 'selected' : ''}>Apps</option>
                <option value="ROLE" ${s.kind === 'ROLE' ? 'selected' : ''}>Roles</option>
                <option value="ENTITLEMENT" ${s.kind === 'ENTITLEMENT' ? 'selected' : ''}>Entitlements</option>
              </select></div>
            <div class="form-group"><label class="form-label">Department</label>
              <input class="form-input gov-dept" value="${esc(s.department)}"></div>
          </div>
          <div class="audit-filter-actions">
            <button type="button" class="btn btn-primary gov-apply">Apply</button>
            <button type="button" class="btn btn-secondary gov-export">Export CSV</button>
            <span class="muted audit-meta-count" style="margin-left:auto;font-size:0.8rem"></span>
          </div>
        </div>
      </div><div class="gov-table-area"><div class="loading-row"><span class="spinner"></span></div></div>`;
      panel.querySelector('.gov-apply').addEventListener('click', () => { s.offset = 0; void loadInventory(); });
      panel.querySelector('.gov-export').addEventListener('click', () => {
        s.q = panel.querySelector('.gov-q').value.trim();
        s.kind = panel.querySelector('.gov-kind').value;
        s.department = panel.querySelector('.gov-dept').value.trim();
        void exportCsv('access-inventory', { q: s.q, kind: s.kind, department: s.department });
      });
    }
    s.q = panel.querySelector('.gov-q')?.value.trim() || '';
    s.kind = panel.querySelector('.gov-kind')?.value || '';
    s.department = panel.querySelector('.gov-dept')?.value.trim() || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportAccessInventory({
        q: s.q, kind: s.kind, department: s.department,
        limit: String(s.limit), offset: String(s.offset),
      });
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} grants`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>User</th><th>Department</th><th>Kind</th><th>Access</th><th>Source</th><th>Granted</th><th>Expires</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="cell-strong">${esc(row.emp_name || row.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(row.emp_email || '')}</span></td>
              <td class="muted">${esc(row.department || '—')}</td>
              <td><span class="badge badge-info">${esc(row.access_kind)}</span></td>
              <td>${esc(row.access_name)}<br><span class="muted" style="font-size:0.75rem">${esc(row.access_ref || '')}</span></td>
              <td class="muted">${esc(row.source || '—')}</td>
              <td class="muted">${fmtDate(row.granted_at)}</td>
              <td class="muted">${row.expires_at ? fmtDate(row.expires_at) : '—'}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">No access grants match these filters</div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadInventory(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadInventory(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadMfa(rebuild) {
    const s = state.mfa;
    if (rebuild || !panel.querySelector('.gov-mfa-filters')) {
      panel.innerHTML = `<div id="gov-mfa-summary" class="stat-grid" style="margin-bottom:1rem"></div>
        <div class="ent-panel gov-mfa-filters"><div class="ent-panel-body">
          <div class="audit-filter-grid">
            <div class="form-group"><label class="form-label">Search</label>
              <input class="form-input gov-q" value="${esc(s.q)}"></div>
            <div class="form-group"><label class="form-label">Enrollment</label>
              <select class="form-select gov-enrolled">
                <option value="">All</option>
                <option value="1" ${s.enrolled === '1' ? 'selected' : ''}>Enrolled</option>
                <option value="0" ${s.enrolled === '0' ? 'selected' : ''}>Not enrolled</option>
              </select></div>
          </div>
          <div class="audit-filter-actions">
            <button type="button" class="btn btn-primary gov-apply">Apply</button>
            <button type="button" class="btn btn-secondary gov-export">Export CSV</button>
            <span class="muted audit-meta-count" style="margin-left:auto;font-size:0.8rem"></span>
          </div>
        </div></div><div class="gov-table-area"></div>`;
      panel.querySelector('.gov-apply').addEventListener('click', () => { s.offset = 0; void loadMfa(); });
      panel.querySelector('.gov-export').addEventListener('click', () => {
        s.q = panel.querySelector('.gov-q').value.trim();
        s.enrolled = panel.querySelector('.gov-enrolled').value;
        void exportCsv('mfa-coverage', { q: s.q, enrolled: s.enrolled });
      });
    }
    s.q = panel.querySelector('.gov-q')?.value.trim() || '';
    s.enrolled = panel.querySelector('.gov-enrolled')?.value || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportMfaCoverage({
        q: s.q, enrolled: s.enrolled, limit: String(s.limit), offset: String(s.offset),
      });
      const sum = r.meta?.summary || {};
      const sumBox = panel.querySelector('#gov-mfa-summary');
      if (sumBox) {
        sumBox.innerHTML = `
          ${statCard('users', 'Active users', sum.activeUsers ?? 0, '', 'primary')}
          ${statCard('fingerprint', 'Enrolled', sum.covered ?? 0, `${sum.coveragePct ?? 0}% coverage`, 'success')}
          ${statCard('alert', 'Gaps', sum.gaps ?? 0, 'need MFA enrollment', 'danger')}`;
      }
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} users`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>User</th><th>Department</th><th>Enrolled</th><th>Methods</th><th>Enrolled at</th><th>Last used</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="cell-strong">${esc(row.full_name || row.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(row.email_corp || '')}</span></td>
              <td class="muted">${esc(row.department || '—')}</td>
              <td>${row.enrolled ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-danger">No</span>'}</td>
              <td>${(row.methods || []).map((m) => `<span class="badge badge-info" style="margin-right:0.25rem">${esc(m)}</span>`).join('') || '—'}</td>
              <td class="muted">${row.enrolled_at ? fmtDate(row.enrolled_at) : '—'}</td>
              <td class="muted">${row.last_used_at ? fmtDate(row.last_used_at) : '—'}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">No users match</div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadMfa(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadMfa(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadLifecycle(rebuild) {
    const s = state.lifecycle;
    if (rebuild || !panel.querySelector('.audit-filter-panel')) {
      panel.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">Search</label>
          <input class="form-input audit-q" value="${esc(s.q)}"></div>
        <div class="form-group"><label class="form-label">Event</label>
          <select class="form-select gov-event">
            <option value="">All</option>
            ${['SUSPEND', 'UNSUSPEND', 'TERMINATE', 'REHIRE', 'MOVER'].map((e) =>
              `<option value="${e}" ${s.eventType === e ? 'selected' : ''}>${e}</option>`).join('')}
          </select></div>`)}
        <div class="gov-table-area"></div>`;
      panel.querySelector('.audit-from').value = s.from;
      panel.querySelector('.audit-to').value = s.to;
      const reload = (rb) => { s.offset = 0; void loadLifecycle(!!rb); };
      panel.querySelectorAll('.audit-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          panel.querySelector('.audit-from').value = isoDateDaysAgo(Number(btn.dataset.days) || 30);
          panel.querySelector('.audit-to').value = todayIso();
          reload();
        });
      });
      panel.querySelector('.audit-apply')?.addEventListener('click', () => reload());
      panel.querySelector('.audit-reset')?.addEventListener('click', () => {
        Object.assign(s, { from: isoDateDaysAgo(90), to: todayIso(), q: '', eventType: '', offset: 0 });
        void loadLifecycle(true);
      });
      panel.querySelector('.audit-export')?.addEventListener('click', () => {
        s.from = panel.querySelector('.audit-from').value;
        s.to = panel.querySelector('.audit-to').value;
        s.q = panel.querySelector('.audit-q').value.trim();
        s.eventType = panel.querySelector('.gov-event').value;
        void exportCsv('lifecycle', { from: s.from, to: s.to, q: s.q, eventType: s.eventType });
      });
    }
    s.from = panel.querySelector('.audit-from')?.value || s.from;
    s.to = panel.querySelector('.audit-to')?.value || s.to;
    s.q = panel.querySelector('.audit-q')?.value.trim() || '';
    s.eventType = panel.querySelector('.gov-event')?.value || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportLifecycle({
        from: s.from, to: s.to, q: s.q, eventType: s.eventType,
        limit: String(s.limit), offset: String(s.offset),
      });
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} events`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>User</th><th>Event</th><th>State change</th><th>Initiated by</th><th>Reason</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.ts)}</td>
              <td class="cell-strong">${esc(row.full_name || row.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(row.email_corp || '')}</span></td>
              <td><span class="badge badge-info">${esc(row.event_type)}</span>${row.source === 'fsm' ? ' <span class="badge badge-neutral">FSM</span>' : ''}</td>
              <td class="muted">${esc(row.old_state || '—')} → ${esc(row.new_state || '—')}</td>
              <td class="muted">${esc(row.initiated_by || '—')}</td>
              <td class="muted truncate" title="${esc(row.reason || '')}">${esc(row.reason || '—')}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">
            <p>No lifecycle events in this range.</p>
            <p class="muted" style="margin-top:0.5rem;font-size:0.85rem">Includes admin suspend/terminate and FSM changes (Attendance IGA suspend/disable, movers). Run Attendance IGA or use Users → Suspend to generate events.</p>
          </div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadLifecycle(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadLifecycle(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadRequests(rebuild) {
    const s = state.requests;
    if (rebuild || !panel.querySelector('.audit-filter-panel')) {
      panel.innerHTML = `<div id="gov-req-summary" class="stat-grid" style="margin-bottom:1rem"></div>
        ${auditFilterBar(`
        <div class="form-group"><label class="form-label">Search</label>
          <input class="form-input audit-q" value="${esc(s.q)}"></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select class="form-select gov-status">
            <option value="">All</option>
            ${['PENDING', 'APPROVED', 'FULFILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].map((st) =>
              `<option value="${st}" ${s.status === st ? 'selected' : ''}>${st}</option>`).join('')}
          </select></div>`)}
        <div class="gov-table-area"></div>`;
      panel.querySelector('.audit-from').value = s.from;
      panel.querySelector('.audit-to').value = s.to;
      const reload = () => { s.offset = 0; void loadRequests(); };
      panel.querySelectorAll('.audit-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          panel.querySelector('.audit-from').value = isoDateDaysAgo(Number(btn.dataset.days) || 30);
          panel.querySelector('.audit-to').value = todayIso();
          reload();
        });
      });
      panel.querySelector('.audit-apply')?.addEventListener('click', reload);
      panel.querySelector('.audit-reset')?.addEventListener('click', () => {
        Object.assign(s, { from: isoDateDaysAgo(90), to: todayIso(), q: '', status: '', offset: 0 });
        void loadRequests(true);
      });
      panel.querySelector('.audit-export')?.addEventListener('click', () => {
        s.from = panel.querySelector('.audit-from').value;
        s.to = panel.querySelector('.audit-to').value;
        s.q = panel.querySelector('.audit-q').value.trim();
        s.status = panel.querySelector('.gov-status').value;
        void exportCsv('access-requests', { from: s.from, to: s.to, q: s.q, status: s.status });
      });
    }
    s.from = panel.querySelector('.audit-from')?.value || s.from;
    s.to = panel.querySelector('.audit-to')?.value || s.to;
    s.q = panel.querySelector('.audit-q')?.value.trim() || '';
    s.status = panel.querySelector('.gov-status')?.value || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportAccessRequests({
        from: s.from, to: s.to, q: s.q, status: s.status,
        limit: String(s.limit), offset: String(s.offset),
      });
      const by = r.meta?.byStatus || [];
      const overdue = by.reduce((n, x) => n + (x.overdue || 0), 0);
      const sumBox = panel.querySelector('#gov-req-summary');
      if (sumBox) {
        sumBox.innerHTML = by.map((x) =>
          statCard('check', x.status, x.n, x.overdue ? `${x.overdue} overdue` : '', x.status === 'PENDING' ? 'warning' : 'info'),
        ).join('') + (overdue ? statCard('alert', 'SLA breached', overdue, 'pending past due', 'danger') : '');
      }
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} requests`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Created</th><th>Status</th><th>Type</th><th>Requester</th><th>Target</th><th>Hours</th><th>SLA</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.created_at)}</td>
              <td><span class="badge badge-info">${esc(row.status)}</span></td>
              <td class="muted">${esc(row.item_type)}</td>
              <td>${esc(row.requester_name || row.requester_emp_id)}</td>
              <td>${esc(row.target_name || row.target_emp_id)}</td>
              <td class="muted">${row.hours_open ?? '—'}</td>
              <td>${Number(row.sla_breached) ? '<span class="badge badge-danger">Breached</span>' : (row.sla_due_at ? `<span class="muted">${fmtDate(row.sla_due_at)}</span>` : '—')}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">No access requests in this range</div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadRequests(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadRequests(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadCerts(rebuild) {
    const s = state.certs;
    if (rebuild || !panel.querySelector('.gov-certs-filters')) {
      panel.innerHTML = `<div class="ent-panel gov-certs-filters"><div class="ent-panel-body">
        <div class="audit-filter-grid">
          <div class="form-group"><label class="form-label">Status</label>
            <select class="form-select gov-status">
              <option value="">All</option>
              ${['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((st) =>
                `<option value="${st}" ${s.status === st ? 'selected' : ''}>${st}</option>`).join('')}
            </select></div>
        </div>
        <div class="audit-filter-actions">
          <button type="button" class="btn btn-primary gov-apply">Apply</button>
          <button type="button" class="btn btn-secondary gov-export">Export CSV</button>
          <span class="muted audit-meta-count" style="margin-left:auto;font-size:0.8rem"></span>
        </div>
      </div></div><div class="gov-table-area"></div>`;
      panel.querySelector('.gov-apply').addEventListener('click', () => { s.offset = 0; void loadCerts(); });
      panel.querySelector('.gov-export').addEventListener('click', () => {
        s.status = panel.querySelector('.gov-status').value;
        void exportCsv('certifications', { status: s.status });
      });
    }
    s.status = panel.querySelector('.gov-status')?.value || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportCertifications({
        status: s.status, limit: String(s.limit), offset: String(s.offset),
      });
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} campaigns`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Campaign</th><th>Status</th><th>Window</th><th>Completion</th><th>Certified</th><th>Revoked</th><th>Pending</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="cell-strong">${esc(row.name)}</td>
              <td><span class="badge badge-info">${esc(row.status)}</span></td>
              <td class="muted">${fmtDate(row.start_date)} → ${fmtDate(row.end_date)}</td>
              <td><strong>${row.completion_pct}%</strong></td>
              <td>${row.certified}</td>
              <td>${row.revoked}</td>
              <td>${row.pending}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">No certification campaigns</div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadCerts(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadCerts(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadSod(rebuild) {
    const s = state.sod;
    if (rebuild || !panel.querySelector('.gov-sod-filters')) {
      panel.innerHTML = `<div class="ent-panel gov-sod-filters"><div class="ent-panel-body">
        <div class="audit-filter-grid">
          <div class="form-group"><label class="form-label">Search</label>
            <input class="form-input gov-q" value="${esc(s.q)}"></div>
          <div class="form-group"><label class="form-label">Status</label>
            <select class="form-select gov-status">
              <option value="">All</option>
              ${['OPEN', 'APPROVED_EXCEPTION', 'RESOLVED', 'SUPPRESSED'].map((st) =>
                `<option value="${st}" ${s.status === st ? 'selected' : ''}>${st}</option>`).join('')}
            </select></div>
          <div class="form-group"><label class="form-label">Severity</label>
            <select class="form-select gov-sev">
              <option value="">All</option>
              ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((st) =>
                `<option value="${st}" ${s.severity === st ? 'selected' : ''}>${st}</option>`).join('')}
            </select></div>
        </div>
        <div class="audit-filter-actions">
          <button type="button" class="btn btn-primary gov-apply">Apply</button>
          <button type="button" class="btn btn-secondary gov-export">Export CSV</button>
          <span class="muted audit-meta-count" style="margin-left:auto;font-size:0.8rem"></span>
        </div>
      </div></div><div class="gov-table-area"></div>`;
      panel.querySelector('.gov-apply').addEventListener('click', () => { s.offset = 0; void loadSod(); });
      panel.querySelector('.gov-export').addEventListener('click', () => {
        s.q = panel.querySelector('.gov-q').value.trim();
        s.status = panel.querySelector('.gov-status').value;
        s.severity = panel.querySelector('.gov-sev').value;
        void exportCsv('sod', { q: s.q, status: s.status, severity: s.severity });
      });
    }
    s.q = panel.querySelector('.gov-q')?.value.trim() || '';
    s.status = panel.querySelector('.gov-status')?.value || '';
    s.severity = panel.querySelector('.gov-sev')?.value || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportSod({
        q: s.q, status: s.status, severity: s.severity,
        limit: String(s.limit), offset: String(s.offset),
      });
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} violations`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Detected</th><th>User</th><th>Policy</th><th>Severity</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.detected_at)}</td>
              <td class="cell-strong">${esc(row.full_name || row.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(row.email_corp || '')}</span></td>
              <td>${esc(row.policy_name)}</td>
              <td><span class="badge badge-${row.severity === 'CRITICAL' || row.severity === 'HIGH' ? 'danger' : 'warning'}">${esc(row.severity)}</span></td>
              <td><span class="badge badge-info">${esc(row.status)}</span></td>
              <td class="muted truncate">${esc(row.notes || '—')}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">No SoD violations match</div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadSod(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadSod(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadAppAccess(rebuild) {
    const s = state.appaccess;
    if (rebuild || !panel.querySelector('.audit-filter-panel')) {
      panel.innerHTML = `${auditFilterBar(`
        <div class="form-group"><label class="form-label">Search</label>
          <input class="form-input audit-q" value="${esc(s.q)}"></div>
        <div class="form-group"><label class="form-label">Action</label>
          <select class="form-select gov-action">
            <option value="">All</option>
            ${['ASSIGN_USER', 'ASSIGN_GROUP', 'REVOKE', 'REQUEST', 'APPROVE', 'REJECT', 'PROVISION'].map((a) =>
              `<option value="${a}" ${s.action === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select></div>`)}
        <div class="gov-table-area"></div>`;
      panel.querySelector('.audit-from').value = s.from;
      panel.querySelector('.audit-to').value = s.to;
      const reload = () => { s.offset = 0; void loadAppAccess(); };
      panel.querySelectorAll('.audit-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          panel.querySelector('.audit-from').value = isoDateDaysAgo(Number(btn.dataset.days) || 30);
          panel.querySelector('.audit-to').value = todayIso();
          reload();
        });
      });
      panel.querySelector('.audit-apply')?.addEventListener('click', reload);
      panel.querySelector('.audit-reset')?.addEventListener('click', () => {
        Object.assign(s, { from: isoDateDaysAgo(90), to: todayIso(), q: '', action: '', offset: 0 });
        void loadAppAccess(true);
      });
      panel.querySelector('.audit-export')?.addEventListener('click', () => {
        s.from = panel.querySelector('.audit-from').value;
        s.to = panel.querySelector('.audit-to').value;
        s.q = panel.querySelector('.audit-q').value.trim();
        s.action = panel.querySelector('.gov-action').value;
        void exportCsv('app-access-changes', { from: s.from, to: s.to, q: s.q, action: s.action });
      });
    }
    s.from = panel.querySelector('.audit-from')?.value || s.from;
    s.to = panel.querySelector('.audit-to')?.value || s.to;
    s.q = panel.querySelector('.audit-q')?.value.trim() || '';
    s.action = panel.querySelector('.gov-action')?.value || '';
    const area = panel.querySelector('.gov-table-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.reportAppAccessChanges({
        from: s.from, to: s.to, q: s.q, action: s.action,
        limit: String(s.limit), offset: String(s.offset),
      });
      const rows = r.data || [];
      panel.querySelector('.audit-meta-count').textContent = `${r.meta?.total ?? rows.length} events`;
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Action</th><th>Application</th><th>Actor</th><th>Target</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="muted">${fmtDate(row.created_at)}</td>
              <td><span class="badge badge-info">${esc(row.action)}</span></td>
              <td class="cell-strong">${esc(row.app_name || '—')}<br><span class="muted" style="font-size:0.75rem">${esc(row.app_slug || '')}</span></td>
              <td>${esc(row.actor_name || row.actor_emp_id || '—')}</td>
              <td>${esc(row.target_name || row.target_emp_id || row.tag_group_id || '—')}</td>
            </tr>`).join('')}</tbody></table></div>${pagerHtml(r.meta, s.offset, s.limit)}`
        : `<div class="card empty-state">No app access changes in this range</div>`;
      area.querySelector('.gov-prev')?.addEventListener('click', () => { s.offset = Math.max(0, s.offset - s.limit); void loadAppAccess(); });
      area.querySelector('.gov-next')?.addEventListener('click', () => { s.offset += s.limit; void loadAppAccess(); });
    } catch (err) {
      area.innerHTML = errHtml(err.message);
    }
  }

  async function loadTab(rebuild = false) {
    if (active === 'inventory') return loadInventory(rebuild);
    if (active === 'mfa') return loadMfa(rebuild);
    if (active === 'lifecycle') return loadLifecycle(rebuild);
    if (active === 'requests') return loadRequests(rebuild);
    if (active === 'certs') return loadCerts(rebuild);
    if (active === 'sod') return loadSod(rebuild);
    return loadAppAccess(rebuild);
  }

  await loadTab(true);
}

export async function viewReports(content) {
  const wrap = el(`<div class="ent-page">
    ${header('Compliance Reports', 'Generate SOX / GDPR / HIPAA / PCI evidence snapshots from audit trails',
      `<button class="btn btn-primary" id="comp-new">+ Generate report</button>`)}
    <div id="comp-msg"></div>
    <div id="comp-area"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`);
  content.replaceChildren(wrap);

  async function load() {
    const area = wrap.querySelector('#comp-area');
    area.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.igaReports();
      const rows = r.data || [];
      area.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Framework</th><th>Period</th><th>Generated</th><th>Evidence</th></tr></thead>
            <tbody>${rows.map((row) => {
              const period = (row.period_start || row.period_end)
                ? `${row.period_start || '—'} → ${row.period_end || '—'}`
                : (row.period || '—');
              return `<tr>
                <td class="cell-strong">${esc(row.name)}</td>
                <td><span class="badge badge-info">${esc(row.framework || '—')}</span></td>
                <td class="muted">${esc(period)}</td>
                <td class="muted">${row.generated_at ? fmtDate(row.generated_at) : '—'}</td>
                <td>
                  <a class="btn btn-sm btn-secondary" href="${esc(api.complianceReportExportUrl(row.id))}" target="_blank" rel="noopener">Download JSON</a>
                </td>
              </tr>`;
            }).join('')}</tbody></table></div>`
        : `<div class="card empty-state"><span class="empty-icon">▣</span>No compliance snapshots yet. Generate one for your audit period.</div>`;
    } catch (err) {
      area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  wrap.querySelector('#comp-new').addEventListener('click', () => {
    const from = isoDateDaysAgo(90);
    const to = todayIso();
    const bd = openModal(`<div class="modal" style="max-width:520px">
      <div class="modal-header"><h2>Generate compliance report</h2></div>
      <div class="modal-body">
        <p class="muted" style="margin-top:0">Aggregates SSO assertions, system audit events, auth attempts, and hash-chain integrity for the selected period.</p>
        <div class="form-group"><label class="form-label">Name</label>
          <input class="form-input" id="comp-name" value="Quarterly access evidence"></div>
        <div class="form-group"><label class="form-label">Framework</label>
          <select class="form-select" id="comp-fw">
            <option value="SOX">SOX</option>
            <option value="GDPR">GDPR</option>
            <option value="HIPAA">HIPAA</option>
            <option value="PCI">PCI</option>
            <option value="ISO27001">ISO 27001</option>
            <option value="CUSTOM">Custom</option>
          </select></div>
        <div class="form-row-2">
          <div class="form-group"><label class="form-label">Period start</label>
            <input type="date" class="form-input" id="comp-from" value="${esc(from)}"></div>
          <div class="form-group"><label class="form-label">Period end</label>
            <input type="date" class="form-input" id="comp-to" value="${esc(to)}"></div>
        </div>
        <div id="comp-modal-msg"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="comp-save">Generate</button>
        <button class="btn btn-secondary" id="comp-cancel">Cancel</button>
      </div>
    </div>`);
    bd.querySelector('#comp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#comp-save').addEventListener('click', async () => {
      const msg = bd.querySelector('#comp-modal-msg');
      const btn = bd.querySelector('#comp-save');
      const payload = {
        name: bd.querySelector('#comp-name').value.trim(),
        framework: bd.querySelector('#comp-fw').value,
        periodStart: bd.querySelector('#comp-from').value,
        periodEnd: bd.querySelector('#comp-to').value,
      };
      if (!payload.name || !payload.periodStart || !payload.periodEnd) {
        msg.innerHTML = `<div class="alert alert-error">Name and period are required.</div>`;
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Generating…';
      try {
        await api.createComplianceReport(payload);
        bd.remove();
        wrap.querySelector('#comp-msg').innerHTML = `<div class="alert alert-success">Compliance evidence report generated.</div>`;
        await load();
      } catch (err) {
        msg.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
        btn.disabled = false;
        btn.textContent = 'Generate';
      }
    });
  });

  await load();
}

/* ---------- Access Requests (admin queue + override) ---------- */
export async function viewAccessRequests(content) {
  const statusBadge = (s) => ({
    PENDING:   '<span class="badge badge-warning">Pending</span>',
    APPROVED:  '<span class="badge badge-success">Approved</span>',
    FULFILLED: '<span class="badge badge-success">Fulfilled</span>',
    REJECTED:  '<span class="badge badge-danger">Rejected</span>',
    CANCELLED: '<span class="badge badge-neutral">Cancelled</span>',
  })[s] || `<span class="badge badge-neutral">${esc(s || '—')}</span>`;

  content.replaceChildren(el(`<div>
    ${header(
      'Access Requests',
      'Pending approval queue — admins can approve or reject in critical situations (bypasses assigned approvers)',
      `<select class="form-input" id="ar-status" style="width:auto;min-width:140px">
        <option value="PENDING" selected>Pending</option>
        <option value="">All statuses</option>
        <option value="APPROVED">Approved</option>
        <option value="FULFILLED">Fulfilled</option>
        <option value="REJECTED">Rejected</option>
        <option value="CANCELLED">Cancelled</option>
      </select>`,
    )}
    <div id="ar-msg" style="margin-bottom:0.75rem"></div>
    <div id="ar-list"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`));
  const wrap = content.firstChild;

  async function load() {
    const status = wrap.querySelector('#ar-status').value;
    try {
      const r = await api.igaAccessReqs('all', status);
      const rows = r.data || [];
      if (!rows.length) {
        wrap.querySelector('#ar-list').innerHTML = `<div class="empty-state"><div class="empty-icon">✓</div><p>No access requests${status === 'PENDING' ? ' pending approval' : ''}.</p></div>`;
        return;
      }
      wrap.querySelector('#ar-list').innerHTML = `<div class="table-wrap"><table>
        <thead><tr>
          <th>Request</th><th>Requester</th><th>For</th><th>Type</th>
          <th>Justification</th><th>Pending approvers</th><th>Submitted</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map((row) => {
          const id = String(row.id);
          const short = id.slice(0, 8);
          const canDecide = row.status === 'PENDING';
          const canRepair = row.status === 'APPROVED' || row.status === 'FULFILLED';
          return `<tr data-rid="${esc(id)}">
            <td><code style="font-size:0.8rem">${esc(short)}…</code></td>
            <td class="cell-strong">${esc(row.requester_name || row.requester_emp_id || '—')}</td>
            <td class="muted">${esc(row.target_name || row.target_emp_id || 'Self')}</td>
            <td><span class="badge badge-info">${esc(row.item_type || '—')}</span></td>
            <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(row.justification || '')}">${esc(row.justification || '—')}</td>
            <td class="muted" style="font-size:0.85rem">${esc(row.pending_approvers || '—')}</td>
            <td class="muted">${fmtDate(row.created_at)}</td>
            <td>${statusBadge(row.status)}</td>
            <td style="white-space:nowrap">${canDecide ? `
              <button class="btn btn-sm btn-success approve-btn" data-id="${esc(id)}">✓ Approve</button>
              <button class="btn btn-sm btn-danger reject-btn" style="margin-left:0.25rem" data-id="${esc(id)}">✗ Reject</button>
            ` : canRepair ? `
              <button class="btn btn-sm btn-secondary fulfill-btn" data-id="${esc(id)}" title="Re-apply grant if approval did not provision access">Grant access</button>
            ` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`;

      function decisionRow(id, decision) {
        const row = wrap.querySelector(`tr[data-rid="${id}"]`);
        if (!row) return;
        const existing = wrap.querySelector('#ar-reason-row-' + id.slice(0, 8));
        if (existing) { existing.remove(); return; }
        const reasonRow = document.createElement('tr');
        reasonRow.id = 'ar-reason-row-' + id.slice(0, 8);
        reasonRow.innerHTML = `<td colspan="9" style="background:var(--bg);padding:0.75rem 1rem">
          <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
            <span class="badge badge-warning">Admin override</span>
            <input class="form-input" id="ar-reason-${esc(id.slice(0, 8))}"
              placeholder="${decision === 'APPROVE' ? 'Optional comment (recorded as admin override)' : 'Reason for rejection (required)'}"
              style="flex:1;min-width:200px">
            <button class="btn btn-sm ${decision === 'APPROVE' ? 'btn-success' : 'btn-danger'} confirm-decision"
              data-id="${esc(id)}" data-decision="${decision}">Confirm ${decision === 'APPROVE' ? 'Approval' : 'Rejection'}</button>
            <button class="btn btn-sm btn-secondary cancel-reason" data-id="${esc(id)}">Cancel</button>
          </div>
        </td>`;
        row.after(reasonRow);
        wrap.querySelector(`.cancel-reason[data-id="${id}"]`).addEventListener('click', () => reasonRow.remove());
        wrap.querySelector(`.confirm-decision[data-id="${id}"]`).addEventListener('click', async () => {
          const comment = wrap.querySelector('#ar-reason-' + id.slice(0, 8)).value.trim();
          if (decision === 'REJECT' && !comment) {
            wrap.querySelector('#ar-msg').innerHTML = `<div class="alert alert-error">Rejection reason is required.</div>`;
            return;
          }
          if (!confirm(`${decision === 'APPROVE' ? 'Approve and fulfill' : 'Reject'} this request as admin override?`)) return;
          try {
            await api.igaRequestDecision(id, decision, comment || undefined, true);
            wrap.querySelector('#ar-msg').innerHTML = `<div class="alert alert-success">Decision recorded (admin override).</div>`;
            setTimeout(() => load(), 800);
          } catch (e) {
            wrap.querySelector('#ar-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
          }
        });
      }

      wrap.querySelectorAll('.approve-btn').forEach((btn) =>
        btn.addEventListener('click', () => decisionRow(btn.dataset.id, 'APPROVE')));
      wrap.querySelectorAll('.reject-btn').forEach((btn) =>
        btn.addEventListener('click', () => decisionRow(btn.dataset.id, 'REJECT')));
      wrap.querySelectorAll('.fulfill-btn').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (!confirm('Re-apply access grant for this request? Use when approval completed but the user still cannot launch the app.')) return;
          try {
            await api.igaFulfillRequest(btn.dataset.id);
            wrap.querySelector('#ar-msg').innerHTML = `<div class="alert alert-success">Access grant applied.</div>`;
            setTimeout(() => load(), 800);
          } catch (e) {
            wrap.querySelector('#ar-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
          }
        }));
    } catch (e) {
      wrap.querySelector('#ar-list').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    }
  }

  wrap.querySelector('#ar-status').addEventListener('change', load);
  await load();
}
