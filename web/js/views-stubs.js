import { api } from './api-admin.js';
import { el, esc, escAttrJson, fmtDate, persistSearch, syncAppUrl } from './ui.js';
import { icon as svgIcon } from './icons.js';

function header(title, subtitle, action = '') {
  return `<div class="page-header page-header--compact">
    <div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>
    ${action ? `<div class="page-header-actions">${action}</div>` : ''}
  </div>`;
}

function kpiStrip(items) {
  return items.map(([value, label, tone]) => `
    <div class="kpi-strip-item${tone ? ` kpi-strip-item--${tone}` : ''}">
      <span class="kpi-strip-value">${esc(String(value ?? '—'))}</span>
      <span class="kpi-strip-label">${esc(label)}</span>
    </div>`).join('');
}

function connectorTypeKey(type) {
  const t = type === 'GOOGLE' ? 'GOOGLE_WORKSPACE' : type;
  return {
    AD: 'ad', AD_AGENT: 'agent', LDAP: 'ad', GOOGLE_WORKSPACE: 'google',
    AZURE_AD: 'azure', OKTA: 'okta', SCIM: 'default', ZOHO: 'default', HRMS: 'default',
  }[t] || 'default';
}

function connectorIconClass(type) {
  return `connector-cell-icon--${connectorTypeKey(type)}`;
}

const CONNECTOR_SVG_ICON = {
  AD: 'server', AD_AGENT: 'server', LDAP: 'server', GOOGLE_WORKSPACE: 'app',
  AZURE_AD: 'oidc', OKTA: 'key', SCIM: 'plug', ZOHO: 'users', HRMS: 'users',
};

function connectorSvg(type) {
  return svgIcon(CONNECTOR_SVG_ICON[normalizeConnectorType(type)] || 'plug');
}

function dsGuideCardsHtml() {
  return `
    <div class="ds-guide-grid">
      <div class="ds-guide-card ds-guide-card--google">
        <div class="ds-guide-card__head">
          <span class="ds-guide-card__icon connector-cell-icon connector-cell-icon--google">${svgIcon('app')}</span>
          <h4>Google Workspace</h4>
        </div>
        <p>Service account + domain-wide delegation for user and group sync. Configure OAuth separately for portal sign-in.</p>
        <ol><li>Add Workspace domains and super-admin email</li><li>Paste service account JSON key</li><li>Run <strong>Test</strong>, then <strong>Sync</strong></li></ol>
      </div>
      <div class="ds-guide-card ds-guide-card--ad">
        <div class="ds-guide-card__head">
          <span class="ds-guide-card__icon connector-cell-icon connector-cell-icon--ad">${svgIcon('server')}</span>
          <h4>Active Directory</h4>
        </div>
        <p>Direct LDAP/LDAPS from the IdP when the directory is reachable on the network.</p>
        <ol><li>Bind DN, password, base DN, and target OU</li><li>Use LDAPS or StartTLS in production</li><li>Optionally scope security groups to mirror</li></ol>
      </div>
      <div class="ds-guide-card ds-guide-card--agent">
        <div class="ds-guide-card__head">
          <span class="ds-guide-card__icon connector-cell-icon connector-cell-icon--agent">${svgIcon('server')}</span>
          <h4>AD on-prem agent</h4>
        </div>
        <p>For firewalled AD — credentials stay on the domain server; sync over HTTPS&nbsp;:443.</p>
        <ol><li>Download agent package + install on domain server</li><li>Edit <code>config.json</code> with LDAP settings</li><li>Create source and paste one-time agent token</li></ol>
      </div>
    </div>`;
}

function statCard(iconName, label, value, sub = '', cls = 'primary') {
  return `<div class="stat-card">
    <div class="stat-icon ${cls}">${svgIcon(iconName)}</div>
    <div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      ${sub ? `<div class="stat-sub">${typeof sub === 'string' ? esc(sub) : sub}</div>` : ''}
    </div>
  </div>`;
}

function openModal(html) {
  const bd = el(`<div class="modal-backdrop">${html}</div>`);
  // Do not close on backdrop click — only Cancel / Close / explicit actions dismiss.
  document.body.appendChild(bd);
  return bd;
}

function loading() {
  return `<div class="loading-row"><span class="spinner"></span></div>`;
}

function errHtml(msg) {
  return `<div class="alert alert-error">${esc(msg)}</div>`;
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

/* Normalise backend responses — all list endpoints return {data:[...]} */
const norm = r => Array.isArray(r) ? r : (r?.data ?? []);

// ─── 1. Groups ────────────────────────────────────────────────────────────────
export async function viewGroups(content, initialTab = 'directory') {
  const tabMap = { directory: 'directory', tags: 'tags', 'tag-groups': 'tags' };
  let activeTab = tabMap[initialTab] || 'directory';
  content.replaceChildren(el(`<div class="ent-page">
    ${header('Groups', 'Directory groups (local / Google / AD) and tag groups used by Application Access Policy',
      `<div style="display:flex;gap:0.5rem">
        <button class="btn btn-secondary" id="sync-groups-btn">⟳ Sync from Directory</button>
        <button class="btn btn-primary" id="new-group-btn">+ New Group</button>
        <button class="btn btn-primary" id="new-tg-btn" hidden>+ Tag Group</button>
      </div>`)}
    <div class="inline-tabs" id="grp-tabs" style="margin-bottom:1rem">
      <button type="button" class="inline-tab${activeTab === 'directory' ? ' active' : ''}" data-tab="directory">Directory Groups</button>
      <button type="button" class="inline-tab${activeTab === 'tags' ? ' active' : ''}" data-tab="tags">Tag Groups</button>
    </div>
    <div id="tab-directory" ${activeTab !== 'directory' ? 'hidden' : ''}>
      <div id="grp-msg" style="margin-bottom:0.75rem"></div>
      <div id="list-area">${loading()}</div>
    </div>
    <div id="tab-tags" ${activeTab !== 'tags' ? 'hidden' : ''}><div id="tg-area">${loading()}</div></div>
  </div>`));
  const wrap = content.firstChild;
  const syncBtn = wrap.querySelector('#sync-groups-btn');
  const newGroupBtn = wrap.querySelector('#new-group-btn');
  const newTgBtn = wrap.querySelector('#new-tg-btn');

  const sourceBadge = (src) => ({
    LOCAL:  '<span class="badge badge-neutral">Local</span>',
    GOOGLE: '<span class="badge badge-info">Google</span>',
    AD:     '<span class="badge badge-success">AD</span>',
  }[src || 'LOCAL'] || `<span class="badge badge-neutral">${esc(src)}</span>`);

  async function openGroupMembersModal(groupId, groupName, isSynced) {
    const bd = openModal(`<div class="modal modal-wide"><div class="modal-header"><h2>${esc(groupName)} — Members</h2></div>
      <div class="modal-body">
        ${isSynced ? '<div class="alert alert-info" style="font-size:0.85rem;margin-bottom:1rem">Membership is synced from Google Workspace or Active Directory. Run <strong>Sync from Directory</strong> or trigger a connector sync to refresh.</div>' : ''}
        <div id="gm-list">${loading()}</div>
        ${isSynced ? '' : `<div class="form-group" style="margin-top:1rem">
          <label class="form-label">Add member</label>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
            <input class="form-input" id="gm-search" placeholder="Search name or email…" style="flex:1;min-width:180px">
            <input class="form-input" id="gm-emp" placeholder="Employee ID or email" style="width:180px">
            <button class="btn btn-primary" id="gm-add">Add</button>
          </div>
          <div id="gm-pick" style="margin-top:0.5rem"></div>
        </div>
        <div class="form-group" style="margin-top:1rem">
          <label class="form-label">Bulk add members</label>
          <p class="muted" style="font-size:0.78rem;margin:0 0 0.4rem">Paste emails, Employee IDs, or directory IDs — one per line (or comma-separated). Max 500.</p>
          <textarea class="form-input" id="gm-bulk" rows="4" placeholder="ravi.verma1@lenskart.in&#10;116970&#10;LOC58DC3A00"></textarea>
          <div style="display:flex;gap:0.5rem;margin-top:0.5rem;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="gm-bulk-add">Bulk add</button>
            <span class="muted" style="font-size:0.78rem" id="gm-bulk-hint"></span>
          </div>
        </div>
        <div class="form-group" style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border,rgba(255,255,255,0.08))">
          <label class="form-label">CSV upload — add or remove</label>
          <p class="muted" style="font-size:0.78rem;margin:0 0 0.5rem">Columns: <code>email</code>, <code>employee_id</code> (one identifier per row is enough). Max 500 rows.</p>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;margin-bottom:0.6rem">
            <a class="btn btn-secondary btn-sm" href="${api.groupMembersCsvTemplateUrl()}" target="_blank" download>Download CSV template</a>
          </div>
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-end">
            <div>
              <label class="form-label" style="font-size:0.78rem">Add from CSV</label>
              <label class="btn btn-primary btn-sm" style="cursor:pointer;margin:0;display:inline-flex">
                Choose CSV… <input type="file" id="gm-csv-add" accept=".csv,text/csv" hidden>
              </label>
            </div>
            <div>
              <label class="form-label" style="font-size:0.78rem">Remove from CSV</label>
              <label class="btn btn-danger btn-sm" style="cursor:pointer;margin:0;display:inline-flex">
                Choose CSV… <input type="file" id="gm-csv-remove" accept=".csv,text/csv" hidden>
              </label>
            </div>
            <span class="muted" style="font-size:0.78rem" id="gm-csv-hint"></span>
          </div>
        </div>`}
        <div id="gm-err"></div>
      </div><div class="modal-footer"><button class="btn btn-secondary" id="gm-close">Close</button></div></div>`);

    function displayEmpId(m) {
      return m.employee_number || m.emp_id || '—';
    }

    async function loadMembers() {
      try {
        const g = await api.getGroup(groupId);
        const members = g.members || [];
        const rows = members.length ? members.map(m => `
          <tr>
            <td class="cell-strong">${esc(m.full_name || m.emp_id)}</td>
            <td class="muted">${esc(m.email_corp || '—')}</td>
            <td>
              <div class="cell-strong" style="font-size:0.85rem">${esc(displayEmpId(m))}</div>
              ${m.employee_number && m.emp_id && String(m.employee_number) !== String(m.emp_id)
                ? `<div class="muted" style="font-size:0.72rem">Dir: ${esc(m.emp_id)}</div>` : ''}
            </td>
            ${isSynced ? '<td></td>' : `<td><button class="btn btn-sm btn-danger gm-rm" data-emp="${esc(m.emp_id)}">Remove</button></td>`}
          </tr>`).join('')
          : `<tr><td colspan="4"><p class="muted">No members yet.</p></td></tr>`;
        bd.querySelector('#gm-list').innerHTML = `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Employee ID</th>${isSynced ? '' : '<th></th>'}</tr></thead>
          <tbody>${rows}</tbody></table></div>`;
        if (!isSynced) {
          bd.querySelectorAll('.gm-rm').forEach(btn => {
            btn.addEventListener('click', async () => {
              try { await api.removeGroupMember(groupId, btn.dataset.emp); await loadMembers(); await load(); }
              catch (e) { alert(e.message); }
            });
          });
        }
      } catch (e) { bd.querySelector('#gm-list').innerHTML = errHtml(e.message); }
    }

    bd.querySelector('#gm-close').addEventListener('click', () => bd.remove());

    if (!isSynced) {
      let searchTimer;
      bd.querySelector('#gm-search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const q = bd.querySelector('#gm-search').value.trim();
          const pick = bd.querySelector('#gm-pick');
          if (q.length < 2) { pick.innerHTML = ''; return; }
          try {
            const users = norm(await api.listUsersUnified(q, 'ACTIVE', '', 15));
            pick.innerHTML = users.length ? users.map(u => {
              const idLabel = u.employee_number || u.emp_id;
              return `
              <button type="button" class="btn btn-sm btn-secondary gm-pick" style="margin:0.25rem 0.25rem 0 0"
                data-emp="${esc(u.employee_number || u.emp_id)}" data-label="${esc(u.full_name || u.emp_id)}">
                ${esc(u.full_name || u.emp_id)}
                <span class="muted">(${esc(u.email_corp || '')} · ${esc(idLabel)})</span>
              </button>`;
            }).join('') : '<span class="muted">No users found</span>';
            pick.querySelectorAll('.gm-pick').forEach(btn => {
              btn.addEventListener('click', () => {
                bd.querySelector('#gm-emp').value = btn.dataset.emp;
                bd.querySelector('#gm-search').value = btn.dataset.label;
                pick.innerHTML = '';
              });
            });
          } catch { pick.innerHTML = ''; }
        }, 300);
      });
      bd.querySelector('#gm-add').addEventListener('click', async () => {
        const empId = bd.querySelector('#gm-emp').value.trim();
        if (!empId) return;
        try {
          await api.addGroupMember(groupId, empId);
          bd.querySelector('#gm-emp').value = '';
          bd.querySelector('#gm-search').value = '';
          bd.querySelector('#gm-err').innerHTML = '';
          await loadMembers(); await load();
        } catch (e) { bd.querySelector('#gm-err').innerHTML = errHtml(e.message); }
      });

      function summarizeBulk(r, action) {
        const verb = action === 'remove' ? 'Removed' : 'Added';
        const count = action === 'remove' ? (r.removed || 0) : (r.added || 0);
        return `${verb} ${count}`
          + (r.skipped ? `, skipped ${r.skipped}` : '')
          + (r.failed ? `, failed ${r.failed}` : '');
      }

      function showBulkResult(r, action, hintEl) {
        const errEl = bd.querySelector('#gm-err');
        const msg = summarizeBulk(r, action);
        if (hintEl) hintEl.textContent = msg;
        if (r.failed) {
          const fails = (r.results || []).filter((x) => !x.ok).slice(0, 8)
            .map((x) => `${esc(x.input)}: ${esc(x.error || 'failed')}`).join('<br>');
          errEl.innerHTML = `<div class="alert alert-warning">${esc(msg)}<div style="margin-top:0.4rem;font-size:0.8rem">${fails}</div></div>`;
        } else {
          errEl.innerHTML = `<div class="alert alert-success">${esc(msg)}</div>`;
        }
      }

      bd.querySelector('#gm-bulk-add')?.addEventListener('click', async () => {
        const raw = bd.querySelector('#gm-bulk').value || '';
        const members = raw
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const errEl = bd.querySelector('#gm-err');
        const hint = bd.querySelector('#gm-bulk-hint');
        errEl.innerHTML = '';
        if (!members.length) {
          errEl.innerHTML = errHtml('Paste at least one email or Employee ID');
          return;
        }
        const btn = bd.querySelector('#gm-bulk-add');
        btn.disabled = true;
        btn.textContent = 'Adding…';
        if (hint) hint.textContent = `${members.length} entries…`;
        try {
          const r = await api.addGroupMembersBulk(groupId, members, 'add');
          showBulkResult(r, 'add', hint);
          if (!r.failed) bd.querySelector('#gm-bulk').value = '';
          await loadMembers(); await load();
        } catch (e) {
          errEl.innerHTML = errHtml(e.message || 'Bulk add failed');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Bulk add';
        }
      });

      async function runCsvBulk(fileInput, action) {
        const file = fileInput.files?.[0];
        const errEl = bd.querySelector('#gm-err');
        const hint = bd.querySelector('#gm-csv-hint');
        errEl.innerHTML = '';
        if (!file) return;
        if (!/\.csv$/i.test(file.name) && file.type && !/csv|text/.test(file.type)) {
          errEl.innerHTML = errHtml('Please upload a .csv file');
          fileInput.value = '';
          return;
        }
        if (hint) hint.textContent = action === 'remove' ? 'Removing…' : 'Adding…';
        try {
          const csvText = await file.text();
          if (!csvText.trim()) throw new Error('CSV file is empty');
          const r = await api.groupMembersCsvBulk(groupId, csvText, action);
          showBulkResult(r, action, hint);
          await loadMembers(); await load();
        } catch (e) {
          errEl.innerHTML = errHtml(e.message || `CSV ${action} failed`);
          if (hint) hint.textContent = '';
        } finally {
          fileInput.value = '';
        }
      }

      bd.querySelector('#gm-csv-add')?.addEventListener('change', (e) => {
        runCsvBulk(e.target, 'add');
      });
      bd.querySelector('#gm-csv-remove')?.addEventListener('change', (e) => {
        const n = e.target.files?.[0]?.name || 'this file';
        if (!confirm(`Remove all members listed in ${n} from this group?`)) {
          e.target.value = '';
          return;
        }
        runCsvBulk(e.target, 'remove');
      });
    }

    await loadMembers();
  }

  async function load() {
    try {
      const groups = norm(await api.listGroups());
      const rows = groups.length ? groups.map(g => {
        const synced = g.source_system && g.source_system !== 'LOCAL';
        return `<tr>
          <td class="cell-strong">${esc(g.name)}</td>
          <td>${g.type === 'DYNAMIC' ? '<span class="badge badge-success">DYNAMIC</span>' : '<span class="badge badge-info">STATIC</span>'}</td>
          <td>${sourceBadge(g.source_system)}</td>
          <td>${g.member_count ?? 0}</td>
          <td>${g.last_synced_at ? `<span class="muted" style="font-size:0.78rem">${fmtDate(g.last_synced_at)}</span>` : '—'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary mgr-group" data-id="${esc(String(g.id))}" data-name="${esc(g.name)}" data-synced="${synced ? '1' : '0'}">${synced ? 'View Members' : 'Manage Members'}</button>
            ${synced ? '' : `<button class="btn btn-sm btn-danger del-group" data-id="${esc(String(g.id))}">Delete</button>`}
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No groups yet. Create a local group or sync from Google / AD connectors.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `
        <p class="muted" style="font-size:0.85rem;margin:0 0 0.75rem">Google/AD connectors mirror directory groups on sync (blank Sync Groups = auto). Or click <strong>Sync from Directory</strong> here. Ensure Google domain-wide delegation includes <code>admin.directory.group.readonly</code>.</p>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Source</th><th>Members</th><th>Last Sync</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-group').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this group?')) return;
          try { await api.deleteGroup(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.mgr-group').forEach(btn => {
        btn.addEventListener('click', () => openGroupMembersModal(btn.dataset.id, btn.dataset.name, btn.dataset.synced === '1'));
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
    wrap.querySelector('#grp-msg').innerHTML = '';
    try {
      const r = await api.syncDirectoryGroups();
      const errNote = r.errors?.length ? ` (${r.errors.length} warnings — check connector config)` : '';
      wrap.querySelector('#grp-msg').innerHTML = `<div class="alert alert-success">Synced <strong>${r.groupsSynced ?? 0}</strong> groups, <strong>${r.membersSynced ?? 0}</strong> members.${errNote}</div>`;
      await load();
    } catch (e) {
      wrap.querySelector('#grp-msg').innerHTML = errHtml(e.message);
    }
    syncBtn.disabled = false; syncBtn.textContent = '⟳ Sync from Directory';
  });

  newGroupBtn.addEventListener('click', () => {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>New Group</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="g-name" placeholder="Group name"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="g-desc" placeholder="Description"></div>
      <div class="form-group"><label class="form-label">Type</label><select class="form-select" id="g-type"><option value="STATIC">STATIC</option><option value="DYNAMIC">DYNAMIC</option></select></div>
      <div id="g-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="g-save">Create</button><button class="btn btn-secondary" id="g-cancel">Cancel</button></div></div>`);
    bd.querySelector('#g-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#g-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#g-name').value, description: bd.querySelector('#g-desc').value, type: bd.querySelector('#g-type').value };
      if (!data.name) { bd.querySelector('#g-err').innerHTML = errHtml('Name is required'); return; }
      try { await api.createGroup(data); bd.remove(); await load(); } catch(e) { bd.querySelector('#g-err').innerHTML = errHtml(e.message); }
    });
  });

  async function openTagGroupMembersModal(groupId, groupName) {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Tag Group — ${esc(groupName)}</h2></div>
      <div class="modal-body"><div id="tg-m-list">${loading()}</div>
        <div class="form-group" style="margin-top:1rem"><label class="form-label">Add member (Employee ID)</label>
          <div style="display:flex;gap:0.5rem"><input class="form-input" id="tg-m-emp" placeholder="E12345" style="flex:1">
          <button class="btn btn-primary" id="tg-m-add">Add</button></div></div>
        <div id="tg-m-err"></div>
      </div><div class="modal-footer"><button class="btn btn-secondary" id="tg-m-close">Close</button></div></div>`);
    async function loadMembers() {
      try {
        const g = await api.getTagGroup(groupId);
        const members = g.members || [];
        const rows = members.length ? members.map(m => `
          <tr><td class="cell-strong">${esc(m.full_name || m.emp_id)}</td>
            <td class="muted">${esc(m.email_corp || '—')}</td>
            <td><button class="btn btn-sm btn-danger rm-m" data-emp="${esc(m.emp_id)}">Remove</button></td></tr>`).join('')
          : `<tr><td colspan="3"><p class="muted">No members.</p></td></tr>`;
        bd.querySelector('#tg-m-list').innerHTML = `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
        bd.querySelectorAll('.rm-m').forEach(btn => {
          btn.addEventListener('click', async () => {
            try { await api.removeTagGroupMember(groupId, btn.dataset.emp); await loadMembers(); await loadTagGroups(); }
            catch (e) { alert(e.message); }
          });
        });
      } catch (e) { bd.querySelector('#tg-m-list').innerHTML = errHtml(e.message); }
    }
    bd.querySelector('#tg-m-close').addEventListener('click', () => bd.remove());
    bd.querySelector('#tg-m-add').addEventListener('click', async () => {
      const empId = bd.querySelector('#tg-m-emp').value.trim();
      if (!empId) return;
      try {
        await api.addTagGroupMember(groupId, empId);
        bd.querySelector('#tg-m-emp').value = '';
        await loadMembers(); await loadTagGroups();
      } catch (e) { bd.querySelector('#tg-m-err').innerHTML = errHtml(e.message); }
    });
    await loadMembers();
  }

  async function loadTagGroups() {
    const area = wrap.querySelector('#tg-area');
    try {
      const groups = norm(await api.listTagGroups(false));
      const rows = groups.length ? groups.map(g => {
        let tags = '—';
        try { tags = (typeof g.tags === 'string' ? JSON.parse(g.tags) : g.tags || []).join(', '); } catch {}
        return `<tr>
          <td class="cell-strong">${esc(g.name)}</td>
          <td class="muted" style="font-size:0.82rem">${esc(tags)}</td>
          <td>${g.member_count ?? 0}</td>
          <td>${g.active === 0 || g.active === false ? '<span class="badge badge-neutral">Inactive</span>' : '<span class="badge badge-success">Active</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary manage-tg" data-id="${esc(String(g.id))}" data-name="${esc(g.name)}">Members</button>
            <button class="btn btn-sm btn-danger del-tg" data-id="${esc(String(g.id))}">Delete</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No tag groups yet. Used by Application Access Policy for group-based app grants.</p></div></td></tr>`;
      area.innerHTML = `
        <p class="muted" style="font-size:0.85rem;margin:0 0 0.75rem">Tag groups are logical cohorts (by tags) for app assignment — distinct from directory groups synced from Google / AD.</p>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Tags</th><th>Members</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      area.querySelectorAll('.del-tg').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this tag group?')) return;
          try { await api.deleteTagGroup(btn.dataset.id); await loadTagGroups(); } catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.manage-tg').forEach(btn => {
        btn.addEventListener('click', () => openTagGroupMembersModal(btn.dataset.id, btn.dataset.name));
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  newTgBtn.addEventListener('click', () => {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>New Tag Group</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="tg-name"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="tg-desc"></div>
      <div class="form-group"><label class="form-label">Tags (comma-separated)</label>
        <input class="form-input" id="tg-tags" placeholder="finance, apac, contractors"></div>
      <div id="tg-err"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="tg-save">Create</button>
      <button class="btn btn-secondary" id="tg-cancel">Cancel</button>
    </div></div>`);
    bd.querySelector('#tg-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#tg-save').addEventListener('click', async () => {
      const name = bd.querySelector('#tg-name').value.trim();
      const tags = bd.querySelector('#tg-tags').value.split(',').map(t => t.trim()).filter(Boolean);
      if (!name || !tags.length) { bd.querySelector('#tg-err').innerHTML = errHtml('Name and at least one tag required'); return; }
      try {
        await api.createTagGroup({ name, description: bd.querySelector('#tg-desc').value, tags });
        bd.remove(); await loadTagGroups();
      } catch (e) { bd.querySelector('#tg-err').innerHTML = errHtml(e.message); }
    });
  });

  async function showGrpTab(name) {
    activeTab = name;
    wrap.querySelectorAll('#grp-tabs .inline-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    wrap.querySelector('#tab-directory').hidden = name !== 'directory';
    wrap.querySelector('#tab-tags').hidden = name !== 'tags';
    syncBtn.hidden = name !== 'directory';
    newGroupBtn.hidden = name !== 'directory';
    newTgBtn.hidden = name !== 'tags';
    syncAppUrl('groups', name, 'directory');
    if (name === 'directory') await load();
    else await loadTagGroups();
  }

  wrap.querySelector('#grp-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) void showGrpTab(btn.dataset.tab);
  });

  await showGrpTab(activeTab);
}

// ─── 1b. Bulk User Import ─────────────────────────────────────────────────────
const BULK_MAX_ROWS = 100_000;
const BULK_BATCH_SIZE = 500;

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseBulkCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: ['File is empty'] };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const col = (names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const emailIdx = col(['email', 'email_corp', 'emailcorp']);
  const nameIdx = col(['full_name', 'fullname', 'name']);
  if (emailIdx < 0 || nameIdx < 0) {
    return { rows: [], errors: ['CSV must include email and full_name columns'] };
  }

  const empIdx = col(['emp_id', 'empid', 'employee_id']);
  const deptIdx = col(['dept_id', 'deptid', 'department']);
  const typeIdx = col(['employment_type', 'employmenttype', 'type']);
  const stateIdx = col(['ilg_state', 'ilgstate', 'state']);
  const mgrIdx = col(['manager_emp_id', 'managerempid', 'manager']);
  const grpIdx = col(['groups', 'group', 'group_names']);

  const rows = [];
  const errors = [];
  const dataLines = lines.slice(1);

  if (dataLines.length > BULK_MAX_ROWS) {
    return { rows: [], errors: [`Maximum ${BULK_MAX_ROWS.toLocaleString()} rows allowed`] };
  }

  for (let i = 0; i < dataLines.length; i++) {
    const cells = parseCsvLine(dataLines[i]);
    const email = (cells[emailIdx] || '').trim();
    const fullName = (cells[nameIdx] || '').trim();
    if (!email && !fullName) continue;

    const groupsRaw = grpIdx >= 0 ? (cells[grpIdx] || '') : '';
    const groups = groupsRaw
      ? groupsRaw.split(/[|;]/).map((g) => g.trim()).filter(Boolean)
      : undefined;

    rows.push({
      line: i + 2,
      email,
      fullName,
      empId: empIdx >= 0 ? (cells[empIdx] || '').trim() || undefined : undefined,
      deptId: deptIdx >= 0 ? (cells[deptIdx] || '').trim() || undefined : undefined,
      employmentType: typeIdx >= 0 ? (cells[typeIdx] || '').trim() || undefined : undefined,
      ilgState: stateIdx >= 0 ? (cells[stateIdx] || '').trim() || undefined : undefined,
      managerEmpId: mgrIdx >= 0 ? (cells[mgrIdx] || '').trim() || undefined : undefined,
      groups,
    });
  }

  if (!rows.length) errors.push('No data rows found');
  return { rows, errors };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function viewBulkUsers(content) {
  content.replaceChildren(el(`<div>
    ${header(
      'Bulk User Import',
      'Create or update up to 100,000 users in one job and assign local group membership',
      '<button type="button" class="btn btn-secondary btn-sm" id="bulk-dl-template">Download template</button>',
    )}
    <div class="card" style="margin-bottom:1rem">
      <h3 style="margin:0 0 0.5rem;font-size:1rem">Import settings</h3>
      <div class="grid-2" style="gap:1rem">
        <div class="field" style="margin:0">
          <label>Mode</label>
          <select id="bulk-mode" class="form-select">
            <option value="upsert">Upsert — create new, update existing (by email)</option>
            <option value="create">Create only — skip rows where email already exists</option>
            <option value="update">Update only — skip rows where email is missing</option>
          </select>
        </div>
        <div class="field" style="margin:0">
          <label>CSV file</label>
          <input type="file" id="bulk-file" accept=".csv,text/csv" class="form-input" />
        </div>
      </div>
      <div class="field" style="margin:1rem 0 0">
        <label>Or paste CSV</label>
        <textarea id="bulk-paste" class="form-input" rows="6" placeholder="email,full_name,emp_id,dept_id,employment_type,ilg_state,manager_emp_id,groups&#10;user@example.com,Jane Doe,,ENG,CORPORATE,ACTIVE,,Team A|Team B"></textarea>
      </div>
      <p class="muted" style="font-size:0.82rem;margin:0.75rem 0 0">
        <strong>groups</strong> column: pipe (<code>|</code>) or semicolon-separated local group names or IDs.
        Synced (Google/AD) groups are skipped with a warning. Max <strong>${BULK_MAX_ROWS.toLocaleString()}</strong> rows per import.
      </p>
      <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;align-items:center">
        <button type="button" class="btn btn-primary" id="bulk-run" disabled>Start import</button>
        <button type="button" class="btn btn-secondary" id="bulk-preview">Preview parse</button>
        <span id="bulk-row-count" class="muted"></span>
      </div>
    </div>
    <div id="bulk-progress" hidden style="margin-bottom:1rem">
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:0.35rem">
        <span id="bulk-progress-label">Processing…</span>
        <span id="bulk-progress-pct">0%</span>
      </div>
      <div style="height:8px;background:var(--border,#e5e7eb);border-radius:4px;overflow:hidden">
        <div id="bulk-progress-bar" style="height:100%;width:0;background:var(--primary,#2563eb);transition:width 0.2s"></div>
      </div>
    </div>
    <div id="bulk-msg"></div>
    <div id="bulk-results"></div>
  </div>`));

  const wrap = content.firstChild;
  let parsedRows = [];

  const templateCsv = [
    'email,full_name,emp_id,dept_id,employment_type,ilg_state,manager_emp_id,groups',
    'jane.doe@example.com,Jane Doe,,ENG,CORPORATE,ACTIVE,,Engineering|All Staff',
    'john.smith@example.com,John Smith,EMP001,SALES,CORPORATE,ACTIVE,MGR001,Sales Team',
  ].join('\n');

  function setRowCount(n) {
    wrap.querySelector('#bulk-row-count').textContent = n
      ? `${n.toLocaleString()} row${n === 1 ? '' : 's'} ready`
      : '';
    wrap.querySelector('#bulk-run').disabled = n === 0;
  }

  function loadFromText(text) {
    const { rows, errors } = parseBulkCsv(text);
    parsedRows = rows;
    const msgEl = wrap.querySelector('#bulk-msg');
    if (errors.length) {
      msgEl.innerHTML = errHtml(errors.join('; '));
      setRowCount(0);
      return;
    }
    msgEl.innerHTML = '';
    setRowCount(rows.length);
  }

  wrap.querySelector('#bulk-dl-template').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(templateCsv);
    a.download = 'bulk-users-template.csv';
    a.click();
  });

  wrap.querySelector('#bulk-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    wrap.querySelector('#bulk-paste').value = text;
    loadFromText(text);
  });

  wrap.querySelector('#bulk-paste').addEventListener('input', () => {
    const text = wrap.querySelector('#bulk-paste').value.trim();
    if (!text) { parsedRows = []; setRowCount(0); return; }
    loadFromText(text);
  });

  wrap.querySelector('#bulk-preview').addEventListener('click', () => {
    const text = wrap.querySelector('#bulk-paste').value.trim();
    if (!text) { wrap.querySelector('#bulk-msg').innerHTML = errHtml('Paste or upload a CSV first'); return; }
    loadFromText(text);
    if (!parsedRows.length) return;
    const preview = parsedRows.slice(0, 5);
    wrap.querySelector('#bulk-results').innerHTML = `
      <div class="card"><h3 style="margin:0 0 0.75rem">Preview (first ${preview.length} rows)</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Line</th><th>Email</th><th>Name</th><th>Groups</th></tr></thead>
        <tbody>${preview.map((r) => `<tr>
          <td class="muted">${r.line}</td>
          <td>${esc(r.email)}</td>
          <td>${esc(r.fullName)}</td>
          <td class="muted">${esc((r.groups || []).join(' | ') || '—')}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>`;
  });

  wrap.querySelector('#bulk-run').addEventListener('click', async () => {
    if (!parsedRows.length) return;
    const mode = wrap.querySelector('#bulk-mode').value;
    const runBtn = wrap.querySelector('#bulk-run');
    const previewBtn = wrap.querySelector('#bulk-preview');
    const progress = wrap.querySelector('#bulk-progress');
    const bar = wrap.querySelector('#bulk-progress-bar');
    const label = wrap.querySelector('#bulk-progress-label');
    const pctEl = wrap.querySelector('#bulk-progress-pct');
    const msgEl = wrap.querySelector('#bulk-msg');
    const resultsEl = wrap.querySelector('#bulk-results');

    runBtn.disabled = true;
    previewBtn.disabled = true;
    progress.hidden = false;
    msgEl.innerHTML = '';
    resultsEl.innerHTML = '';

    const chunks = chunkArray(parsedRows, BULK_BATCH_SIZE);
    const totals = { created: 0, updated: 0, failed: 0, groupsAdded: 0, processed: 0 };
    const failedRows = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const pct = Math.round((i / chunks.length) * 100);
        bar.style.width = `${pct}%`;
        pctEl.textContent = `${pct}%`;
        label.textContent = `Batch ${i + 1} of ${chunks.length} (${chunk.length} rows)…`;

        const r = await api.bulkUsersBatch(chunk, mode);
        totals.created += r.created || 0;
        totals.updated += r.updated || 0;
        totals.failed += r.failed || 0;
        totals.groupsAdded += r.groupsAdded || 0;
        totals.processed += r.processed || chunk.length;

        for (const row of (r.rows || [])) {
          if (row.action === 'failed') failedRows.push(row);
        }
      }

      bar.style.width = '100%';
      pctEl.textContent = '100%';
      label.textContent = 'Complete';

      const tone = totals.failed ? 'alert-warning' : 'alert-success';
      msgEl.innerHTML = `<div class="alert ${tone}">
        Processed <strong>${totals.processed.toLocaleString()}</strong> rows —
        created <strong>${totals.created.toLocaleString()}</strong>,
        updated <strong>${totals.updated.toLocaleString()}</strong>,
        failed <strong>${totals.failed.toLocaleString()}</strong>,
        group memberships added <strong>${totals.groupsAdded.toLocaleString()}</strong>.
      </div>`;

      if (failedRows.length) {
        const show = failedRows.slice(0, 100);
        resultsEl.innerHTML = `<div class="card"><h3 style="margin:0 0 0.75rem">Errors (${failedRows.length.toLocaleString()})</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Line</th><th>Email</th><th>Error</th></tr></thead>
            <tbody>${show.map((r) => `<tr>
              <td class="muted">${r.line ?? '—'}</td>
              <td>${esc(r.email || '')}</td>
              <td class="muted">${esc(r.error || 'Unknown error')}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          ${failedRows.length > 100 ? `<p class="muted" style="margin-top:0.5rem">Showing first 100 errors.</p>` : ''}
          <button type="button" class="btn btn-secondary btn-sm" id="bulk-dl-errors" style="margin-top:0.75rem">Download errors CSV</button>
        </div>`;
        wrap.querySelector('#bulk-dl-errors')?.addEventListener('click', () => {
          csvDownload('bulk-import-errors.csv', [
            ['line', 'email', 'error'],
            ...failedRows.map((r) => [r.line ?? '', r.email ?? '', r.error ?? '']),
          ]);
        });
      }
    } catch (err) {
      msgEl.innerHTML = errHtml(err.message || 'Import failed');
      progress.hidden = true;
    }

    runBtn.disabled = parsedRows.length === 0;
    previewBtn.disabled = false;
  });
}

// ─── 2. System Users ──────────────────────────────────────────────────────────
export async function viewSystemUsers(content) {
  content.replaceChildren(el(`<div>${header('System Users', 'Service accounts and machine identities', `<button class="btn btn-primary" id="new-su-btn">+ Add Service User</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const users = norm(await api.listSystemUsers());
      const rows = users.length ? users.map(u => `
        <tr>
          <td class="cell-strong">${esc(u.name || u.username || '—')}</td>
          <td><span class="badge badge-info">${esc(u.type || 'SERVICE')}</span></td>
          <td class="muted">${esc(u.owner_emp_id || '—')}</td>
          <td class="muted">${esc(u.description || u.source_system || '—')}</td>
          <td class="muted">${u.created_at ? fmtDate(u.created_at) : '—'}</td>
          <td><button class="btn btn-sm btn-danger del-su" data-id="${esc(String(u.id))}">Delete</button></td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No service accounts.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Username</th><th>Type</th><th>Owner</th><th>Notes</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-su').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this service user?')) return;
          try { await api.deleteSystemUser(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  wrap.querySelector('#new-su-btn').addEventListener('click', () => {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Add Service User</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Username</label><input class="form-input" id="su-user" placeholder="svc-myapp"></div>
      <div class="form-group"><label class="form-label">Type</label><select class="form-select" id="su-type"><option value="SERVICE_ACCOUNT">SERVICE_ACCOUNT</option><option value="API_CLIENT">API_CLIENT</option><option value="ROBOT">ROBOT</option><option value="SHARED">SHARED</option></select></div>
      <div class="form-group"><label class="form-label">Owner Employee ID</label><input class="form-input" id="su-owner" placeholder="Optional emp_id of owner"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="su-desc" placeholder="What this account is for"></div>
      <div class="form-group"><label class="form-label">Source System</label><input class="form-input" id="su-src" placeholder="e.g. jenkins, aws"></div>
      <div id="su-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="su-save">Create</button><button class="btn btn-secondary" id="su-cancel">Cancel</button></div></div>`);
    bd.querySelector('#su-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#su-save').addEventListener('click', async () => {
      const data = {
        name: bd.querySelector('#su-user').value.trim(),
        type: bd.querySelector('#su-type').value,
        owner_emp_id: bd.querySelector('#su-owner').value.trim() || undefined,
        description: bd.querySelector('#su-desc').value.trim() || undefined,
        source_system: bd.querySelector('#su-src').value.trim() || undefined,
      };
      if (!data.name) { bd.querySelector('#su-err').innerHTML = errHtml('Username required'); return; }
      try { await api.createSystemUser(data); bd.remove(); await load(); } catch(e) { bd.querySelector('#su-err').innerHTML = errHtml(e.message); }
    });
  });

  await load();
}

// ─── 3. Identity Profiles ─────────────────────────────────────────────────────
export async function viewIdentityProfiles(content) {
  content.replaceChildren(el(`<div>${header('Identity Profiles', 'Define how identities are sourced and correlated', `<button class="btn btn-primary" id="new-ip-btn">+ New Profile</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const profiles = norm(await api.listIdentityProfiles());
      const rows = profiles.length ? profiles.map(p => `
        <tr>
          <td class="cell-strong">${esc(p.name)}</td>
          <td><span class="badge badge-info">${esc(p.population || p.source_type || '—')}</span></td>
          <td>${p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-ip" data-id="${esc(String(p.id))}" data-name="${esc(p.name)}" data-desc="${esc(p.description||'')}" data-src="${esc(p.population||p.source_type||'')}">Edit</button>
            <button class="btn btn-sm btn-danger del-ip" data-id="${esc(String(p.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">◎</div><p>No identity profiles.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Population</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

      wrap.querySelectorAll('.del-ip').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this profile?')) return;
          try { await api.deleteIdentityProfile(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-ip').forEach(btn => {
        btn.addEventListener('click', () => openIpModal(btn.dataset.id, { name: btn.dataset.name, description: btn.dataset.desc, population: btn.dataset.src }));
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openIpModal(id, defaults = {}) {
    const isEdit = !!id;
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Identity Profile</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ip-name" value="${esc(defaults.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="ip-desc" value="${esc(defaults.description||'')}"></div>
      <div class="form-group"><label class="form-label">Population</label><select class="form-select" id="ip-src">
        <option value="EMPLOYEE" ${(defaults.population||defaults.source_type)==='EMPLOYEE'?'selected':''}>Employee</option>
        <option value="CONTRACTOR" ${(defaults.population||defaults.source_type)==='CONTRACTOR'?'selected':''}>Contractor</option>
        <option value="PARTNER" ${(defaults.population||defaults.source_type)==='PARTNER'?'selected':''}>Partner</option>
        <option value="CUSTOMER" ${(defaults.population||defaults.source_type)==='CUSTOMER'?'selected':''}>Customer</option>
        <option value="SERVICE" ${(defaults.population||defaults.source_type)==='SERVICE'?'selected':''}>Service Account</option>
      </select></div>
      <div id="ip-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="ip-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="ip-cancel">Cancel</button></div></div>`);
    bd.querySelector('#ip-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#ip-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#ip-name').value, description: bd.querySelector('#ip-desc').value, population: bd.querySelector('#ip-src').value };
      if (!data.name) { bd.querySelector('#ip-err').innerHTML = errHtml('Name required'); return; }
      try {
        if (isEdit) await api.updateIdentityProfile(id, data); else await api.createIdentityProfile(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#ip-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#new-ip-btn').addEventListener('click', () => openIpModal(null));
  await load();
}

// ─── 4. MFA Methods ───────────────────────────────────────────────────────────
export async function viewMfaMethods(content) {
  content.replaceChildren(el(`<div class="ent-page">
    ${header('MFA Methods', 'Multi-factor authentication enrollment and enforcement policy')}
    <div id="mfa-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;
  let mfaActiveTab = 'overview';

  const methodDefs = [
    { key: 'totp',         label: 'Authenticator App (TOTP)', desc: 'Time-based one-time passwords via Google Authenticator, Authy, etc.' },
    { key: 'backup_codes', label: 'Backup Codes',             desc: 'Single-use emergency recovery codes (bundled with TOTP).' },
    { key: 'webauthn',     label: 'WebAuthn / Passkeys',      desc: 'Hardware security keys and biometric passkeys.' },
    { key: 'email_otp',    label: 'Email OTP',                desc: 'One-time code sent to registered email address.' },
    { key: 'sms_otp',      label: 'SMS OTP',                  desc: 'One-time code sent via SMS to employee mobile.' },
  ];

  function deliveryModeLabel(mode) {
    if (mode === 'smtp') return 'Ready · SMTP';
    if (mode === 'api') return 'Ready · API';
    if (mode === 'gateway') return 'Ready';
    if (mode === 'dev') return 'Dev mode';
    return 'Not configured';
  }

  function deliveryBadge(mode) {
    if (mode === 'smtp' || mode === 'api' || mode === 'gateway') return 'badge-success';
    if (mode === 'dev') return 'badge-warning';
    return 'badge-danger';
  }

  function sourceBadge(source) {
    if (source === 'db') return '<span class="badge badge-info">Admin GUI</span>';
    if (source === 'env') return '<span class="badge badge-neutral">.env fallback</span>';
    return '<span class="badge badge-neutral">—</span>';
  }

  async function loadMfaPage() {
    try {
      const [status, policyRes, groupsRes, deliveryRes, groupPolRes, criticalAppsRes] = await Promise.all([
        api.mfaStatus().catch(() => ({})),
        api.getMfaPolicy().catch(() => ({ data: {} })),
        api.listGroups().catch(() => ({ data: [] })),
        api.getMfaDeliveryStatus().catch(() => ({ data: {} })),
        api.listMfaGroupPolicies().catch(() => ({ data: [] })),
        api.listMfaCriticalApps().catch(() => ({ data: [] })),
      ]);
      const policy = policyRes?.data || {};
      const groups = norm(groupsRes);
      const groupPolicies = norm(groupPolRes);
      const criticalApps = norm(criticalAppsRes);
      const enrolled = status?.methods || [];
      const allowedMethods = Array.isArray(policy.allowed_methods)
        ? policy.allowed_methods
        : ['totp', 'backup_codes', 'webauthn', 'email_otp', 'sms_otp'];
      const allowedSet = new Set(allowedMethods);
      const liveCount = methodDefs.filter((m) => allowedSet.has(m.key)).length;
      const enrolledCount = enrolled.length;
      const globalEnforce = !!policy['global_enforce'];
      const enforceAdmins = !!policy['enforce_for_admins'];
      const gracePeriod   = policy['grace_period_hours'] ?? 24;
      const rememberDevice = policy['remember_device_hours'] ?? 24;
      const criticalAppMfa = policy['critical_app_mfa'] !== false && policy['critical_app_mfa'] !== 0 && policy['critical_app_mfa'] !== '0';
      const criticalAppMaxAge = policy['critical_app_mfa_max_age_seconds'] ?? 300;
      const parseExcludedGroupIds = (raw) => {
        if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean);
        if (typeof raw !== 'string') return [];
        const trimmed = raw.trim();
        if (!trimmed) return [];
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed.map((v) => String(v)).filter(Boolean);
        } catch { /* ignore */ }
        return trimmed.split(',').map((v) => v.trim()).filter(Boolean);
      };
      const excludedGroupIds = parseExcludedGroupIds(policy['excluded_group_ids']);
      const groupById = new Map(groups.map((g) => [String(g.id), g]));
      const excludedIds = new Set(excludedGroupIds.map(String));

      const cards = methodDefs.map((m) => {
        const isAllowed = allowedSet.has(m.key);
        const isEnrolled = enrolled.includes(m.key);
        return `<div class="mfa-method-card card">
          <div class="mfa-method-card-head">
            <strong>${esc(m.label)}</strong>
            <div class="mfa-method-card-badges">
              <span class="badge ${isAllowed ? 'badge-success' : 'badge-neutral'}">${isAllowed ? 'Live' : 'Disabled'}</span>
              ${isEnrolled ? '<span class="badge badge-info">Your enrollment</span>' : '<span class="badge badge-neutral">Not enrolled</span>'}
            </div>
          </div>
          <p class="muted">${esc(m.desc)}</p>
        </div>`;
      }).join('');

      const methodPolicyRows = methodDefs.map((m) => `
        <label class="mfa-policy-method" style="display:flex;align-items:center;gap:0.55rem;padding:0.4rem 0;cursor:pointer">
          <input type="checkbox" class="policy-method" value="${esc(m.key)}" ${allowedSet.has(m.key) ? 'checked' : ''}>
          <span style="font-size:0.875rem">${esc(m.label)}</span>
        </label>`).join('');

      const delivery = deliveryRes?.data || {};
      const emailDelivery = delivery.emailOtp || {};
      const smsDelivery = delivery.smsOtp || {};
      const emailMode = emailDelivery.mode || 'none';
      const smsMode = smsDelivery.mode || 'none';

      const methodLabel = (key) => methodDefs.find((m) => m.key === key)?.label || key;
      const policyRowsHtml = groupPolicies.length
        ? groupPolicies.map((p) => {
          const methods = Array.isArray(p.allowedMethods) ? p.allowedMethods : [];
          return `<tr data-id="${esc(String(p.id))}">
            <td class="cell-strong">${esc(p.groupName || p.groupId)}</td>
            <td><span class="badge badge-neutral">${esc(p.sourceSystem || 'LOCAL')}</span></td>
            <td><div class="mfa-method-chips">${methods.map((k) => `<span class="mfa-method-chip">${esc(methodLabel(k))}</span>`).join('') || '<span class="muted">—</span>'}</div></td>
            <td>${p.enforce ? '<span class="badge badge-danger">Enforce</span>' : '<span class="badge badge-neutral">Optional</span>'}</td>
            <td>${p.active === false ? '<span class="badge badge-warning">Off</span>' : '<span class="badge badge-success">Active</span>'}</td>
            <td class="table-actions">
              <button type="button" class="btn btn-sm btn-secondary mfa-gp-edit" data-id="${esc(String(p.id))}">Edit</button>
              <button type="button" class="btn btn-sm btn-danger mfa-gp-del" data-id="${esc(String(p.id))}">Delete</button>
            </td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="6"><div class="empty-state"><p>No group MFA policies yet. Assign allowed methods per directory group.</p></div></td></tr>`;

      wrap.querySelector('#mfa-area').innerHTML = `
        <div class="inline-tabs" id="mfa-page-tabs" style="margin-bottom:1.25rem">
          <button type="button" class="inline-tab${mfaActiveTab === 'overview' ? ' active' : ''}" data-tab="overview">Overview &amp; Global Policy</button>
          <button type="button" class="inline-tab${mfaActiveTab === 'policies' ? ' active' : ''}" data-tab="policies">MFA Policies</button>
        </div>

        <div id="mfa-tab-overview" class="mfa-tab-pane${mfaActiveTab === 'overview' ? '' : ' is-hidden'}">
        <!-- ── Stats ── -->
        <div class="stat-grid" style="margin-bottom:1.5rem">
          ${statCard('shieldCheck', 'Methods Enrolled',   enrolledCount,      status?.enabled ? 'Active' : 'Not active', 'primary')}
          ${statCard('check',       'Live Methods',     liveCount,          `${liveCount} of ${methodDefs.length} enabled`, 'success')}
          ${statCard('shield',      'Your Methods',     enrolledCount,      enrolledCount ? 'you have MFA methods' : 'enroll in Settings', enrolledCount ? 'accent' : 'warning')}
          ${statCard('shield',      'Global Enforce',     globalEnforce ? 'ON' : 'OFF', globalEnforce ? 'MFA required for all' : 'Off', globalEnforce ? 'danger' : 'primary')}
        </div>

        <!-- ── Method cards ── -->
        <div class="section-title">Available Methods</div>
        <div class="mfa-method-grid" style="margin-bottom:1.5rem">${cards}</div>

        <!-- ── OTP delivery (Admin GUI) ── -->
        <div class="ent-panel mfa-delivery-panel" style="margin-bottom:0.25rem">
          <div class="ent-panel-head">
            <div class="panel-meta">
              <h2>OTP delivery channels</h2>
              <p class="subtitle">Configure SMTP, HTTP email API, or SMS gateway for OTP. Changes apply immediately — no API restart.</p>
            </div>
          </div>
          <div class="ent-panel-body">
            <div class="mfa-delivery-split">
              <div class="config-form-panel">
                <div class="mfa-delivery-head">
                  <h3>Email OTP</h3>
                  <div style="display:flex;gap:0.35rem;align-items:center;flex-wrap:wrap">
                    <span class="badge ${deliveryBadge(emailMode)}">${esc(deliveryModeLabel(emailMode))}</span>
                    ${sourceBadge(emailDelivery.source)}
                  </div>
                </div>
                <p class="form-hint" style="margin-top:0">Codes are emailed to each user&apos;s corporate address (<code>email_corp</code>). Choose SMTP or an HTTP email API.</p>
                <form id="mfa-smtp-form">
                  <div class="form-group">
                    <label class="form-label">Delivery method</label>
                    <div class="mfa-transport-pills" role="radiogroup" aria-label="Email delivery method">
                      <label class="mfa-transport-pill">
                        <input type="radio" name="mfa-email-transport" value="smtp" ${(emailDelivery.transport || 'smtp') !== 'api' ? 'checked' : ''}>
                        <span>
                          <strong>SMTP</strong>
                          <span class="muted">Host, port, username &amp; password</span>
                        </span>
                      </label>
                      <label class="mfa-transport-pill">
                        <input type="radio" name="mfa-email-transport" value="api" ${emailDelivery.transport === 'api' ? 'checked' : ''}>
                        <span>
                          <strong>HTTP API</strong>
                          <span class="muted">POST to your email gateway</span>
                        </span>
                      </label>
                    </div>
                  </div>

                  <div id="mfa-email-smtp-fields" class="${emailDelivery.transport === 'api' ? 'is-hidden' : ''}">
                    <div class="form-row-2">
                      <div class="form-group">
                        <label class="form-label">SMTP host</label>
                        <input class="form-input" id="mfa-smtp-host" value="${esc(emailDelivery.smtpHost || '')}" placeholder="smtp.office365.com" autocomplete="off">
                      </div>
                      <div class="form-group">
                        <label class="form-label">Port</label>
                        <input class="form-input" id="mfa-smtp-port" type="number" min="1" max="65535" value="${esc(String(emailDelivery.smtpPort || 587))}">
                      </div>
                    </div>
                    <div class="form-row-2">
                      <div class="form-group">
                        <label class="form-label">Username</label>
                        <input class="form-input" id="mfa-smtp-user" value="${esc(emailDelivery.smtpUser || '')}" placeholder="noreply@lenskart.com" autocomplete="off">
                      </div>
                      <div class="form-group">
                        <label class="form-label">Password</label>
                        <input class="form-input" id="mfa-smtp-pass" type="password" placeholder="${emailDelivery.hasSmtpPass ? 'Saved — leave blank to keep' : 'SMTP password'}" autocomplete="new-password">
                      </div>
                    </div>
                    <div class="form-row-2">
                      <div class="form-group">
                        <label class="form-label">From address</label>
                        <input class="form-input" id="mfa-smtp-from" value="${esc(emailDelivery.smtpFrom || '')}" placeholder="noreply@lenskart.com">
                      </div>
                      <div class="form-group">
                        <label class="form-label">Connection security</label>
                        <select class="form-select" id="mfa-smtp-secure">
                          <option value="0" ${!emailDelivery.smtpSecure ? 'selected' : ''}>STARTTLS (port 587)</option>
                          <option value="1" ${emailDelivery.smtpSecure ? 'selected' : ''}>TLS / SSL (port 465)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div id="mfa-email-api-fields" class="${emailDelivery.transport === 'api' ? '' : 'is-hidden'}">
                    <div class="form-group">
                      <label class="form-label">Email API URL</label>
                      <input class="form-input" id="mfa-email-api-url" value="${esc(emailDelivery.emailApiUrl || '')}" placeholder="https://mail.example.com/v1/send" autocomplete="off">
                      <p class="form-hint">POST JSON: <code>{ "to", "subject", "body", "from" }</code> with optional Bearer auth</p>
                    </div>
                    <div class="form-row-2">
                      <div class="form-group">
                        <label class="form-label">From address</label>
                        <input class="form-input" id="mfa-email-api-from" value="${esc(emailDelivery.smtpFrom || '')}" placeholder="noreply@lenskart.com">
                      </div>
                      <div class="form-group">
                        <label class="form-label">API key <span class="muted">(optional)</span></label>
                        <input class="form-input" id="mfa-email-api-key" type="password" placeholder="${emailDelivery.hasEmailApiKey ? 'Saved — leave blank to keep' : 'Optional Bearer token'}" autocomplete="new-password">
                      </div>
                    </div>
                  </div>

                  <label class="mfa-toggle-row">
                    <input type="checkbox" id="mfa-otp-dev-log" ${emailDelivery.otpDevLog || smsDelivery.otpDevLog ? 'checked' : ''}>
                    <span>
                      <strong>Development mode</strong>
                      <span class="muted">Return OTP codes in API responses and logs (never enable in production)</span>
                    </span>
                  </label>
                  <div id="mfa-smtp-msg" style="margin:0.65rem 0"></div>
                  <div class="mfa-delivery-actions">
                    <button type="submit" class="btn btn-primary" id="mfa-smtp-save">Save email delivery</button>
                    <button type="button" class="btn btn-secondary" id="mfa-smtp-test">Send test email</button>
                    <button type="button" class="btn btn-secondary" id="mfa-smtp-clear">Clear email settings</button>
                  </div>
                </form>
              </div>

              <div class="config-form-panel">
                <div class="mfa-delivery-head">
                  <h3>SMS OTP (gateway)</h3>
                  <div style="display:flex;gap:0.35rem;align-items:center;flex-wrap:wrap">
                    <span class="badge ${deliveryBadge(smsMode)}">${esc(deliveryModeLabel(smsMode))}</span>
                    ${sourceBadge(smsDelivery.source)}
                  </div>
                </div>
                <p class="form-hint" style="margin-top:0">Codes are sent to the mobile number on each employee profile via HTTP POST.</p>
                <form id="mfa-sms-form">
                  <div class="form-group">
                    <label class="form-label">Gateway URL</label>
                    <input class="form-input" id="mfa-sms-url" value="${esc(smsDelivery.smsApiUrl || '')}" placeholder="https://sms.example.com/v1/send" autocomplete="off">
                    <p class="form-hint">POST JSON body: <code>{ "to": "+91…", "message": "…" }</code></p>
                  </div>
                  <div class="form-group">
                    <label class="form-label">API key <span class="muted">(optional Bearer token)</span></label>
                    <input class="form-input" id="mfa-sms-key" type="password" placeholder="${smsDelivery.hasSmsApiKey ? 'Saved — leave blank to keep' : 'Optional API key'}" autocomplete="new-password">
                  </div>
                  <label class="mfa-toggle-row">
                    <input type="checkbox" id="mfa-sms-dev-log" ${smsDelivery.smsDevLog ? 'checked' : ''}>
                    <span>
                      <strong>SMS development log</strong>
                      <span class="muted">Log SMS body when gateway URL is empty (dev only)</span>
                    </span>
                  </label>
                  <div id="mfa-sms-msg" style="margin:0.65rem 0"></div>
                  <div class="mfa-delivery-actions">
                    <button type="submit" class="btn btn-primary" id="mfa-sms-save">Save SMS delivery</button>
                    <button type="button" class="btn btn-secondary" id="mfa-sms-clear">Clear SMS</button>
                  </div>
                </form>
              </div>
            </div>
            <p class="card-footnote">
              After delivery is Ready, enable <em>Email OTP</em> / <em>SMS OTP</em> under Allowed MFA Methods below, then users enroll at Settings → MFA.
            </p>
          </div>
        </div>

        <!-- ── Enforce Policy ── -->
        <div class="card" style="margin-bottom:1.25rem;border-left:3px solid var(--primary)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem">
            <div>
              <div style="font-weight:700;font-size:1rem">MFA Enforcement Policy</div>
              <p class="muted" style="font-size:0.85rem;margin:0">Control who must complete MFA before accessing the portal.</p>
            </div>
            <button class="btn btn-primary" id="save-policy-btn">Save Policy</button>
          </div>
          <div id="policy-msg" style="margin-bottom:0.75rem"></div>
          <div class="grid-2" style="gap:1rem">
            <div class="form-group">
              <label class="form-label" style="font-weight:600">Global Enforcement</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Require MFA for ALL users at login.</p>
              <select class="form-select" id="policy-global">
                <option value="1" ${globalEnforce?'selected':''}>Enabled — everyone must enroll MFA</option>
                <option value="0" ${!globalEnforce?'selected':''}>Disabled — MFA is optional (unless per-user enforced)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" style="font-weight:600">Enforce MFA for administrators</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Off by default. When enabled, portal operators (Admin / Super-Admin and other console roles) must enroll MFA. Same grace period as global enforcement — not auto-forced outside this policy.</p>
              <select class="form-select" id="policy-admins">
                <option value="1" ${enforceAdmins?'selected':''}>Enabled — require MFA for administrators</option>
                <option value="0" ${!enforceAdmins?'selected':''}>Disabled — administrators follow global / per-user / group policy only</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" style="font-weight:600">Grace Period (hours)</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Allow login without MFA for this many hours after enforcement begins (first-time enrollment only).</p>
              <input class="form-input" type="number" id="policy-grace" value="${esc(String(gracePeriod))}" min="0" max="168" />
            </div>
            <div class="form-group">
              <label class="form-label" style="font-weight:600">Remember MFA on this browser (hours)</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">After a successful MFA challenge, do not ask again on the same browser for this many hours. Set 0 to always prompt. Adaptive risk (STEP_UP / MFA) still forces a challenge.</p>
              <input class="form-input" type="number" id="policy-remember" value="${esc(String(rememberDevice))}" min="0" max="8760" />
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label" style="font-weight:600">Allowed MFA Methods</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.45rem">Users can enroll only the methods enabled here.</p>
              <div class="mfa-policy-methods">${methodPolicyRows}</div>
            </div>
            <div class="form-group" style="grid-column:1/-1;padding-top:0.5rem;border-top:1px solid var(--border,#e2e8f0)">
              <label class="form-label" style="font-weight:600">Application-level MFA (critical apps)</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.65rem">When enabled, launching a marked critical application requires a fresh MFA challenge even if the portal session is already open (SAML / OIDC). Remember-device does <strong>not</strong> skip this step-up.</p>
              <div class="grid-2" style="gap:1rem;margin-bottom:0.85rem">
                <div>
                  <label class="form-label">Push application MFA</label>
                  <select class="form-select" id="policy-critical-app-mfa">
                    <option value="1" ${criticalAppMfa ? 'selected' : ''}>Enabled — enforce MFA at critical app launch</option>
                    <option value="0" ${!criticalAppMfa ? 'selected' : ''}>Disabled — ignore critical-app flags</option>
                  </select>
                </div>
                <div>
                  <label class="form-label">Fresh MFA max age (seconds)</label>
                  <input class="form-input" type="number" id="policy-critical-app-age" value="${esc(String(criticalAppMaxAge))}" min="0" max="86400" />
                  <p class="muted" style="font-size:0.75rem;margin:0.25rem 0 0">0 = challenge on every launch. Default 300 (5 min).</p>
                </div>
              </div>
              <div class="table-wrap"><table><thead><tr>
                <th>Application</th><th>Slug</th><th>Critical MFA</th>
              </tr></thead><tbody>
              ${criticalApps.length ? criticalApps.map((a) => `<tr>
                <td class="cell-strong">${esc(a.name)}${a.has_saml ? ' <span class="badge badge-info">SAML</span>' : ''}</td>
                <td class="mono muted" style="font-size:0.78rem">${esc(a.slug)}</td>
                <td>
                  <label style="display:flex;gap:0.4rem;align-items:center;margin:0;cursor:pointer;font-weight:600">
                    <input type="checkbox" class="policy-critical-app" data-id="${esc(a.id)}" ${a.require_mfa ? 'checked' : ''} />
                    Require MFA at launch
                  </label>
                </td>
              </tr>`).join('') : '<tr><td colspan="3"><div class="empty-state"><p>No applications in catalog yet. Register a SAML app first.</p></div></td></tr>'}
              </tbody></table></div>
              <p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0">You can also toggle this on each SAML application under Applications → SAML.</p>
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label" style="font-weight:600">Exclude Groups from Policy MFA</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Drag groups to the right column (or use the arrows) to bypass global/admin MFA — including login challenges for already-enrolled methods. Per-user Enforce and group Enforce still apply. Adaptive risk can still require MFA.</p>
              <div class="mfa-exclude-shuttle" id="mfa-exclude-shuttle" data-empty="${groups.length ? '0' : '1'}">
                <div class="mfa-exclude-col">
                  <div class="mfa-exclude-col-head">
                    <strong>Available groups</strong>
                    <span class="muted" id="mfa-avail-count">0</span>
                  </div>
                  <input class="form-input mfa-exclude-search" id="policy-exclude-search" placeholder="Search available…" autocomplete="off" />
                  <div class="mfa-exclude-list" id="mfa-avail-list" data-side="available" aria-label="Available groups"></div>
                </div>
                <div class="mfa-exclude-actions" aria-hidden="true">
                  <button type="button" class="btn btn-secondary btn-sm" id="mfa-exclude-add" title="Exclude selected">→</button>
                  <button type="button" class="btn btn-secondary btn-sm" id="mfa-exclude-remove" title="Restore selected">←</button>
                </div>
                <div class="mfa-exclude-col">
                  <div class="mfa-exclude-col-head">
                    <strong>Excluded from MFA</strong>
                    <span class="muted"><span id="policy-exclude-count">0</span> selected</span>
                  </div>
                  <div class="mfa-exclude-hint muted">Drop groups here</div>
                  <div class="mfa-exclude-list mfa-exclude-list--target" id="mfa-excl-list" data-side="excluded" aria-label="Excluded groups"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Per-User MFA Management ── -->
        <div class="card" style="margin-bottom:1.25rem">
          <div style="font-weight:700;font-size:1rem;margin-bottom:0.25rem">Per-User MFA Management</div>
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">Search a user to enforce, reset (force fresh enrollment), or disable MFA.</p>
          <div style="display:flex;gap:0.6rem;align-items:flex-end;flex-wrap:wrap;margin-bottom:0.75rem">
            <div class="form-group" style="flex:1;min-width:240px;margin:0">
              <label class="form-label">Search user (name or email)</label>
              <input class="form-input" id="mfa-user-search" placeholder="e.g. ravi.verma@lenskart.in" autocomplete="off" />
            </div>
          </div>
          <div id="mfa-user-results"></div>
          <div id="mfa-user-actions" style="display:none">
            <div id="mfa-user-info" style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;background:var(--surface-3);border-radius:var(--radius);margin-bottom:0.75rem;flex-wrap:wrap">
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
              <button class="btn btn-primary btn-sm" id="mfa-enforce-btn">🔒 Enforce MFA</button>
              <button class="btn btn-secondary btn-sm" id="mfa-unenforce-btn">Remove Enforcement</button>
              <button class="btn btn-secondary btn-sm" id="mfa-reset-btn">↺ Reset MFA (force re-enrollment)</button>
              <button class="btn btn-danger btn-sm" id="mfa-disable-btn">Disable MFA</button>
            </div>
            <div id="mfa-action-msg" style="margin-top:0.5rem;font-size:0.85rem"></div>
          </div>
        </div>

        <div style="margin-top:0.5rem">
          <a href="/?v=settings" class="btn btn-secondary">My Enrollment →</a>
        </div>
        </div><!-- /mfa-tab-overview -->

        <div id="mfa-tab-policies" class="mfa-tab-pane${mfaActiveTab === 'policies' ? '' : ' is-hidden'}">
          <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:0.85rem">
              <div>
                <div style="font-weight:700;font-size:1rem">Group MFA Policies</div>
                <p class="muted" style="font-size:0.85rem;margin:0.2rem 0 0">Assign which MFA methods members of each group may use. Global allowed methods are the ceiling. Multiple group policies for one user are combined (union), then limited by global settings.</p>
              </div>
              <button type="button" class="btn btn-primary" id="mfa-gp-add">+ Add group policy</button>
            </div>
            <div id="mfa-gp-msg" style="margin-bottom:0.75rem"></div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Source</th>
                    <th>Allowed methods</th>
                    <th>Enforce</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="mfa-gp-tbody">${policyRowsHtml}</tbody>
              </table>
            </div>
          </div>
        </div>`;

      const availListEl = wrap.querySelector('#mfa-avail-list');
      const exclListEl = wrap.querySelector('#mfa-excl-list');
      const excludeSearchEl = wrap.querySelector('#policy-exclude-search');
      const excludeCountEl = wrap.querySelector('#policy-exclude-count');
      const availCountEl = wrap.querySelector('#mfa-avail-count');
      const selectedAvail = new Set();
      const selectedExcl = new Set();
      let dragGroupId = null;

      function groupLabel(g) {
        return String(g?.name || g?.id || '');
      }

      function renderGroupItem(g, side) {
        const id = String(g.id);
        const selected = (side === 'available' ? selectedAvail : selectedExcl).has(id);
        return `<div class="mfa-exclude-item${selected ? ' is-selected' : ''}"
            draggable="true" data-id="${esc(id)}" data-side="${side}"
            data-label="${esc(groupLabel(g).toLowerCase())}" role="option" aria-selected="${selected ? 'true' : 'false'}">
            <span class="mfa-exclude-item-name">${esc(groupLabel(g))}</span>
            <span class="mfa-exclude-item-src muted">${esc(g.source_system || 'LOCAL')}</span>
          </div>`;
      }

      function renderExcludeShuttle() {
        if (!availListEl || !exclListEl) return;
        const q = (excludeSearchEl?.value || '').trim().toLowerCase();
        const available = groups.filter((g) => !excludedIds.has(String(g.id)));
        const excluded = [...excludedIds]
          .map((id) => groupById.get(id) || { id, name: `${id} (missing)`, source_system: '—' })
          .sort((a, b) => groupLabel(a).localeCompare(groupLabel(b)));

        const filteredAvail = available.filter((g) => {
          if (!q) return true;
          return groupLabel(g).toLowerCase().includes(q)
            || String(g.source_system || '').toLowerCase().includes(q);
        });

        availListEl.innerHTML = filteredAvail.length
          ? filteredAvail.map((g) => renderGroupItem(g, 'available')).join('')
          : `<div class="mfa-exclude-empty muted">${groups.length ? 'No matching groups' : 'No groups found. Create/sync groups in Identity → Groups.'}</div>`;
        exclListEl.innerHTML = excluded.length
          ? excluded.map((g) => renderGroupItem(g, 'excluded')).join('')
          : `<div class="mfa-exclude-empty muted">Drag groups here to exclude</div>`;

        if (availCountEl) availCountEl.textContent = String(available.length);
        if (excludeCountEl) excludeCountEl.textContent = String(excluded.length);
      }

      function moveToExcluded(ids) {
        ids.forEach((id) => {
          excludedIds.add(String(id));
          selectedAvail.delete(String(id));
        });
        renderExcludeShuttle();
      }

      function moveToAvailable(ids) {
        ids.forEach((id) => {
          excludedIds.delete(String(id));
          selectedExcl.delete(String(id));
        });
        renderExcludeShuttle();
      }

      function bindListInteractions(listEl, side) {
        if (!listEl) return;
        listEl.addEventListener('click', (e) => {
          const item = e.target.closest('.mfa-exclude-item');
          if (!item) return;
          const id = item.dataset.id;
          const bag = side === 'available' ? selectedAvail : selectedExcl;
          if (e.ctrlKey || e.metaKey) {
            if (bag.has(id)) bag.delete(id); else bag.add(id);
          } else {
            bag.clear();
            bag.add(id);
          }
          renderExcludeShuttle();
        });
        listEl.addEventListener('dblclick', (e) => {
          const item = e.target.closest('.mfa-exclude-item');
          if (!item) return;
          if (side === 'available') moveToExcluded([item.dataset.id]);
          else moveToAvailable([item.dataset.id]);
        });
        listEl.addEventListener('dragstart', (e) => {
          const item = e.target.closest('.mfa-exclude-item');
          if (!item) return;
          dragGroupId = item.dataset.id;
          e.dataTransfer.setData('text/plain', dragGroupId);
          e.dataTransfer.effectAllowed = 'move';
          item.classList.add('is-dragging');
        });
        listEl.addEventListener('dragend', (e) => {
          const item = e.target.closest('.mfa-exclude-item');
          item?.classList.remove('is-dragging');
          dragGroupId = null;
          availListEl?.classList.remove('is-drop-target');
          exclListEl?.classList.remove('is-drop-target');
        });
        listEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          listEl.classList.add('is-drop-target');
        });
        listEl.addEventListener('dragleave', (e) => {
          if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('is-drop-target');
        });
        listEl.addEventListener('drop', (e) => {
          e.preventDefault();
          listEl.classList.remove('is-drop-target');
          const id = e.dataTransfer.getData('text/plain') || dragGroupId;
          if (!id) return;
          if (side === 'excluded') moveToExcluded([id]);
          else moveToAvailable([id]);
        });
      }

      bindListInteractions(availListEl, 'available');
      bindListInteractions(exclListEl, 'excluded');
      excludeSearchEl?.addEventListener('input', () => renderExcludeShuttle());
      wrap.querySelector('#mfa-exclude-add')?.addEventListener('click', () => {
        if (selectedAvail.size) moveToExcluded([...selectedAvail]);
      });
      wrap.querySelector('#mfa-exclude-remove')?.addEventListener('click', () => {
        if (selectedExcl.size) moveToAvailable([...selectedExcl]);
      });
      renderExcludeShuttle();

      // ── Save SMTP / Email API / SMS delivery ───────────────────────────────
      function syncEmailTransportUi() {
        const transport = wrap.querySelector('input[name="mfa-email-transport"]:checked')?.value || 'smtp';
        const smtpFields = wrap.querySelector('#mfa-email-smtp-fields');
        const apiFields = wrap.querySelector('#mfa-email-api-fields');
        smtpFields?.classList.toggle('is-hidden', transport !== 'smtp');
        apiFields?.classList.toggle('is-hidden', transport !== 'api');
      }
      wrap.querySelectorAll('input[name="mfa-email-transport"]').forEach((el) => {
        el.addEventListener('change', syncEmailTransportUi);
      });
      syncEmailTransportUi();

      const smtpForm = wrap.querySelector('#mfa-smtp-form');
      smtpForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = wrap.querySelector('#mfa-smtp-msg');
        const btn = wrap.querySelector('#mfa-smtp-save');
        const transport = wrap.querySelector('input[name="mfa-email-transport"]:checked')?.value || 'smtp';
        const payload = {
          emailTransport: transport,
          otpDevLog: !!wrap.querySelector('#mfa-otp-dev-log')?.checked,
          smsDevLog: !!wrap.querySelector('#mfa-sms-dev-log')?.checked,
        };

        if (transport === 'api') {
          payload.emailApiUrl = wrap.querySelector('#mfa-email-api-url').value.trim();
          payload.smtpFrom = wrap.querySelector('#mfa-email-api-from').value.trim();
          const apiKey = wrap.querySelector('#mfa-email-api-key').value;
          if (apiKey) payload.emailApiKey = apiKey;
          if (payload.emailApiUrl && !payload.smtpFrom) {
            msg.innerHTML = '<div class="alert alert-error">From address is required when Email API URL is set.</div>';
            return;
          }
        } else {
          payload.smtpHost = wrap.querySelector('#mfa-smtp-host').value.trim();
          payload.smtpPort = Number(wrap.querySelector('#mfa-smtp-port').value) || 587;
          payload.smtpUser = wrap.querySelector('#mfa-smtp-user').value.trim();
          payload.smtpFrom = wrap.querySelector('#mfa-smtp-from').value.trim();
          payload.smtpSecure = wrap.querySelector('#mfa-smtp-secure').value === '1';
          const pass = wrap.querySelector('#mfa-smtp-pass').value;
          if (pass) payload.smtpPass = pass;
          if (payload.smtpHost && !payload.smtpFrom) {
            msg.innerHTML = '<div class="alert alert-error">From address is required when SMTP host is set.</div>';
            return;
          }
        }

        btn.disabled = true;
        btn.textContent = 'Saving…';
        msg.innerHTML = '';
        try {
          await api.saveMfaDelivery(payload);
          msg.innerHTML = '<div class="alert alert-success">Email delivery settings saved.</div>';
          await loadMfaPage();
        } catch (err) {
          msg.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to save')}</div>`;
          btn.disabled = false;
          btn.textContent = 'Save email delivery';
        }
      });

      wrap.querySelector('#mfa-smtp-clear')?.addEventListener('click', async () => {
        if (!confirm('Clear email delivery settings (SMTP and Email API) stored in the Admin GUI?')) return;
        const msg = wrap.querySelector('#mfa-smtp-msg');
        try {
          await api.saveMfaDelivery({ clearSmtp: true, clearEmailApi: true, emailTransport: 'smtp' });
          msg.innerHTML = '<div class="alert alert-success">Email delivery settings cleared.</div>';
          await loadMfaPage();
        } catch (err) {
          msg.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to clear')}</div>`;
        }
      });

      wrap.querySelector('#mfa-smtp-test')?.addEventListener('click', async () => {
        const msg = wrap.querySelector('#mfa-smtp-msg');
        const btn = wrap.querySelector('#mfa-smtp-test');
        btn.disabled = true;
        btn.textContent = 'Sending…';
        msg.innerHTML = '';
        try {
          const r = await api.testMfaDelivery({});
          msg.innerHTML = `<div class="alert alert-success">Test email sent to ${esc(r.sentTo || 'your address')}.</div>`;
        } catch (err) {
          msg.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Test email failed')}</div>`;
        } finally {
          btn.disabled = false;
          btn.textContent = 'Send test email';
        }
      });

      const smsForm = wrap.querySelector('#mfa-sms-form');
      smsForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = wrap.querySelector('#mfa-sms-msg');
        const btn = wrap.querySelector('#mfa-sms-save');
        const payload = {
          smsApiUrl: wrap.querySelector('#mfa-sms-url').value.trim(),
          otpDevLog: !!wrap.querySelector('#mfa-otp-dev-log')?.checked,
          smsDevLog: !!wrap.querySelector('#mfa-sms-dev-log')?.checked,
        };
        const key = wrap.querySelector('#mfa-sms-key').value;
        if (key) payload.smsApiKey = key;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        msg.innerHTML = '';
        try {
          await api.saveMfaDelivery(payload);
          msg.innerHTML = '<div class="alert alert-success">SMS delivery settings saved.</div>';
          await loadMfaPage();
        } catch (err) {
          msg.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to save')}</div>`;
          btn.disabled = false;
          btn.textContent = 'Save SMS delivery';
        }
      });

      wrap.querySelector('#mfa-sms-clear')?.addEventListener('click', async () => {
        if (!confirm('Clear SMS gateway settings stored in the Admin GUI?')) return;
        const msg = wrap.querySelector('#mfa-sms-msg');
        try {
          await api.saveMfaDelivery({ clearSms: true });
          msg.innerHTML = '<div class="alert alert-success">SMS settings cleared.</div>';
          await loadMfaPage();
        } catch (err) {
          msg.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to clear')}</div>`;
        }
      });

      // ── Save policy ────────────────────────────────────────────────────────
      wrap.querySelector('#save-policy-btn').addEventListener('click', async () => {
        const msg = wrap.querySelector('#policy-msg');
        msg.innerHTML = '';
        const excludedGroups = [...excludedIds];
        const allowed_methods = Array
          .from(wrap.querySelectorAll('.policy-method:checked'))
          .map((n) => n.value);
        const btn = wrap.querySelector('#save-policy-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
          await api.updateMfaPolicy({
            global_enforce:     parseInt(wrap.querySelector('#policy-global').value) === 1,
            enforce_for_admins: parseInt(wrap.querySelector('#policy-admins').value) === 1,
            grace_period_hours: parseInt(wrap.querySelector('#policy-grace').value) || 24,
            remember_device_hours: Math.max(0, parseInt(wrap.querySelector('#policy-remember').value, 10) || 0),
            critical_app_mfa: parseInt(wrap.querySelector('#policy-critical-app-mfa').value, 10) === 1,
            critical_app_mfa_max_age_seconds: Math.max(0, Math.min(86400, parseInt(wrap.querySelector('#policy-critical-app-age').value, 10) || 0)),
            excluded_group_ids: excludedGroups,
            allowed_methods,
          });
          const toggles = [...wrap.querySelectorAll('.policy-critical-app')];
          await Promise.all(toggles.map((cb) => api.setMfaCriticalApp(cb.dataset.id, {
            requireMfa: !!cb.checked,
          })));
          msg.innerHTML = `<div class="alert alert-success">Policy saved successfully.</div>`;
          await loadMfaPage();
        } catch (e) { msg.innerHTML = errHtml(e.message); }
        finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Policy'; } }
      });

      // ── Per-user search & actions ───────────────────────────────────────────
      let selectedUser = null;
      let searchTimer = null;

      wrap.querySelector('#mfa-user-search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        selectedUser = null;
        wrap.querySelector('#mfa-user-actions').style.display = 'none';
        wrap.querySelector('#mfa-action-msg').textContent = '';
        const q = wrap.querySelector('#mfa-user-search').value.trim();
        if (q.length < 2) { wrap.querySelector('#mfa-user-results').innerHTML = ''; return; }
        searchTimer = setTimeout(async () => {
          try {
            const r = await api.listUsersUnified(q, '', '', 10, 0);
            const items = (r?.data || []);
            if (!items.length) {
              wrap.querySelector('#mfa-user-results').innerHTML = `<p class="muted" style="font-size:0.85rem;margin:0.3rem 0">No users found.</p>`;
              return;
            }
            wrap.querySelector('#mfa-user-results').innerHTML = `
              <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;max-height:220px;overflow-y:auto;margin-bottom:0.5rem">
                ${items.map(u => `
                  <div class="search-dropdown-item" style="padding:0.55rem 0.85rem;cursor:pointer;display:flex;align-items:center;gap:0.6rem;border-bottom:1px solid var(--border)"
                    data-user="${escAttrJson({ emp_id: u.emp_id, full_name: u.full_name, email: u.email_corp, mfa_enforced: !!u.mfa_enforced })}">
                    <span class="avatar" style="width:28px;height:28px;font-size:0.7rem;flex-shrink:0">${esc((u.full_name||'?').charAt(0).toUpperCase())}</span>
                    <div>
                      <div style="font-weight:600;font-size:0.875rem">${esc(u.full_name || u.emp_id)}</div>
                      <div class="muted" style="font-size:0.75rem">${esc(u.email_corp || '')} · ${esc(u.emp_id)}</div>
                    </div>
                    ${u.mfa_enforced ? '<span class="badge badge-danger" style="margin-left:auto">Enforced</span>' : ''}
                  </div>`).join('')}
              </div>`;
            wrap.querySelectorAll('.search-dropdown-item').forEach(item => {
              item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface-2)'; });
              item.addEventListener('mouseleave', () => { item.style.background = ''; });
              item.addEventListener('click', async () => {
                selectedUser = JSON.parse(item.dataset.user);
                wrap.querySelector('#mfa-user-search').value = `${selectedUser.full_name} — ${selectedUser.email}`;
                wrap.querySelector('#mfa-user-results').innerHTML = '';
                wrap.querySelector('#mfa-action-msg').textContent = '';

                // Fetch live MFA status
                let mfaStatus = {};
                try { mfaStatus = await api.adminMfaStatus(selectedUser.emp_id); } catch {}
                wrap.querySelector('#mfa-user-info').innerHTML = `
                  <span class="avatar" style="width:36px;height:36px;font-size:0.85rem;flex-shrink:0">${esc((selectedUser.full_name||'?').charAt(0).toUpperCase())}</span>
                  <div>
                    <div style="font-weight:600">${esc(selectedUser.full_name)}</div>
                    <div class="muted" style="font-size:0.78rem">${esc(selectedUser.email)}</div>
                  </div>
                  <div style="margin-left:auto;display:flex;gap:0.4rem;flex-wrap:wrap">
                    ${mfaStatus?.enabled ? '<span class="badge badge-success">MFA Active</span>' : '<span class="badge badge-neutral">No MFA</span>'}
                    ${selectedUser.mfa_enforced ? '<span class="badge badge-danger">Enforced</span>' : '<span class="badge badge-neutral">Not Enforced</span>'}
                    ${mfaStatus?.policyExcludedByGroup ? '<span class="badge badge-warning">Group Excluded</span>' : ''}
                  </div>`;
                wrap.querySelector('#mfa-user-actions').style.display = 'block';
              });
            });
          } catch (e) {
            wrap.querySelector('#mfa-user-results').innerHTML = errHtml(e.message);
          }
        }, 300);
      });

      function setActionMsg(msg2, isError = false) {
        const el2 = wrap.querySelector('#mfa-action-msg');
        el2.innerHTML = isError
          ? `<span style="color:var(--danger)">${esc(msg2)}</span>`
          : `<span style="color:var(--success)">${esc(msg2)}</span>`;
      }

      wrap.querySelector('#mfa-enforce-btn').addEventListener('click', async () => {
        if (!selectedUser) return;
        if (!confirm(`Enforce MFA for ${selectedUser.full_name}? They will be required to enroll at next login.`)) return;
        try {
          await api.adminMfaEnforce(selectedUser.emp_id, true);
          selectedUser.mfa_enforced = true;
          setActionMsg(`✓ MFA enforcement enabled for ${selectedUser.full_name}`);
        } catch (e) { setActionMsg(e.message, true); }
      });

      wrap.querySelector('#mfa-unenforce-btn').addEventListener('click', async () => {
        if (!selectedUser) return;
        try {
          await api.adminMfaEnforce(selectedUser.emp_id, false);
          selectedUser.mfa_enforced = false;
          setActionMsg(`✓ MFA enforcement removed for ${selectedUser.full_name}`);
        } catch (e) { setActionMsg(e.message, true); }
      });

      wrap.querySelector('#mfa-reset-btn').addEventListener('click', async () => {
        if (!selectedUser) return;
        if (!confirm(`Reset MFA for ${selectedUser.full_name}? Current MFA will be removed and fresh enrollment will be required at next login.`)) return;
        try {
          await api.adminMfaReset(selectedUser.emp_id, true);
          selectedUser.mfa_enforced = true;
          setActionMsg(`✓ MFA reset for ${selectedUser.full_name}. Fresh enrollment is now required on next login.`);
        } catch (e) { setActionMsg(e.message, true); }
      });

      wrap.querySelector('#mfa-disable-btn').addEventListener('click', async () => {
        if (!selectedUser) return;
        if (!confirm(`Disable MFA for ${selectedUser.full_name}? This removes their MFA entirely. Are you sure?`)) return;
        try {
          await api.adminMfaDisable(selectedUser.emp_id);
          await api.adminMfaEnforce(selectedUser.emp_id, false);
          selectedUser.mfa_enforced = false;
          setActionMsg(`✓ MFA disabled for ${selectedUser.full_name}.`);
        } catch (e) { setActionMsg(e.message, true); }
      });

      // ── Tabs ──────────────────────────────────────────────────────────────
      function showMfaTab(name) {
        mfaActiveTab = name;
        wrap.querySelectorAll('#mfa-page-tabs .inline-tab').forEach((t) => {
          t.classList.toggle('active', t.dataset.tab === name);
        });
        wrap.querySelector('#mfa-tab-overview')?.classList.toggle('is-hidden', name !== 'overview');
        wrap.querySelector('#mfa-tab-policies')?.classList.toggle('is-hidden', name !== 'policies');
      }
      wrap.querySelectorAll('#mfa-page-tabs .inline-tab').forEach((btn) => {
        btn.addEventListener('click', () => showMfaTab(btn.dataset.tab));
      });

      // ── Group MFA policies ────────────────────────────────────────────────
      function openGroupPolicyModal(existing = null) {
        const usedIds = new Set(groupPolicies.map((p) => String(p.groupId)));
        if (existing) usedIds.delete(String(existing.groupId));
        const groupOpts = groups
          .filter((g) => !usedIds.has(String(g.id)) || (existing && String(g.id) === String(existing.groupId)))
          .map((g) => `<option value="${esc(String(g.id))}"${existing && String(g.id) === String(existing.groupId) ? ' selected' : ''}>${esc(g.name || g.id)} (${esc(g.source_system || 'LOCAL')})</option>`)
          .join('');
        const selectedMethods = new Set(
          Array.isArray(existing?.allowedMethods) ? existing.allowedMethods.map(String) : ['totp', 'backup_codes'],
        );
        const methodChecks = methodDefs.map((m) => `
          <label class="mfa-policy-method" style="display:flex;align-items:center;gap:0.55rem;padding:0.35rem 0;cursor:pointer">
            <input type="checkbox" class="mfa-gp-method" value="${esc(m.key)}" ${selectedMethods.has(m.key) ? 'checked' : ''}>
            <span style="font-size:0.875rem">${esc(m.label)}</span>
          </label>`).join('');

        const bd = openModal(`<div class="modal" style="width:560px;max-width:96vw">
          <div class="modal-header"><h2>${existing ? 'Edit' : 'Add'} group MFA policy</h2></div>
          <div class="modal-body">
            <div id="mfa-gp-err"></div>
            <div class="form-group">
              <label class="form-label">Group</label>
              <select class="form-select" id="mfa-gp-group" ${existing ? '' : ''}>
                <option value="">Select a group…</option>
                ${groupOpts || '<option value="" disabled>No groups available</option>'}
              </select>
              <p class="muted" style="font-size:0.78rem;margin:0.35rem 0 0">One policy per group. Methods must also be enabled under Global Policy.</p>
            </div>
            <div class="form-group">
              <label class="form-label">Allowed MFA methods</label>
              <div class="mfa-policy-methods">${methodChecks}</div>
            </div>
            <div class="form-group" style="display:flex;flex-direction:column;gap:0.45rem">
              <label class="mfa-policy-method" style="display:flex;align-items:center;gap:0.55rem;cursor:pointer">
                <input type="checkbox" id="mfa-gp-enforce" ${existing?.enforce ? 'checked' : ''}>
                <span style="font-size:0.875rem">Enforce MFA for this group</span>
              </label>
              <label class="mfa-policy-method" style="display:flex;align-items:center;gap:0.55rem;cursor:pointer">
                <input type="checkbox" id="mfa-gp-active" ${existing && existing.active === false ? '' : 'checked'}>
                <span style="font-size:0.875rem">Policy active</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">Notes (optional)</label>
              <input class="form-input" id="mfa-gp-notes" maxlength="500" value="${esc(existing?.notes || '')}" placeholder="e.g. Store staff — TOTP only">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="mfa-gp-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="mfa-gp-save">${existing ? 'Save changes' : 'Create policy'}</button>
          </div>
        </div>`);

        bd.querySelector('#mfa-gp-cancel').addEventListener('click', () => bd.remove());
        bd.querySelector('#mfa-gp-save').addEventListener('click', async () => {
          const errEl = bd.querySelector('#mfa-gp-err');
          errEl.innerHTML = '';
          const groupId = bd.querySelector('#mfa-gp-group').value;
          const allowedMethods = Array.from(bd.querySelectorAll('.mfa-gp-method:checked')).map((n) => n.value);
          if (!groupId) {
            errEl.innerHTML = errHtml('Select a group');
            return;
          }
          if (!allowedMethods.length) {
            errEl.innerHTML = errHtml('Select at least one MFA method');
            return;
          }
          const payload = {
            groupId,
            allowedMethods,
            enforce: !!bd.querySelector('#mfa-gp-enforce')?.checked,
            active: !!bd.querySelector('#mfa-gp-active')?.checked,
            notes: bd.querySelector('#mfa-gp-notes').value.trim() || null,
          };
          const btn = bd.querySelector('#mfa-gp-save');
          btn.disabled = true;
          try {
            if (existing) await api.updateMfaGroupPolicy(existing.id, payload);
            else await api.createMfaGroupPolicy(payload);
            bd.remove();
            mfaActiveTab = 'policies';
            await loadMfaPage();
          } catch (e) {
            errEl.innerHTML = errHtml(e.message || 'Save failed');
            btn.disabled = false;
          }
        });
      }

      wrap.querySelector('#mfa-gp-add')?.addEventListener('click', () => openGroupPolicyModal());
      wrap.querySelectorAll('.mfa-gp-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pol = groupPolicies.find((p) => String(p.id) === String(btn.dataset.id));
          if (pol) openGroupPolicyModal(pol);
        });
      });
      wrap.querySelectorAll('.mfa-gp-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this group MFA policy?')) return;
          try {
            await api.deleteMfaGroupPolicy(btn.dataset.id);
            mfaActiveTab = 'policies';
            await loadMfaPage();
          } catch (e) {
            const msg = wrap.querySelector('#mfa-gp-msg');
            if (msg) msg.innerHTML = errHtml(e.message);
          }
        });
      });

    } catch(e) {
      wrap.querySelector('#mfa-area').innerHTML = errHtml(e.message);
    }
  }

  await loadMfaPage();
}

// ─── 5. Adaptive Auth ─────────────────────────────────────────────────────────

const AA_CONDITION_TYPES = [
  { type: 'IP_RANGE', label: 'IP Range / CIDR', hint: 'Comma-separated prefixes, e.g. 10.0.0.0/8, 192.168.' },
  { type: 'NETWORK_TYPE', label: 'Network Type', options: ['CORPORATE', 'EXTERNAL', 'TOR', 'PROXY'] },
  { type: 'DEVICE_MANAGED', label: 'Device Managed' },
  { type: 'NEW_DEVICE', label: 'New Device (not seen before)' },
  { type: 'IMPOSSIBLE_TRAVEL', label: 'Impossible Travel' },
  { type: 'COUNTRY', label: 'Country (ISO code)' },
  { type: 'USER_ROLE', label: 'User Role', options: ['ADMIN', 'SUPER_ADMIN', 'IT_OPS', 'SECURITY', 'EMPLOYEE'] },
  { type: 'RISK_SCORE', label: 'Risk Score (0–100)' },
  { type: 'SENSITIVE_APP', label: 'Sensitive Application' },
  { type: 'TOR_PROXY', label: 'TOR / Proxy IP' },
];

const AA_ACTIONS = ['ALLOW', 'MFA', 'STEP_UP', 'DENY', 'BLOCK'];

function parseAaConditions(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeAaConditions(raw) {
  const labels = parseAaConditions(raw).map(c => {
    const meta = AA_CONDITION_TYPES.find(t => t.type === c.type);
    return meta?.label || c.type;
  });
  return labels.length ? labels.join(', ') : '—';
}

function aaTypeOptions(selected = 'NEW_DEVICE') {
  return AA_CONDITION_TYPES.map(t =>
    `<option value="${esc(t.type)}"${t.type === selected ? ' selected' : ''}>${esc(t.label)}</option>`,
  ).join('');
}

function aaMultiOptions(options, selected = []) {
  const sel = new Set((selected || []).map(v => String(v).toUpperCase()));
  return options.map(o => `<option value="${esc(o)}"${sel.has(o) ? ' selected' : ''}>${esc(o)}</option>`).join('');
}

function aaFieldsHtml(type, cond = {}) {
  switch (type) {
    case 'IP_RANGE':
      return `<input class="form-input aa-field" data-f="values" placeholder="10.0.0.0/8, 192.168." value="${esc((cond.values || []).join(', '))}" style="flex:2">`;
    case 'NETWORK_TYPE':
    case 'USER_ROLE':
      return `<select class="form-select aa-field" data-f="values" multiple style="flex:2;min-height:2.4rem">${aaMultiOptions(AA_CONDITION_TYPES.find(t => t.type === type).options, cond.values)}</select>`;
    case 'DEVICE_MANAGED':
      return `<select class="form-select aa-field" data-f="value" style="flex:1">
        <option value="true"${String(cond.value).toLowerCase() === 'true' ? ' selected' : ''}>Managed device</option>
        <option value="false"${String(cond.value).toLowerCase() !== 'true' ? ' selected' : ''}>Unmanaged device</option>
      </select>`;
    case 'COUNTRY':
      return `<select class="form-select aa-field" data-f="op" style="flex:0.8">
        <option value="in"${cond.op !== 'not_in' ? ' selected' : ''}>Is in</option>
        <option value="not_in"${cond.op === 'not_in' ? ' selected' : ''}>Is not in</option>
      </select>
      <input class="form-input aa-field" data-f="values" placeholder="US, IN, GB" value="${esc((cond.values || []).join(', '))}" style="flex:1.5">`;
    case 'RISK_SCORE':
      return `<select class="form-select aa-field" data-f="op" style="flex:0.8">
        <option value="gt"${cond.op === 'gt' ? ' selected' : ''}>&gt;</option>
        <option value="gte"${!cond.op || cond.op === 'gte' ? ' selected' : ''}>&gt;=</option>
        <option value="lt"${cond.op === 'lt' ? ' selected' : ''}>&lt;</option>
        <option value="lte"${cond.op === 'lte' ? ' selected' : ''}>&lt;=</option>
      </select>
      <input class="form-input aa-field" data-f="value" type="number" min="0" max="100" value="${esc(String(cond.value ?? 60))}" style="flex:0.8">`;
    default:
      return `<span class="muted" style="flex:2;font-size:0.82rem">No extra settings — matches when this signal is detected.</span>`;
  }
}

function mountAaConditionRow(container, cond = {}) {
  const type = cond.type || 'NEW_DEVICE';
  const row = el(`<div class="form-check-row aa-cond-row" style="gap:0.5rem;margin-bottom:0.5rem;align-items:flex-start">
    <select class="form-select aa-type" style="flex:1.2">${aaTypeOptions(type)}</select>
    <div class="aa-fields" style="display:flex;gap:0.5rem;flex:2;align-items:center">${aaFieldsHtml(type, cond)}</div>
    <button type="button" class="btn btn-sm btn-danger aa-remove" title="Remove condition">×</button>
  </div>`);
  const syncFields = () => {
    const nextType = row.querySelector('.aa-type').value;
    row.querySelector('.aa-fields').innerHTML = aaFieldsHtml(nextType, { type: nextType });
  };
  row.querySelector('.aa-type').addEventListener('change', syncFields);
  row.querySelector('.aa-remove').addEventListener('click', () => {
    const rows = container.querySelectorAll('.aa-cond-row');
    if (rows.length <= 1) return;
    row.remove();
  });
  container.appendChild(row);
  return row;
}

function collectAaConditions(container) {
  const conditions = [];
  for (const row of container.querySelectorAll('.aa-cond-row')) {
    const type = row.querySelector('.aa-type').value;
    const cond = { type };
    if (type === 'IP_RANGE' || type === 'COUNTRY') {
      const raw = row.querySelector('[data-f="values"]')?.value || '';
      const values = raw.split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) return { error: `${AA_CONDITION_TYPES.find(t => t.type === type)?.label || type} requires at least one value` };
      cond.values = type === 'COUNTRY' ? values.map(v => v.toUpperCase()) : values;
      if (type === 'COUNTRY') cond.op = row.querySelector('[data-f="op"]')?.value || 'in';
    } else if (type === 'NETWORK_TYPE' || type === 'USER_ROLE') {
      const values = [...row.querySelector('[data-f="values"]').selectedOptions].map(o => o.value);
      if (!values.length) return { error: `${AA_CONDITION_TYPES.find(t => t.type === type)?.label || type} requires at least one selection` };
      cond.values = values;
    } else if (type === 'DEVICE_MANAGED') {
      cond.value = row.querySelector('[data-f="value"]')?.value || 'false';
    } else if (type === 'RISK_SCORE') {
      cond.op = row.querySelector('[data-f="op"]')?.value || 'gte';
      const value = Number(row.querySelector('[data-f="value"]')?.value);
      if (Number.isNaN(value)) return { error: 'Risk score must be a number between 0 and 100' };
      cond.value = value;
    }
    conditions.push(cond);
  }
  if (!conditions.length) return { error: 'Add at least one condition' };
  return { conditions };
}

export async function viewAdaptiveAuth(content) {
  content.replaceChildren(el(`<div>${header('Adaptive Authentication', 'Risk-based authentication policies', `<button class="btn btn-primary" id="new-aa-btn">+ New Policy</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  const policyCache = new Map();

  async function load() {
    try {
      const policies = norm(await api.listAdaptivePolicies());
      policyCache.clear();
      policies.forEach(p => policyCache.set(String(p.id), p));
      const actionBadge = a => ({ ALLOW: 'badge-success', MFA: 'badge-warning', MFA_REQUIRED: 'badge-warning', STEP_UP: 'badge-warning', DENY: 'badge-danger', BLOCK: 'badge-danger' }[a] || 'badge-neutral');
      const rows = policies.length ? policies.map(p => `<tr>
          <td class="cell-strong">${esc(p.name)}</td>
          <td class="muted" style="font-size:0.8rem">${esc(summarizeAaConditions(p.conditions_json))}</td>
          <td><span class="badge ${actionBadge(p.action)}">${esc(p.action)}</span></td>
          <td>${p.priority ?? '—'}</td>
          <td>${p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-aa" data-id="${esc(String(p.id))}">Edit</button>
            <button class="btn btn-sm btn-danger del-aa" data-id="${esc(String(p.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No adaptive policies.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Conditions</th><th>Action</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-aa').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this policy?')) return;
          try { await api.deleteAdaptivePolicy(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-aa').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = policyCache.get(btn.dataset.id);
          if (!p) return;
          openAaModal(p.id, p);
        });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openAaModal(id, defaults = {}) {
    const isEdit = !!id;
    const action = defaults.action === 'MFA_REQUIRED' ? 'MFA' : (defaults.action || 'MFA');
    const actionOpts = AA_ACTIONS.map(a => `<option value="${a}"${a === action ? ' selected' : ''}>${a}</option>`).join('');
    const initialConditions = parseAaConditions(defaults.conditions_json);
    const bd = openModal(`<div class="modal modal-wide"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Adaptive Policy</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="aa-name" value="${esc(defaults.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="aa-desc" value="${esc(defaults.description||'')}"></div>
      <div class="form-group">
        <label class="form-label">Conditions</label>
        <p class="muted" style="font-size:0.78rem;margin:0 0 0.5rem">All conditions must match (AND). Lower priority numbers are evaluated first.</p>
        <div id="aa-conditions"></div>
        <button type="button" class="btn btn-sm btn-secondary" id="aa-add-cond" style="margin-top:0.35rem">+ Add Condition</button>
      </div>
      <div class="form-group"><label class="form-label">Action</label><select class="form-select" id="aa-action">${actionOpts}</select></div>
      <div class="form-group"><label class="form-label">Priority</label><input class="form-input" id="aa-pri" type="number" value="${esc(String(defaults.priority ?? 10))}"></div>
      <div id="aa-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="aa-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="aa-cancel">Cancel</button></div></div>`);
    const condContainer = bd.querySelector('#aa-conditions');
    if (initialConditions.length) {
      initialConditions.forEach(c => mountAaConditionRow(condContainer, c));
    } else {
      mountAaConditionRow(condContainer, { type: 'NEW_DEVICE' });
    }
    bd.querySelector('#aa-add-cond').addEventListener('click', () => mountAaConditionRow(condContainer));
    bd.querySelector('#aa-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#aa-save').addEventListener('click', async () => {
      const name = bd.querySelector('#aa-name').value.trim();
      if (!name) { bd.querySelector('#aa-err').innerHTML = errHtml('Name required'); return; }
      const collected = collectAaConditions(condContainer);
      if (collected.error) { bd.querySelector('#aa-err').innerHTML = errHtml(collected.error); return; }
      const data = {
        name,
        description: bd.querySelector('#aa-desc').value.trim() || null,
        conditions_json: collected.conditions,
        action: bd.querySelector('#aa-action').value,
        priority: parseInt(bd.querySelector('#aa-pri').value, 10) || 10,
      };
      try {
        if (isEdit) await api.updateAdaptivePolicy(id, data); else await api.createAdaptivePolicy(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#aa-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#new-aa-btn').addEventListener('click', () => openAaModal(null));
  await load();
}

// ─── 6. Password Policies ─────────────────────────────────────────────────────
export async function viewPasswordPolicies(content) {
  content.replaceChildren(el(`<div>${header('Password Policies', 'Configure password complexity and lockout rules', `<button class="btn btn-primary" id="new-pp-btn">+ New Policy</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const policies = norm(await api.listPasswordPolicies());
      const rows = policies.length ? policies.map(p => `
        <tr>
          <td class="cell-strong">${esc(p.name)}</td>
          <td>${p.min_length ?? 8}</td>
          <td>${[p.require_uppercase && 'U', p.require_lowercase && 'l', p.require_digits && '0', p.require_special && '#'].filter(Boolean).join(' ')}</td>
          <td>${p.max_age_days ?? '—'}</td>
          <td>${p.history_count ?? '—'}</td>
          <td>${p.lockout_attempts ?? '—'}</td>
          <td>${p.is_default ? '<span class="badge badge-success">Default</span>' : '<span class="badge badge-neutral">Policy</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-pp" data-p="${escAttrJson({id:p.id,name:p.name,min_length:p.min_length,require_uppercase:p.require_uppercase,require_lowercase:p.require_lowercase,require_digits:p.require_digits,require_special:p.require_special,max_age_days:p.max_age_days,history_count:p.history_count,lockout_attempts:p.lockout_attempts,lockout_duration_min:p.lockout_duration_min,is_default:p.is_default})}">Edit</button>
            <button class="btn btn-sm btn-danger del-pp" data-id="${esc(String(p.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">◎</div><p>No password policies.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Min Len</th><th>Requires</th><th>Max Age</th><th>History</th><th>Lockout</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-pp').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this policy?')) return;
          try { await api.deletePasswordPolicy(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-pp').forEach(btn => {
        btn.addEventListener('click', () => { let p; try { p = JSON.parse(btn.dataset.p); } catch { p = {}; } openPpModal(p.id, p); });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openPpModal(id, d = {}) {
    const isEdit = !!id;
    const chk = (v) => v ? 'checked' : '';
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Password Policy</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="pp-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Min Length</label><input class="form-input" id="pp-minlen" type="number" value="${d.min_length||10}"></div>
      <div class="form-group" style="display:flex;gap:1rem;flex-wrap:wrap">
        <label class="form-check"><input type="checkbox" id="pp-upper" ${chk(d.require_uppercase ?? 1)}> Uppercase</label>
        <label class="form-check"><input type="checkbox" id="pp-lower" ${chk(d.require_lowercase ?? 1)}> Lowercase</label>
        <label class="form-check"><input type="checkbox" id="pp-digit" ${chk(d.require_digits ?? 1)}> Digit</label>
        <label class="form-check"><input type="checkbox" id="pp-special" ${chk(d.require_special)}> Special char</label>
        <label class="form-check"><input type="checkbox" id="pp-default" ${chk(d.is_default)}> Default policy</label>
      </div>
      <div class="form-group"><label class="form-label">Max Age (days)</label><input class="form-input" id="pp-maxage" type="number" value="${d.max_age_days||90}"></div>
      <div class="form-group"><label class="form-label">History Count</label><input class="form-input" id="pp-hist" type="number" value="${d.history_count||5}"></div>
      <div class="form-group"><label class="form-label">Lockout Attempts</label><input class="form-input" id="pp-lock" type="number" value="${d.lockout_attempts||10}"></div>
      <div class="form-group"><label class="form-label">Lockout Duration (min)</label><input class="form-input" id="pp-lockdur" type="number" value="${d.lockout_duration_min||30}"></div>
      <div id="pp-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="pp-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="pp-cancel">Cancel</button></div></div>`);
    bd.querySelector('#pp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#pp-save').addEventListener('click', async () => {
      const data = {
        name: bd.querySelector('#pp-name').value,
        min_length: parseInt(bd.querySelector('#pp-minlen').value)||10,
        require_uppercase: bd.querySelector('#pp-upper').checked ? 1 : 0,
        require_lowercase: bd.querySelector('#pp-lower').checked ? 1 : 0,
        require_digits: bd.querySelector('#pp-digit').checked ? 1 : 0,
        require_special: bd.querySelector('#pp-special').checked ? 1 : 0,
        max_age_days: parseInt(bd.querySelector('#pp-maxage').value)||90,
        history_count: parseInt(bd.querySelector('#pp-hist').value)||5,
        lockout_attempts: parseInt(bd.querySelector('#pp-lock').value)||10,
        lockout_duration_min: parseInt(bd.querySelector('#pp-lockdur').value)||30,
        is_default: bd.querySelector('#pp-default').checked ? 1 : 0,
      };
      if (!data.name) { bd.querySelector('#pp-err').innerHTML = errHtml('Name required'); return; }
      try {
        if (isEdit) await api.updatePasswordPolicy(id, data); else await api.createPasswordPolicy(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#pp-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#new-pp-btn').addEventListener('click', () => openPpModal(null));
  await load();
}

// ─── 7. Login Customization (alias of Branding — single source of truth) ───────
export async function viewLoginCustomization(content) {
  // Merged into Branding to avoid duplicate save surfaces with mismatched fields.
  return viewBranding(content);
}

// ─── 8. OIDC Apps ─────────────────────────────────────────────────────────────
// ─── Pre-built SSO Integration Catalog (350+) ────────────────────────────────
function _app(id, name, _domain, cat, proto, hint, scopes, grants) {
  // icon intentionally null — no external CDN in airgapped deployments.
  // The catalogIcon() renderer generates a coloured letter-avatar instead.
  return {
    id, name, icon: null,
    cat, protocol: proto,
    hint: hint || `${name} supports ${proto} for enterprise SSO.`,
    scopes: scopes || ['openid','email','profile'],
    grants: grants || ['authorization_code'],
  };
}
const _S = 'SAML', _O = 'OIDC';
const SSO_CATALOG = [
  // ── Collaboration ──────────────────────────────────────────────────────────
  _app('slack',          'Slack',                  'slack.com',           'Collaboration',   _O, 'Use Slack OIDC integration for workspace SSO via OAuth 2.0.'),
  _app('teams',          'Microsoft Teams',        'microsoft.com',       'Collaboration',   _S, 'Configure via Microsoft Entra ID app gallery. ACS URL provided after SP setup.'),
  _app('zoom',           'Zoom',                   'zoom.us',             'Collaboration',   _S, 'Zoom supports SAML 2.0 SSO. Configure in Zoom Admin → Advanced → Single Sign-On.'),
  _app('webex',          'Cisco Webex',            'webex.com',           'Collaboration',   _S, 'Webex supports SAML 2.0. Configure in Control Hub → Settings → SSO.'),
  _app('google-chat',    'Google Chat',            'google.com',          'Collaboration',   _S, 'Google Chat SSO is managed through Google Workspace SAML federation.'),
  _app('discord',        'Discord',                'discord.com',         'Collaboration',   _O, 'Discord supports OAuth 2.0 / OIDC for server authentication flows.'),
  _app('mattermost',     'Mattermost',             'mattermost.com',      'Collaboration',   _S, 'Mattermost supports SAML 2.0 in System Console → Authentication → SAML 2.0.'),
  _app('lark',           'Lark / Feishu',          'larksuite.com',       'Collaboration',   _S, 'Lark Enterprise supports SAML 2.0 SSO via Admin → Security → SSO.'),
  _app('ringcentral',    'RingCentral',            'ringcentral.com',     'Collaboration',   _S, 'RingCentral supports SAML 2.0 SSO in Admin Portal → Security → SSO.'),
  _app('gotomeeting',    'GoTo Meeting',           'goto.com',            'Collaboration',   _S, 'GoTo Meeting supports SAML 2.0 for enterprise authentication.'),
  _app('chanty',         'Chanty',                 'chanty.com',          'Collaboration',   _O, 'Chanty supports OAuth 2.0 / OIDC for team chat SSO.'),
  _app('flock',          'Flock',                  'flock.com',           'Collaboration',   _S, 'Flock for Business supports SAML 2.0 SSO via Admin Settings.'),
  _app('twist',          'Twist',                  'twist.com',           'Collaboration',   _S, 'Twist supports SAML 2.0 for async team communication.'),
  _app('pumble',         'Pumble',                 'pumble.com',          'Collaboration',   _S, 'Pumble supports SAML 2.0 for enterprise teams.'),
  _app('elements',       'Rocket.Chat',            'rocket.chat',         'Collaboration',   _S, 'Rocket.Chat supports SAML 2.0 in Administration → SAML.'),
  _app('bluejeans',      'BlueJeans',              'bluejeans.com',       'Collaboration',   _S, 'BlueJeans supports SAML 2.0 SSO for video meetings.'),
  // ── Project Management ─────────────────────────────────────────────────────
  _app('jira',           'Jira / Confluence',      'atlassian.com',       'Project Mgmt',    _S, 'Atlassian Access enables SAML 2.0 SSO for all Atlassian Cloud products.'),
  _app('asana',          'Asana',                  'asana.com',           'Project Mgmt',    _S, 'Asana Business/Enterprise supports SAML 2.0 via Admin Console → Security → SAML.'),
  _app('monday',         'Monday.com',             'monday.com',          'Project Mgmt',    _S, 'Monday.com Enterprise supports SAML 2.0 in Admin → Security → SAML.'),
  _app('linear',         'Linear',                 'linear.app',          'Project Mgmt',    _O, 'Linear supports OIDC-based SSO for workspace authentication.'),
  _app('trello',         'Trello',                 'trello.com',          'Project Mgmt',    _S, 'Trello (via Atlassian Access) supports SAML 2.0 SSO.'),
  _app('clickup',        'ClickUp',                'clickup.com',         'Project Mgmt',    _S, 'ClickUp Enterprise supports SAML 2.0 in Settings → Security → SSO.'),
  _app('wrike',          'Wrike',                  'wrike.com',           'Project Mgmt',    _S, 'Wrike supports SAML 2.0 for enterprise plans via Admin → Security.'),
  _app('smartsheet',     'Smartsheet',             'smartsheet.com',      'Project Mgmt',    _S, 'Smartsheet supports SAML 2.0 SSO in Account Admin → Security.'),
  _app('notion',         'Notion',                 'notion.so',           'Project Mgmt',    _S, 'Notion Enterprise supports SAML 2.0 in Settings → Identity & Provisioning.'),
  _app('basecamp',       'Basecamp',               'basecamp.com',        'Project Mgmt',    _O, 'Basecamp supports OAuth 2.0 for third-party app integrations.'),
  _app('airtable',       'Airtable',               'airtable.com',        'Project Mgmt',    _S, 'Airtable Enterprise supports SAML 2.0 SSO via Admin panel.'),
  _app('height',         'Height',                 'height.app',          'Project Mgmt',    _O, 'Height supports OIDC-based SSO for team project management.'),
  _app('shortcut',       'Shortcut',               'shortcut.com',        'Project Mgmt',    _S, 'Shortcut (formerly Clubhouse) supports SAML 2.0 for engineering teams.'),
  _app('productboard',   'Productboard',           'productboard.com',    'Project Mgmt',    _S, 'Productboard supports SAML 2.0 SSO for product management teams.'),
  _app('teamwork',       'Teamwork',               'teamwork.com',        'Project Mgmt',    _S, 'Teamwork supports SAML 2.0 SSO in Site Settings → Security.'),
  _app('nifty',          'Nifty',                  'niftypm.com',         'Project Mgmt',    _S, 'Nifty supports SAML 2.0 SSO for enterprise project teams.'),
  _app('plane',          'Plane',                  'plane.so',            'Project Mgmt',    _O, 'Plane (open-source) supports OIDC for self-hosted authentication.'),
  // ── Development Tools ──────────────────────────────────────────────────────
  _app('github',         'GitHub Enterprise',      'github.com',          'Development',     _S, 'GitHub Enterprise Cloud SAML SSO at organisation level. ACS: https://github.com/orgs/{org}/saml/consume.'),
  _app('gitlab',         'GitLab',                 'gitlab.com',          'Development',     _S, 'GitLab supports SAML 2.0 for self-managed (Admin → SAML) and GitLab.com groups.'),
  _app('bitbucket',      'Bitbucket',              'atlassian.com',       'Development',     _S, 'Bitbucket Cloud (via Atlassian Access) supports SAML 2.0 SSO.'),
  _app('jenkins',        'Jenkins',                'jenkins.io',          'Development',     _O, 'Use the OpenID Connect Authentication Plugin for Jenkins SSO.'),
  _app('circleci',       'CircleCI',               'circleci.com',        'Development',     _S, 'CircleCI supports SAML 2.0 SSO for organisation authentication.'),
  _app('sonarqube',      'SonarQube',              'sonarsource.com',     'Development',     _O, 'SonarQube supports SAML 2.0 and OIDC via Administration → Security → Authentication.'),
  _app('argocd',         'Argo CD',                'argoproj.github.io',  'Development',     _O, 'Argo CD supports OIDC via dex connector or direct OIDC config in argocd-cm ConfigMap.', ['openid','email','groups']),
  _app('snyk',           'Snyk',                   'snyk.io',             'Development',     _S, 'Snyk Business/Enterprise supports SAML 2.0 SSO via Organisation Settings → SSO.'),
  _app('jfrog',          'JFrog Artifactory',      'jfrog.com',           'Development',     _S, 'JFrog Artifactory supports SAML 2.0 via Admin → Authentication → SAML.'),
  _app('harbor',         'Harbor Registry',        'goharbor.io',         'Development',     _O, 'Harbor supports OIDC authentication via Administration → Configuration → Authentication.'),
  _app('buildkite',      'Buildkite',              'buildkite.com',       'Development',     _S, 'Buildkite supports SAML 2.0 SSO for organisation authentication.'),
  _app('harness',        'Harness',                'harness.io',          'Development',     _S, 'Harness supports SAML 2.0 SSO via Account Settings → Access Control → Authentication.'),
  _app('octopus',        'Octopus Deploy',         'octopus.com',         'Development',     _O, 'Octopus Deploy Cloud supports OpenID Connect for team authentication.'),
  _app('drone',          'Drone CI',               'drone.io',            'Development',     _O, 'Drone CI supports OAuth 2.0 / OIDC for source control-based auth.'),
  _app('sonarcloud',     'SonarCloud',             'sonarcloud.io',       'Development',     _S, 'SonarCloud supports SAML 2.0 SSO for organization authentication.'),
  _app('nexus',          'Nexus Repository',       'sonatype.com',        'Development',     _S, 'Sonatype Nexus Repository Pro supports SAML 2.0 for enterprise SSO.'),
  _app('gitea',          'Gitea',                  'gitea.io',            'Development',     _O, 'Gitea supports OAuth 2.0 / OIDC for self-hosted Git SSO.'),
  _app('confluence',     'Confluence',             'atlassian.com',       'Development',     _S, 'Confluence Cloud supports SAML 2.0 SSO via Atlassian Access.'),
  _app('semaphore',      'Semaphore CI',           'semaphoreci.com',     'Development',     _O, 'Semaphore supports OIDC-based SSO for CI/CD pipeline access.'),
  // ── Monitoring & Observability ─────────────────────────────────────────────
  _app('datadog',        'Datadog',                'datadog.com',         'Monitoring',      _S, 'Datadog supports SAML 2.0 in Organisation Settings → SAML.'),
  _app('newrelic',       'New Relic',              'newrelic.com',        'Monitoring',      _S, 'New Relic supports SAML 2.0 SSO via Admin → Authentication → SAML.'),
  _app('dynatrace',      'Dynatrace',              'dynatrace.com',       'Monitoring',      _S, 'Dynatrace supports SAML 2.0 SSO via Settings → People & Groups → SSO.'),
  _app('splunk',         'Splunk',                 'splunk.com',          'Monitoring',      _S, 'Splunk supports SAML 2.0 via Settings → Authentication → SAML.'),
  _app('pagerduty',      'PagerDuty',              'pagerduty.com',       'Monitoring',      _S, 'PagerDuty supports SAML 2.0 SSO in Account Settings → Single Sign-On.'),
  _app('opsgenie',       'Opsgenie',               'atlassian.com',       'Monitoring',      _S, 'Opsgenie supports SAML 2.0 SSO via Admin → Settings → SSO.'),
  _app('grafana',        'Grafana Cloud',          'grafana.com',         'Monitoring',      _O, 'Grafana supports OAuth 2.0 / OIDC via grafana.ini [auth.generic_oauth].'),
  _app('appdynamics',    'AppDynamics',            'appdynamics.com',     'Monitoring',      _S, 'AppDynamics (Cisco) supports SAML 2.0 SSO for enterprise accounts.'),
  _app('sentry',         'Sentry',                 'sentry.io',           'Monitoring',      _S, 'Sentry supports SAML 2.0 SSO via Organisation Settings → Auth.'),
  _app('rollbar',        'Rollbar',                'rollbar.com',         'Monitoring',      _S, 'Rollbar supports SAML 2.0 SSO for team authentication.'),
  _app('lightstep',      'Lightstep',              'lightstep.com',       'Monitoring',      _O, 'Lightstep supports OIDC-based SSO for observability platform access.'),
  _app('honeycomb',      'Honeycomb',              'honeycomb.io',        'Monitoring',      _S, 'Honeycomb supports SAML 2.0 SSO via Team Settings → Authentication.'),
  _app('elastic',        'Elastic / Kibana',       'elastic.co',          'Monitoring',      _S, 'Elastic Stack supports SAML 2.0 via security.yml and Kibana SSO.'),
  _app('statuspage',     'Atlassian Statuspage',   'atlassian.com',       'Monitoring',      _S, 'Statuspage supports SAML 2.0 SSO for team authentication.'),
  _app('victorops',      'VictorOps / Splunk On-Call','victorops.com',    'Monitoring',      _S, 'VictorOps supports SAML 2.0 SSO for on-call management.'),
  // ── Cloud & Infrastructure ─────────────────────────────────────────────────
  _app('aws',            'AWS IAM Identity Center','amazon.com',          'Cloud',           _S, 'AWS IAM Identity Center accepts SAML 2.0 from external IdPs. ACS URL: https://signin.aws.amazon.com/saml.'),
  _app('gcp',            'Google Cloud Platform',  'cloud.google.com',    'Cloud',           _S, 'Google Cloud supports SAML 2.0 federated identity via Cloud Identity.'),
  _app('azure',          'Azure / Entra ID',       'microsoft.com',       'Cloud',           _S, 'Azure AD supports SAML 2.0 and OIDC federation from external IdPs.'),
  _app('digitalocean',   'DigitalOcean',           'digitalocean.com',    'Cloud',           _O, 'DigitalOcean supports OAuth 2.0 / OIDC for team member authentication.'),
  _app('heroku',         'Heroku',                 'heroku.com',          'Cloud',           _S, 'Heroku Enterprise supports SAML 2.0 SSO via Dashboard → Access.'),
  _app('cloudflare',     'Cloudflare Access',      'cloudflare.com',      'Cloud',           _S, 'Cloudflare Access supports SAML 2.0 as an identity provider for Zero Trust.'),
  _app('vercel',         'Vercel',                 'vercel.com',          'Cloud',           _S, 'Vercel Enterprise supports SAML 2.0 SSO via Team Settings → Security.'),
  _app('netlify',        'Netlify',                'netlify.com',         'Cloud',           _O, 'Netlify supports OAuth 2.0 for team and identity-based access.'),
  _app('ibmcloud',       'IBM Cloud',              'ibm.com',             'Cloud',           _S, 'IBM Cloud supports SAML 2.0 federated enterprise SSO via IBMid.'),
  _app('oracle-cloud',   'Oracle Cloud',           'oracle.com',          'Cloud',           _S, 'Oracle Cloud Infrastructure (OCI) supports SAML 2.0 for federated identity.'),
  _app('terraform',      'Terraform Cloud',        'hashicorp.com',       'Cloud',           _S, 'HashiCorp Terraform Cloud supports SAML 2.0 SSO for organisation access.'),
  _app('rancher',        'Rancher',                'rancher.com',         'Cloud',           _S, 'Rancher supports SAML 2.0 (Shibboleth, Ping, ADFS) for cluster authentication.'),
  _app('openshift',      'Red Hat OpenShift',      'redhat.com',          'Cloud',           _O, 'OpenShift supports OIDC via OAuth Identity Providers in cluster configuration.'),
  _app('linode',         'Akamai / Linode',        'linode.com',          'Cloud',           _O, 'Linode supports OAuth 2.0 for programmatic and SSO-based access.'),
  // ── HR & People ────────────────────────────────────────────────────────────
  _app('workday',        'Workday',                'workday.com',         'HR',              _S, 'Workday acts as SP; configure SAML 2.0 in Edit Tenant Setup → Security.'),
  _app('bamboohr',       'BambooHR',               'bamboohr.com',        'HR',              _S, 'BambooHR supports SAML 2.0 SSO under Settings → Single Sign-On.'),
  _app('gusto',          'Gusto',                  'gusto.com',           'HR',              _O, 'Gusto supports OAuth 2.0 / OIDC for payroll partner integrations.'),
  _app('rippling',       'Rippling',               'rippling.com',        'HR',              _S, 'Rippling supports SAML 2.0 SSO via IT Management → Single Sign-On.'),
  _app('hibob',          'HiBob',                  'hibob.com',           'HR',              _S, 'HiBob supports SAML 2.0 SSO via Admin Settings → Integrations → SSO.'),
  _app('personio',       'Personio',               'personio.com',        'HR',              _S, 'Personio supports SAML 2.0 SSO under Admin → Settings → Single Sign-On.'),
  _app('lattice',        'Lattice',                'lattice.com',         'HR',              _S, 'Lattice supports SAML 2.0 SSO via Admin → Security → SAML.'),
  _app('cultureamp',     'Culture Amp',            'cultureamp.com',      'HR',              _S, 'Culture Amp supports SAML 2.0 SSO for enterprise authentication.'),
  _app('adp',            'ADP Workforce Now',      'adp.com',             'HR',              _S, 'ADP supports SAML 2.0 federated SSO for payroll and HR access.'),
  _app('ukg',            'UKG Pro / Ready',        'ukg.com',             'HR',              _S, 'UKG supports SAML 2.0 SSO via Admin → Security → SSO Configuration.'),
  _app('successfactors', 'SAP SuccessFactors',     'sap.com',             'HR',              _S, 'SAP SuccessFactors supports SAML 2.0 via Provisioning → SAML Setup.'),
  _app('greenhouse',     'Greenhouse',             'greenhouse.io',       'HR',              _S, 'Greenhouse ATS supports SAML 2.0 SSO via Dev Center → SSO.'),
  _app('lever',          'Lever',                  'lever.co',            'HR',              _S, 'Lever supports SAML 2.0 SSO for recruiting platform access.'),
  _app('workable',       'Workable',               'workable.com',        'HR',              _S, 'Workable supports SAML 2.0 SSO for hiring team authentication.'),
  _app('icims',          'iCIMS',                  'icims.com',           'HR',              _S, 'iCIMS supports SAML 2.0 SSO via Platform Configuration → Security.'),
  _app('smartrecruiters','SmartRecruiters',        'smartrecruiters.com', 'HR',              _S, 'SmartRecruiters Enterprise supports SAML 2.0 SSO.'),
  _app('dayforce',       'Ceridian Dayforce',      'dayforce.com',        'HR',              _S, 'Ceridian Dayforce supports SAML 2.0 SSO via Application Configuration.'),
  _app('paylocity',      'Paylocity',              'paylocity.com',       'HR',              _S, 'Paylocity supports SAML 2.0 SSO for HR and payroll access.'),
  _app('namely',         'Namely',                 'namely.com',          'HR',              _S, 'Namely supports SAML 2.0 SSO via Admin → Integrations → SSO.'),
  _app('15five',         '15Five',                 '15five.com',          'HR',              _S, '15Five supports SAML 2.0 SSO for performance management.'),
  _app('officevibe',     'Officevibe',             'officevibe.com',      'HR',              _S, 'Officevibe supports SAML 2.0 SSO for employee engagement.'),
  // ── CRM & Sales ────────────────────────────────────────────────────────────
  _app('salesforce',     'Salesforce',             'salesforce.com',      'CRM',             _S, 'Salesforce supports SAML 2.0. Configure in Setup → Single Sign-On Settings.'),
  _app('hubspot',        'HubSpot',                'hubspot.com',         'CRM',             _S, 'HubSpot Enterprise supports SAML 2.0 SSO via Security → Single Sign-On.'),
  _app('zohocrm',        'Zoho CRM',               'zoho.com',            'CRM',             _S, 'Zoho CRM supports SAML 2.0 SSO via Zoho Directory or direct SAML setup.'),
  _app('pipedrive',      'Pipedrive',              'pipedrive.com',       'CRM',             _S, 'Pipedrive supports SAML 2.0 SSO for enterprise sales teams.'),
  _app('freshsales',     'Freshsales',             'freshworks.com',      'CRM',             _S, 'Freshsales supports SAML 2.0 SSO via Admin Settings → Security → SSO.'),
  _app('msdynamics',     'Microsoft Dynamics 365', 'microsoft.com',       'CRM',             _S, 'Dynamics 365 federated authentication via Azure AD SAML 2.0.'),
  _app('sugarcrm',       'SugarCRM',               'sugarcrm.com',        'CRM',             _S, 'SugarCRM supports SAML 2.0 SSO via Admin → Password Management → SAML.'),
  _app('copper',         'Copper CRM',             'copper.com',          'CRM',             _O, 'Copper CRM supports OAuth 2.0 / OIDC for Google Workspace-based SSO.'),
  _app('outreach',       'Outreach',               'outreach.io',         'CRM',             _S, 'Outreach supports SAML 2.0 SSO via Admin Settings → Security → SSO.'),
  _app('salesloft',      'Salesloft',              'salesloft.com',       'CRM',             _S, 'Salesloft supports SAML 2.0 SSO for sales engagement authentication.'),
  _app('gong',           'Gong',                   'gong.io',             'CRM',             _S, 'Gong supports SAML 2.0 SSO via Company Settings → Single Sign-On.'),
  _app('apollo',         'Apollo.io',              'apollo.io',           'CRM',             _O, 'Apollo.io supports OAuth 2.0 / OIDC for sales intelligence access.'),
  _app('insightly',      'Insightly',              'insightly.com',       'CRM',             _S, 'Insightly supports SAML 2.0 SSO for enterprise CRM access.'),
  // ── ITSM & Support ─────────────────────────────────────────────────────────
  _app('servicenow',     'ServiceNow',             'servicenow.com',      'ITSM',            _S, 'ServiceNow supports SAML 2.0 via System Security → High Security Plugin → SSO.'),
  _app('zendesk',        'Zendesk',                'zendesk.com',         'ITSM',            _S, 'Zendesk supports SAML 2.0 in Admin → Security → Single Sign-On.'),
  _app('freshdesk',      'Freshdesk',              'freshworks.com',      'ITSM',            _S, 'Freshdesk supports SAML 2.0 SSO via Admin → Security → Single Sign-On.'),
  _app('jiraservice',    'Jira Service Management','atlassian.com',       'ITSM',            _S, 'Jira Service Management (via Atlassian Access) supports SAML 2.0 SSO.'),
  _app('ivanti',         'Ivanti',                 'ivanti.com',          'ITSM',            _S, 'Ivanti Service Manager supports SAML 2.0 for enterprise SSO.'),
  _app('cherwell',       'Cherwell',               'cherwell.com',        'ITSM',            _S, 'Cherwell Service Management supports SAML 2.0 SSO integration.'),
  _app('bmc',            'BMC Helix',              'bmc.com',             'ITSM',            _S, 'BMC Helix ITSM supports SAML 2.0 for enterprise service management.'),
  _app('topdesk',        'TOPdesk',                'topdesk.com',         'ITSM',            _S, 'TOPdesk supports SAML 2.0 SSO via functional settings.'),
  _app('manageengine',   'ManageEngine ServiceDesk','manageengine.com',   'ITSM',            _S, 'ManageEngine ServiceDesk Plus supports SAML 2.0 SSO.'),
  _app('helpscout',      'Help Scout',             'helpscout.com',       'ITSM',            _S, 'Help Scout supports SAML 2.0 SSO for enterprise customer support teams.'),
  _app('intercom',       'Intercom',               'intercom.com',        'ITSM',            _S, 'Intercom supports SAML 2.0 SSO via Settings → Security → SSO.'),
  _app('drift',          'Drift / Salesloft',      'drift.com',           'ITSM',            _S, 'Drift supports SAML 2.0 SSO for enterprise customer engagement.'),
  _app('freshservice',   'Freshservice',           'freshworks.com',      'ITSM',            _S, 'Freshservice IT service management supports SAML 2.0 SSO.'),
  _app('spiceworks',     'Spiceworks Cloud Help Desk','spiceworks.com',   'ITSM',            _O, 'Spiceworks supports OAuth 2.0 for cloud help desk authentication.'),
  // ── Finance & Accounting ───────────────────────────────────────────────────
  _app('quickbooks',     'QuickBooks Online',      'intuit.com',          'Finance',         _O, 'QuickBooks Online supports OAuth 2.0 / OIDC for accounting integrations.'),
  _app('xero',           'Xero',                   'xero.com',            'Finance',         _O, 'Xero supports OAuth 2.0 / OIDC for accounting app partner authentication.'),
  _app('netsuite',       'Oracle NetSuite',        'netsuite.com',        'Finance',         _S, 'NetSuite supports SAML 2.0 SSO via Setup → Integrations → SAML SSO.'),
  _app('sap',            'SAP ERP / S/4HANA',      'sap.com',             'Finance',         _S, 'SAP supports SAML 2.0 via Trust Configuration in SAP Cloud Identity Services.'),
  _app('sage',           'Sage Intacct',           'sage.com',            'Finance',         _S, 'Sage Intacct supports SAML 2.0 SSO via Company → Security → SSO.'),
  _app('freshbooks',     'FreshBooks',             'freshbooks.com',      'Finance',         _O, 'FreshBooks supports OAuth 2.0 / OIDC for partner integrations.'),
  _app('expensify',      'Expensify',              'expensify.com',       'Finance',         _S, 'Expensify supports SAML 2.0 SSO via Domain Control settings.'),
  _app('concur',         'SAP Concur',             'concur.com',          'Finance',         _S, 'SAP Concur supports SAML 2.0 SSO via Administration → Authentication Admin.'),
  _app('coupa',          'Coupa',                  'coupa.com',           'Finance',         _S, 'Coupa supports SAML 2.0 SSO via Setup → Security Controls → SSO.'),
  _app('tipalti',        'Tipalti',                'tipalti.com',         'Finance',         _S, 'Tipalti supports SAML 2.0 SSO for enterprise AP automation.'),
  _app('bill',           'Bill.com',               'bill.com',            'Finance',         _S, 'Bill.com supports SAML 2.0 SSO for AP/AR automation.'),
  _app('brex',           'Brex',                   'brex.com',            'Finance',         _O, 'Brex supports OAuth 2.0 / OIDC for corporate card authentication.'),
  _app('ramp',           'Ramp',                   'ramp.com',            'Finance',         _S, 'Ramp supports SAML 2.0 SSO via Settings → Security → Single Sign-On.'),
  _app('recurly',        'Recurly',                'recurly.com',         'Finance',         _S, 'Recurly supports SAML 2.0 SSO for subscription billing platform access.'),
  _app('chargebee',      'Chargebee',              'chargebee.com',       'Finance',         _O, 'Chargebee supports OAuth 2.0 / OIDC for subscription management.'),
  _app('zuora',          'Zuora',                  'zuora.com',           'Finance',         _S, 'Zuora supports SAML 2.0 SSO via Manage → Manage Users → SAML.'),
  // ── Security & IAM ─────────────────────────────────────────────────────────
  _app('okta',           'Okta (SP-initiated)',     'okta.com',            'IAM',             _S, 'Use when Lenskart IdP federates INTO an Okta org. Okta acts as SP.'),
  _app('cyberark',       'CyberArk PAM',           'cyberark.com',        'IAM',             _S, 'CyberArk Privileged Access Manager supports SAML 2.0 SSO for web access.'),
  _app('ping',           'Ping Identity',          'pingidentity.com',    'IAM',             _S, 'PingFederate supports SAML 2.0 federation as SP from external IdPs.'),
  _app('forgerock',      'ForgeRock / PingAM',     'forgerock.com',       'IAM',             _S, 'ForgeRock Access Management supports SAML 2.0 SP federation.'),
  _app('sailpoint',      'SailPoint IIQ',          'sailpoint.com',       'IAM',             _S, 'SailPoint IdentityIQ supports SAML 2.0 for IdP-initiated and SP-initiated SSO.'),
  _app('saviynt',        'Saviynt',                'saviynt.com',         'IAM',             _S, 'Saviynt supports SAML 2.0 SSO for IGA platform access.'),
  _app('beyondtrust',    'BeyondTrust',            'beyondtrust.com',     'IAM',             _S, 'BeyondTrust Privileged Remote Access supports SAML 2.0 SSO.'),
  _app('onepassword',    '1Password Business',     '1password.com',       'IAM',             _S, '1Password Business supports SAML 2.0 SSO via Settings → Single Sign-On.'),
  _app('lastpass',       'LastPass',               'lastpass.com',        'IAM',             _S, 'LastPass supports SAML 2.0 SSO via Admin Console → Enterprise SSO.'),
  _app('delinea',        'Delinea / Thycotic',     'delinea.com',         'IAM',             _S, 'Delinea Secret Server supports SAML 2.0 SSO for PAM access.'),
  _app('oneidentity',    'One Identity',           'oneidentity.com',     'IAM',             _S, 'One Identity Safeguard supports SAML 2.0 SSO for privileged access.'),
  _app('jumpcloud',      'JumpCloud',              'jumpcloud.com',       'IAM',             _S, 'JumpCloud supports SAML 2.0 SSO for cloud directory services.'),
  _app('auth0',          'Auth0',                  'auth0.com',           'IAM',             _S, 'Auth0 supports SAML 2.0 as SP; use Lenskart IdP as an enterprise connection.'),
  _app('keeper',         'Keeper Security',        'keepersecurity.com',  'IAM',             _S, 'Keeper Business supports SAML 2.0 SSO via Admin Console → SSO Cloud.'),
  _app('bitwarden',      'Bitwarden',              'bitwarden.com',       'IAM',             _S, 'Bitwarden supports SAML 2.0 SSO for enterprise password management.'),
  // ── Analytics & BI ─────────────────────────────────────────────────────────
  _app('tableau',        'Tableau',                'tableau.com',         'Analytics',       _S, 'Tableau Online and Server support SAML 2.0 SSO via Site Settings → Authentication.'),
  _app('looker',         'Looker',                 'looker.com',          'Analytics',       _S, 'Looker supports SAML 2.0 for enterprise SSO via Admin → Authentication → SAML.'),
  _app('powerbi',        'Power BI',               'microsoft.com',       'Analytics',       _S, 'Power BI (via Azure AD) supports SAML 2.0 federated SSO.'),
  _app('metabase',       'Metabase',               'metabase.com',        'Analytics',       _S, 'Metabase Enterprise supports SAML 2.0 SSO via Admin → Authentication.'),
  _app('sisense',        'Sisense',                'sisense.com',         'Analytics',       _S, 'Sisense supports SAML 2.0 SSO via Admin → Security → Single Sign-On.'),
  _app('domo',           'Domo',                   'domo.com',            'Analytics',       _S, 'Domo supports SAML 2.0 SSO via Admin Settings → Authentication → SSO.'),
  _app('thoughtspot',    'ThoughtSpot',            'thoughtspot.com',     'Analytics',       _S, 'ThoughtSpot supports SAML 2.0 SSO via Security Settings → SSO.'),
  _app('amplitude',      'Amplitude',              'amplitude.com',       'Analytics',       _S, 'Amplitude supports SAML 2.0 SSO via Settings → SSO.'),
  _app('mixpanel',       'Mixpanel',               'mixpanel.com',        'Analytics',       _S, 'Mixpanel Enterprise supports SAML 2.0 SSO via Organization Settings → Access Control.'),
  _app('heap',           'Heap',                   'heap.io',             'Analytics',       _S, 'Heap supports SAML 2.0 SSO via Account → Security → Single Sign-On.'),
  _app('segment',        'Segment',                'segment.com',         'Analytics',       _S, 'Segment supports SAML 2.0 SSO via Workspace Settings → Authentication.'),
  _app('pendo',          'Pendo',                  'pendo.io',            'Analytics',       _S, 'Pendo supports SAML 2.0 SSO via Admin → Integrations → SSO.'),
  _app('fullstory',      'FullStory',              'fullstory.com',       'Analytics',       _S, 'FullStory supports SAML 2.0 SSO via Settings → Security.'),
  _app('posthog',        'PostHog',                'posthog.com',         'Analytics',       _S, 'PostHog Cloud supports SAML 2.0 SSO via Settings → Authentication.'),
  _app('hotjar',         'Hotjar',                 'hotjar.com',          'Analytics',       _S, 'Hotjar Business supports SAML 2.0 SSO via Organisation Settings.'),
  _app('matomo',         'Matomo',                 'matomo.org',          'Analytics',       _O, 'Matomo supports OIDC / OAuth 2.0 via Login OIDC plugin for self-hosted.'),
  _app('mode',           'Mode Analytics',         'mode.com',            'Analytics',       _S, 'Mode supports SAML 2.0 SSO via Organization Settings → Security.'),
  _app('superset',       'Apache Superset',        'superset.apache.org', 'Analytics',       _O, 'Apache Superset supports OIDC via Flask-OIDC; configure in superset_config.py.'),
  // ── Productivity & Storage ─────────────────────────────────────────────────
  _app('gsuite',         'Google Workspace',       'workspace.google.com','Productivity',    _S, 'Google Workspace supports SAML 2.0. Configure in Admin Console → Security → SSO with third-party IdP.'),
  _app('office365',      'Microsoft 365',          'microsoft.com',       'Productivity',    _S, 'Microsoft 365 federated authentication with SAML 2.0 via Entra ID.'),
  _app('box',            'Box',                    'box.com',             'Productivity',    _S, 'Box supports SAML 2.0 SSO in Admin Console → Enterprise Settings → User Settings.'),
  _app('dropbox',        'Dropbox Business',       'dropbox.com',         'Productivity',    _S, 'Dropbox Business supports SAML 2.0 in Admin Console → Settings → Single Sign-On.'),
  _app('sharepoint',     'SharePoint Online',      'microsoft.com',       'Productivity',    _S, 'SharePoint Online SSO via Azure AD SAML 2.0 federation.'),
  _app('gdrive',         'Google Drive',           'google.com',          'Productivity',    _S, 'Google Drive SSO managed through Google Workspace SAML federation.'),
  _app('onedrive',       'OneDrive for Business',  'microsoft.com',       'Productivity',    _S, 'OneDrive SSO via Azure AD / Entra ID SAML 2.0.'),
  _app('docusign',       'DocuSign',               'docusign.com',        'Productivity',    _S, 'DocuSign supports SAML 2.0 SSO via Admin → Identity Providers.'),
  _app('adobesign',      'Adobe Acrobat Sign',     'adobe.com',           'Productivity',    _S, 'Adobe Acrobat Sign supports SAML 2.0 SSO via Account Setup → Security Settings.'),
  _app('pandadoc',       'PandaDoc',               'pandadoc.com',        'Productivity',    _S, 'PandaDoc supports SAML 2.0 SSO via Workspace Settings → Security.'),
  _app('coda',           'Coda',                   'coda.io',             'Productivity',    _S, 'Coda supports SAML 2.0 SSO for enterprise workspace access.'),
  _app('gitbook',        'GitBook',                'gitbook.com',         'Productivity',    _S, 'GitBook supports SAML 2.0 SSO via Organisation Settings → SSO.'),
  _app('slab',           'Slab',                   'slab.com',            'Productivity',    _S, 'Slab supports SAML 2.0 SSO for team documentation access.'),
  _app('guru',           'Guru',                   'getguru.com',         'Productivity',    _S, 'Guru supports SAML 2.0 SSO via Admin → Security → Single Sign-On.'),
  _app('outline',        'Outline',                'getoutline.com',      'Productivity',    _O, 'Outline (open-source) supports OIDC via oidc_* environment variables.'),
  _app('tettra',         'Tettra',                 'tettra.com',          'Productivity',    _S, 'Tettra supports SAML 2.0 SSO for knowledge base authentication.'),
  // ── Design & Creative ──────────────────────────────────────────────────────
  _app('figma',          'Figma',                  'figma.com',           'Design',          _S, 'Figma Organization supports SAML 2.0 SSO via Organization Settings → Security.'),
  _app('canva',          'Canva',                  'canva.com',           'Design',          _S, 'Canva for Teams supports SAML 2.0 SSO for enterprise design workflows.'),
  _app('adobe',          'Adobe Creative Cloud',   'adobe.com',           'Design',          _S, 'Adobe Creative Cloud supports SAML 2.0 via Admin Console → Settings → Identity.'),
  _app('sketch',         'Sketch',                 'sketch.com',          'Design',          _S, 'Sketch Business supports SAML 2.0 SSO via Workspace Settings.'),
  _app('invision',       'InVision',               'invisionapp.com',     'Design',          _S, 'InVision Enterprise supports SAML 2.0 SSO via Account Settings.'),
  _app('miro2',          'Miro',                   'miro.com',            'Design',          _S, 'Miro supports SAML 2.0 SSO for Enterprise plans via Company Settings.'),
  _app('lucidchart',     'Lucidchart',             'lucid.app',           'Design',          _S, 'Lucidchart supports SAML 2.0 SSO via Admin Panel → App Management → SSO.'),
  _app('whimsical',      'Whimsical',              'whimsical.com',       'Design',          _S, 'Whimsical Business supports SAML 2.0 SSO for design teams.'),
  _app('mural',          'MURAL',                  'mural.co',            'Design',          _S, 'MURAL supports SAML 2.0 SSO via Company Dashboard → Security → SSO.'),
  _app('zeplin',         'Zeplin',                 'zeplin.io',           'Design',          _S, 'Zeplin Enterprise supports SAML 2.0 SSO via Organization Settings.'),
  _app('framer',         'Framer',                 'framer.com',          'Design',          _O, 'Framer supports OIDC-based SSO for enterprise design platform access.'),
  _app('webflow',        'Webflow',                'webflow.com',         'Design',          _S, 'Webflow Enterprise supports SAML 2.0 SSO via Workspace Settings → Security.'),
  _app('abstract',       'Abstract',               'abstract.com',        'Design',          _S, 'Abstract supports SAML 2.0 SSO for enterprise design version control.'),
  // ── Marketing & Email ──────────────────────────────────────────────────────
  _app('mailchimp',      'Mailchimp',              'mailchimp.com',       'Marketing',       _O, 'Mailchimp supports OAuth 2.0 / OIDC for marketing automation integrations.'),
  _app('marketo',        'Marketo (Adobe)',         'marketo.com',         'Marketing',       _S, 'Marketo supports SAML 2.0 SSO via Admin → Security → Single Sign-On.'),
  _app('pardot',         'Salesforce Pardot',      'salesforce.com',      'Marketing',       _S, 'Pardot supports SAML 2.0 SSO (via Salesforce) for marketing automation.'),
  _app('activecampaign', 'ActiveCampaign',         'activecampaign.com',  'Marketing',       _S, 'ActiveCampaign supports SAML 2.0 SSO via Settings → Security → SSO.'),
  _app('klaviyo',        'Klaviyo',                'klaviyo.com',         'Marketing',       _S, 'Klaviyo supports SAML 2.0 SSO via Organisation Settings → Security.'),
  _app('braze',          'Braze',                  'braze.com',           'Marketing',       _S, 'Braze supports SAML 2.0 SSO via Company Settings → Security Settings.'),
  _app('iterable',       'Iterable',               'iterable.com',        'Marketing',       _S, 'Iterable supports SAML 2.0 SSO via Settings → Team → SSO.'),
  _app('sfmc',           'Salesforce Marketing Cloud','salesforce.com',    'Marketing',       _S, 'SFMC supports SAML 2.0 SSO via Administration → SSO Settings.'),
  _app('sendgrid',       'Twilio SendGrid',         'sendgrid.com',       'Marketing',       _O, 'Twilio SendGrid supports OAuth 2.0 for transactional email API access.'),
  _app('mailgun',        'Mailgun',                'mailgun.com',         'Marketing',       _O, 'Mailgun supports OAuth 2.0 for email API authentication.'),
  _app('customerio',     'Customer.io',            'customer.io',         'Marketing',       _S, 'Customer.io supports SAML 2.0 SSO for marketing automation teams.'),
  _app('drip',           'Drip',                   'drip.com',            'Marketing',       _O, 'Drip supports OAuth 2.0 for e-commerce marketing automation.'),
  _app('convertkit',     'ConvertKit',             'convertkit.com',      'Marketing',       _O, 'ConvertKit supports OAuth 2.0 for creator email platform integrations.'),
  _app('moosend',        'Moosend',                'moosend.com',         'Marketing',       _O, 'Moosend supports OAuth 2.0 for email marketing integrations.'),
  _app('campaign-monitor','Campaign Monitor',      'campaignmonitor.com', 'Marketing',       _O, 'Campaign Monitor supports OAuth 2.0 for email marketing platform access.'),
  // ── Learning & Training ────────────────────────────────────────────────────
  _app('coursera',       'Coursera for Teams',     'coursera.org',        'Learning',        _S, 'Coursera for Enterprise supports SAML 2.0 SSO via Admin Settings.'),
  _app('udemy',          'Udemy Business',         'udemy.com',           'Learning',        _S, 'Udemy Business supports SAML 2.0 SSO via Admin → Settings → SSO.'),
  _app('linkedin-learn', 'LinkedIn Learning',      'linkedin.com',        'Learning',        _S, 'LinkedIn Learning (via LinkedIn Enterprise) supports SAML 2.0 SSO.'),
  _app('docebo',         'Docebo LMS',             'docebo.com',          'Learning',        _S, 'Docebo supports SAML 2.0 SSO via Admin Menu → E-Learning → SSO.'),
  _app('absorb',         'Absorb LMS',             'absorblms.com',       'Learning',        _S, 'Absorb LMS supports SAML 2.0 SSO for enterprise learning management.'),
  _app('cornerstone',    'Cornerstone OnDemand',   'cornerstoneondemand.com','Learning',      _S, 'Cornerstone supports SAML 2.0 SSO via Administration → Security → SSO.'),
  _app('moodle',         'Moodle',                 'moodle.org',          'Learning',        _S, 'Moodle supports SAML 2.0 via the SAML2 Authentication Plugin (mdlauth_saml2).'),
  _app('canvas',         'Canvas LMS',             'instructure.com',     'Learning',        _S, 'Canvas supports SAML 2.0 SSO via Admin → Authentication Providers.'),
  _app('degreed',        'Degreed',                'degreed.com',         'Learning',        _S, 'Degreed supports SAML 2.0 SSO for learning experience platform access.'),
  _app('360learning',    '360Learning',            '360learning.com',     'Learning',        _S, '360Learning supports SAML 2.0 SSO via Admin Settings → Integrations → SSO.'),
  _app('learnupon',      'LearnUpon',              'learnupon.com',       'Learning',        _S, 'LearnUpon supports SAML 2.0 SSO via Portal Settings → SSO.'),
  _app('litmos',         'SAP Litmos',             'litmos.com',          'Learning',        _S, 'SAP Litmos supports SAML 2.0 SSO via Admin → Integrations → SSO.'),
  _app('talentlms',      'TalentLMS',              'talentlms.com',       'Learning',        _S, 'TalentLMS supports SAML 2.0 SSO via Account & Settings → Security.'),
  _app('skillsoft',      'Skillsoft / Percipio',   'skillsoft.com',       'Learning',        _S, 'Skillsoft Percipio supports SAML 2.0 SSO for enterprise L&D.'),
  // ── E-commerce & Payments ──────────────────────────────────────────────────
  _app('shopify',        'Shopify Plus',           'shopify.com',         'E-commerce',      _S, 'Shopify Plus supports SAML 2.0 SSO via Settings → Users and Permissions.'),
  _app('bigcommerce',    'BigCommerce',            'bigcommerce.com',     'E-commerce',      _S, 'BigCommerce Enterprise supports SAML 2.0 SSO via Store Setup → Single Sign-On.'),
  _app('stripe',         'Stripe Dashboard',       'stripe.com',          'E-commerce',      _S, 'Stripe Dashboard supports SAML 2.0 SSO for team member authentication.'),
  _app('paypal',         'PayPal Business',        'paypal.com',          'E-commerce',      _O, 'PayPal Business supports OAuth 2.0 for payment API authentication.'),
  _app('square',         'Square',                 'squareup.com',        'E-commerce',      _O, 'Square supports OAuth 2.0 for POS and payment platform integrations.'),
  _app('adyen',          'Adyen',                  'adyen.com',           'E-commerce',      _S, 'Adyen supports SAML 2.0 SSO for Customer Area authentication.'),
  _app('magento',        'Adobe Commerce (Magento)','adobe.com',          'E-commerce',      _S, 'Adobe Commerce supports SAML 2.0 SSO via Security → Identity and Access Management.'),
  _app('woocommerce',    'WooCommerce',            'woocommerce.com',     'E-commerce',      _O, 'WooCommerce supports OAuth 2.0 for REST API authentication.'),
  // ── Data & Integration ─────────────────────────────────────────────────────
  _app('snowflake',      'Snowflake',              'snowflake.com',       'Data',            _S, 'Snowflake supports SAML 2.0 SSO via Security → Identity Providers.'),
  _app('databricks',     'Databricks',             'databricks.com',      'Data',            _S, 'Databricks supports SAML 2.0 SSO via Admin Console → Authentication.'),
  _app('dbt',            'dbt Cloud',              'getdbt.com',          'Data',            _O, 'dbt Cloud supports OIDC SSO via Account Settings → Single Sign-On.'),
  _app('fivetran',       'Fivetran',               'fivetran.com',        'Data',            _S, 'Fivetran supports SAML 2.0 SSO via Manage Account → Security.'),
  _app('airbyte',        'Airbyte',                'airbyte.com',         'Data',            _O, 'Airbyte Cloud supports OIDC-based SSO for data integration access.'),
  _app('mulesoft',       'MuleSoft Anypoint',      'mulesoft.com',        'Data',            _S, 'MuleSoft Anypoint Platform supports SAML 2.0 via Access Management → Identity Management.'),
  _app('boomi',          'Boomi',                  'boomi.com',           'Data',            _S, 'Boomi AtomSphere supports SAML 2.0 SSO via Settings → Account → Identity Provider.'),
  _app('informatica',    'Informatica',            'informatica.com',     'Data',            _S, 'Informatica Intelligent Data Management Cloud supports SAML 2.0 SSO.'),
  _app('workato',        'Workato',                'workato.com',         'Data',            _S, 'Workato supports SAML 2.0 SSO via Settings → Access → Single Sign-On.'),
  _app('zapier',         'Zapier',                 'zapier.com',          'Data',            _S, 'Zapier supports SAML 2.0 SSO for enterprise team authentication.'),
  _app('make',           'Make (Integromat)',       'make.com',            'Data',            _S, 'Make (formerly Integromat) supports SAML 2.0 SSO for enterprise plans.'),
  _app('tray',           'Tray.io',                'tray.io',             'Data',            _S, 'Tray.io supports SAML 2.0 SSO for enterprise integration access.'),
  _app('celigo',         'Celigo',                 'celigo.com',          'Data',            _S, 'Celigo Integration Cloud supports SAML 2.0 SSO via Account Settings.'),
  _app('stitch',         'Stitch Data',            'stitchdata.com',      'Data',            _O, 'Stitch Data supports OAuth 2.0 for data pipeline authentication.'),
  _app('talend',         'Talend Cloud',           'talend.com',          'Data',            _S, 'Talend Cloud supports SAML 2.0 SSO for data integration platform access.'),
  // ── Customer Success ───────────────────────────────────────────────────────
  _app('gainsight',      'Gainsight',              'gainsight.com',       'Customer Success',_S, 'Gainsight supports SAML 2.0 SSO via Administration → SSO.'),
  _app('churnzero',      'ChurnZero',              'churnzero.com',       'Customer Success',_S, 'ChurnZero supports SAML 2.0 SSO for customer success platform access.'),
  _app('totango',        'Totango',                'totango.com',         'Customer Success',_S, 'Totango supports SAML 2.0 SSO via Admin → Settings → SSO.'),
  _app('planhat',        'Planhat',                'planhat.com',         'Customer Success',_S, 'Planhat supports SAML 2.0 SSO for customer intelligence platform.'),
  _app('vitally',        'Vitally',                'vitally.io',          'Customer Success',_S, 'Vitally supports SAML 2.0 SSO for customer success teams.'),
  _app('catalyst',       'Catalyst',               'catalyst.io',         'Customer Success',_S, 'Catalyst supports SAML 2.0 SSO for CS platform access.'),
  _app('clientsuccess',  'ClientSuccess',          'clientsuccess.com',   'Customer Success',_S, 'ClientSuccess supports SAML 2.0 SSO for CSM platform authentication.'),
  _app('useriq',         'UserIQ',                 'useriq.com',          'Customer Success',_S, 'UserIQ supports SAML 2.0 SSO for customer success analytics.'),
  // ── Legal & Compliance ─────────────────────────────────────────────────────
  _app('contractpodai',  'ContractPodAi',          'contractpodai.com',   'Legal',           _S, 'ContractPodAi supports SAML 2.0 SSO for legal AI platform access.'),
  _app('ironclad',       'Ironclad',               'ironcladapp.com',     'Legal',           _S, 'Ironclad supports SAML 2.0 SSO via Company Settings → Security → SSO.'),
  _app('conga',          'Conga Contracts',        'conga.com',           'Legal',           _S, 'Conga Contracts supports SAML 2.0 SSO for contract lifecycle management.'),
  _app('onetrust',       'OneTrust',               'onetrust.com',        'Legal',           _S, 'OneTrust supports SAML 2.0 SSO via Platform Administration → SSO.'),
  _app('trustarc',       'TrustArc',               'trustarc.com',        'Legal',           _S, 'TrustArc supports SAML 2.0 SSO for privacy compliance platform.'),
  _app('osano',          'Osano',                  'osano.com',           'Legal',           _O, 'Osano supports OIDC for cookie consent management platform authentication.'),
  _app('vaultworks',     'Vault Works',            'vaultworks.com',      'Legal',           _S, 'Vault Works supports SAML 2.0 SSO for legal matter management.'),
  _app('legalzoom',      'LegalZoom Enterprise',   'legalzoom.com',       'Legal',           _O, 'LegalZoom Enterprise supports OAuth 2.0 for legal services access.'),
  // ── Video & Media ──────────────────────────────────────────────────────────
  _app('vimeo',          'Vimeo Business',         'vimeo.com',           'Media',           _S, 'Vimeo supports SAML 2.0 SSO for Business and Enterprise plans.'),
  _app('wistia',         'Wistia',                 'wistia.com',          'Media',           _O, 'Wistia supports OAuth 2.0 / OIDC for video hosting platform access.'),
  _app('panopto',        'Panopto',                'panopto.com',         'Media',           _S, 'Panopto supports SAML 2.0 SSO via System → Identity Providers.'),
  _app('kaltura',        'Kaltura',                'kaltura.com',         'Media',           _S, 'Kaltura supports SAML 2.0 SSO for enterprise video platform.'),
  _app('brightcove',     'Brightcove',             'brightcove.com',      'Media',           _S, 'Brightcove supports SAML 2.0 SSO for video cloud platform access.'),
  _app('vidyard',        'Vidyard',                'vidyard.com',         'Media',           _S, 'Vidyard supports SAML 2.0 SSO for video messaging platform.'),
  _app('loom',           'Loom',                   'loom.com',            'Media',           _S, 'Loom Enterprise supports SAML 2.0 SSO via Settings → Security.'),
  // ── DevSecOps & Scanning ───────────────────────────────────────────────────
  _app('veracode',       'Veracode',               'veracode.com',        'Security',        _S, 'Veracode supports SAML 2.0 SSO for application security platform access.'),
  _app('checkmarx',      'Checkmarx',              'checkmarx.com',       'Security',        _S, 'Checkmarx supports SAML 2.0 SSO for SAST/SCA platform authentication.'),
  _app('qualys',         'Qualys',                 'qualys.com',          'Security',        _S, 'Qualys supports SAML 2.0 SSO for vulnerability management platform.'),
  _app('crowdstrike',    'CrowdStrike Falcon',     'crowdstrike.com',     'Security',        _S, 'CrowdStrike Falcon supports SAML 2.0 SSO via Settings → Identity Provider.'),
  _app('sentinelone',    'SentinelOne',            'sentinelone.com',     'Security',        _S, 'SentinelOne supports SAML 2.0 SSO via Settings → SSO.'),
  _app('lacework',       'Lacework',               'lacework.com',        'Security',        _S, 'Lacework supports SAML 2.0 SSO for cloud security platform.'),
  _app('prismacloud',    'Prisma Cloud (Palo Alto)','paloaltonetworks.com','Security',        _S, 'Prisma Cloud supports SAML 2.0 SSO via Settings → Access Control → SSO.'),
  _app('wiz',            'Wiz',                    'wiz.io',              'Security',        _S, 'Wiz supports SAML 2.0 SSO via Settings → General → Single Sign-On.'),
  _app('orca',           'Orca Security',          'orca.security',       'Security',        _S, 'Orca Security supports SAML 2.0 SSO for cloud security platform.'),
  _app('tenable',        'Tenable.io',             'tenable.com',         'Security',        _S, 'Tenable.io supports SAML 2.0 SSO via Settings → Single Sign-On.'),
  _app('rapid7',         'Rapid7 Insight',         'rapid7.com',          'Security',        _S, 'Rapid7 InsightVM/InsightIDR supports SAML 2.0 SSO via Platform Administration.'),
  // ── ERP & Operations ──────────────────────────────────────────────────────
  _app('sap-erp',        'SAP ERP / Fiori',        'sap.com',             'ERP',             _S, 'SAP Fiori apps support SAML 2.0 via Cloud Identity Services (IAS) federation.'),
  _app('oracle-erp',     'Oracle Fusion ERP',      'oracle.com',          'ERP',             _S, 'Oracle Fusion Cloud supports SAML 2.0 SSO via Security Console → Identity Providers.'),
  _app('dynamics-erp',   'Microsoft Dynamics 365 ERP','microsoft.com',    'ERP',             _S, 'Dynamics 365 ERP supports SAML 2.0 SSO via Azure AD federation.'),
  _app('odoo',           'Odoo',                   'odoo.com',            'ERP',             _O, 'Odoo supports OIDC via oauth_provider module for enterprise SSO.'),
  _app('epicor',         'Epicor Kinetic',         'epicor.com',          'ERP',             _S, 'Epicor Kinetic supports SAML 2.0 SSO for enterprise resource planning.'),
  _app('infor',          'Infor CloudSuite',       'infor.com',           'ERP',             _S, 'Infor CloudSuite supports SAML 2.0 SSO via Infor OS Security Administration.'),
  _app('netsuite-erp',   'NetSuite ERP',           'netsuite.com',        'ERP',             _S, 'NetSuite ERP supports SAML 2.0 SSO via Setup → Integrations → SSO.'),
  // ── Supply Chain & Procurement ─────────────────────────────────────────────
  _app('sap-ariba',      'SAP Ariba',              'ariba.com',           'Procurement',     _S, 'SAP Ariba supports SAML 2.0 SSO via SSP module configuration.'),
  _app('jaggaer',        'Jaggaer',                'jaggaer.com',         'Procurement',     _S, 'Jaggaer supports SAML 2.0 SSO for procurement platform access.'),
  _app('ivalua',         'Ivalua',                 'ivalua.com',          'Procurement',     _S, 'Ivalua supports SAML 2.0 SSO for source-to-pay platform.'),
  _app('tradogram',      'Tradogram',              'tradogram.com',       'Procurement',     _O, 'Tradogram supports OAuth 2.0 for procurement management SSO.'),
  // ── Hospitality & Retail ───────────────────────────────────────────────────
  _app('oracle-hospitality','Oracle OPERA Cloud', 'oracle.com',           'Hospitality',     _S, 'Oracle OPERA Cloud supports SAML 2.0 SSO via Identity Cloud Service.'),
  _app('lightspeed',     'Lightspeed Retail',      'lightspeedhq.com',    'Retail',          _O, 'Lightspeed Retail supports OAuth 2.0 for POS platform access.'),
  _app('vend',           'Lightspeed (Vend)',      'vendhq.com',          'Retail',          _O, 'Vend by Lightspeed supports OAuth 2.0 / OIDC for retail management.'),
  _app('revel',          'Revel Systems',          'revelsystems.com',    'Retail',          _O, 'Revel POS supports OAuth 2.0 for restaurant and retail platform.'),
  // ── Real Estate & Facilities ───────────────────────────────────────────────
  _app('procore',        'Procore',                'procore.com',         'Construction',    _S, 'Procore supports SAML 2.0 SSO via Company Settings → Single Sign-On.'),
  _app('autodesk',       'Autodesk BIM 360',       'autodesk.com',        'Construction',    _S, 'Autodesk Construction Cloud supports SAML 2.0 SSO via Identity Management.'),
  _app('planon',         'Planon IWMS',            'planonsoftware.com',  'Facilities',      _S, 'Planon supports SAML 2.0 SSO for integrated workplace management.'),
  // ── Healthcare (if applicable) ─────────────────────────────────────────────
  _app('epic',           'Epic MyChart',           'epic.com',            'Healthcare',      _S, 'Epic supports SAML 2.0 SSO via Security Configuration for healthcare enterprises.'),
  _app('salesforce-health','Salesforce Health Cloud','salesforce.com',    'Healthcare',      _S, 'Salesforce Health Cloud uses standard SAML 2.0 SSO from Salesforce Setup.'),
  _app('workiva',        'Workiva',                'workiva.com',         'Healthcare',      _S, 'Workiva supports SAML 2.0 SSO via My Account → Security → SSO.'),
  // ── Telecom & Communication ────────────────────────────────────────────────
  _app('twilio',         'Twilio Console',         'twilio.com',          'Telecom',         _S, 'Twilio supports SAML 2.0 SSO for organisation member authentication.'),
  _app('vonage',         'Vonage / Nexmo',         'vonage.com',          'Telecom',         _O, 'Vonage supports OAuth 2.0 / OIDC for communications API platform access.'),
  _app('ringcentral2',   'RingCentral Office',     'ringcentral.com',     'Telecom',         _O, 'RingCentral supports OAuth 2.0 / OIDC for UCaaS integrations.'),
  _app('8x8',            '8×8',                    '8x8.com',             'Telecom',         _S, '8×8 Work supports SAML 2.0 SSO for cloud communications.'),
  _app('dialpad',        'Dialpad',                'dialpad.com',         'Telecom',         _S, 'Dialpad supports SAML 2.0 SSO via Settings → Security.'),
  _app('aircall',        'Aircall',                'aircall.io',          'Telecom',         _S, 'Aircall supports SAML 2.0 SSO for cloud call centre access.'),
  _app('cloudtalk',      'CloudTalk',              'cloudtalk.io',        'Telecom',         _O, 'CloudTalk supports OIDC-based SSO for VoIP platform.'),
  _app('five9',          'Five9',                  'five9.com',           'Telecom',         _S, 'Five9 supports SAML 2.0 SSO for contact centre platform access.'),
  _app('genesys',        'Genesys Cloud',          'genesys.com',         'Telecom',         _O, 'Genesys Cloud CX supports OAuth 2.0 / OIDC for contact centre authentication.'),
  // ── Travel & Expense ──────────────────────────────────────────────────────
  _app('concur-travel',  'SAP Concur Travel',      'concur.com',          'Travel',          _S, 'SAP Concur Travel supports SAML 2.0 SSO via Administration → Authentication Admin.'),
  _app('egencia',        'Egencia (Amex GBT)',     'egencia.com',         'Travel',          _S, 'Egencia supports SAML 2.0 SSO for corporate travel management.'),
  _app('navan',          'Navan (TripActions)',     'navan.com',           'Travel',          _S, 'Navan supports SAML 2.0 SSO via Company Settings → Security → SSO.'),
  _app('sap-travex',     'SAP Travel Expense',     'sap.com',             'Travel',          _S, 'SAP Travel & Expense supports SAML 2.0 SSO via Cloud Identity Services.'),
  // ── Custom & Generic ──────────────────────────────────────────────────────
  _app('custom-saml',    'Custom SAML App',        null,                  'Custom',          _S, 'Register any application that supports SAML 2.0 Service Provider SSO.'),
  _app('custom-oidc',    'Custom OAuth / OIDC App', null,                 'Custom',          _O, 'Register any application that supports OpenID Connect / OAuth 2.0 (Client ID + Secret).', ['openid','email','profile'], ['authorization_code','refresh_token']),
  _app('custom-legacy',  'Legacy App (Header)',    null,                  'Custom',          _S, 'Use header-based or reverse-proxy SSO for applications that cannot do SAML/OIDC natively.'),
];

const CATALOG_CATS = ['All', ...new Set(SSO_CATALOG.map(a => a.cat))];

// =============================================================================
// INTEGRATION WIZARD — multi-step setup flow for catalog apps
// =============================================================================
const WIZ_ICON_COLOURS = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#6366f1'];
function wizColour(name = '') { return WIZ_ICON_COLOURS[name.charCodeAt(0) % WIZ_ICON_COLOURS.length]; }

// Vendor-specific setup tips. Anything not in the table falls back to generic instructions.
const VENDOR_TIPS = {
  'custom-oidc': {
    docsUrl: null,
    setupSteps: [
      'Open your application\'s <strong>OAuth 2.0 / OpenID Connect</strong> provider settings.',
      'Paste the <strong>IdP endpoints</strong> from step 2 (discovery URL is usually enough).',
      'Copy the <strong>redirect / callback URIs</strong> your app shows and paste them in step 3 of this wizard.',
      'After you click <strong>Register</strong>, copy the auto-generated <strong>Client ID</strong> and <strong>Client Secret</strong> back into your app.',
    ],
  },
  slack: {
    docsUrl: 'https://slack.com/help/articles/360039304351-Use-OpenID-Connect-with-Slack',
    setupSteps: [
      'Open <strong>Slack workspace admin → Settings &amp; permissions → Authentication</strong>.',
      'Choose <strong>OpenID Connect</strong> as the SSO method.',
      'Paste the IdP discovery / authorization / token endpoints from this wizard.',
      'Save, then return here to enter Slack\'s callback URL.',
    ],
  },
  zoom: {
    docsUrl: 'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066768',
    setupSteps: [
      'Sign in to <strong>Zoom Admin → Advanced → Single Sign-On</strong>.',
      'Choose <strong>SAML</strong> and click <em>Edit</em>.',
      'Paste the IdP Issuer / SSO URL / X.509 certificate from the next step.',
      'Zoom will display its Service Provider details — paste them back here.',
    ],
  },
  'google-workspace': {
    docsUrl: 'https://support.google.com/a/answer/6087519',
    setupSteps: [
      'Open <strong>Google Admin Console → Security → Authentication → SSO with third-party IdP</strong>.',
      'Add a new IdP profile and paste the metadata URL from this wizard.',
      'Assign the profile to the relevant Organisational Units.',
    ],
  },
  github: {
    docsUrl: 'https://docs.github.com/en/enterprise-cloud@latest/admin/identity-and-access-management/using-saml-for-enterprise-iam',
    setupSteps: [
      'In <strong>GitHub Enterprise → Settings → Authentication security</strong>, enable SAML SSO.',
      'Paste the Sign-on URL, Issuer, and X.509 certificate from this wizard.',
      'GitHub will return ACS URL and Entity ID — paste them back into the SP step.',
    ],
  },
  teams: {
    docsUrl: 'https://learn.microsoft.com/en-us/microsoftteams/sign-in-teams',
    setupSteps: [
      'Microsoft Teams uses <strong>Microsoft Entra ID</strong> for federation.',
      'Configure Lenskart IdP as a custom claims provider in Entra ID.',
      'Use the IdP metadata URL from this wizard when setting up the federation trust.',
    ],
  },
  jira: {
    docsUrl: 'https://support.atlassian.com/security-and-access-policies/docs/configure-saml-single-sign-on-with-an-identity-provider/',
    setupSteps: [
      'Open <strong>Atlassian Access → Security → Authentication policies</strong>.',
      'Add a new SAML SSO directory.',
      'Paste the IdP Entity ID, SSO URL, and certificate from this wizard.',
      'Atlassian will display the SP Entity ID and ACS URL — paste them in the SP step.',
    ],
  },
  aws: {
    docsUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_saml.html',
    setupSteps: [
      'In the AWS IAM console, create a new SAML Identity Provider with the metadata XML from this wizard.',
      'Create or edit IAM Roles with a trust policy that references the new IdP.',
      'AWS will display the SP role ARN and audience — paste those into the SP step.',
    ],
  },
};

function vendorTips(slug, app) {
  const t = VENDOR_TIPS[slug];
  if (t) return t;
  return {
    docsUrl: null,
    setupSteps: [
      `Open <strong>${esc(app.name)}</strong>'s SSO / Authentication settings page.`,
      `Choose <strong>${esc(app.protocol)} 2.0</strong> as the SSO method.`,
      `Paste the IdP details from the next step into <strong>${esc(app.name)}</strong>.`,
      `Copy the Service Provider details that <strong>${esc(app.name)}</strong> returns and paste them back here.`,
    ],
  };
}

// Small DOM helper: copyable read-only field
function readonlyInput(value, id) {
  return `<div class="wiz-readonly-input">
    <input class="form-input" id="${id}" value="${esc(value)}" readonly onclick="this.select()">
    <button type="button" class="btn btn-secondary btn-sm copy-btn" data-copy="${id}">Copy</button>
  </div>`;
}

function wireCopyButtons(root) {
  root.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = root.querySelector('#' + btn.dataset.copy);
      if (!target) return;
      try {
        navigator.clipboard?.writeText(target.value);
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      } catch { /* clipboard API unavailable */ }
    });
  });
}

// Generic stepped wizard — `steps` is an array of { id, label, render(d), validate?(d, body), collect?(d, body), bind?(body, d), finishLabel? }
function runWizard({ title, subtitle, vendor, steps, initialData, onFinish }) {
  let stepIdx = 0;
  const data = { ...(initialData || {}) };

  const bd = openModal(`<div class="modal modal-wizard" role="dialog" aria-labelledby="wiz-title">
    <div class="modal-header">
      <div style="display:flex;gap:0.85rem;align-items:center;min-width:0;flex:1">
        ${vendor ? `<div style="width:40px;height:40px;border-radius:9px;background:${wizColour(vendor.name||'')};color:#fff;font-weight:700;font-size:1.1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">${esc((vendor.name||'?')[0].toUpperCase())}</div>` : ''}
        <div class="wizard-title-block">
          <h2 id="wiz-title">${esc(title)}</h2>
          ${subtitle ? `<div class="muted">${esc(subtitle)}</div>` : ''}
        </div>
      </div>
      <button type="button" class="wizard-close" aria-label="Close">&times;</button>
    </div>
    <div class="wizard-stepper" id="wiz-stepper"></div>
    <div class="modal-body" id="wiz-body" style="min-height:280px"></div>
    <div class="modal-footer">
      <button type="button" class="btn btn-secondary" id="wiz-back">← Back</button>
      <div class="footer-right">
        <button type="button" class="btn btn-secondary" id="wiz-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="wiz-next">Next →</button>
      </div>
    </div>
  </div>`);

  const stepperEl = bd.querySelector('#wiz-stepper');
  const bodyEl    = bd.querySelector('#wiz-body');
  const backBtn   = bd.querySelector('#wiz-back');
  const cancelBtn = bd.querySelector('#wiz-cancel');
  const nextBtn   = bd.querySelector('#wiz-next');
  const closeBtn  = bd.querySelector('.wizard-close');

  function setError(msg) {
    let errEl = bodyEl.querySelector('.wiz-err');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'wiz-err alert alert-error';
      errEl.style.marginTop = '1rem';
      bodyEl.appendChild(errEl);
    }
    errEl.textContent = msg;
  }

  function clearError() {
    bodyEl.querySelector('.wiz-err')?.remove();
  }

  function renderStepper() {
    stepperEl.innerHTML = steps.map((s, i) => {
      const status = i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'pending';
      const num = i < stepIdx ? '✓' : (i + 1);
      return `<div class="wiz-step wiz-step-${status}">
        <span class="wiz-num">${num}</span>
        <span class="wiz-label">${esc(s.label)}</span>
        ${i < steps.length - 1 ? '<span class="wiz-sep"></span>' : ''}
      </div>`;
    }).join('');
  }

  function renderStep() {
    renderStepper();
    const step = steps[stepIdx];
    bodyEl.innerHTML = step.render(data);
    if (step.bind) step.bind(bodyEl, data);
    wireCopyButtons(bodyEl);
    backBtn.style.visibility = stepIdx === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = stepIdx === steps.length - 1
      ? (step.finishLabel || 'Finish ✓')
      : 'Next →';
    clearError();
  }

  async function tryAdvance() {
    const step = steps[stepIdx];
    nextBtn.disabled = true;
    try {
      if (step.validate) {
        const err = step.validate(data, bodyEl);
        if (err) { setError(err); nextBtn.disabled = false; return; }
      }
      if (step.collect) await step.collect(data, bodyEl);
      if (stepIdx === steps.length - 1) {
        if (onFinish) await onFinish(data, bd);
        return;
      }
      stepIdx++;
      renderStep();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      nextBtn.disabled = false;
    }
  }

  backBtn.addEventListener('click', () => {
    if (stepIdx > 0) { stepIdx--; renderStep(); }
  });
  cancelBtn.addEventListener('click', () => bd.remove());
  closeBtn.addEventListener('click', () => bd.remove());
  nextBtn.addEventListener('click', tryAdvance);

  renderStep();
  return { bd, getData: () => data, close: () => bd.remove() };
}

// SAML integration wizard — 4 steps: Overview, IdP details, SP configuration, Activate
function openSamlWizard(app) {
  const origin   = window.location.origin;
  const idpMeta  = `${origin}/saml/metadata`;
  const idpSso   = `${origin}/saml/sso`;
  const idpEntId = idpMeta;
  const tips     = vendorTips(app.id, app);

  const initial = {
    name:         app.name,
    slug:         app.id,
    entityId:     '',
    acsUrl:       '',
    sloUrl:       '',
    nameidFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    iconUrl:      '',
  };

  runWizard({
    title:    `Add ${app.name}`,
    subtitle: `${app.cat || 'Pre-built integration'} · SAML 2.0`,
    vendor:   app,
    initialData: initial,
    steps: [
      {
        id: 'overview', label: 'Overview',
        render: () => `
          <div class="info-box">
            <strong>How this works</strong>
            <ol class="wiz-tip-list">
              <li>Copy the <strong>IdP details</strong> from step 2 into ${esc(app.name)}'s SSO settings.</li>
              <li>Paste the <strong>Service Provider details</strong> that ${esc(app.name)} gives you back into step 3.</li>
              <li>Test the integration and activate it.</li>
            </ol>
          </div>
          <h3 style="font-size:0.95rem;margin:1.25rem 0 0.5rem">Vendor setup steps</h3>
          <ol class="wiz-tip-list">
            ${tips.setupSteps.map((s) => `<li>${s}</li>`).join('')}
          </ol>
          ${tips.docsUrl ? `<p style="font-size:0.85rem;margin-top:1rem"><a href="${esc(tips.docsUrl)}" target="_blank" rel="noopener">Open ${esc(app.name)} SSO documentation →</a></p>` : ''}
        `,
      },
      {
        id: 'idp', label: 'IdP Details',
        render: () => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
            Open <strong>${esc(app.name)}</strong>'s SSO / SAML settings in another tab and paste these values.
          </p>
          <div class="form-group">
            <label class="form-label">Identity Provider Issuer / Entity ID</label>
            ${readonlyInput(idpEntId, 'idp-eid')}
          </div>
          <div class="form-group">
            <label class="form-label">Identity Provider SSO URL</label>
            ${readonlyInput(idpSso, 'idp-sso')}
          </div>
          <div class="form-group">
            <label class="form-label">IdP Metadata URL <span class="muted" style="font-weight:400;font-size:0.78rem">(most apps accept this — paste once and they auto-discover the rest)</span></label>
            ${readonlyInput(idpMeta, 'idp-meta')}
          </div>
          <div style="border-top:1px solid var(--border);margin-top:1.25rem;padding-top:1.25rem">
            <p class="form-label" style="margin-bottom:0.65rem">Downloads — some apps require the raw files instead of a URL</p>
            <div style="display:flex;gap:0.75rem;flex-wrap:wrap">
              <button type="button" class="btn btn-secondary btn-sm" id="dl-metadata">
                ⬇ Download Metadata XML
              </button>
              <button type="button" class="btn btn-secondary btn-sm" id="dl-cert">
                ⬇ Download Certificate (.pem)
              </button>
            </div>
            <p id="dl-error" class="muted" style="font-size:0.78rem;color:var(--danger);margin-top:0.5rem;display:none"></p>
          </div>
        `,
        bind: (_body) => {
          // wire download buttons after DOM is injected
          const body = _body;
          const errEl = body.querySelector('#dl-error');

          body.querySelector('#dl-metadata').addEventListener('click', async () => {
            try {
              const res = await fetch(idpMeta);
              if (!res.ok) throw new Error(`Server returned ${res.status}`);
              const xml = await res.text();
              const blob = new Blob([xml], { type: 'application/xml' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'idp-metadata.xml';
              a.click();
              URL.revokeObjectURL(a.href);
              errEl.style.display = 'none';
            } catch (e) {
              errEl.textContent = 'Could not fetch metadata: ' + e.message;
              errEl.style.display = '';
            }
          });

          body.querySelector('#dl-cert').addEventListener('click', async () => {
            try {
              const res = await fetch(idpMeta);
              if (!res.ok) throw new Error(`Server returned ${res.status}`);
              const xml = await res.text();
              // Extract X509Certificate value from metadata XML
              const match = xml.match(/<[^>]*:?X509Certificate[^>]*>([\s\S]*?)<\/[^>]*:?X509Certificate>/i);
              if (!match) throw new Error('No X.509 certificate found in metadata. Generate SAML keys first (scripts/gen-saml-dev-keys.sh).');
              const raw = match[1].replace(/\s+/g, '');
              const pem = '-----BEGIN CERTIFICATE-----\n' +
                raw.match(/.{1,64}/g).join('\n') +
                '\n-----END CERTIFICATE-----\n';
              const blob = new Blob([pem], { type: 'application/x-pem-file' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'idp-certificate.pem';
              a.click();
              URL.revokeObjectURL(a.href);
              errEl.style.display = 'none';
            } catch (e) {
              errEl.textContent = e.message;
              errEl.style.display = '';
            }
          });
        },
      },
      {
        id: 'sp', label: 'SP Configuration',
        render: (d) => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
            Paste the values that <strong>${esc(app.name)}</strong> shows on its SAML configuration screen.
          </p>
          <div class="form-2col">
            <div class="form-group span2">
              <label class="form-label">SP Metadata XML <span class="muted" style="font-weight:400">— upload or paste</span></label>
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem">
                <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">
                  Upload .xml file
                  <input type="file" id="w-meta-file" accept=".xml,text/xml,application/xml" style="display:none">
                </label>
                <button type="button" class="btn btn-secondary btn-sm" id="w-meta-parse">Parse metadata</button>
              </div>
              <textarea class="form-textarea" id="w-meta-paste" rows="4" placeholder="Paste SAML SP metadata XML"></textarea>
            </div>
            <div class="form-group span2">
              <label class="form-label">Display Name <span style="color:var(--danger)">*</span></label>
              <input class="form-input" id="w-name" value="${esc(d.name)}">
            </div>
            <div class="form-group span2">
              <label class="form-label">SP Entity ID <span style="color:var(--danger)">*</span></label>
              <input class="form-input" id="w-eid" value="${esc(d.entityId)}" placeholder="https://app.example.com/saml/metadata">
            </div>
            <div class="form-group span2">
              <label class="form-label">Assertion Consumer Service (ACS) URL <span style="color:var(--danger)">*</span></label>
              <input class="form-input" id="w-acs" type="url" value="${esc(d.acsUrl)}" placeholder="https://app.example.com/saml/acs">
            </div>
            <div class="form-group">
              <label class="form-label">Single Logout URL <span class="muted" style="font-weight:400">(optional)</span></label>
              <input class="form-input" id="w-slo" type="url" value="${esc(d.sloUrl)}" placeholder="https://app.example.com/saml/slo">
            </div>
            <div class="form-group">
              <label class="form-label">NameID Format</label>
              <select class="form-select" id="w-nid">
                <option value="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">Email Address</option>
                <option value="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">Persistent</option>
                <option value="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">Transient</option>
                <option value="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">Unspecified</option>
              </select>
            </div>
            <div class="form-group span2">
              <label class="form-label">Internal Slug <span style="color:var(--danger)">*</span></label>
              <input class="form-input" id="w-slug" value="${esc(d.slug)}" pattern="[a-z0-9-]+">
              <p class="muted" style="font-size:0.72rem;margin-top:0.25rem">Used in launch URLs (<code>/saml/launch/${esc(d.slug)}</code>). Lower-case letters, digits, hyphens only.</p>
            </div>
          </div>
        `,
        bind: (body, d) => {
          body.querySelector('#w-nid').value = d.nameidFormat;
          const errEl = body.closest('.modal-body')?.querySelector('#wiz-err') || body.querySelector('#wiz-err');
          async function applyMeta(data) {
            if (data.entityId) body.querySelector('#w-eid').value = data.entityId;
            if (data.acsUrl) body.querySelector('#w-acs').value = data.acsUrl;
            if (data.sloUrl) body.querySelector('#w-slo').value = data.sloUrl;
            if (data.nameidFormat) {
              const sel = body.querySelector('#w-nid');
              if ([...sel.options].some((o) => o.value === data.nameidFormat)) sel.value = data.nameidFormat;
            }
          }
          async function doParse(xml) {
            const trimmed = (xml || '').trim();
            if (!trimmed) return;
            const btn = body.querySelector('#w-meta-parse');
            btn.disabled = true; btn.textContent = 'Parsing…';
            try {
              const r = await parseSamlMetadataClient(trimmed);
              await applyMeta(r.data || r);
            } catch (e) {
              if (errEl) errEl.textContent = e.message || 'Could not parse metadata.';
            }
            btn.disabled = false; btn.textContent = 'Parse metadata';
          }
          body.querySelector('#w-meta-parse').addEventListener('click', () =>
            doParse(body.querySelector('#w-meta-paste').value));
          body.querySelector('#w-meta-file').addEventListener('change', async (ev) => {
            const file = ev.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            body.querySelector('#w-meta-paste').value = text;
            await doParse(text);
            ev.target.value = '';
          });
        },
        validate: (_d, body) => {
          const v = (sel) => body.querySelector(sel).value.trim();
          if (!v('#w-name')) return 'Display name is required.';
          if (!v('#w-eid'))  return 'SP Entity ID is required.';
          if (!v('#w-acs'))  return 'ACS URL is required.';
          if (!/^[a-z0-9-]+$/.test(v('#w-slug'))) return 'Slug must use lower-case letters, digits, and hyphens only.';
          try { new URL(v('#w-acs')); } catch { return 'ACS URL must be a valid absolute URL.'; }
          if (v('#w-slo')) { try { new URL(v('#w-slo')); } catch { return 'SLO URL must be a valid absolute URL.'; } }
          return null;
        },
        collect: (d, body) => {
          d.name         = body.querySelector('#w-name').value.trim();
          d.slug         = body.querySelector('#w-slug').value.trim();
          d.entityId     = body.querySelector('#w-eid').value.trim();
          d.acsUrl       = body.querySelector('#w-acs').value.trim();
          d.sloUrl       = body.querySelector('#w-slo').value.trim();
          d.nameidFormat = body.querySelector('#w-nid').value;
        },
      },
      {
        id: 'review', label: 'Activate',
        finishLabel: '✓ Activate Integration',
        render: (d) => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">Review the values below — they will be saved as a SAML application.</p>
          <div class="card">
            <div class="kv"><div class="k">Name</div><div class="v">${esc(d.name)}</div></div>
            <div class="kv"><div class="k">Slug</div><div class="v"><code>${esc(d.slug)}</code></div></div>
            <div class="kv"><div class="k">SP Entity ID</div><div class="v truncate" title="${esc(d.entityId)}">${esc(d.entityId)}</div></div>
            <div class="kv"><div class="k">ACS URL</div><div class="v truncate" title="${esc(d.acsUrl)}">${esc(d.acsUrl)}</div></div>
            ${d.sloUrl ? `<div class="kv"><div class="k">SLO URL</div><div class="v truncate" title="${esc(d.sloUrl)}">${esc(d.sloUrl)}</div></div>` : ''}
            <div class="kv"><div class="k">NameID Format</div><div class="v"><code>${esc((d.nameidFormat||'').split(':').pop())}</code></div></div>
          </div>
        `,
      },
    ],
    onFinish: async (d, bd) => {
      await api.createSamlApp({
        name:         d.name,
        slug:         d.slug,
        entityId:     d.entityId,
        acsUrl:       d.acsUrl,
        sloUrl:       d.sloUrl || undefined,
        nameidFormat: d.nameidFormat,
      });
      bd.querySelector('.wizard-stepper').style.display = 'none';
      bd.querySelector('#wiz-body').innerHTML = `
        <div class="wizard-success">
          <div class="check-circle">${svgIcon('check')}</div>
          <h3>${esc(d.name)} is connected</h3>
          <p class="muted">Users with access can now launch ${esc(d.name)} via SSO.</p>
          <a href="/saml/launch/${esc(d.slug)}" target="_blank" class="btn btn-primary">Test SSO Launch →</a>
        </div>
      `;
      bd.querySelector('#wiz-back').style.display = 'none';
      bd.querySelector('#wiz-next').style.display = 'none';
      const cancel = bd.querySelector('#wiz-cancel');
      cancel.textContent = 'Done';
      cancel.classList.replace('btn-secondary', 'btn-primary');
      // Reload the Applications tab if visible so the new app appears
      cancel.addEventListener('click', () => {
        if (window.LILG_NAV) window.LILG_NAV('applications', { tab: 'saml' });
      }, { once: true });
    },
  });
}

// OIDC integration wizard — 4 steps: Overview, Redirect URIs, Advanced, Review
function openOidcWizard(app, opts = {}) {
  const origin = window.location.origin;
  const idpIssuer     = origin;
  const idpDiscovery  = `${origin}/.well-known/openid-configuration`;
  const idpAuthorize  = `${origin}/oauth/authorize`;
  const idpToken      = `${origin}/oauth/token`;
  const idpUserinfo   = `${origin}/oauth/userinfo`;
  const idpJwks       = `${origin}/.well-known/jwks.json`;
  const tips = vendorTips(app.id, app);

  const allowedScopes = new Set(['openid', 'email', 'profile']);
  const allowedGrants = new Set(['authorization_code', 'refresh_token']);
  const initial = {
    name:           app.name,
    catalog_slug:   app.id,
    category:       app.cat,
    redirectsRaw:   '',
    grants:         (app.grants || ['authorization_code', 'refresh_token']).filter((g) => allowedGrants.has(g)),
    scopes:         (app.scopes || ['openid', 'email', 'profile']).filter((s) => allowedScopes.has(s)),
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
  };
  if (!initial.scopes.includes('openid')) initial.scopes.unshift('openid');
  if (!initial.grants.length) initial.grants = ['authorization_code', 'refresh_token'];

  runWizard({
    title:    `Add ${app.name}`,
    subtitle: `${app.cat || 'Pre-built integration'} · OIDC / OAuth 2.0`,
    vendor:   app,
    initialData: initial,
    steps: [
      {
        id: 'overview', label: 'Overview',
        render: () => `
          <div class="info-box">
            <strong>Integration steps</strong>
            <ol class="wiz-tip-list">
              <li>In ${esc(app.name)}, open OAuth / OpenID Connect settings and paste the <strong>Discovery URL</strong> from the next step.</li>
              <li>Copy ${esc(app.name)}'s <strong>redirect URI</strong> and paste it in step 3.</li>
              <li>Finish registration — this IdP creates a <strong>Client ID</strong> and <strong>Client Secret</strong>. Paste both into ${esc(app.name)}. The secret is shown only once.</li>
            </ol>
          </div>
          ${tips.setupSteps?.length ? `
            <h3 style="font-size:0.95rem;margin:1.25rem 0 0.5rem">Vendor notes</h3>
            <ol class="wiz-tip-list">
              ${tips.setupSteps.map((s) => `<li>${s}</li>`).join('')}
            </ol>` : ''}
          ${tips.docsUrl ? `<p style="font-size:0.85rem;margin-top:1rem"><a href="${esc(tips.docsUrl)}" target="_blank" rel="noopener">${esc(app.name)} documentation →</a></p>` : ''}
        `,
      },
      {
        id: 'idp', label: 'IdP Details',
        render: () => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
            Paste the Discovery URL into <strong>${esc(app.name)}</strong>. Most apps load the remaining endpoints automatically.
          </p>
          <div class="form-group">
            <label class="form-label">Discovery URL</label>
            ${readonlyInput(idpDiscovery, 'oidc-disc')}
          </div>
          <div class="form-group">
            <label class="form-label">Issuer</label>
            ${readonlyInput(idpIssuer, 'oidc-iss')}
          </div>
          <details class="oidc-more-endpoints" style="margin-top:0.75rem">
            <summary style="cursor:pointer;font-size:0.85rem;font-weight:600;color:var(--text-muted)">Additional endpoints</summary>
            <div style="margin-top:0.85rem;display:grid;gap:0.75rem">
              <div class="form-group" style="margin:0">
                <label class="form-label">Authorization</label>
                ${readonlyInput(idpAuthorize, 'oidc-authz')}
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Token</label>
                ${readonlyInput(idpToken, 'oidc-token')}
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">UserInfo</label>
                ${readonlyInput(idpUserinfo, 'oidc-userinfo')}
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">JWKS</label>
                ${readonlyInput(idpJwks, 'oidc-jwks')}
              </div>
            </div>
          </details>
        `,
      },
      {
        id: 'redirects', label: 'Redirect URIs',
        render: (d) => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
            Enter the callback URL(s) from ${esc(app.name)} — one per line.
          </p>
          <div class="form-group">
            <label class="form-label">Redirect URIs <span style="color:var(--danger)">*</span></label>
            <textarea class="form-textarea" id="w-uris" rows="4" placeholder="https://app.example.com/callback">${esc(d.redirectsRaw || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Display name</label>
            <input class="form-input" id="w-name" value="${esc(d.name)}">
          </div>
        `,
        validate: (_d, body) => {
          if (!body.querySelector('#w-name').value.trim()) return 'Display name is required.';
          const lines = body.querySelector('#w-uris').value
            .split('\n').map((s) => s.trim()).filter(Boolean);
          if (!lines.length) return 'At least one redirect URI is required.';
          for (const line of lines) {
            try { new URL(line); }
            catch { return `Invalid URL: ${line}`; }
          }
          return null;
        },
        collect: (d, body) => {
          d.name = body.querySelector('#w-name').value.trim();
          d.redirectsRaw = body.querySelector('#w-uris').value;
        },
      },
      {
        id: 'advanced', label: 'Advanced',
        render: (d) => {
          const grant = (id) => d.grants.includes(id) ? 'checked' : '';
          const scope = (id) => d.scopes.includes(id) ? 'checked' : '';
          return `
            <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
              Defaults suit most applications. Change only if ${esc(app.name)} requires different settings.
            </p>
            <div class="form-2col">
              <div class="form-group">
                <label class="form-label">Grant types</label>
                <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-code" ${grant('authorization_code')}><label for="gt-code">authorization_code</label></div>
                <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-refresh" ${grant('refresh_token')}><label for="gt-refresh">refresh_token</label></div>
              </div>
              <div class="form-group">
                <label class="form-label">Scopes</label>
                ${['openid','email','profile'].map((s) => `
                  <div class="form-check-row"><input type="checkbox" class="form-check" id="sc-${s}" ${scope(s)}><label for="sc-${s}">${esc(s)}</label></div>
                `).join('')}
              </div>
              <div class="form-group span2">
                <label class="form-label">Client authentication</label>
                <select class="form-select" id="w-tea">
                  <option value="client_secret_basic">Client secret (Basic) — recommended</option>
                  <option value="client_secret_post">Client secret (POST body)</option>
                  <option value="none">None (public client + PKCE)</option>
                </select>
              </div>
            </div>
          `;
        },
        bind: (body, d) => {
          body.querySelector('#w-tea').value = d.token_endpoint_auth_method;
        },
        validate: (_d, body) => {
          if (!body.querySelector('#gt-code').checked && !body.querySelector('#gt-refresh').checked) {
            return 'Select at least one grant type.';
          }
          if (!body.querySelector('#sc-openid').checked) {
            return 'The openid scope is required.';
          }
          return null;
        },
        collect: (d, body) => {
          d.grants = [];
          if (body.querySelector('#gt-code').checked)    d.grants.push('authorization_code');
          if (body.querySelector('#gt-refresh').checked) d.grants.push('refresh_token');
          d.scopes = ['openid', 'email', 'profile']
            .filter((s) => body.querySelector('#sc-' + s).checked);
          d.token_endpoint_auth_method = body.querySelector('#w-tea').value;
        },
      },
      {
        id: 'review', label: 'Activate',
        finishLabel: 'Register app',
        render: (d) => {
          const uris = (d.redirectsRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
          return `
            <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
              Confirm the configuration. Registration generates a Client ID and Client Secret for you to paste into ${esc(app.name)}.
            </p>
            <div class="ent-panel">
              <div class="kv-list">
                <div class="kv"><div class="k">Name</div><div class="v">${esc(d.name)}</div></div>
                <div class="kv"><div class="k">Redirect URIs</div><div class="v" style="word-break:break-all">${uris.map((u) => `<code style="font-size:0.78rem;display:block">${esc(u)}</code>`).join('') || '—'}</div></div>
                <div class="kv"><div class="k">Grant types</div><div class="v">${esc(d.grants.join(', ') || '—')}</div></div>
                <div class="kv"><div class="k">Scopes</div><div class="v">${esc(d.scopes.join(', ') || '—')}</div></div>
                <div class="kv"><div class="k">Token auth</div><div class="v"><code>${esc(d.token_endpoint_auth_method)}</code></div></div>
              </div>
            </div>
          `;
        },
      },
    ],
    onFinish: async (d, bd) => {
      const result = await api.createOidcClient({
        name:           d.name,
        redirect_uris:  (d.redirectsRaw || '').split('\n').map((s) => s.trim()).filter(Boolean),
        grant_types:    d.grants,
        scopes:         d.scopes,
        response_types: ['code'],
        token_endpoint_auth_method: d.token_endpoint_auth_method,
        catalog_slug:   d.catalog_slug,
        category:       d.category,
      });
      bd.querySelector('.wizard-stepper').style.display = 'none';
      bd.querySelector('#wiz-body').innerHTML = `
        <div class="wizard-success">
          <div class="check-circle">${svgIcon('check')}</div>
          <h3>${esc(d.name)} registered</h3>
          <p class="muted">Share these values with ${esc(app.name)}. The client secret is shown only once.</p>
        </div>
        <div class="form-group">
          <label class="form-label">Discovery URL</label>
          ${readonlyInput(idpDiscovery, 'r-disc')}
        </div>
        <div class="form-group">
          <label class="form-label">Client ID</label>
          ${readonlyInput(result.client_id, 'r-cid')}
        </div>
        <div class="form-group">
          <label class="form-label">Client Secret</label>
          ${readonlyInput(result.client_secret, 'r-csec')}
        </div>
      `;
      wireCopyButtons(bd.querySelector('#wiz-body'));
      bd.querySelector('#wiz-back').style.display = 'none';
      bd.querySelector('#wiz-next').style.display = 'none';
      const cancel = bd.querySelector('#wiz-cancel');
      cancel.textContent = 'Done';
      cancel.classList.replace('btn-secondary', 'btn-primary');
      cancel.addEventListener('click', () => {
        if (opts.onDone) opts.onDone();
        else if (window.LILG_NAV) window.LILG_NAV('applications', { tab: 'oidc' });
      }, { once: true });
    },
  });
}

// ─── 8. OIDC / OAuth Applications ────────────────────────────────────────────
export async function viewOidcApps(content, opts = {}) {
  const embed = !!opts.embed;
  const origin = window.location.origin;
  const discoveryUrl = `${origin}/.well-known/openid-configuration`;
  const actionBtn = `<button class="btn btn-primary" id="new-oidc-btn">+ Register OAuth / OIDC app</button>`;
  content.replaceChildren(el(`<div>
    ${embed
      ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;margin-bottom:0.75rem;flex-wrap:wrap">
           <p class="muted" style="margin:0;font-size:0.85rem;flex:1;min-width:220px">Register OAuth 2.0 / OpenID Connect apps that use this IdP as the authorization server (Client ID + Secret).</p>
           ${actionBtn}
         </div>`
      : header('OIDC / OAuth', 'Register applications that sign in through this Identity Provider', actionBtn)}

    <div class="ent-panel" style="margin-bottom:1.25rem">
      <div class="card-head"><h2 style="margin:0;font-size:1rem">Issuer</h2></div>
      <div class="card-body">
        <p class="muted" style="font-size:0.85rem;margin:0 0 0.75rem">
          Give this Discovery URL to the application, together with the Client ID and Client Secret created at registration.
          Or use <strong>Pre-built Integrations</strong> and filter <em>OIDC / OAuth</em>.
        </p>
        ${readonlyInput(discoveryUrl, 'oidc-page-disc')}
      </div>
    </div>

    <div id="list-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;
  wireCopyButtons(wrap);

  wrap.querySelector('#new-oidc-btn')?.addEventListener('click', () => {
    const app = SSO_CATALOG.find((a) => a.id === 'custom-oidc');
    if (app) {
      openOidcWizard(app, {
        onDone: async () => {
          await load();
          wrap.querySelector('#list-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      });
    }
  });

  async function load() {
    try {
      const r = await api.listOidcClients();
      const clients = Array.isArray(r) ? r : (r && r.data ? r.data : []);
      const rows = clients.length ? clients.map((c) => `
        <tr>
          <td><span class="cell-strong">${esc(c.name || c.client_name || '—')}</span></td>
          <td><code style="font-size:0.75rem;user-select:all">${esc(c.client_id)}</code></td>
          <td class="muted" style="font-size:0.8rem">${esc(parseJsonArr(c.grant_types).join(', ') || '—')}</td>
          <td class="muted" style="font-size:0.8rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="${esc(parseJsonArr(c.redirect_uris).join(', '))}">${esc(parseJsonArr(c.redirect_uris).join(', ') || '—')}</td>
          <td>${c.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td class="actions" style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary edit-oidc" data-id="${esc(String(c.id))}">Edit</button>
            <button class="btn btn-sm btn-secondary rotate-oidc" data-id="${esc(String(c.id))}" data-name="${esc(c.name || c.client_name || '')}">Rotate secret</button>
            <button class="btn btn-sm btn-danger del-oidc" data-id="${esc(String(c.id))}">Delete</button>
          </td>
        </tr>`).join('')
        : `<tr><td colspan="6"><div class="empty-state"><p>No applications registered yet.</p><p class="muted" style="font-size:0.85rem">Register an app to create a Client ID and Client Secret.</p></div></td></tr>`;

      wrap.querySelector('#list-area').innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.75rem">
          <h2 style="margin:0;font-size:1.05rem;font-weight:700">Registered applications
            ${clients.length ? `<span class="badge badge-info" style="font-size:0.75rem;margin-left:0.35rem">${clients.length}</span>` : ''}
          </h2>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Client ID</th><th>Grants</th><th>Redirect URIs</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;

      wrap.querySelectorAll('.del-oidc').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this OIDC application?')) return;
          try { await api.deleteOidcClient(btn.dataset.id); await load(); } catch (e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.rotate-oidc').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Rotate the client secret for "${btn.dataset.name}"? The current secret will stop working immediately.`)) return;
          try {
            const result = await api.rotateOidcSecret(btn.dataset.id);
            showSecretModal(null, result.client_secret, async () => await load());
          } catch (e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-oidc').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const c = await api.getOidcClient(btn.dataset.id);
            openEditOidcModal(c, async () => await load());
          } catch (e) { alert(e.message); }
        });
      });
    } catch (e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openEditOidcModal(c, onDone) {
    const uris = parseJsonArr(c.redirect_uris).join('\n');
    const scopes = parseJsonArr(c.scopes).join(' ');
    const grants = parseJsonArr(c.grant_types);
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Edit application</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Display name</label>
          <input class="form-input" id="e-name" value="${esc(c.name || '')}"></div>
        <div class="form-group"><label class="form-label">Client ID</label>
          <input class="form-input" value="${esc(c.client_id)}" readonly onclick="this.select()"></div>
        <div class="form-group"><label class="form-label">Redirect URIs <span class="muted" style="font-weight:400">(one per line)</span></label>
          <textarea class="form-textarea" id="e-uris" rows="4">${esc(uris)}</textarea></div>
        <div class="form-group"><label class="form-label">Scopes</label>
          <input class="form-input" id="e-scopes" value="${esc(scopes || 'openid email profile')}"></div>
        <div class="form-group"><label class="form-label">Grant types</label>
          <label class="form-check-row"><input type="checkbox" id="e-g-code" ${grants.includes('authorization_code') ? 'checked' : ''}> authorization_code</label>
          <label class="form-check-row"><input type="checkbox" id="e-g-refresh" ${grants.includes('refresh_token') ? 'checked' : ''}> refresh_token</label>
        </div>
        <div class="form-group"><label class="form-label">Status</label>
          <select class="form-select" id="e-active">
            <option value="1" ${c.active ? 'selected' : ''}>Active</option>
            <option value="0" ${!c.active ? 'selected' : ''}>Off</option>
          </select></div>
        <div id="e-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="e-cancel">Cancel</button>
        <button class="btn btn-primary" id="e-save">Save</button>
      </div>
    </div>`);
    bd.querySelector('#e-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#e-save').addEventListener('click', async () => {
      const errEl = bd.querySelector('#e-err');
      errEl.innerHTML = '';
      const redirect_uris = bd.querySelector('#e-uris').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const scopesArr = bd.querySelector('#e-scopes').value.trim().split(/\s+/).filter(Boolean);
      const grant_types = [];
      if (bd.querySelector('#e-g-code').checked) grant_types.push('authorization_code');
      if (bd.querySelector('#e-g-refresh').checked) grant_types.push('refresh_token');
      if (!redirect_uris.length) { errEl.innerHTML = `<div class="alert alert-error">At least one redirect URI is required.</div>`; return; }
      if (!scopesArr.includes('openid')) { errEl.innerHTML = `<div class="alert alert-error">Scopes must include openid.</div>`; return; }
      try {
        await api.updateOidcClient(c.id, {
          name: bd.querySelector('#e-name').value.trim(),
          redirect_uris,
          scopes: scopesArr,
          grant_types,
          active: Number(bd.querySelector('#e-active').value),
        });
        bd.remove();
        if (onDone) onDone();
      } catch (e) {
        errEl.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
      }
    });
  }

  function parseJsonArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }

  function showSecretModal(clientId, secret, onDone) {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>New client secret</h2></div>
      <div class="modal-body">
        <div class="alert alert-warning" style="margin-bottom:1rem">Copy and store this secret now. It will not be shown again.</div>
        ${clientId ? `<div class="form-group"><label class="form-label">Client ID</label><input class="form-input" value="${esc(clientId)}" readonly onclick="this.select()"></div>` : ''}
        <div class="form-group"><label class="form-label">Client Secret</label>
          <input class="form-input" id="secret-val" value="${esc(secret || '')}" readonly onclick="this.select()" style="font-family:var(--font-mono)"></div>
        <button type="button" class="btn btn-secondary btn-sm" id="secret-copy">Copy secret</button>
      </div>
      <div class="modal-footer"><button class="btn btn-primary" id="sec-done">Done</button></div>
    </div>`);
    bd.querySelector('#secret-copy')?.addEventListener('click', () => {
      const val = bd.querySelector('#secret-val')?.value || '';
      navigator.clipboard?.writeText(val);
      bd.querySelector('#secret-copy').textContent = 'Copied';
    });
    bd.querySelector('#sec-done').addEventListener('click', () => { bd.remove(); if (onDone) onDone(); });
  }

  await load();
}

// ─── 8b. Pre-built Integrations ───────────────────────────────────────────────
export async function viewPrebuiltApps(content, opts = {}) {
  const embed = !!opts.embed;
  content.replaceChildren(el(`<div>
    ${embed ? '' : header('Pre-built Integrations', `${SSO_CATALOG.length} integrations — click any card to auto-configure`)}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <div>
        <h2 style="margin:0;font-size:1.05rem;font-weight:700">Pre-built Integrations</h2>
        <p class="muted" style="margin:0.2rem 0 0;font-size:0.82rem">
          ${SSO_CATALOG.length} integrations — click to auto-configure
        </p>
      </div>
      <div style="display:flex;gap:0.6rem;align-items:center">
        <input class="form-input" id="pbi-search" placeholder="Search integrations…" style="max-width:220px">
      </div>
    </div>
    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.65rem" id="pbi-proto-filters">
      ${[['All','All protocols'],['SAML','SAML'],['OIDC','OIDC / OAuth']].map(([id, label]) =>
        `<button type="button" class="btn btn-sm ${id==='All'?'btn-primary':'btn-secondary'} pbi-proto" data-proto="${esc(id)}">${esc(label)}</button>`
      ).join('')}
    </div>
    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem" id="pbi-filters">
      ${['All',...new Set(SSO_CATALOG.map(a=>a.cat))].map(c =>
        `<button class="btn btn-sm ${c==='All'?'btn-primary':'btn-secondary'} pbi-filter" data-cat="${esc(c)}">${esc(c)}</button>`
      ).join('')}
    </div>
    <div id="pbi-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:0.85rem"></div>
  </div>`));
  const wrap = content.firstChild;

  const ICON_COLOURS = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#6366f1'];
  function catalogIcon(app) {
    const bg = ICON_COLOURS[(app.name||' ').charCodeAt(0) % ICON_COLOURS.length];
    const letter = esc((app.name||'?')[0].toUpperCase());
    return `<div style="width:34px;height:34px;border-radius:8px;background:${bg};
      color:#fff;font-weight:700;font-size:0.9rem;display:flex;align-items:center;
      justify-content:center;flex-shrink:0">${letter}</div>`;
  }

  let activeCat = 'All';
  let activeProto = 'All';
  let searchQ   = '';

  function renderGrid() {
    const q = searchQ.toLowerCase();
    const visible = SSO_CATALOG.filter(a =>
      (activeCat === 'All' || a.cat === activeCat) &&
      (activeProto === 'All' || a.protocol === activeProto) &&
      (!q || a.name.toLowerCase().includes(q) || a.cat.toLowerCase().includes(q) || a.protocol.toLowerCase().includes(q))
    );

    wrap.querySelector('#pbi-grid').innerHTML = visible.map(app => `
      <div class="card" style="padding:1rem;cursor:default;position:relative">
        <div style="display:flex;align-items:center;gap:0.65rem;margin-bottom:0.6rem">
          ${catalogIcon(app)}
          <div>
            <div style="font-weight:600;font-size:0.875rem;line-height:1.2">${esc(app.name)}</div>
            <span class="badge ${app.protocol==='OIDC'?'badge-info':'badge-warning'}" style="font-size:0.62rem">${esc(app.protocol === 'OIDC' ? 'OIDC / OAuth' : app.protocol)}</span>
          </div>
        </div>
        <div class="muted" style="font-size:0.72rem;margin-bottom:0.65rem;line-height:1.45;min-height:2.5em">${esc((app.hint||'').slice(0,80))}${(app.hint||'').length>80?'…':''}</div>
        <button class="btn btn-primary btn-sm" style="width:100%;font-size:0.78rem" data-app="${esc(app.id)}">+ Add</button>
      </div>`).join('')
      || `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><p>No integrations match "${esc(searchQ)}"</p></div>`;

    wrap.querySelectorAll('[data-app]').forEach(btn => {
      btn.addEventListener('click', () => {
        const app = SSO_CATALOG.find(a => a.id === btn.dataset.app);
        if (!app) return;
        if (app.protocol === 'SAML') openSamlWizard(app);
        else                          openOidcWizard(app);
      });
    });
  }

  wrap.querySelector('#pbi-search').addEventListener('input', e => { searchQ = e.target.value; renderGrid(); });
  persistSearch(wrap.querySelector('#pbi-search'), 'integrations');
  wrap.querySelectorAll('.pbi-proto').forEach(btn => {
    btn.addEventListener('click', () => {
      activeProto = btn.dataset.proto;
      wrap.querySelectorAll('.pbi-proto').forEach(b => {
        b.classList.toggle('btn-primary',   b.dataset.proto === activeProto);
        b.classList.toggle('btn-secondary', b.dataset.proto !== activeProto);
      });
      renderGrid();
    });
  });
  wrap.querySelectorAll('.pbi-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCat = btn.dataset.cat;
      wrap.querySelectorAll('.pbi-filter').forEach(b => {
        b.classList.toggle('btn-primary',   b.dataset.cat === activeCat);
        b.classList.toggle('btn-secondary', b.dataset.cat !== activeCat);
      });
      renderGrid();
    });
  });

  if (!wrap.querySelector('#pbi-search').value) renderGrid();
}

// ─── 9. App Discovery ─────────────────────────────────────────────────────────
export async function viewAppDiscovery(content, opts = {}) {
  const embed = !!opts.embed;
  const actions = `<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
    <button class="btn btn-primary" id="disc-ext-scan" disabled title="Install / enable the App Discovery extension (v1.2+)">Scan from browser</button>
    <button class="btn btn-secondary" id="disc-scan">Run Discovery Scan</button>
    <button class="btn btn-primary" id="disc-add">+ Add App</button>
  </div>`;
  content.replaceChildren(el(`<div class="disc-page">
    ${embed
      ? `<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">${actions}</div>`
      : header('App Discovery', 'Inventory from browser history / portal signals + manual findings', actions)}
    <div id="disc-stats" class="stat-grid" style="margin-bottom:1rem">${loading()}</div>
    <div class="card" style="margin-bottom:1rem;padding:0.85rem 1rem">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
        <div>
          <strong>Browser extension</strong>
          <span id="disc-ext-status" class="muted" style="margin-left:0.5rem;font-size:0.85rem">Checking…</span>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <a class="btn btn-secondary btn-sm" href="/extension/app-discovery.zip" download="lilg-app-discovery-extension.zip">Download v1.2</a>
          <button class="btn btn-primary btn-sm" id="disc-ext-scan-2" disabled>Scan from browser</button>
        </div>
      </div>
    </div>
    <div class="card ra-filter-card" style="margin-bottom:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center">
      <input class="form-input" id="disc-q" placeholder="Search name or domain…" style="flex:1;min-width:180px">
      <select class="form-select" id="disc-status" style="width:auto">
        <option value="all" selected>All statuses</option>
        <option value="NEW">New</option>
        <option value="REVIEWING">Reviewing</option>
        <option value="SANCTIONED">Sanctioned</option>
        <option value="IGNORED">Ignored</option>
      </select>
      <select class="form-select" id="disc-source" style="width:auto">
        <option value="all">All sources</option>
        <option value="BROWSER">Browser signal</option>
        <option value="MANUAL">Manual</option>
        <option value="IMPORT">Import</option>
        <option value="CATALOG_GAP">Catalog gap (legacy)</option>
      </select>
    </div>
    <div id="disc-msg"></div>
    <div id="disc-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;

  const riskBadge = (r) => {
    const m = { HIGH: 'badge-danger', MEDIUM: 'badge-warning', LOW: 'badge-success', UNKNOWN: 'badge-neutral' };
    return `<span class="badge ${m[r] || 'badge-neutral'}">${esc(r || 'UNKNOWN')}</span>`;
  };
  const statusBadge = (s) => {
    const m = { NEW: 'badge-warning', REVIEWING: 'badge-info', SANCTIONED: 'badge-success', IGNORED: 'badge-neutral' };
    return `<span class="badge ${m[s] || 'badge-neutral'}">${esc(s || '—')}</span>`;
  };
  const sourceLabel = (s) => ({ BROWSER: 'Browser', CATALOG_GAP: 'Catalog gap', SSO_SIGNAL: 'SSO signal', MANUAL: 'Manual', IMPORT: 'Import' }[s] || s);

  async function loadStats() {
    try {
      const s = await api.discoveryStats();
      wrap.querySelector('#disc-stats').innerHTML = [
        statCard('search', 'Discovered', s.total ?? 0, 'in inventory', 'primary'),
        statCard('alert', 'New', s.newCount ?? 0, 'awaiting review', 'warning'),
        statCard('shield', 'High risk', s.highRisk ?? 0, 'new / reviewing', 'danger'),
        statCard('check', 'Sanctioned', s.sanctioned ?? 0, 'in catalog / accepted', 'success'),
      ].join('');
    } catch {
      wrap.querySelector('#disc-stats').innerHTML = '';
    }
  }

  async function loadList() {
    const area = wrap.querySelector('#disc-area');
    area.innerHTML = loading();
    try {
      const status = wrap.querySelector('#disc-status').value;
      const source = wrap.querySelector('#disc-source').value;
      const q = wrap.querySelector('#disc-q').value.trim();
      const r = await api.listDiscoveredApps({
        status: status === 'all' ? '' : status,
        source: source === 'all' ? '' : source,
        q,
        limit: '200',
      });
      const rows = r.data || [];
      if (!rows.length) {
        area.innerHTML = `<div class="empty-state">
          <div class="empty-icon">🔍</div>
          <p>No discovered apps for this filter.</p>
          <p class="muted" style="font-size:0.85rem;margin-top:0.5rem;max-width:28rem">
            Install the browser history extension (instructions above), scan while signed in, then
            <strong>Run Discovery Scan</strong> — or <strong>+ Add App</strong> manually.
            HTTP disk cache is not readable; history is used instead.
          </p>
        </div>`;
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table>
        <thead><tr>
          <th>Application</th><th>Domain</th><th>Category</th><th>Source</th>
          <th>Risk</th><th>Status</th><th>Signal</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows.map(d => `<tr data-id="${esc(d.id)}">
          <td class="cell-strong">${esc(d.name)}${d.linked_app_name ? `<div class="muted" style="font-size:0.75rem">→ ${esc(d.linked_app_name)}</div>` : ''}</td>
          <td><code style="font-size:0.78rem">${esc(d.domain)}</code></td>
          <td class="muted">${esc(d.category || '—')}</td>
          <td><span class="badge badge-info">${esc(sourceLabel(d.source))}</span></td>
          <td>${riskBadge(d.risk_level)}</td>
          <td>${statusBadge(d.status)}</td>
          <td class="muted" style="font-size:0.8rem">${Number(d.hit_count) || 0} hits · ${Number(d.user_count) || 0} users<br><span style="font-size:0.72rem">${d.last_seen_at ? fmtDate(d.last_seen_at) : '—'}</span></td>
          <td style="white-space:nowrap">
            ${d.status !== 'SANCTIONED' && !d.linked_app_id ? `<button class="btn btn-sm btn-primary disc-promote" data-id="${esc(d.id)}" title="Add to Application Catalog">Promote</button>` : ''}
            ${d.status === 'NEW' ? `<button class="btn btn-sm btn-secondary disc-review" data-id="${esc(d.id)}">Review</button>` : ''}
            ${d.status !== 'IGNORED' ? `<button class="btn btn-sm btn-secondary disc-ignore" data-id="${esc(d.id)}">Ignore</button>` : `<button class="btn btn-sm btn-secondary disc-reopen" data-id="${esc(d.id)}">Reopen</button>`}
            <button class="btn btn-sm btn-danger disc-del" data-id="${esc(d.id)}">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`;

      area.querySelectorAll('.disc-promote').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Promote this app into the Application Catalog as RESTRICTED? You can then register SAML/OIDC.')) return;
          btn.disabled = true;
          try {
            const r = await api.promoteDiscoveredApp(btn.dataset.id);
            wrap.querySelector('#disc-msg').innerHTML = `<div class="alert alert-success">Promoted as catalog slug <code>${esc(r.slug)}</code>. Open Applications → Catalog / SAML to finish SSO setup.</div>`;
            await loadStats(); await loadList();
          } catch (e) { alert(e.message); btn.disabled = false; }
        });
      });
      area.querySelectorAll('.disc-review').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api.updateDiscoveredApp(btn.dataset.id, { status: 'REVIEWING' }); await loadStats(); await loadList(); }
          catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.disc-ignore').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api.updateDiscoveredApp(btn.dataset.id, { status: 'IGNORED' }); await loadStats(); await loadList(); }
          catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.disc-reopen').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api.updateDiscoveredApp(btn.dataset.id, { status: 'NEW' }); await loadStats(); await loadList(); }
          catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.disc-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this discovery record?')) return;
          try { await api.deleteDiscoveredApp(btn.dataset.id); await loadStats(); await loadList(); }
          catch (e) { alert(e.message); }
        });
      });
    } catch (e) {
      area.innerHTML = errHtml(e.message);
    }
  }

  function openAddModal() {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Add discovered app</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="da-name" placeholder="e.g. Notion"></div>
      <div class="form-group"><label class="form-label">Domain</label><input class="form-input" id="da-domain" placeholder="e.g. notion.so"></div>
      <div class="form-group"><label class="form-label">Category</label><input class="form-input" id="da-cat" placeholder="e.g. Knowledge"></div>
      <div class="form-group"><label class="form-label">Risk</label>
        <select class="form-select" id="da-risk"><option value="UNKNOWN">Unknown</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="da-notes" rows="2" placeholder="How was this found?"></textarea></div>
      <div id="da-err"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="da-save">Save</button>
      <button class="btn btn-secondary" id="da-cancel">Cancel</button>
    </div></div>`);
    bd.querySelector('#da-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#da-save').addEventListener('click', async () => {
      const name = bd.querySelector('#da-name').value.trim();
      const domain = bd.querySelector('#da-domain').value.trim();
      if (!name || !domain) { bd.querySelector('#da-err').innerHTML = errHtml('Name and domain are required'); return; }
      try {
        await api.createDiscoveredApp({
          name, domain,
          category: bd.querySelector('#da-cat').value.trim() || null,
          riskLevel: bd.querySelector('#da-risk').value,
          notes: bd.querySelector('#da-notes').value.trim() || null,
        });
        bd.remove(); await loadStats(); await loadList();
      } catch (e) { bd.querySelector('#da-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#disc-add')?.addEventListener('click', openAddModal);

  function setExtStatus(text, ready) {
    const el = wrap.querySelector('#disc-ext-status');
    if (el) el.textContent = text;
    wrap.querySelectorAll('#disc-ext-scan, #disc-ext-scan-2').forEach((b) => {
      b.disabled = !ready;
      if (ready) b.removeAttribute('title');
      else b.title = 'Install App Discovery extension v1.2+, then reload this page';
    });
  }

  function waitExtMessage(type, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('Extension did not respond. Reload the extension (chrome://extensions → Reload) and refresh this page.'));
      }, timeoutMs);
      function onMsg(ev) {
        if (ev.source !== window || ev.data?.source !== 'lilg-extension') return;
        if (ev.data.type !== type) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(ev.data.payload || ev.data);
      }
      window.addEventListener('message', onMsg);
    });
  }

  async function runExtScan() {
    const btns = [...wrap.querySelectorAll('#disc-ext-scan, #disc-ext-scan-2')];
    btns.forEach((b) => { b.disabled = true; b.textContent = 'Scanning…'; });
    wrap.querySelector('#disc-msg').innerHTML = '<div class="alert alert-info">Asking the browser extension to scan history…</div>';
    try {
      const resultPromise = waitExtMessage('LILG_DISCOVERY_SCAN_RESULT');
      window.postMessage({ source: 'lilg-idp', type: 'LILG_DISCOVERY_SCAN' }, '*');
      const res = await resultPromise;
      const r = res?.result || res || {};
      if (r.ok === false || (res?.result && res.result.ok === false)) {
        throw new Error(r.error || res?.result?.error || 'Extension scan failed');
      }
      const body = res?.result || r;
      wrap.querySelector('#disc-msg').innerHTML = `<div class="alert alert-success">
        Browser scan finished — <strong>${res.domains ?? 0}</strong> domains found,
        uploaded <strong>${body.accepted ?? 0}</strong>,
        inventory <strong>${body.inventoryCreated ?? 0}</strong> new /
        <strong>${body.inventoryUpdated ?? 0}</strong> updated
        ${body.catalogMatched ? ` · ${body.catalogMatched} already in catalog` : ''}.
      </div>`;
      wrap.querySelector('#disc-source').value = 'BROWSER';
      await loadStats(); await loadList();
    } catch (e) {
      wrap.querySelector('#disc-msg').innerHTML = errHtml(e.message);
    }
    btns.forEach((b) => { b.textContent = 'Scan from browser'; b.disabled = false; });
  }

  wrap.querySelector('#disc-ext-scan')?.addEventListener('click', () => { void runExtScan(); });
  wrap.querySelector('#disc-ext-scan-2')?.addEventListener('click', () => { void runExtScan(); });

  // Detect extension content-script
  {
    let detected = false;
    const onPong = (ev) => {
      if (ev.source !== window || ev.data?.source !== 'lilg-extension') return;
      if (ev.data.type !== 'LILG_DISCOVERY_PONG') return;
      detected = true;
      setExtStatus(`Connected (v${ev.data.version || '?'})`, true);
    };
    window.addEventListener('message', onPong);
    window.postMessage({ source: 'lilg-idp', type: 'LILG_DISCOVERY_PING' }, '*');
    setTimeout(() => {
      if (!detected) setExtStatus('Not detected — download v1.2, Load unpacked, then refresh this page', false);
    }, 1200);
  }

  wrap.querySelector('#disc-scan')?.addEventListener('click', async () => {
    const btn = wrap.querySelector('#disc-scan');
    btn.disabled = true; btn.textContent = 'Scanning…';
    wrap.querySelector('#disc-msg').innerHTML = '';
    try {
      const r = await api.scanDiscoveredApps();
      wrap.querySelector('#disc-msg').innerHTML = `<div class="alert alert-success">
        Scan complete — removed <strong>${r.removedNoise ?? 0}</strong> false positives,
        reconciled <strong>${r.reconciled ?? 0}</strong> with your catalog,
        browser signals: <strong>${r.browserCreated ?? 0}</strong> new / <strong>${r.browserUpdated ?? 0}</strong> updated.
      </div>`;
      await loadStats(); await loadList();
    } catch (e) {
      wrap.querySelector('#disc-msg').innerHTML = errHtml(e.message);
    }
    btn.disabled = false; btn.textContent = 'Run Discovery Scan';
  });

  let searchTimer = null;
  wrap.querySelector('#disc-q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { void loadList(); }, 280);
  });
  wrap.querySelector('#disc-status').addEventListener('change', () => { void loadList(); });
  wrap.querySelector('#disc-source').addEventListener('change', () => { void loadList(); });

  await loadStats();
  await loadList();
}

// ─── 10. Directory Sync ───────────────────────────────────────────────────────
// ─── connector type metadata ─────────────────────────────────────────────────
const GOOGLE_WS_META = {
  label: 'Google Workspace', icon: '🔵', badge: 'badge-success',
  desc: 'Google Workspace / G Suite directory',
  fields: ['customerDomain','serviceAccountEmail','serviceAccountKey','adminEmail','syncOrgUnits','syncGroups','syncGroupMemberships','syncUsers','provisionOrgUnit','includeSubOrgUnits'],
  connectionFields: ['customerDomain','serviceAccountEmail','serviceAccountKey','adminEmail'],
  scopeFields: ['syncOrgUnits','syncGroups','syncUsers','syncGroupMemberships','provisionOrgUnit','includeSubOrgUnits'],
};

function normalizeConnectorType(t) {
  return t === 'GOOGLE' ? 'GOOGLE_WORKSPACE' : t;
}

function parseConnectorScheduleUi(raw) {
  const s = (raw || '').trim();
  if (!s || s.toLowerCase() === 'manual') return { mode: 'every:15m' };
  const every = s.match(/^every:(\d+)(m|h)$/i);
  if (every) {
    const token = `${every[1]}${every[2].toLowerCase()}`;
    const preset = `every:${token}`;
    const presets = ['every:15m', 'every:30m', 'every:1h', 'every:6h', 'every:12h', 'every:24h'];
    if (presets.includes(preset)) return { mode: preset };
    return { mode: 'custom-interval', value: parseInt(every[1], 10), unit: every[2].toLowerCase() };
  }
  const legacy = s.match(/^(\d+)(m|h)$/i);
  if (legacy && !s.includes(' ')) return parseConnectorScheduleUi(`every:${legacy[1]}${legacy[2].toLowerCase()}`);
  if (['15m', '30m', '1h', '6h', '12h', '24h'].includes(s)) return parseConnectorScheduleUi(`every:${s}`);
  if (s.split(/\s+/).length === 5) return { mode: 'custom-cron', cron: s };
  return { mode: 'every:15m' };
}

function formatConnectorScheduleLabel(raw) {
  const s = (raw || '').trim();
  if (!s || s.toLowerCase() === 'manual') return 'Manual';
  const every = s.match(/^every:(\d+)(m|h)$/i);
  if (every) {
    const n = parseInt(every[1], 10);
    const unit = every[2].toLowerCase() === 'h' ? 'hour(s)' : 'minute(s)';
    return `Every ${n} ${unit}`;
  }
  const legacy = s.match(/^(\d+)(m|h)$/i);
  if (legacy && !s.includes(' ')) return formatConnectorScheduleLabel(`every:${legacy[1]}${legacy[2].toLowerCase()}`);
  const parts = s.split(/\s+/);
  if (parts.length === 5 && parts[2] === '*' && parts[1] !== '*' && parts[0] !== '*' && !parts[0].includes('/') && !parts[1].includes('/')) {
    return `Daily at ${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')} UTC`;
  }
  if (parts[0]?.startsWith('*/')) return `Every ${parts[0].slice(2)} minute(s)`;
  if (parts[1]?.startsWith('*/')) return `Every ${parts[1].slice(2)} hour(s)`;
  return s;
}

function renderConnectorScheduleFields(defaults) {
  const ui = parseConnectorScheduleUi(defaults.sync_schedule);
  const presets = [
    ['manual', 'Manual only'],
    ['every:15m', 'Every 15 minutes'],
    ['every:30m', 'Every 30 minutes'],
    ['every:1h', 'Every 1 hour'],
    ['every:6h', 'Every 6 hours'],
    ['every:12h', 'Every 12 hours'],
    ['every:24h', 'Every 24 hours'],
    ['custom-interval', 'Custom interval…'],
    ['custom-cron', 'Custom cron (advanced)…'],
  ];
  const opts = presets.map(([v, l]) => `<option value="${v}" ${ui.mode === v ? 'selected' : ''}>${l}</option>`).join('');
  const showInterval = ui.mode === 'custom-interval';
  const showCron = ui.mode === 'custom-cron';
  const cronVal = showCron ? (ui.cron || '') : (defaults.sync_schedule && String(defaults.sync_schedule).includes(' ') ? defaults.sync_schedule : '0 3 * * *');
  return `
    <div class="form-group" style="grid-column:1/-1">
      <label class="form-label">Sync Schedule</label>
      <select class="form-select" id="cfg-schedule-mode">${opts}</select>
      <p class="muted" style="font-size:0.75rem;margin:0.35rem 0 0">Runs automatically when the connector is Connected. All times are UTC.</p>
    </div>
    <div class="form-group" id="cfg-schedule-interval-wrap" style="grid-column:1/-1;${showInterval ? '' : 'display:none'}">
      <label class="form-label">Custom interval</label>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        <input class="form-input" id="cfg-schedule-interval-val" type="number" min="1" max="10080" value="${showInterval ? (ui.value || 15) : 15}" style="max-width:100px">
        <select class="form-select" id="cfg-schedule-interval-unit" style="max-width:120px">
          <option value="m" ${ui.unit === 'h' ? '' : 'selected'}>Minutes</option>
          <option value="h" ${ui.unit === 'h' ? 'selected' : ''}>Hours</option>
        </select>
      </div>
    </div>
    <div class="form-group" id="cfg-schedule-cron-wrap" style="grid-column:1/-1;${showCron ? '' : 'display:none'}">
      <label class="form-label">Cron expression <span class="muted" style="font-size:0.75rem">(minute hour day month weekday)</span></label>
      <input class="form-input" id="cfg-schedule-cron" value="${esc(cronVal)}" placeholder="0 3 * * *">
    </div>`;
}

function bindConnectorScheduleFields(bd) {
  const mode = bd.querySelector('#cfg-schedule-mode');
  if (!mode) return;
  const intervalWrap = bd.querySelector('#cfg-schedule-interval-wrap');
  const cronWrap = bd.querySelector('#cfg-schedule-cron-wrap');
  const refresh = () => {
    if (intervalWrap) intervalWrap.style.display = mode.value === 'custom-interval' ? '' : 'none';
    if (cronWrap) cronWrap.style.display = mode.value === 'custom-cron' ? '' : 'none';
  };
  mode.addEventListener('change', refresh);
  refresh();
}

function collectConnectorSchedule(bd) {
  const mode = bd.querySelector('#cfg-schedule-mode')?.value || 'manual';
  if (mode === 'manual') return null;
  if (mode === 'custom-interval') {
    const v = parseInt(bd.querySelector('#cfg-schedule-interval-val')?.value || '0', 10);
    const unit = bd.querySelector('#cfg-schedule-interval-unit')?.value || 'm';
    if (!v || v <= 0) throw new Error('Custom sync interval must be greater than zero');
    return `every:${v}${unit}`;
  }
  if (mode === 'custom-cron') {
    const cron = bd.querySelector('#cfg-schedule-cron')?.value.trim() || '';
    if (cron.split(/\s+/).length !== 5) throw new Error('Cron must be five fields: minute hour day month weekday');
    return cron;
  }
  return mode;
}

const CONNECTOR_TYPES = {
  AD:               { label: 'Active Directory', icon: '🏢', badge: 'badge-info',    desc: 'Microsoft Active Directory / LDAP (IdP connects directly)',
    fields: ['host','port','bindDn','bindPassword','baseDn','targetOu','upnDomain','useSsl','syncGroups'],
    connectionFields: ['host','port','bindDn','bindPassword','baseDn','targetOu','upnDomain','useSsl'],
    scopeFields: ['syncGroups'] },
  AD_AGENT:         { label: 'Active Directory (Agent)', icon: '🖥️', badge: 'badge-info', desc: 'On-prem Windows agent — bidirectional sync over HTTPS :443; AD credentials stay on the agent',
    fields: ['idpUrl','baseDn','targetOu','upnDomain','syncGroups'],
    connectionFields: ['idpUrl'],
    scopeFields: ['baseDn','targetOu','upnDomain','syncGroups'],
    agentNote: true },
  LDAP:             { label: 'LDAP',             icon: '📂', badge: 'badge-info',    desc: 'Generic LDAP v3 directory server',             fields: ['host','port','bindDn','bindPassword','baseDn','useSsl'] },
  GOOGLE_WORKSPACE: GOOGLE_WS_META,
  AZURE_AD:         { label: 'Azure AD / Entra', icon: '☁️', badge: 'badge-info',    desc: 'Microsoft Entra ID (Azure AD)',                 fields: ['tenantId','clientId','clientSecret','domain'] },
  OKTA:             { label: 'Okta',             icon: '🔑', badge: 'badge-warning', desc: 'Okta Universal Directory',                      fields: ['domain','apiToken'] },
  SCIM:             { label: 'SCIM 2.0',         icon: '⚙️', badge: 'badge-neutral', desc: 'Any SCIM 2.0-compliant directory',              fields: ['baseUrl','bearerToken','syncMode'] },
  ZOHO:             { label: 'Zoho People',      icon: '🟢', badge: 'badge-success', desc: 'Zoho People HR + identity',                     fields: ['orgId','oauthToken'] },
  HRMS:             { label: 'HRMS (Custom)',     icon: '👥', badge: 'badge-neutral', desc: 'Internal HRMS via REST / JDBC',                 fields: ['baseUrl','apiKey','syncMode'] },
};

// human-readable labels for config fields
const FIELD_LABELS = {
  host:               'Server Host / IP',
  port:               'Port',
  bindDn:             'Bind DN',
  bindPassword:       'Bind Password',
  baseDn:             'Base DN (domain root, e.g. DC=Lenskart,DC=in)',
  targetOu:           'New User OU (e.g. OU=IT — optional if Base DN is already an OU)',
  upnDomain:          'UPN Suffix (e.g. lenskart.com — optional)',
  useSsl:             'Protocol',
  customerDomain:     'Workspace domains',
  serviceAccountEmail:'Service Account Email',
  serviceAccountKey:  'Service Account JSON Key',
  adminEmail:         'Admin Email (Workspace super admin — required for domain-wide delegation)',
  syncOrgUnits:       'Sync OUs (one per line, e.g. /Sales — blank = all OUs)',
  syncGroups:         'Sync Groups (Google: group email, blank/* = all Workspace groups up to 200; AD: CN/sAMAccountName/DN, blank/* = all security groups)',
  idpUrl:             'IdP URL (HTTPS, port 443 — e.g. https://idp.lenskart.com)',
  syncGroupMemberships: 'Mirror group membership into IdP Groups (on by default)',
  syncUsers:          'Sync Users (one per line, user email — optional filter)',
  provisionOrgUnit:   'Provision OU (outbound new users, e.g. /Employees)',
  includeSubOrgUnits: 'Include sub-OUs',
  tenantId:           'Tenant ID',
  clientId:           'Client ID',
  clientSecret:       'Client Secret',
  domain:             'Domain',
  apiToken:           'API Token',
  baseUrl:            'Base URL',
  bearerToken:        'Bearer Token',
  orgId:              'Organisation ID',
  oauthToken:         'OAuth Token',
  syncMode:           'Sync Mode',
};

function connectorStatusBadge(status) {
  const map = {
    CONNECTED: { badge: 'badge-success', label: 'Connected' },
    ACTIVE:    { badge: 'badge-success', label: 'Connected' }, // legacy
    CONFIGURED:{ badge: 'badge-info',    label: 'Configured' },
    ERROR:     { badge: 'badge-danger',  label: 'Error' },
    DISABLED:  { badge: 'badge-neutral', label: 'Disabled' },
  };
  const m = map[status] || { badge: 'badge-neutral', label: status || '—' };
  return `<span class="badge ${m.badge}">${esc(m.label)}</span>`;
}

export async function viewDirectorySync(content, initialTab = 'sources', me = null) {
  const allowed = new Set(['sources', 'users', 'mapping', 'sync']);
  const validTab = allowed.has(initialTab) ? initialTab : 'sources';
  const headerActions = `
    <a class="btn btn-secondary btn-sm btn-with-icon" href="${esc(api.adAgentPackageUrl())}" download="lilg-ad-connector.zip">
      ${svgIcon('download')}<span>AD Agent</span>
    </a>
    <button type="button" class="btn btn-primary btn-sm btn-with-icon" id="ds-add-header-btn">
      ${svgIcon('plus')}<span>Add Source</span>
    </button>`;
  content.replaceChildren(el(`<div class="admin-page ds-page">
    ${header('Universal Directory', 'Identity sources and hybrid users across AD, Google, and local directories', headerActions)}
    <div class="inline-tabs ds-tabs" id="ds-tabs">
      <button type="button" class="inline-tab${validTab === 'sources' ? ' active' : ''}" data-tab="sources">Directory Sources</button>
      <button type="button" class="inline-tab${validTab === 'users' ? ' active' : ''}" data-tab="users">Users</button>
      <button type="button" class="inline-tab${validTab === 'mapping' ? ' active' : ''}" data-tab="mapping">Attribute Mapping</button>
      <button type="button" class="inline-tab${validTab === 'sync' ? ' active' : ''}" data-tab="sync">Sync Settings</button>
    </div>
    <div id="tab-sources"></div>
    <div id="tab-users" style="display:none"></div>
    <div id="tab-mapping" style="display:none"></div>
    <div id="tab-sync" style="display:none"></div>
  </div>`));
  const wrap = content.firstChild;

  function showTab(name) {
    wrap.querySelectorAll('#ds-tabs .inline-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    ['sources', 'users', 'mapping', 'sync'].forEach((t) => {
      const elTab = wrap.querySelector('#tab-' + t);
      if (elTab) elTab.style.display = name === t ? '' : 'none';
    });
    const addBtn = wrap.querySelector('#ds-add-header-btn');
    if (addBtn) addBtn.style.display = name === 'sources' ? '' : 'none';
    syncAppUrl('directorySync', name, 'sources');
  }
  wrap.querySelectorAll('#ds-tabs .inline-tab').forEach(t => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
  });

  // ── initialise both tabs ─────────────────────────────────────────────────────
  initSourcesTab(wrap.querySelector('#tab-sources'));
  initUsersTab(wrap.querySelector('#tab-users'), me);
  initAttrMappingTab(wrap.querySelector('#tab-mapping'));
  initSyncSettingsTab(wrap.querySelector('#tab-sync'));
  showTab(validTab);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  TAB 1: Directory Sources (connector management)            ║
// ╚══════════════════════════════════════════════════════════════╝
function initSourcesTab(panel) {
  panel.innerHTML = `
    <div id="ds-overview" class="ds-overview" hidden>
      <div id="ds-stats" class="stat-grid ds-stat-grid"></div>
      <div class="ds-actions-bar" id="ds-actions"></div>
      <div class="ds-callout" id="ds-callout"></div>
    </div>
    <div id="ds-area">${loading()}</div>`;

  function renderSourceStats(connectors) {
    const total = connectors.length;
    const active = connectors.filter((c) => ['CONNECTED', 'ACTIVE'].includes(c.status)).length;
    const configured = connectors.filter((c) => c.status === 'CONFIGURED').length;
    const errors = connectors.filter((c) => c.status === 'ERROR').length;
    const lastSync = connectors.reduce((best, c) => {
      if (!c.last_sync_at) return best;
      return !best || new Date(c.last_sync_at) > new Date(best) ? c.last_sync_at : best;
    }, null);
    const overview = panel.querySelector('#ds-overview');
    overview.hidden = false;

    panel.querySelector('#ds-stats').innerHTML = [
      statCard('plug', 'Directory sources', total, `${active} connected · ${configured} pending test`, 'primary'),
      statCard('link', 'Healthy', active, errors ? `${errors} source(s) in error` : 'All sources connected', errors ? 'warning' : 'success'),
      statCard('refresh', 'Last sync', lastSync ? fmtDate(lastSync) : 'Never', lastSync ? 'Most recent directory run' : 'No sync completed yet', 'info'),
      statCard('check', 'Pending test', configured, configured ? 'Run connectivity test on new sources' : 'All sources verified', configured ? 'warning' : 'teal'),
    ].join('');

    panel.querySelector('#ds-actions').innerHTML = `
      <div class="ds-actions-bar__left">
        <span class="ds-actions-bar__title">${esc(String(total))} source${total === 1 ? '' : 's'}</span>
        <span class="ds-actions-bar__sep" aria-hidden="true"></span>
        <button type="button" class="btn btn-secondary btn-sm btn-with-icon" id="ds-harvest-all">
          ${svgIcon('refresh')}<span>Harvest all roles</span>
        </button>
        <a class="btn btn-secondary btn-sm btn-with-icon" id="ds-download-ad-agent" href="${esc(api.adAgentPackageUrl())}" download="${esc('lilg-ad-connector.zip')}">
          ${svgIcon('download')}<span>Download AD agent</span>
        </a>
      </div>
      <a class="btn btn-ghost btn-sm btn-with-icon" href="/?v=entitlementCatalog">
        <span>View entitlements catalog</span>${svgIcon('arrowRight')}
      </a>`;

    panel.querySelector('#ds-callout').innerHTML = dsGuideCardsHtml();

    panel.querySelector('#ds-harvest-all')?.addEventListener('click', async () => {
      if (!confirm('Harvest groups/roles from all AD and Google connectors into the entitlements catalog?')) return;
      const btn = panel.querySelector('#ds-harvest-all');
      btn.disabled = true;
      btn.innerHTML = `${svgIcon('refresh')}<span>Harvesting…</span>`;
      try {
        const r = await api.harvestAllEntitlements();
        showToast(`Done — ${r.harvested ?? 0} new, ${r.updated ?? 0} updated across ${r.connectors ?? 0} connector(s).`);
      } catch (e) { showToast(e.message || 'Harvest all failed', true); }
      btn.disabled = false;
      btn.innerHTML = `${svgIcon('refresh')}<span>Harvest all roles</span>`;
    });
  }

  function renderSourceTable(connectors) {
    const rows = connectors.map((c) => {
      const meta = CONNECTOR_TYPES[normalizeConnectorType(c.connector_type)] || { label: c.connector_type, icon: '⚙️', badge: 'badge-neutral' };
      const errHint = c.last_error
        ? `<span class="ds-row-error" title="${esc(c.last_error)}">${svgIcon('alert')}</span>`
        : '';
      return `<tr data-cid="${esc(String(c.id))}">
        <td>
          <div class="connector-cell">
            <div class="connector-cell-icon ${connectorIconClass(c.connector_type)}" aria-hidden="true">${meta.icon}</div>
            <div class="connector-cell-body">
              <div class="connector-cell-name">${esc(c.name)}</div>
              <div class="connector-cell-meta">${esc(meta.label)} · ${esc(c.sync_mode || 'INCREMENTAL')}</div>
            </div>
          </div>
        </td>
        <td><span class="badge badge-neutral">${esc(c.direction || '—')}</span></td>
        <td class="muted">${esc(formatConnectorScheduleLabel(c.sync_schedule))}</td>
        <td class="muted">${c.last_sync_at ? fmtDate(c.last_sync_at) : 'Never'}</td>
        <td>
          <div class="ds-status-cell">
            ${connectorStatusBadge(c.status)}${errHint}
            ${c.last_health_check_at ? `<div class="muted ds-status-sub">Checked ${fmtDate(c.last_health_check_at)}</div>` : ''}
          </div>
        </td>
        <td class="actions">
          <div class="row-actions row-actions--compact">
            <button class="btn btn-sm btn-primary ds-sync" data-id="${esc(String(c.id))}">Sync</button>
            <button class="btn btn-sm btn-secondary ds-test" data-id="${esc(String(c.id))}">Test</button>
            <button class="btn btn-sm btn-ghost ds-edit" data-id="${esc(String(c.id))}" data-type="${esc(c.connector_type)}" data-name="${esc(c.name)}" data-mode="${esc(c.sync_mode || '')}" data-sched="${esc(c.sync_schedule || '')}">Edit</button>
            <button class="btn btn-sm btn-ghost ds-harvest" data-id="${esc(String(c.id))}" title="Import groups/roles into IGA entitlements catalog">Harvest</button>
            ${normalizeConnectorType(c.connector_type) === 'AD_AGENT' ? `<a class="btn btn-sm btn-secondary btn-with-icon" href="${esc(api.adAgentPackageUrl())}" download="lilg-ad-connector.zip" title="Download on-prem agent package">${svgIcon('download')}<span>ZIP</span></a>` : ''}
            <button class="btn btn-sm btn-ghost ds-logs" data-id="${esc(String(c.id))}" data-name="${esc(c.name)}">History</button>
            <button class="btn btn-sm btn-danger ds-del" data-id="${esc(String(c.id))}">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    panel.querySelector('#ds-area').innerHTML = `
      <div class="ent-panel ds-sources-panel">
        <div class="ent-panel-head">
          <div class="panel-meta">
            <h2>Configured sources</h2>
            <p class="subtitle">Manage sync, connectivity tests, and role harvest per directory</p>
          </div>
        </div>
        <div class="ent-panel-body ent-panel-body--flush">
          <div class="table-wrap table-wrap--flat">
            <table class="dense-table ds-sources-table">
              <thead><tr>
                <th>Source</th><th>Direction</th><th>Schedule</th><th>Last sync</th><th>Status</th><th class="actions-col">Actions</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    bindCardActions();
  }

  // ── render connector list ──────────────────────────────────────────────────
  async function load() {
    try {
      const r = await api.igaConnectors();
      const connectors = (r && r.data) ? r.data : (Array.isArray(r) ? r : []);

      if (!connectors.length) {
        panel.querySelector('#ds-overview').hidden = true;
        panel.querySelector('#ds-area').innerHTML = `
          <div class="empty-panel ds-empty-panel">
            <div class="ds-empty-icon">${svgIcon('plug')}</div>
            <h2>No directory sources configured</h2>
            <p class="muted">Connect Active Directory, Google Workspace, Azure AD, or any SCIM directory to start syncing identities into Universal Directory.</p>
            <div class="ds-empty-actions">
              <button type="button" class="btn btn-primary btn-with-icon" id="ds-empty-add">${svgIcon('plus')}<span>Add directory source</span></button>
              <a class="btn btn-secondary btn-with-icon" href="${esc(api.adAgentPackageUrl())}" download="${esc('lilg-ad-connector.zip')}">${svgIcon('download')}<span>Download AD agent</span></a>
            </div>
            <div class="ds-callout ds-callout--inline">
              <div class="ds-callout__icon">${svgIcon('server')}</div>
              <div class="ds-callout__body">
                <h3 class="ds-callout__title">Firewalled Active Directory?</h3>
                <p class="ds-callout__text">Use the on-prem agent package — includes <code>README.md</code> with Windows install steps and service setup.</p>
              </div>
            </div>
          </div>`;
        panel.querySelector('#ds-empty-add').addEventListener('click', openAddWizard);
        return;
      }

      renderSourceStats(connectors);
      renderSourceTable(connectors);
    } catch (e) { panel.querySelector('#ds-area').innerHTML = errHtml(e.message); }
  }

  // ── bind all card button actions ────────────────────────────────────────────
  function bindCardActions() {
    // Sync Now
    panel.querySelectorAll('.ds-sync').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '⟳ Syncing…';
        try {
          await api.syncConnector(btn.dataset.id);
          showToast('Sync triggered — check history for results.');
          await load();
        } catch(e) { showToast(e.message || 'Sync failed', true); }
        finally { btn.disabled = false; btn.textContent = 'Sync'; }
      });
    });

    // Harvest Roles → IGA entitlements catalog (OIG-style)
    panel.querySelectorAll('.ds-harvest').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Harvest groups/roles from this connector into the Request Access entitlements catalog?')) return;
        btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Harvesting…';
        try {
          const r = await api.harvestEntitlements(btn.dataset.id);
          const errs = (r.errors && r.errors.length) ? ` Warnings: ${r.errors.slice(0, 3).join('; ')}` : '';
          showToast(`Harvested ${r.harvested ?? 0} new, updated ${r.updated ?? 0}, deactivated ${r.deactivated ?? 0}.${errs}`);
          await load();
        } catch (e) {
          showToast(e.message || 'Harvest failed', true);
        }
        btn.disabled = false; btn.textContent = prev || 'Harvest Roles';
      });
    });

    // Test Connection — Connected only after success; list reloads
    panel.querySelectorAll('.ds-test').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Testing…';
        try {
          const r = await api.testConnector(btn.dataset.id);
          showToast(r.message || (r.success ? 'Connection successful — status set to Connected' : 'Test failed'));
          await load();
        } catch(e) {
          const detail = e.body && e.body.detail ? `\n${e.body.detail}` : '';
          showToast((e.message || 'Test failed') + detail, true);
          await load();
        }
        btn.disabled = false; btn.textContent = 'Test';
      });
    });

    // Edit
    panel.querySelectorAll('.ds-edit').forEach(btn => {
      btn.addEventListener('click', () => openEditModal(btn.dataset.id, btn.dataset));
    });

    // Sync History
    panel.querySelectorAll('.ds-logs').forEach(btn => {
      btn.addEventListener('click', () => openLogsModal(btn.dataset.id, btn.dataset.name));
    });

    // Delete
    panel.querySelectorAll('.ds-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this directory source? This will not delete synced users.')) return;
        try { await api.deleteConnector(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
      });
    });
  }

  // ── toast helper ────────────────────────────────────────────────────────────
  function showToast(msg, isError = false) {
    const t = el(`<div style="position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;
      padding:0.75rem 1.25rem;border-radius:6px;font-size:0.9rem;max-width:380px;
      background:${isError?'var(--danger)':'var(--success)'};color:#fff;
      box-shadow:0 4px 16px rgba(0,0,0,0.25)">${esc(msg)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ── step-1: choose connector type ───────────────────────────────────────────
  function openAddWizard() {
    const typeCards = Object.entries(CONNECTOR_TYPES).map(([k, v]) =>
      `<button type="button" class="ds-type-card ds-type-card--${connectorTypeKey(k)}" data-type="${k}">
        <span class="ds-type-card__icon connector-cell-icon ${connectorIconClass(k)}">${connectorSvg(k)}</span>
        <span class="ds-type-card__body">
          <span class="ds-type-card__label">${esc(v.label)}</span>
          <span class="ds-type-card__desc">${esc(v.desc)}</span>
        </span>
        ${svgIcon('arrowRight')}
      </button>`).join('');

    const bd = openModal(`<div class="modal ds-modal">
      <div class="modal-header">
        <div>
          <h2>Add directory source</h2>
          <p class="modal-subtitle">Choose a connector type — Google Workspace, Active Directory, SCIM, and more</p>
        </div>
      </div>
      <div class="modal-body">
        <div class="ds-type-grid">${typeCards}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="wiz-cancel">Cancel</button>
      </div>
    </div>`);

    bd.querySelector('#wiz-cancel').addEventListener('click', () => bd.remove());

    bd.querySelectorAll('.ds-type-card').forEach(card => {
      card.addEventListener('click', () => {
        bd.remove();
        openConfigModal(null, card.dataset.type, {});
      });
    });
  }

  // ── step-2: configure ───────────────────────────────────────────────────────
  function openConfigModal(existingId, connectorType, defaults) {
    connectorType = normalizeConnectorType(connectorType);
    const meta = CONNECTOR_TYPES[connectorType] || { label: connectorType, fields: [] };
    const isEdit = !!existingId;
    const isGoogle = connectorType === 'GOOGLE_WORKSPACE';
    const isAd = connectorType === 'AD';
    const isAdAgent = connectorType === 'AD_AGENT';
    const useScopeTabs = isGoogle || isAd || isAdAgent;

    function renderConfigField(f) {
      const label = FIELD_LABELS[f] || f;
      const val = esc(String(defaults[f] || ''));
      if (f === 'useSsl') {
        const usingSsl    = defaults[f] === true || defaults[f] === 'true' || defaults[f] === 1;
        const usingStartTls = defaults['startTls'] === true || defaults['startTls'] === 'true' || defaults['startTls'] === 1;
        const proto = usingSsl ? 'ldaps' : usingStartTls ? 'starttls' : 'ldap';
        return `<div class="form-group">
          <label class="form-label" for="cfg-${f}">${esc(label)}</label>
          <select id="cfg-${f}" class="form-control" onchange="
            var port = document.getElementById('cfg-port');
            if (port) port.value = (this.value === 'ldaps') ? '636' : '389';
          ">
            <option value="ldap"     ${proto === 'ldap'     ? 'selected' : ''}>LDAP (port 389) — plain text (not recommended)</option>
            <option value="starttls" ${proto === 'starttls' ? 'selected' : ''}>LDAP + StartTLS (port 389) — encrypted</option>
            <option value="ldaps"    ${proto === 'ldaps'    ? 'selected' : ''}>LDAPS (port 636) — SSL/TLS</option>
          </select>
        </div>`;
      }
      if (f === 'serviceAccountKey') {
        return `<div class="form-group">
          <label class="form-label">${esc(label)}</label>
          <textarea class="form-textarea" id="cfg-${f}" rows="4" placeholder='{"type":"service_account","project_id":"..."}'>${val}</textarea>
        </div>`;
      }
      if (f === 'customerDomain' && isGoogle) {
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${esc(label)} <span style="color:var(--danger)">*</span></label>
          <textarea class="form-textarea" id="cfg-${f}" rows="3" placeholder="lenskart.com&#10;lenskart.in&#10;dealskart.in">${val}</textarea>
          <p class="muted" style="font-size:0.75rem;margin-top:0.35rem">All Google Workspace domains on this tenant (one per line). Sync imports users from every domain; the same list is used for portal Google sign-in.</p>
        </div>`;
      }
      if (f === 'adminEmail' && isGoogle) {
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${esc(label)} <span style="color:var(--danger)">*</span></label>
          <input type="email" class="form-input" id="cfg-${f}" value="${val}" placeholder="admin@company.com">
          <p class="muted" style="font-size:0.75rem;margin-top:0.35rem">Must be a Google Workspace <strong>super admin</strong> in your domain — not the service account email. Used for domain-wide delegation impersonation.</p>
        </div>`;
      }
      if (f === 'syncOrgUnits' && isGoogle) {
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${esc(label)}</label>
          <textarea class="form-textarea" id="cfg-${f}" rows="3" placeholder="/Sales&#10;/Engineering">${val}</textarea>
        </div>`;
      }
      if (f === 'syncGroups' && (isGoogle || connectorType === 'AD' || isAdAgent)) {
        const ph = isGoogle
          ? 'sales-team@company.com&#10;it-admins@company.com'
          : 'IT-Admins&#10;VPN-Users&#10;*';
        const hint = (connectorType === 'AD' || isAdAgent)
          ? '<p class="muted" style="font-size:0.75rem;margin-top:0.35rem">One group per line. Members appear after users are linked in AD sync. Use <code>*</code> to mirror all security groups (max 200).</p>'
          : '';
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${esc(label)}</label>
          <textarea class="form-textarea" id="cfg-${f}" rows="3" placeholder="${ph}">${val}</textarea>
          ${hint}
        </div>`;
      }
      if (f === 'syncGroupMemberships' && isGoogle) {
        const checked = defaults[f] !== false && defaults[f] !== 'false';
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
            <input type="checkbox" id="cfg-${f}" ${checked ? 'checked' : ''}>
            ${esc(label)}
          </label>
        </div>`;
      }
      if (f === 'syncUsers' && isGoogle) {
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${esc(label)}</label>
          <textarea class="form-textarea" id="cfg-${f}" rows="2" placeholder="alice@company.com&#10;bob@company.com">${val}</textarea>
          <p class="muted" style="font-size:0.75rem;margin-top:0.35rem">When set, only these users are imported (looked up by primary email). Outbound provision is limited to this list unless the employee already has a Google link. Click <strong>Save Changes</strong> before syncing.</p>
        </div>`;
      }
      if (f === 'includeSubOrgUnits' && isGoogle) {
        const checked = defaults[f] !== false && defaults[f] !== 'false';
        return `<div class="form-group" style="grid-column:1/-1">
          <label class="form-label" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
            <input type="checkbox" id="cfg-${f}" ${checked ? 'checked' : ''}>
            ${esc(label)}
            <span class="muted" style="font-size:0.75rem">— when OUs are set, also sync users in child OUs</span>
          </label>
        </div>`;
      }
      if (f === 'syncMode') {
        return `<div class="form-group"><label class="form-label">${esc(label)}</label>
          <select class="form-select" id="cfg-${f}">
            <option ${defaults[f]==='INCREMENTAL'?'selected':''}>INCREMENTAL</option>
            <option ${defaults[f]==='FULL'?'selected':''}>FULL</option>
            <option ${defaults[f]==='RECONCILE'?'selected':''}>RECONCILE</option>
          </select></div>`;
      }
      const type = (f.toLowerCase().includes('password')||f.toLowerCase().includes('token')||f.toLowerCase().includes('secret')||f.toLowerCase().includes('key')) ? 'password' : 'text';
      const ph = { host:'ldap.company.com', port:'389', bindDn:'CN=svc-idp,DC=company,DC=com',
        baseDn:'DC=company,DC=com', targetOu:'OU=IT', upnDomain:'company.com', customerDomain:'company.com',
        provisionOrgUnit:'/Employees', tenantId:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        clientId:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', domain:'company.okta.com',
        baseUrl:'https://scim.app.com/v2', apiKey:'sk_...', orgId:'12345' }[f] || '';
      return `<div class="form-group">
        <label class="form-label">${esc(label)}${['bindPassword','clientSecret','apiToken','bearerToken','oauthToken','serviceAccountKey'].includes(f)?` <span class="muted" style="font-size:0.75rem">(stored encrypted)</span>`:''}${['bindPassword','clientSecret','apiToken','bearerToken','oauthToken'].includes(f)&&isEdit?` <span class="muted" style="font-size:0.75rem">— leave blank to keep existing</span>`:''}</label>
        <input type="${type}" class="form-input" id="cfg-${f}" value="${val}" placeholder="${esc(ph)}">
      </div>`;
    }

    const fieldList = meta.fields || [];
    const configFields = fieldList.map(renderConfigField).join('');
    const googleConnFields = (meta.connectionFields || fieldList).map(renderConfigField).join('');
    const googleScopeFields = (meta.scopeFields || []).map(renderConfigField).join('');

    const adConnFields = (meta.connectionFields || fieldList).map(renderConfigField).join('');
    const adScopeFields = (meta.scopeFields || []).map(renderConfigField).join('');
    const redirectUri = String(defaults.oidcRedirectUri || `${window.location.origin}/auth/google/callback`);
    const oidcClientId = esc(String(defaults.oidcClientId || ''));
    const oidcHasSecret = defaults.oidcHasClientSecret ? true : false;
    const oidcMismatch = defaults.oidcCredentialMismatch ? true : false;
    const oidcSource = defaults.oidcSource
      ? `Credentials source: Client ID from <strong>${esc(defaults.oidcSource.clientId || '—')}</strong>, Secret from <strong>${esc(defaults.oidcSource.clientSecret || '—')}</strong>.`
      : '';

    const googleAuthFields = `
          <p class="muted" style="font-size:0.82rem;margin:0 0 1rem">OAuth <strong>Web application</strong> client for <em>Continue with Google</em>. Directory sync uses the <em>service account</em> on the Connection tab — a different credential. Sync working does <strong>not</strong> mean portal login is configured.</p>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">OAuth Client ID</label>
            <input class="form-input" id="cfg-oidcClientId" value="${oidcClientId}" placeholder="123456789.apps.googleusercontent.com">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">OAuth Client Secret</label>
            <input class="form-input" id="cfg-oidcClientSecret" type="password" placeholder="${oidcHasSecret ? 'Saved (leave blank to keep current)' : 'GOCSPX-...'}">
            <p class="muted" style="font-size:0.75rem;margin:0.3rem 0 0">After rotating the secret in Google Cloud, paste the new value here and Save — leave blank keeps the old stored secret.</p>
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">OAuth JSON (optional)</label>
            <textarea class="form-textarea" id="cfg-oidcOAuthJson" rows="3" placeholder='Paste OAuth Web client JSON from Google Cloud Console (must include "web": { client_id, client_secret })'></textarea>
          </div>
          <div class="alert alert-info" style="font-size:0.8rem;margin-bottom:0;line-height:1.45">
            Google Cloud Console → APIs &amp; Services → Credentials → <strong>OAuth 2.0 Client ID</strong> (type <em>Web application</em>):<br>
            Authorized redirect URI (exact):<br>
            <code style="font-size:0.78rem;user-select:all">${esc(redirectUri)}</code>
            ${oidcSource ? `<br><span class="muted" style="font-size:0.75rem">${oidcSource}</span>` : ''}
            ${oidcMismatch ? `<br><strong class="text-danger" style="font-size:0.75rem">Client ID and Secret may be mismatched — paste OAuth JSON again and Save.</strong>` : ''}
          </div>`;

    const scopedFieldsBlock = useScopeTabs ? `
        <div class="inline-tabs ds-cfg-tabs" role="tablist">
          <button type="button" class="inline-tab cfg-tab active" data-pane="conn">Connection</button>
          ${isGoogle ? `<button type="button" class="inline-tab cfg-tab" data-pane="auth">Portal sign-in</button>` : ''}
          <button type="button" class="inline-tab cfg-tab" data-pane="scope">Sync scope</button>
        </div>
        <div id="cfg-pane-conn" class="cfg-pane ds-cfg-pane">
          <div class="ds-form-grid">${isGoogle ? googleConnFields : adConnFields}</div>
          ${isAdAgent ? `<div class="ds-callout ds-callout--compact">
            <div class="ds-callout__icon">${svgIcon('server')}</div>
            <div class="ds-callout__body">
              <h3 class="ds-callout__title">On-prem agent required</h3>
              <p class="ds-callout__text">LDAP credentials belong in the agent <code>config.json</code>, not here. The agent connects outbound to IdP on HTTPS&nbsp;:443.</p>
              <a href="${esc(api.adAgentPackageUrl())}" download="lilg-ad-connector.zip" class="btn btn-secondary btn-sm btn-with-icon">${svgIcon('download')}<span>Download package</span></a>
            </div>
          </div>` : ''}
          ${isGoogle ? `<div class="ds-callout ds-callout--compact ds-callout--google">
            <div class="ds-callout__icon connector-cell-icon connector-cell-icon--google">${svgIcon('app')}</div>
            <div class="ds-callout__body">
              <h3 class="ds-callout__title">Domain-wide delegation</h3>
              <p class="ds-callout__text">In Google Admin → Security → API controls, authorize the service account Client ID with scopes <code>admin.directory.user</code> and <code>admin.directory.group.readonly</code>.</p>
            </div>
          </div>` : ''}
          ${isAd ? `<div class="ds-callout ds-callout--compact ds-callout--ad">
            <div class="ds-callout__icon connector-cell-icon connector-cell-icon--ad">${svgIcon('server')}</div>
            <div class="ds-callout__body">
              <h3 class="ds-callout__title">LDAP connectivity</h3>
              <p class="ds-callout__text">Use LDAPS or StartTLS in production. The IdP must reach your domain controller on port 389 or 636.</p>
            </div>
          </div>` : ''}
        </div>
        ${isGoogle ? `<div id="cfg-pane-auth" class="cfg-pane ds-cfg-pane" style="display:none">${googleAuthFields}</div>` : ''}
        <div id="cfg-pane-scope" class="cfg-pane ds-cfg-pane" style="display:none">
          <p class="ds-cfg-pane-intro">${isGoogle
            ? 'Choose which OUs and users to import. Leave blank to sync the entire directory. <strong>Sync Groups</strong> mirrors Workspace groups into Identity → Groups.'
            : 'List AD groups to mirror into Identity → Groups. User sync must run first so members can be linked.'}</p>
          <div class="ds-form-grid">${isGoogle ? googleScopeFields : adScopeFields}</div>
        </div>` : `
        <div class="ds-form-grid ds-form-grid--2col">${configFields}</div>`;

    const bd = openModal(`<div class="modal ds-modal ds-config-modal">
      <div class="modal-header ds-config-modal__head">
        <span class="ds-config-modal__badge connector-cell-icon ${connectorIconClass(connectorType)}">${connectorSvg(connectorType)}</span>
        <div>
          <h2>${isEdit ? 'Edit' : 'Configure'} ${esc(meta.label || connectorType)}</h2>
          <p class="modal-subtitle">${esc(meta.desc || 'Directory connector settings')}</p>
        </div>
      </div>
      <div class="modal-body ds-config-modal__body">
        <div class="ds-form-grid ds-form-grid--2col ds-config-basics">
          <div class="form-group">
            <label class="form-label">Display name <span class="text-danger">*</span></label>
            <input class="form-input" id="cfg-name" value="${esc(defaults.name||meta.label||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Slug <span class="muted">(URL-safe ID)</span></label>
            <input class="form-input" id="cfg-slug" value="${esc(defaults.slug||connectorType.toLowerCase().replace(/_/g,'-'))}">
          </div>
          <div class="form-group">
            <label class="form-label">Direction</label>
            <select class="form-select" id="cfg-direction">
              <option ${defaults.direction==='INBOUND'?'selected':''} value="INBOUND">INBOUND — read users from source</option>
              <option ${defaults.direction==='OUTBOUND'?'selected':''} value="OUTBOUND">OUTBOUND — provision to source</option>
              <option ${(!defaults.direction||defaults.direction==='BIDIRECTIONAL')?'selected':''} value="BIDIRECTIONAL">BIDIRECTIONAL</option>
            </select>
          </div>
          ${renderConnectorScheduleFields(defaults)}
        </div>
        ${useScopeTabs ? `<div class="ds-config-section"><h3 class="ds-config-section__title">${isGoogle ? 'Google Workspace' : isAdAgent ? 'Agent connector' : 'Active Directory'}</h3>` : ''}
        ${scopedFieldsBlock}
        ${useScopeTabs ? '</div>' : ''}
        <div id="cfg-err"></div>
      </div>
      <div class="modal-footer ds-config-modal__footer">
        ${!isEdit ? `<button type="button" class="btn btn-secondary btn-with-icon" id="cfg-back">${svgIcon('chevronLeft')}<span>Back</span></button>` : ''}
        <span class="modal-footer-spacer"></span>
        <button type="button" class="btn btn-secondary" id="cfg-cancel">Cancel</button>
        <button type="button" class="btn btn-secondary btn-with-icon" id="cfg-test-btn">${svgIcon('check')}<span>Test connection</span></button>
        <button type="button" class="btn btn-primary btn-with-icon" id="cfg-save">${svgIcon('check')}<span>${isEdit ? 'Save changes' : 'Add source'}</span></button>
      </div>
    </div>`);

    bindConnectorScheduleFields(bd);

    if (!isEdit) bd.querySelector('#cfg-back').addEventListener('click', () => { bd.remove(); openAddWizard(); });
    bd.querySelector('#cfg-cancel').addEventListener('click', () => bd.remove());

    if (useScopeTabs) {
      bd.querySelectorAll('.cfg-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          bd.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const pane = tab.dataset.pane;
          bd.querySelector('#cfg-pane-conn').style.display = pane === 'conn' ? '' : 'none';
          const authPane = bd.querySelector('#cfg-pane-auth');
          if (authPane) authPane.style.display = pane === 'auth' ? '' : 'none';
          bd.querySelector('#cfg-pane-scope').style.display = pane === 'scope' ? '' : 'none';
        });
      });
    }

    // Auto-generate slug from name
    if (!isEdit) {
      bd.querySelector('#cfg-name').addEventListener('input', (e) => {
        bd.querySelector('#cfg-slug').value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      });
    }

    // Test Connection button (saves first, then tests)
    bd.querySelector('#cfg-test-btn').addEventListener('click', async () => {
      const testBtn = bd.querySelector('#cfg-test-btn');
      testBtn.disabled = true; testBtn.textContent = '⟳ Testing…';
      try {
        if (isEdit) {
          const data = collectFormData(bd, connectorType);
          await api.updateConnector(existingId, data);
          if (isGoogle) await saveGooglePortalAuth(bd);
          const r = await api.testConnector(existingId);
          bd.querySelector('#cfg-err').innerHTML = `<div class="alert ${r.success?'alert-success':'alert-error'}">${esc(r.message||'')}</div>`;
        } else {
          bd.querySelector('#cfg-err').innerHTML = `<div class="alert alert-info">Save the connector first, then use "Test Connection" from the directory list.</div>`;
        }
      } catch(e) {
        const detail = e.body && e.body.detail ? `<br><small>${esc(e.body.detail)}</small>` : '';
        bd.querySelector('#cfg-err').innerHTML = errHtml(e.message) + detail;
      }
      testBtn.disabled = false; testBtn.textContent = '✓ Test Connection';
    });

    // Save
    bd.querySelector('#cfg-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#cfg-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const data = collectFormData(bd, connectorType);
        if (!data.name) { bd.querySelector('#cfg-err').innerHTML = errHtml('Display Name is required'); saveBtn.disabled=false; saveBtn.textContent=isEdit?'Save Changes':'Add Source'; return; }
        if (isEdit) {
          await api.updateConnector(existingId, data);
          if (isGoogle) await saveGooglePortalAuth(bd);
        } else {
          const created = await api.createConnector(data);
          if (isAdAgent && created?.agentToken) {
            openModal(`<div class="modal" style="width:560px;max-width:96vw">
              <div class="modal-header"><h2>Agent token — copy now</h2></div>
              <div class="modal-body">
                <p class="muted" style="font-size:0.85rem">This token is shown once. Paste it into the on-prem agent <code>config.json</code> as <code>agentToken</code>.</p>
                <pre style="background:var(--surface-2);padding:0.75rem;border-radius:6px;overflow:auto;user-select:all;font-size:0.8rem">${esc(created.agentToken)}</pre>
                <p class="muted" style="font-size:0.8rem;margin-top:0.75rem">Connector ID: <code>${esc(created.id || '')}</code></p>
              </div>
              <div class="modal-footer"><button class="btn btn-primary" id="agent-token-ok">Done</button></div>
            </div>`);
            document.getElementById('agent-token-ok')?.addEventListener('click', () => document.querySelector('.modal-backdrop')?.remove());
          }
          if (isGoogle && created?.id) {
            try { await saveGooglePortalAuth(bd); } catch (oidcErr) {
              showToast('Connector saved. Complete Portal sign-in tab for Google login.', true);
            }
          }
        }
        bd.remove();
        await load();
        showToast(isEdit ? 'Connector updated.' : '✓ Directory source added! Use "Test Connection" to verify.');
      } catch(e) { bd.querySelector('#cfg-err').innerHTML = errHtml(e.message); saveBtn.disabled=false; saveBtn.textContent=isEdit?'Save Changes':'Add Source'; }
    });
  }

  // ── collect form values from config modal ───────────────────────────────────
  async function saveGooglePortalAuth(bd) {
    const clientId = bd.querySelector('#cfg-oidcClientId')?.value.trim() || '';
    const clientSecret = bd.querySelector('#cfg-oidcClientSecret')?.value.trim() || '';
    const oauthClientJson = bd.querySelector('#cfg-oidcOAuthJson')?.value.trim() || '';
    const hostedDomain = bd.querySelector('#cfg-customerDomain')?.value.trim() || '';
    const payload = {};
    if (hostedDomain) payload.hostedDomain = hostedDomain;
    if (clientId) payload.clientId = clientId;
    if (clientSecret) payload.clientSecret = clientSecret;
    if (oauthClientJson) payload.oauthClientJson = oauthClientJson;
    // Nothing to persist (blank Portal sign-in + blank Workspace domains)
    if (!payload.hostedDomain && !payload.clientId && !payload.clientSecret && !payload.oauthClientJson) return;
    // Workspace domains are required for Google portal login — do not call API with empty domain
    if (!payload.hostedDomain && (payload.clientId || payload.clientSecret || payload.oauthClientJson)) {
      throw new Error('Workspace domain(s) are required on the Connection tab for Google portal sign-in.');
    }
    await api.saveGoogleOidcSettings(payload);
  }

  // Secrets: omit blank on save so merge keeps the existing stored value.
  // Everything else (incl. Sync Scope) must send '' so clears persist.
  const CONNECTOR_SECRET_FIELDS = new Set([
    'serviceAccountKey', 'bindPassword', 'clientSecret', 'apiToken',
    'bearerToken', 'oauthToken', 'apiKey',
  ]);

  function collectFormData(bd, connectorType) {
    connectorType = normalizeConnectorType(connectorType);
    const meta = CONNECTOR_TYPES[connectorType] || { fields: [] };
    const configJson = {};
    for (const f of (meta.fields || [])) {
      const el2 = bd.querySelector(`#cfg-${f}`);
      if (!el2) continue;
      if (el2.type === 'checkbox') configJson[f] = el2.checked;
      else if (f === 'useSsl') {
        configJson['useSsl']   = el2.value === 'ldaps';
        configJson['startTls'] = el2.value === 'starttls';
      } else {
        const val = el2.value.trim();
        if (val !== '') configJson[f] = val;
        else if (!CONNECTOR_SECRET_FIELDS.has(f)) configJson[f] = '';
      }
    }
    return {
      name:          bd.querySelector('#cfg-name').value.trim(),
      slug:          bd.querySelector('#cfg-slug').value.trim(),
      connectorType,
      direction:     bd.querySelector('#cfg-direction').value,
      syncSchedule:  collectConnectorSchedule(bd),
      syncMode:      'INCREMENTAL',
      configJson,
    };
  }

  // ── edit modal (loads existing config first) ─────────────────────────────────
  async function openEditModal(connectorId, btnData) {
    try {
      const c = await api.getConnector(connectorId);
      const defaults = {
        name:          c.name,
        slug:          c.slug,
        direction:     c.direction,
        sync_schedule: c.sync_schedule,
        ...(c.config || {}),
      };
      if (normalizeConnectorType(c.connector_type) === 'GOOGLE_WORKSPACE') {
        try {
          const oidc = await api.getGoogleOidcSettings();
          defaults.oidcClientId = oidc.clientId || '';
          defaults.oidcHasClientSecret = oidc.hasClientSecret;
          defaults.oidcCredentialMismatch = oidc.credentialPairMismatch;
          defaults.oidcRedirectUri = oidc.redirectUri || `${window.location.origin}/auth/google/callback`;
          defaults.oidcSource = oidc.source || null;
          if (!defaults.customerDomain && oidc.hostedDomains?.length) {
            defaults.customerDomain = oidc.hostedDomains.join('\n');
          }
        } catch {
          // OIDC settings optional until Portal sign-in tab is filled
        }
      }
      openConfigModal(connectorId, btnData.type || c.connector_type, defaults);
    } catch(e) { alert('Could not load connector: ' + e.message); }
  }

  // ── sync history modal ───────────────────────────────────────────────────────
  function runProgressHint(r2) {
    if (r2.status !== 'RUNNING' && r2.status !== 'PENDING_AGENT') {
      return r2.error_summary ? esc(r2.error_summary.slice(0, 80)) : '—';
    }
    let payload = r2.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    const phase = payload && payload.phase ? String(payload.phase) : 'running';
    const detail = payload && payload.detail ? String(payload.detail) : '';
    const processed = r2.items_processed ?? 0;
    const text = detail || (processed > 0 ? `${processed} processed` : 'Starting…');
    return esc(`${phase}: ${text}`);
  }

  async function openLogsModal(connectorId, connectorName) {
    async function downloadRunExport(runId, startedAt) {
      const url = api.connectorRunExportUrl(connectorId, runId);
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
      const stamp = startedAt ? String(startedAt).slice(0, 10) : 'run';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sync-run-${stamp}-${String(runId).slice(0, 8)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    }

    const bd = openModal(`<div class="modal ds-modal ds-logs-modal">
      <div class="modal-header">
        <div>
          <h2>Sync history</h2>
          <p class="modal-subtitle">${esc(connectorName)}</p>
        </div>
      </div>
      <div class="modal-body ent-panel-body--flush" id="logs-body">${loading()}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="logs-refresh">Refresh</button>
        <button type="button" class="btn btn-secondary" id="logs-close">Close</button>
      </div>
    </div>`);

    let pollTimer = null;

    async function renderRuns() {
      try {
        const r = await api.getConnectorRuns(connectorId, 20);
        const runs = (r && r.data) ? r.data : [];
        if (!runs.length) {
          bd.querySelector('#logs-body').innerHTML = `<div class="empty-panel ds-empty-panel ds-empty-panel--compact"><div class="ds-empty-icon">${svgIcon('refresh')}</div><p class="muted">No sync runs yet for this source.</p></div>`;
          return;
        }
        const hasActive = runs.some((r2) => r2.status === 'RUNNING' || r2.status === 'PENDING_AGENT');
        const rows = runs.map(r2 => `<tr>
        <td class="muted">${r2.started_at ? fmtDate(r2.started_at) : '—'}</td>
        <td><span class="badge badge-neutral">${esc(r2.run_type||'—')}</span></td>
        <td><span class="badge ${r2.status==='SUCCESS'?'badge-success':r2.status==='FAILED'?'badge-danger':r2.status==='RUNNING'?'badge-info':'badge-warning'}">${esc(r2.status||'—')}</span></td>
        <td>${r2.items_processed ?? '—'}</td>
        <td class="text-success">${r2.items_succeeded ?? '—'}</td>
        <td class="${r2.items_failed?'text-danger':''}">${r2.items_failed ?? '—'}</td>
        <td class="muted ds-log-error" title="${esc(r2.error_summary||'')}">${runProgressHint(r2)}</td>
        <td><button type="button" class="btn btn-secondary btn-sm ds-run-export" data-run-id="${esc(r2.id||'')}" data-started="${esc(r2.started_at||'')}">Export</button></td>
      </tr>`).join('');
        bd.querySelector('#logs-body').innerHTML = `
        <div class="table-wrap table-wrap--flat"><table class="dense-table">
          <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Processed</th><th>OK</th><th>Failed</th><th>Progress / Error</th><th>Export</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${hasActive ? '<p class="muted" style="font-size:0.82rem;margin:0.75rem 0 0">Live sync in progress — this view refreshes every 5s. Export downloads CSV (opens in Excel) with synced vs failed users; partial export available while RUNNING.</p>' : '<p class="muted" style="font-size:0.82rem;margin:0.75rem 0 0">Export downloads CSV (opens in Excel) listing each user, status (OK / WARNING / FAILED), and error details.</p>'}`;
        bd.querySelectorAll('.ds-run-export').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              await downloadRunExport(btn.dataset.runId, btn.dataset.started);
            } catch (e) {
              alert(e.message || 'Export failed');
            } finally {
              btn.disabled = false;
            }
          });
        });
        if (pollTimer) clearInterval(pollTimer);
        if (hasActive && document.body.contains(bd)) {
          pollTimer = setInterval(() => { void renderRuns(); }, 5000);
        }
      } catch(e) { bd.querySelector('#logs-body').innerHTML = errHtml(e.message); }
    }

    bd.querySelector('#logs-close').addEventListener('click', () => {
      if (pollTimer) clearInterval(pollTimer);
      bd.remove();
    });
    bd.querySelector('#logs-refresh').addEventListener('click', () => { void renderRuns(); });
    await renderRuns();
  }

  panel.querySelector('#ds-add-btn')?.addEventListener('click', openAddWizard);
  panel.closest('.admin-page')?.querySelector('#ds-add-header-btn')?.addEventListener('click', openAddWizard);
  load();
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  Attribute Mapping + Sync Settings (Google Directory)       ║
// ╚══════════════════════════════════════════════════════════════╝
function initAttrMappingTab(panel) {
  const DEFAULT_SOURCE = [
    'employeeId', 'organizations.department', 'organizations.title', 'organizations.costCenter',
    'organizations.location', 'manager', 'phones', 'addresses', 'thumbnailPhotoUrl',
    'name.givenName', 'name.familyName', 'primaryEmail',
  ];
  const DEFAULT_LOCAL = [
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
  ];
  const DEFAULT_MAPS = [
    { source_attr: 'employeeId', local_attr: 'employee_number', enabled: 1 },
    { source_attr: 'organizations.department', local_attr: 'dept_id', enabled: 1 },
    { source_attr: 'organizations.title', local_attr: 'role', enabled: 1 },
    { source_attr: 'organizations.costCenter', local_attr: 'cost_center', enabled: 1 },
    { source_attr: 'organizations.location', local_attr: 'location', enabled: 1 },
    { source_attr: 'manager', local_attr: 'manager_emp_id', enabled: 1 },
    { source_attr: 'phones', local_attr: 'mobile', enabled: 1 },
    { source_attr: 'addresses', local_attr: 'office_address', enabled: 1 },
    { source_attr: 'thumbnailPhotoUrl', local_attr: 'photo_url', enabled: 1 },
    { source_attr: 'name.givenName', local_attr: 'first_name', enabled: 1 },
    { source_attr: 'name.familyName', local_attr: 'last_name', enabled: 1 },
    { source_attr: 'primaryEmail', local_attr: 'email_corp', enabled: 1 },
  ];

  panel.innerHTML = `
    <div class="ent-panel ds-mapping-panel">
      <div class="ent-panel-head">
        <div class="panel-meta">
          <h2>Google Workspace attribute mapping</h2>
          <p class="subtitle">Map Google directory fields to local employee attributes — applied on the next sync</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm btn-with-icon" id="am-save">${svgIcon('check')}<span>Save mapping</span></button>
      </div>
      <div id="am-banner"></div>
      <div class="ent-panel-body ent-panel-body--flush" id="am-body">${loading()}</div>
      <div class="ent-panel-body" id="am-msg"></div>
    </div>`;

  let sourceOptions = DEFAULT_SOURCE.slice();
  let localOptions = DEFAULT_LOCAL.slice();
  let maps = DEFAULT_MAPS.map((m) => ({ ...m }));
  let apiReady = false;

  async function load() {
    try {
      const r = await api.getGoogleAttrMaps();
      maps = (r.data && r.data.length) ? r.data : DEFAULT_MAPS.map((m) => ({ ...m }));
      sourceOptions = r.sourceOptions?.length ? r.sourceOptions : DEFAULT_SOURCE.slice();
      localOptions = r.localOptions?.length ? r.localOptions : DEFAULT_LOCAL.slice();
      apiReady = true;
      panel.querySelector('#am-banner').innerHTML = '';
      render();
    } catch (e) {
      apiReady = false;
      const status = e.status || 0;
      panel.querySelector('#am-banner').innerHTML = status === 404
        ? `<div class="alert alert-info" style="margin:0.75rem 1rem 0">Directory API is not available on this server build yet. Showing default mappings — rebuild <code>lilg-api</code> to save changes.</div>`
        : `<div class="alert alert-warning" style="margin:0.75rem 1rem 0">${esc(e.message || 'Could not load mappings')}. Showing defaults.</div>`;
      maps = DEFAULT_MAPS.map((m) => ({ ...m }));
      render();
    }
  }

  function render() {
    const rows = maps.map((m, i) => `
      <tr data-i="${i}">
        <td>
          <select class="form-select am-src">
            ${sourceOptions.map((s) => `<option value="${esc(s)}" ${m.source_attr === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </td>
        <td class="muted" style="text-align:center">→</td>
        <td>
          <select class="form-select am-local">
            ${localOptions.map((o) => `<option value="${esc(o.value)}" ${m.local_attr === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </td>
        <td style="text-align:center"><input type="checkbox" class="am-en" ${m.enabled ? 'checked' : ''}></td>
        <td><button class="btn btn-sm btn-secondary am-up" title="Move up">↑</button>
            <button class="btn btn-sm btn-secondary am-dn" title="Move down">↓</button></td>
      </tr>`).join('');
    panel.querySelector('#am-body').innerHTML = `
      <div class="table-wrap table-wrap--flat">
        <table class="dense-table ds-mapping-table">
          <thead><tr><th>Google attribute</th><th></th><th>Local attribute</th><th>Enabled</th><th>Order</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="ds-mapping-actions">
        <button type="button" class="btn btn-secondary btn-sm btn-with-icon" id="am-add">${svgIcon('plus')}<span>Add mapping</span></button>
      </div>`;

    panel.querySelector('#am-add')?.addEventListener('click', () => {
      maps.push({ source_attr: sourceOptions[0] || 'employeeId', local_attr: 'employee_number', enabled: 1 });
      render();
    });
    panel.querySelectorAll('tr[data-i]').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('.am-up')?.addEventListener('click', () => {
        if (i <= 0) return;
        [maps[i - 1], maps[i]] = [maps[i], maps[i - 1]];
        render();
      });
      tr.querySelector('.am-dn')?.addEventListener('click', () => {
        if (i >= maps.length - 1) return;
        [maps[i + 1], maps[i]] = [maps[i], maps[i + 1]];
        render();
      });
    });
  }

  panel.querySelector('#am-save').addEventListener('click', async () => {
    const rows = [...panel.querySelectorAll('tr[data-i]')];
    const payload = rows.map((tr, idx) => ({
      source_attr: tr.querySelector('.am-src').value,
      local_attr: tr.querySelector('.am-local').value,
      enabled: tr.querySelector('.am-en').checked,
      sort_order: (idx + 1) * 10,
    }));
    if (!apiReady) {
      panel.querySelector('#am-msg').innerHTML = `<div class="alert alert-warning">Cannot save until the API is rebuilt with directory endpoints.</div>`;
      return;
    }
    try {
      const r = await api.saveGoogleAttrMaps(payload);
      maps = r.data || payload;
      panel.querySelector('#am-msg').innerHTML = `<div class="alert alert-success">Attribute mapping saved.</div>`;
      render();
    } catch (e) {
      panel.querySelector('#am-msg').innerHTML = errHtml(e.message);
    }
  });

  load();
}

function initSyncSettingsTab(panel) {
  panel.innerHTML = `
    <div id="ss-stats" class="stat-grid ds-stat-grid ds-stat-grid--placeholder" hidden></div>
    <div class="ent-panel ds-sync-panel">
      <div class="ent-panel-head">
        <div class="panel-meta">
          <span class="ds-sync-panel__badge connector-cell-icon connector-cell-icon--google">${svgIcon('app')}</span>
          <div>
            <h2>Google Workspace sync</h2>
            <p class="subtitle">Field-level sync options and manual run controls for Google directory connectors</p>
          </div>
        </div>
      </div>
      <div class="ent-panel-body" id="ss-body">${loading()}</div>
      <div class="ent-panel-body" id="ss-msg"></div>
    </div>
    <div class="ent-panel ds-sync-logs-panel">
      <div class="ent-panel-head">
        <div class="panel-meta">
          <h2>Sync history</h2>
          <p class="subtitle">Recent connector runs and directory audit events</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm btn-with-icon" id="ss-refresh-logs">${svgIcon('refresh')}<span>Refresh</span></button>
      </div>
      <div class="ent-panel-body ent-panel-body--flush" id="ss-logs">${loading()}</div>
    </div>`;

  async function loadSettings() {
    const defaults = {
      sync_employee_id: 1, sync_department: 1, sync_designation: 1, sync_manager: 1,
      sync_cost_center: 1, sync_mobile: 1, sync_location: 1, sync_profile_photo: 1,
      sync_office_address: 1, disable_deleted: 0, frequency: 'manual',
    };
    let s = defaults;
    let apiReady = true;
    try {
      const r = await api.getGoogleSyncSettings();
      s = { ...defaults, ...(r.data || {}) };
    } catch (e) {
      apiReady = false;
      panel.querySelector('#ss-msg').innerHTML = (e.status === 404)
        ? `<div class="alert alert-info">Directory API is not available on this server build yet. Showing default settings — rebuild <code>lilg-api</code> to enable Save / Sync.</div>`
        : `<div class="alert alert-warning">${esc(e.message || 'Could not load sync settings')}. Showing defaults.</div>`;
    }
    try {
      const labels = {
        ss_sync_employee_id: 'Sync Employee ID',
        ss_sync_department: 'Sync Department',
        ss_sync_designation: 'Sync Designation',
        ss_sync_manager: 'Sync Manager',
        ss_sync_cost_center: 'Sync Cost Center',
        ss_sync_mobile: 'Sync Mobile',
        ss_sync_location: 'Sync Location',
        ss_sync_profile_photo: 'Sync Profile Photo',
        ss_sync_office_address: 'Sync Office Address',
        ss_disable_deleted: 'Disable deleted Google users',
      };
      const chk = (id, on) => `<label class="form-check-row"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${labels[id] || id}</label>`;
      panel.querySelector('#ss-body').innerHTML = `
        <div class="ds-sync-options">
          <h3 class="ds-config-section__title">Attributes to sync</h3>
          <div class="ds-sync-checkgrid">
            ${chk('ss_sync_employee_id', s.sync_employee_id)}
            ${chk('ss_sync_department', s.sync_department)}
            ${chk('ss_sync_designation', s.sync_designation)}
            ${chk('ss_sync_manager', s.sync_manager)}
            ${chk('ss_sync_cost_center', s.sync_cost_center)}
            ${chk('ss_sync_mobile', s.sync_mobile)}
            ${chk('ss_sync_location', s.sync_location)}
            ${chk('ss_sync_profile_photo', s.sync_profile_photo)}
            ${chk('ss_sync_office_address', s.sync_office_address)}
            ${chk('ss_disable_deleted', s.disable_deleted)}
          </div>
        </div>
        <div class="ds-sync-schedule">
          <div class="form-group" style="max-width:280px;margin:0">
            <label class="form-label">Sync frequency</label>
            <select class="form-select" id="ss_frequency">
              <option value="15m" ${s.frequency === '15m' ? 'selected' : ''}>Every 15 minutes</option>
              <option value="30m" ${s.frequency === '30m' ? 'selected' : ''}>Every 30 minutes</option>
              <option value="1h" ${s.frequency === '1h' ? 'selected' : ''}>Every hour</option>
              <option value="manual" ${!s.frequency || s.frequency === 'manual' ? 'selected' : ''}>Manual only</option>
            </select>
          </div>
        </div>
        <div class="ds-sync-actions">
          <button type="button" class="btn btn-primary btn-with-icon" id="ss-save">${svgIcon('check')}<span>Save settings</span></button>
          <button type="button" class="btn btn-secondary btn-with-icon" id="ss-sync-now">${svgIcon('refresh')}<span>Sync now</span></button>
          <button type="button" class="btn btn-secondary" id="ss-full-sync">Run full sync</button>
        </div>
        <div id="ss-sync-progress" class="ds-sync-progress" hidden>
          <div class="muted ds-sync-progress__label" id="ss-prog-label">Syncing…</div>
          <div class="ds-sync-progress__track">
            <div class="ds-sync-progress__bar" id="ss-prog-bar"></div>
          </div>
        </div>`;

      if (!apiReady) {
        panel.querySelector('#ss-save').disabled = true;
        panel.querySelector('#ss-sync-now').disabled = true;
        panel.querySelector('#ss-full-sync').disabled = true;
      }

      panel.querySelector('#ss-save').addEventListener('click', async () => {
        if (!apiReady) {
          panel.querySelector('#ss-msg').innerHTML = `<div class="alert alert-warning">Cannot save until the API is rebuilt with directory endpoints.</div>`;
          return;
        }
        const payload = {
          sync_employee_id: panel.querySelector('#ss_sync_employee_id').checked,
          sync_department: panel.querySelector('#ss_sync_department').checked,
          sync_designation: panel.querySelector('#ss_sync_designation').checked,
          sync_manager: panel.querySelector('#ss_sync_manager').checked,
          sync_cost_center: panel.querySelector('#ss_sync_cost_center').checked,
          sync_mobile: panel.querySelector('#ss_sync_mobile').checked,
          sync_location: panel.querySelector('#ss_sync_location').checked,
          sync_profile_photo: panel.querySelector('#ss_sync_profile_photo').checked,
          sync_office_address: panel.querySelector('#ss_sync_office_address').checked,
          disable_deleted: panel.querySelector('#ss_disable_deleted').checked,
          frequency: panel.querySelector('#ss_frequency').value,
        };
        try {
          await api.saveGoogleSyncSettings(payload);
          panel.querySelector('#ss-msg').innerHTML = `<div class="alert alert-success">Sync settings saved.</div>`;
        } catch (e) {
          panel.querySelector('#ss-msg').innerHTML = errHtml(e.message);
        }
      });

      const runSync = async (fn, label) => {
        if (!apiReady) {
          panel.querySelector('#ss-msg').innerHTML = `<div class="alert alert-warning">Cannot sync until the API is rebuilt with directory endpoints.</div>`;
          return;
        }
        const prog = panel.querySelector('#ss-sync-progress');
        prog.hidden = false;
        panel.querySelector('#ss-prog-label').textContent = label;
        panel.querySelector('#ss-prog-bar').style.width = '35%';
        try {
          const r = await fn();
          panel.querySelector('#ss-prog-bar').style.width = '100%';
          panel.querySelector('#ss-msg').innerHTML = `<div class="alert alert-success">
            ${esc(label)} complete — Added ${r.usersAdded ?? 0}, Updated ${r.usersUpdated ?? 0},
            Disabled ${r.usersDisabled ?? 0}, Failed ${r.usersFailed ?? 0}
            ${r.durationMs != null ? ' · ' + Math.round(r.durationMs / 1000) + 's' : ''}
          </div>`;
          loadLogs();
        } catch (e) {
          panel.querySelector('#ss-msg').innerHTML = errHtml(e.message);
        } finally {
          setTimeout(() => { prog.hidden = true; }, 800);
        }
      };

      panel.querySelector('#ss-sync-now').addEventListener('click', () => runSync(() => api.googleSyncNow(), 'Sync Now'));
      panel.querySelector('#ss-full-sync').addEventListener('click', () => {
        if (!confirm('Run a full Google directory resync? This may take several minutes.')) return;
        runSync(() => api.googleFullSync(), 'Full Sync');
      });
    } catch (e) {
      panel.querySelector('#ss-body').innerHTML = errHtml(e.message);
    }
  }

  async function loadLogs() {
    try {
      const r = await api.googleSyncLogs(30);
      const runs = r.data?.runs || [];
      const audit = r.data?.audit || [];
      panel.querySelector('#ss-logs').innerHTML = `
        <div class="ds-log-section">
          <h3 class="ds-config-section__title">Connector runs</h3>
          <div class="table-wrap table-wrap--flat"><table class="dense-table">
            <thead><tr><th>Type</th><th>Status</th><th>Processed</th><th>OK</th><th>Failed</th><th>Started</th></tr></thead>
            <tbody>${runs.length ? runs.map((x) => `<tr>
              <td><span class="badge badge-neutral">${esc(x.run_type || '')}</span></td>
              <td><span class="badge ${x.status === 'SUCCESS' ? 'badge-success' : x.status === 'FAILED' ? 'badge-danger' : 'badge-warning'}">${esc(x.status || '')}</span></td>
              <td>${esc(String(x.items_processed ?? ''))}</td>
              <td class="text-success">${esc(String(x.items_succeeded ?? ''))}</td>
              <td class="${x.items_failed ? 'text-danger' : ''}">${esc(String(x.items_failed ?? ''))}</td>
              <td class="muted">${x.started_at ? fmtDate(x.started_at) : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="muted">No runs yet</td></tr>'}
            </tbody>
          </table></div>
        </div>
        <div class="ds-log-section">
          <h3 class="ds-config-section__title">Directory audit</h3>
          <div class="table-wrap table-wrap--flat"><table class="dense-table">
            <thead><tr><th>Action</th><th>User</th><th>Admin</th><th>When</th></tr></thead>
            <tbody>${audit.length ? audit.map((a) => `<tr>
              <td>${esc(a.action || '')}</td>
              <td>${esc(a.emp_id || '—')}</td>
              <td>${esc(a.admin_emp_id || '—')}</td>
              <td class="muted">${a.created_at ? fmtDate(a.created_at) : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="muted">No audit entries</td></tr>'}
            </tbody>
          </table></div>
        </div>`;
    } catch (e) {
      const msg = e.status === 404
        ? 'Sync logs will appear here after the API is rebuilt and a sync has run.'
        : (e.message || 'Could not load logs');
      panel.querySelector('#ss-logs').innerHTML = `<p class="muted" style="margin:0;font-size:0.9rem">${esc(msg)}</p>`;
    }
  }

  panel.querySelector('#ss-refresh-logs')?.addEventListener('click', loadLogs);
  loadSettings();
  loadLogs();
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  TAB 2: Universal Directory — Hybrid Identity Users         ║
// ╚══════════════════════════════════════════════════════════════╝
function initUsersTab(panel, me = null) {
  // ── Source badge colours ─────────────────────────────────────────────────────
  const SRC_BADGE = {
    AD:            { label: 'AD',              color: '#0078D4', bg: '#e8f3fc' },
    GOOGLE:        { label: 'Google',          color: '#34a853', bg: '#e8f7ed' },
    ZOHO:          { label: 'Zoho',            color: '#e42527', bg: '#fde9e9' },
    SLACK:         { label: 'Slack',           color: '#4a154b', bg: '#f0e9f0' },
    GITHUB:        { label: 'GitHub',          color: '#24292e', bg: '#ebebeb' },
    HRMS:          { label: 'HRMS',            color: '#ff6600', bg: '#fff0e6' },
    NEXSID:        { label: 'NexSid',          color: '#5c4ee5', bg: '#efedfc' },
    SALESMAN_OTP:  { label: 'Salesman OTP',    color: '#0aa',    bg: '#e6fbfb' },
    BIGQUERY:      { label: 'BigQuery',        color: '#4285f4', bg: '#eaf1fd' },
    AWS_IDC:       { label: 'AWS IDC',         color: '#ff9900', bg: '#fff5e6' },
    LOCAL:         { label: 'Local',           color: '#6c757d', bg: '#f0f0f0' },
  };

  function srcBadge(src) {
    const b = SRC_BADGE[src] || { label: src, color: '#555', bg: '#eee' };
    const cls = { AD: 'ad', GOOGLE: 'google', LOCAL: 'local' }[src] || 'default';
    return `<span class="ds-src-badge ds-src-badge--${cls}">${esc(b.label)}</span>`;
  }

  function stateBadge(s) {
    const map = { ACTIVE:'badge-success', SUSPENDED:'badge-warning', TERMINATED:'badge-danger', INACTIVE:'badge-neutral' };
    return `<span class="badge ${map[s]||'badge-neutral'}">${esc(s||'—')}</span>`;
  }

  // ── Build shell ──────────────────────────────────────────────────────────────
  panel.innerHTML = `
    <div id="ud-stats" class="stat-grid ds-stat-grid" hidden></div>
    <div class="ent-panel ds-users-panel">
      <div class="ent-panel-head">
        <div class="panel-meta">
          <h2>Hybrid directory users</h2>
          <p class="subtitle">Unified view across Active Directory, Google Workspace, and local accounts</p>
        </div>
        <div class="page-toolbar-actions">
          <button type="button" class="btn btn-secondary btn-sm btn-with-icon" id="ud-refresh-btn">${svgIcon('refresh')}<span>Refresh</span></button>
          <button type="button" class="btn btn-secondary btn-sm" id="ud-bulk-upload-btn">Bulk upload</button>
          <button type="button" class="btn btn-primary btn-sm btn-with-icon" id="ud-create-btn">${svgIcon('plus')}<span>Local user</span></button>
        </div>
      </div>
      <div class="ent-panel-body">
        <div class="filter-toolbar ds-users-filters">
          <input class="form-input filter-toolbar-search" id="ud-search" placeholder="Search name, email, employee ID…">
          <select class="form-select" id="ud-src-filter">
            <option value="">All sources</option>
            <option value="AD">Active Directory</option>
            <option value="GOOGLE">Google Workspace</option>
            <option value="LOCAL">Local only</option>
          </select>
          <select class="form-select" id="ud-state-filter">
            <option value="">Available</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="__all__">All states</option>
          </select>
          <input class="form-input" id="ud-dept-filter" placeholder="Department" style="max-width:140px">
          <input class="form-input" id="ud-mgr-filter" placeholder="Manager" style="max-width:140px">
          <input class="form-input" id="ud-loc-filter" placeholder="Location" style="max-width:120px">
          <select class="form-select" id="ud-type-filter">
            <option value="">All types</option>
            <option value="CORPORATE">Corporate</option>
            <option value="STORE">Store</option>
            <option value="PLANT">Plant</option>
            <option value="DC">DC</option>
          </select>
        </div>
        <div id="ud-bulk-bar" class="ds-bulk-bar" hidden>
          <span class="muted"><strong id="ud-sel-count">0</strong> selected</span>
          <select class="form-select" id="ud-bulk-action" style="max-width:220px">
            <option value="">Bulk actions…</option>
            <option value="enable">Bulk enable</option>
            <option value="disable">Bulk disable</option>
            <option value="delete">Bulk delete</option>
            <option value="reset_password">Bulk reset password</option>
            <option value="send_welcome">Bulk send welcome email</option>
            <option value="export">Bulk export</option>
          </select>
          <button type="button" class="btn btn-sm btn-primary" id="ud-bulk-run">Apply</button>
          <button type="button" class="btn btn-sm btn-secondary" id="ud-bulk-clear">Clear</button>
        </div>
        <div id="ud-toast" class="ds-inline-toast"></div>
        <div id="ud-table-area">${loading()}</div>
      </div>
    </div>`;

  let allUsers = [];
  let searchTimer = null;
  const selected = new Set();
  const PAGE_SIZE = 100;
  let listOffset = 0;
  let listTotal = 0;
  let listStats = { withAd: 0, withGoogle: 0, localOnly: 0 };

  function toast(msg, type = 'success') {
    const el = panel.querySelector('#ud-toast');
    if (!el) return;
    el.innerHTML = `<div class="alert alert-${type === 'error' ? 'error' : type === 'info' ? 'info' : 'success'}" style="margin:0">${esc(msg)}</div>`;
    setTimeout(() => { if (el) el.innerHTML = ''; }, 4500);
  }

  function currentFilters() {
    return {
      department: panel.querySelector('#ud-dept-filter')?.value?.trim() || '',
      manager: panel.querySelector('#ud-mgr-filter')?.value?.trim() || '',
      location: panel.querySelector('#ud-loc-filter')?.value?.trim() || '',
      employeeType: panel.querySelector('#ud-type-filter')?.value || '',
    };
  }

  // ── Load & render user list ──────────────────────────────────────────────────
  async function loadUsers(q = '', state = '', source = '', opts = {}) {
    const resetPage = opts.resetPage !== false;
    if (resetPage) listOffset = 0;
    panel.querySelector('#ud-table-area').innerHTML = loading();
    try {
      const includeInactive = state === '__all__';
      const apiState = includeInactive ? '' : state;
      const r = await api.listUsersUnified(
        q, apiState, source, PAGE_SIZE, listOffset, includeInactive, currentFilters(),
      );
      allUsers = Array.isArray(r) ? r : (r?.data ?? []);
      listTotal = Array.isArray(r) ? allUsers.length : Number(r?.total ?? allUsers.length);
      listStats = {
        withAd: Number(r?.stats?.withAd ?? 0),
        withGoogle: Number(r?.stats?.withGoogle ?? 0),
        localOnly: Number(r?.stats?.localOnly ?? 0),
      };
      selected.clear();
      updateBulkBar();
      renderStats();
      renderTable(allUsers);
    } catch(e) {
      panel.querySelector('#ud-table-area').innerHTML = errHtml(e.message);
    }
  }

  function renderStats() {
    const statsEl = panel.querySelector('#ud-stats');
    statsEl.hidden = false;
    statsEl.innerHTML = [
      statCard('users', 'Directory users', listTotal, 'Matching current filters', 'primary'),
      statCard('server', 'With AD', listStats.withAd, 'Linked to Active Directory', 'info'),
      statCard('app', 'With Google', listStats.withGoogle, 'Linked to Google Workspace', 'success'),
      statCard('user', 'Local only', listStats.localOnly, 'No external directory link', 'teal'),
    ].join('');
  }

  function updateBulkBar() {
    const bar = panel.querySelector('#ud-bulk-bar');
    const count = selected.size;
    if (bar) {
      bar.hidden = count === 0;
      const c = panel.querySelector('#ud-sel-count');
      if (c) c.textContent = String(count);
    }
  }

  function renderTable(users) {
    if (!users.length) {
      panel.querySelector('#ud-table-area').innerHTML = `
        <div class="empty-panel ds-empty-panel ds-empty-panel--compact">
          <div class="ds-empty-icon">${svgIcon('users')}</div>
          <p class="muted">No users match your filters.</p>
        </div>`;
      return;
    }

    const rows = users.map(u => {
      const sources = (u.identity_sources || '').split(',').filter(Boolean);
      const badges  = sources.length ? sources.map(srcBadge).join('') : srcBadge('LOCAL');
      const displayId = u.employee_number || u.emp_id;
      const init = (u.full_name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      const checked = selected.has(u.emp_id) ? 'checked' : '';
      return `<tr style="cursor:pointer" class="ud-row" data-empid="${esc(u.emp_id)}">
        <td onclick="event.stopPropagation()"><input type="checkbox" class="ud-check" data-empid="${esc(u.emp_id)}" ${checked}></td>
        <td>
          <div class="user-cell">
            ${u.photo_url
              ? `<img class="user-cell-avatar" src="${esc(u.photo_url)}" alt="" style="object-fit:cover;width:32px;height:32px;border-radius:50%">`
              : `<div class="user-cell-avatar">${esc(init)}</div>`}
            <div>
              <div class="user-cell-name">${esc(u.full_name||'—')}</div>
              <div class="user-cell-meta">${esc(displayId)}</div>
            </div>
          </div>
        </td>
        <td class="muted">${esc(u.email_corp||'—')}</td>
        <td class="muted">${esc(u.dept_id||'—')}</td>
        <td class="muted">${esc(u.designation || u.role || '—')}</td>
        <td>${stateBadge(u.ilg_state)}</td>
        <td>${badges}</td>
        <td class="actions">
          <button class="btn btn-sm btn-secondary ud-profile-btn" data-empid="${esc(u.emp_id)}">Profile</button>
        </td>
      </tr>`;
    }).join('');

    const from = listTotal === 0 ? 0 : listOffset + 1;
    const to = Math.min(listOffset + users.length, listTotal);
    const page = Math.floor(listOffset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(listTotal / PAGE_SIZE));
    const canPrev = listOffset > 0;
    const canNext = listOffset + PAGE_SIZE < listTotal;

    panel.querySelector('#ud-table-area').innerHTML = `
      <div class="table-wrap table-wrap--flat">
        <table class="dense-table ds-users-table">
          <thead><tr>
            <th style="width:28px"><input type="checkbox" id="ud-check-all" title="Select page"></th>
            <th>User</th><th>Email</th><th>Department</th><th>Designation</th><th>State</th><th>Sources</th><th class="actions-col"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="ds-table-footer">
        <span class="muted">Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${listTotal.toLocaleString()}</span>
        <div class="ds-table-footer__pager">
          <button type="button" class="btn btn-sm btn-secondary" id="ud-page-prev" ${canPrev ? '' : 'disabled'}>Previous</button>
          <span class="muted">Page ${page} / ${pages}</span>
          <button type="button" class="btn btn-sm btn-secondary" id="ud-page-next" ${canNext ? '' : 'disabled'}>Next</button>
        </div>
      </div>`;

    panel.querySelector('#ud-check-all')?.addEventListener('change', (e) => {
      const on = e.target.checked;
      users.forEach((u) => { if (on) selected.add(u.emp_id); else selected.delete(u.emp_id); });
      panel.querySelectorAll('.ud-check').forEach((c) => { c.checked = on; });
      updateBulkBar();
    });
    panel.querySelectorAll('.ud-check').forEach((c) => {
      c.addEventListener('change', () => {
        if (c.checked) selected.add(c.dataset.empid);
        else selected.delete(c.dataset.empid);
        updateBulkBar();
      });
    });

    panel.querySelectorAll('.ud-row, .ud-profile-btn').forEach(el2 => {
      el2.addEventListener('click', (e) => {
        if (e.target.closest('.ud-check')) return;
        e.stopPropagation();
        const empId = el2.dataset.empid || el2.closest('tr')?.dataset?.empid;
        if (empId) openProfileDrawer(empId);
      });
    });

    panel.querySelector('#ud-page-prev')?.addEventListener('click', () => {
      if (!canPrev) return;
      listOffset = Math.max(0, listOffset - PAGE_SIZE);
      const f = getFilters();
      loadUsers(f.q, f.state, f.source, { resetPage: false });
    });
    panel.querySelector('#ud-page-next')?.addEventListener('click', () => {
      if (!canNext) return;
      listOffset += PAGE_SIZE;
      const f = getFilters();
      loadUsers(f.q, f.state, f.source, { resetPage: false });
    });
  }

  // ── Full profile slide-in drawer (godmode) ──────────────────────────────────
  // Manual profile edit (when directory sync did not fill fields)
  function openEditProfileModal(emp, onSaved) {
    const bd = openModal(`<div class="modal" style="width:640px;max-width:96vw">
      <div class="modal-header"><h2>Edit profile — ${esc(emp.full_name || emp.emp_id || '')}</h2></div>
      <div class="modal-body">
        <p class="muted" style="font-size:0.82rem;margin:0 0 0.85rem">Updates are stored on the IdP user record (sync status becomes <strong>MANUAL</strong>). A later Google sync may overwrite fields that are enabled under Sync Settings.</p>
        <div id="pp-edit-err"></div>
        <div class="form-2col">
          <div class="form-group">
            <label class="form-label">First name</label>
            <input class="form-input" id="pp-e-first" value="${esc(emp.first_name || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Last name</label>
            <input class="form-input" id="pp-e-last" value="${esc(emp.last_name || '')}">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">Display name</label>
            <input class="form-input" id="pp-e-display" value="${esc(emp.full_name || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Employee ID</label>
            <input class="form-input" id="pp-e-empno" value="${esc(emp.employee_number || '')}" placeholder="HR / Google employee ID">
          </div>
          <div class="form-group">
            <label class="form-label">Username</label>
            <input class="form-input" id="pp-e-user" value="${esc(emp.username || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Department</label>
            <input class="form-input" id="pp-e-dept" value="${esc(emp.dept_id || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Designation</label>
            <input class="form-input" id="pp-e-role" value="${esc(emp.role || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Mobile</label>
            <input class="form-input" id="pp-e-mobile" value="${esc(emp.mobile || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Location</label>
            <input class="form-input" id="pp-e-loc" value="${esc(emp.location || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Cost center</label>
            <input class="form-input" id="pp-e-cc" value="${esc(emp.cost_center || '')}">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">Office address</label>
            <input class="form-input" id="pp-e-addr" value="${esc(emp.office_address || '')}">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="pp-e-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="pp-e-save">Save profile</button>
      </div>
    </div>`);

    bd.querySelector('#pp-e-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#pp-e-save').addEventListener('click', async () => {
      const errEl = bd.querySelector('#pp-edit-err');
      errEl.innerHTML = '';
      const btn = bd.querySelector('#pp-e-save');
      const payload = {
        firstName: bd.querySelector('#pp-e-first').value.trim() || null,
        lastName: bd.querySelector('#pp-e-last').value.trim() || null,
        displayName: bd.querySelector('#pp-e-display').value.trim() || undefined,
        employeeNumber: bd.querySelector('#pp-e-empno').value.trim() || null,
        username: bd.querySelector('#pp-e-user').value.trim() || null,
        department: bd.querySelector('#pp-e-dept').value.trim() || null,
        designation: bd.querySelector('#pp-e-role').value.trim() || null,
        mobile: bd.querySelector('#pp-e-mobile').value.trim() || null,
        location: bd.querySelector('#pp-e-loc').value.trim() || null,
        costCenter: bd.querySelector('#pp-e-cc').value.trim() || null,
        officeAddress: bd.querySelector('#pp-e-addr').value.trim() || null,
      };
      if (!payload.displayName) {
        errEl.innerHTML = errHtml('Display name is required');
        return;
      }
      btn.disabled = true;
      try {
        await api.updateUserProfile(emp.emp_id, payload);
        bd.remove();
        if (typeof onSaved === 'function') await onSaved();
      } catch (e) {
        errEl.innerHTML = errHtml(e.message || 'Save failed');
        btn.disabled = false;
      }
    });
  }

  async function openProfileDrawer(empId) {
    // Remove any existing panel
    document.querySelector('.profile-panel-overlay')?.remove();

    // Build overlay + slide-in panel
    const overlay = document.createElement('div');
    overlay.className = 'profile-panel-overlay';
    overlay.innerHTML = `
      <div class="profile-panel" id="pp-panel">
        <!-- ── Header ───────────────────────────────────────────────────────── -->
        <div class="pp-header" id="pp-header">
          <div class="pp-avatar" id="pp-avatar">?</div>
          <div>
            <div class="pp-name" id="pp-name">Loading…</div>
            <div class="pp-sub" id="pp-sub"></div>
            <div class="pp-badges" id="pp-badges"></div>
          </div>
          <div class="pp-actions">
            <div class="pp-lifecycle" id="pp-lifecycle"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="pp-close-x" title="Close (Esc)">Close</button>
          </div>
        </div>

        <!-- ── Tab bar ──────────────────────────────────────────────────────── -->
        <div class="pp-tabs" id="pp-tabs">
          <button class="pp-tab active" data-tab="overview">Overview</button>
          <button class="pp-tab" data-tab="identity">Identity Links <span class="pp-tab-badge" id="pp-tab-id-count" style="display:none"></span></button>
          <button class="pp-tab" data-tab="sessions">Sessions <span class="pp-tab-badge" id="pp-tab-sess-count" style="display:none"></span></button>
          <button class="pp-tab" data-tab="mfa">MFA</button>
          <button class="pp-tab" data-tab="password">Password Reset</button>
        </div>

        <!-- ── Tab body ─────────────────────────────────────────────────────── -->
        <div class="pp-body" id="pp-body">${loading()}</div>
      </div>`;

    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.querySelector('#pp-panel').classList.add('pp-open');
      });
    });

    // Close helpers — Close button / Esc only (no outside-click dismiss)
    function closePanel() {
      document.removeEventListener('keydown', onKey);
      const panel2 = overlay.querySelector('#pp-panel');
      if (!panel2 || !overlay.isConnected) {
        overlay.remove();
        return;
      }
      panel2.classList.remove('pp-open');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        overlay.remove();
      };
      panel2.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 350);
    }
    const onKey = (e) => { if (e.key === 'Escape') closePanel(); };
    overlay.querySelector('#pp-close-x').addEventListener('click', closePanel);
    document.addEventListener('keydown', onKey);

    // State
    let profileData = null;
    let activeTab = 'overview';
    let lastPasswordResetHtml = '';

    function formatPasswordResetResults(r) {
      const results = r.results || [];
      const rows = results.map(res => `
              <div class="pp-reset-result ${res.status === 'SUCCESS' ? 'success' : res.status === 'SKIPPED' ? '' : 'fail'}">
                ${srcBadge(res.system)}
                <span style="flex:1">${res.status === 'SUCCESS'
                  ? '✓ Updated successfully'
                  : res.status === 'SKIPPED'
                    ? `— ${esc(res.error || 'Skipped')}`
                    : `✗ ${esc(res.error || 'Failed')}`}</span>
              </div>`).join('');

      const summary = r.summary || (r.success ? 'Password reset across all linked systems' : 'Password reset failed');
      const banner = r.success
        ? `<div class="pp-alert success" style="margin-bottom:0.75rem">✓ ${esc(summary)}</div>`
        : `<div class="pp-alert error"   style="margin-bottom:0.75rem">⚠ ${esc(summary)}</div>`;
      return banner + rows;
    }

    function activeLinks() {
      return (profileData?.identityLinks || []).filter(l => l.status !== 'DELETED');
    }

    function profileSourceBadges(emp, links) {
      const fromLinks = [...new Set(links.map(l => l.system))];
      if (fromLinks.length) return fromLinks;
      if ((emp.emp_id || '').startsWith('AD-')) return ['AD'];
      if ((emp.emp_id || '').startsWith('GW-')) return ['GOOGLE'];
      return [];
    }

    // ── Render header ───────────────────────────────────────────────────────────
    function renderHeader() {
      const emp   = profileData.employee      || {};
      const links = activeLinks();
      const sessions = profileData.recentLogins || [];
      const mfa = profileData.mfaStatus || { enabled: false, enrolled: false };

      const initial = (emp.full_name || empId).charAt(0).toUpperCase();
      overlay.querySelector('#pp-avatar').textContent = initial;
      overlay.querySelector('#pp-name').textContent   = emp.full_name || empId;
      overlay.querySelector('#pp-sub').textContent    =
        [emp.employee_number || emp.emp_id, emp.email_corp, emp.dept_id].filter(Boolean).join('  ·  ');

      const activeSources = profileSourceBadges(emp, links);
      overlay.querySelector('#pp-badges').innerHTML =
        stateBadge(emp.ilg_state) +
        (activeSources.length ? activeSources.map(srcBadge).join('') : srcBadge('LOCAL')) +
        (mfa.enabled ? `<span class="badge badge-success">MFA</span>` : '');

      // Tab counters
      const idCount = links.length;
      const sessCount = sessions.length;
      const idBadge   = overlay.querySelector('#pp-tab-id-count');
      const sessBadge = overlay.querySelector('#pp-tab-sess-count');
      if (idCount)   { idBadge.textContent   = idCount;   idBadge.style.display   = ''; }
      if (sessCount) { sessBadge.textContent = sessCount; sessBadge.style.display = ''; }

      // Lifecycle buttons
      const state        = (emp.ilg_state || '').toUpperCase();
      const canSuspend   = state === 'ACTIVE' || state === 'REACTIVATED';
      const canUnsuspend = state === 'SUSPENDED_HR';
      const canTerminate = state !== 'DEPARTED' && state !== 'DEPROVISIONED';

      overlay.querySelector('#pp-lifecycle').innerHTML = [
        canSuspend   ? `<button class="btn btn-sm btn-warning"  id="pp-btn-suspend">⏸ Suspend</button>`    : '',
        canUnsuspend ? `<button class="btn btn-sm btn-success"  id="pp-btn-unsuspend">▶ Unsuspend</button>` : '',
        canTerminate ? `<button class="btn btn-sm btn-danger"   id="pp-btn-terminate">✕ Terminate</button>` : '',
      ].join('');

      if (canSuspend) {
        overlay.querySelector('#pp-btn-suspend').addEventListener('click', async () => {
          if (!confirm(`Suspend ${emp.full_name}?\nThey will lose all active sessions and login access immediately.`)) return;
          try { await api.suspendUser(empId); reloadProfile(); }
          catch(e) { alert('Failed to suspend: ' + e.message); }
        });
      }
      if (canUnsuspend) {
        overlay.querySelector('#pp-btn-unsuspend').addEventListener('click', async () => {
          if (!confirm(`Restore access for ${emp.full_name}?`)) return;
          try { await api.unsuspendUser(empId); reloadProfile(); }
          catch(e) { alert('Failed to unsuspend: ' + e.message); }
        });
      }
      if (canTerminate) {
        overlay.querySelector('#pp-btn-terminate').addEventListener('click', async () => {
          if (!confirm(`TERMINATE ${emp.full_name}?\n\nThis will permanently revoke all access and cannot be undone.`)) return;
          try { await api.terminateUser(empId); reloadProfile(); }
          catch(e) { alert('Failed to terminate: ' + e.message); }
        });
      }
    }

    // ── Render tab content ──────────────────────────────────────────────────────
    function renderTab(tab) {
      activeTab = tab;
      overlay.querySelectorAll('.pp-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab));

      if (!profileData) {
        overlay.querySelector('#pp-body').innerHTML = loading();
        return;
      }

      const emp          = profileData.employee      || {};
      const links        = activeLinks();
      const recentLogins = profileData.recentLogins  || [];
      const writebackLog = profileData.writebackLog  || [];
      const mfaStatus    = profileData.mfaStatus     || { enrolled: false, enabled: false, remainingBackupCodes: 0, lastUsedAt: null };
      const activeSources = profileSourceBadges(emp, links);
      const body         = overlay.querySelector('#pp-body');

      // ── Overview tab ─────────────────────────────────────────────────────────
      if (tab === 'overview') {
        const attrs = [
          ['Employee ID',      esc(emp.employee_number || '—')],
          ['Directory ID',     esc(emp.emp_id || '—')],
          ['Username',         esc(emp.username || '—')],
          ['Corporate Email',  esc(emp.email_corp || '—')],
          ['Department',       esc(emp.dept_id    || '—')],
          ['Designation',      emp.role ? esc(emp.role) : '<span class="muted">—</span>'],
          ['Manager',          emp.manager_name
            ? `${esc(emp.manager_name)} <span class="muted" style="font-size:0.8rem">&lt;${esc(emp.manager_email||'')}&gt;</span>`
            : '—'],
          ['Location',         esc(emp.location || emp.city || '—')],
          ['Cost Center',      esc(emp.cost_center || '—')],
          ['Phone',            esc(emp.mobile || '—')],
          ['Office Address',   esc(emp.office_address || '—')],
          ['Joining Date',     emp.hire_date ? fmtDate(emp.hire_date) : '—'],
          ['Employment Type',  esc(emp.employment_type || '—')],
          ['State',            stateBadge(emp.ilg_state)],
          ['Source',           activeSources.length ? activeSources.map(srcBadge).join('') : srcBadge('LOCAL')],
          ['Last Sync Time',   emp.attrs_synced_at ? fmtDate(emp.attrs_synced_at)
            : (links.find(l => l.last_synced_at)?.last_synced_at ? fmtDate(links.find(l => l.last_synced_at).last_synced_at) : '—')],
          ['Sync Status',      emp.sync_status
            ? `<span class="badge ${emp.sync_status==='SYNCED'?'badge-success':emp.sync_status==='MANUAL'?'badge-info':'badge-neutral'}">${esc(emp.sync_status)}</span>`
            : '—'],
          ['Portal Administrator', emp.portal_role
            ? `<span class="badge badge-primary">${esc(emp.portal_role)}</span>`
            : '<span class="muted">None</span>'],
          ['Last Login',       emp.last_login_at ? fmtDate(emp.last_login_at) : '—'],
        ];

        body.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.35rem">
            <p class="pp-section-title" style="margin:0">Account Details</p>
            <button type="button" class="btn btn-sm btn-primary" id="pp-edit-profile">Edit profile</button>
          </div>
          <p class="muted" style="font-size:0.78rem;margin:0 0 0.75rem">If Google/AD sync did not fill department or employee ID, update them here.</p>
          <div class="pp-attr-grid">
            ${attrs.map(([k, v]) => `
              <div class="pp-attr">
                <span class="pp-attr-label">${k}</span>
                <span class="pp-attr-value">${v}</span>
              </div>`).join('')}
          </div>

          ${writebackLog.length ? `
          <p class="pp-section-title" style="margin-top:0.5rem">Password Writeback History</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>System</th><th>Status</th><th>Error</th><th>When</th></tr></thead>
              <tbody>
                ${writebackLog.slice(0, 5).map(w => `<tr>
                  <td>${srcBadge(w.target_system)}</td>
                  <td><span class="badge ${w.status==='SUCCESS'?'badge-success':'badge-danger'}">${esc(w.status)}</span></td>
                  <td class="muted" style="font-size:0.78rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w.error||'')}</td>
                  <td class="muted" style="font-size:0.78rem;white-space:nowrap">${w.created_at ? fmtDate(w.created_at) : '—'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : ''}`;

        overlay.querySelector('#pp-edit-profile')?.addEventListener('click', () => {
          openEditProfileModal(emp, async () => {
            await reloadProfile(true);
            try { await loadUsers(); } catch { /* list may not be visible */ }
          });
        });
      }

      // ── Identity Links tab ───────────────────────────────────────────────────
      else if (tab === 'identity') {
        const linkRows = links.length
          ? links.map(l => `<tr>
              <td>${srcBadge(l.system)}</td>
              <td style="font-size:0.8rem;word-break:break-all;max-width:160px">${esc(l.external_id||'—')}</td>
              <td><span class="badge ${l.status==='ACTIVE'?'badge-success':l.status==='DISABLED'?'badge-warning':'badge-neutral'}">${esc(l.status)}</span></td>
              <td style="font-size:0.75rem">${esc(l.auth_kind||'—')}</td>
              <td style="font-size:0.75rem;white-space:nowrap">${l.last_synced_at ? fmtDate(l.last_synced_at) : '—'}</td>
              <td>${l.drift_flag ? '<span class="badge badge-warning" title="Attribute drift detected">⚠ Drift</span>' : ''}</td>
            </tr>`).join('')
          : `<tr><td colspan="6"><div class="pp-empty"><div class="pp-empty-icon">🔗</div>
              No external identities linked yet.<br>
              <span class="muted" style="font-size:0.85rem">Run the AD and Google connector sync — links are created automatically (AD, Google, or both).</span>
            </div></td></tr>`;

        body.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;gap:1rem">
            <div>
              <p class="pp-section-title" style="margin:0">Linked Identity Sources</p>
              <p class="muted" style="font-size:0.82rem;margin:0.35rem 0 0;line-height:1.5">
                External identities (Active Directory, Google Workspace, etc.) are managed by connector sync — not manual linking.
              </p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Source</th><th>External ID</th><th>Status</th><th>Auth</th><th>Last Synced</th><th>Drift</th></tr></thead>
              <tbody>${linkRows}</tbody>
            </table>
          </div>`;
      }

      // ── Sessions tab ─────────────────────────────────────────────────────────
      else if (tab === 'sessions') {
        const sessRows = recentLogins.length
          ? recentLogins.map(s => `<tr>
              <td style="font-size:0.8rem;white-space:nowrap">${s.started_at ? fmtDate(s.started_at) : '—'}</td>
              <td style="font-size:0.8rem">${esc(s.iss||'—')}</td>
              <td style="font-size:0.8rem">${esc(s.device_info||'—')}</td>
              <td style="font-size:0.78rem">${esc(s.geo_location||'—')}</td>
              <td style="font-size:0.78rem;font-family:var(--mono,'JetBrains Mono',monospace)">${esc(s.ip||'—')}</td>
              <td style="font-size:0.78rem;white-space:nowrap">${s.last_active_at ? fmtDate(s.last_active_at) : '—'}</td>
            </tr>`).join('')
          : '';

        body.innerHTML = recentLogins.length
          ? `
            <p class="pp-section-title">Active & Recent Sessions (last 10)</p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Started</th><th>Provider</th><th>Device</th><th>Location</th><th>IP</th><th>Last Active</th></tr></thead>
                <tbody>${sessRows}</tbody>
              </table>
            </div>`
          : `<div class="pp-empty"><div class="pp-empty-icon">🖥️</div>No recent sessions found.</div>`;
      }

      // ── MFA tab ─────────────────────────────────────────────────────────────
      else if (tab === 'mfa') {
        const emp = profileData.employee || {};
        const isEnforced = !!(emp.mfa_enforced);
        const statusBadge = mfaStatus.enabled
          ? `<span class="badge badge-success">Enabled</span>`
          : mfaStatus.pendingEnrollment
            ? `<span class="badge badge-warning">Enrollment pending</span>`
            : `<span class="badge badge-neutral">Disabled</span>`;

        body.innerHTML = `
          <p class="pp-section-title">Multi-factor Authentication</p>
          <div class="pp-attr-grid" style="margin-bottom:1rem">
            <div class="pp-attr"><span class="pp-attr-label">Status</span><span class="pp-attr-value">${statusBadge}</span></div>
            <div class="pp-attr"><span class="pp-attr-label">Enforcement</span><span class="pp-attr-value">
              ${isEnforced
                ? '<span class="badge badge-danger">🔒 Enforced</span>'
                : '<span class="badge badge-neutral">Not enforced</span>'}
            </span></div>
            <div class="pp-attr"><span class="pp-attr-label">Backup Codes Left</span><span class="pp-attr-value">${Number(mfaStatus.remainingBackupCodes || 0)}</span></div>
            <div class="pp-attr"><span class="pp-attr-label">Last Used</span><span class="pp-attr-value">${mfaStatus.lastUsedAt ? fmtDate(mfaStatus.lastUsedAt) : '—'}</span></div>
            <div class="pp-attr"><span class="pp-attr-label">Policy Exclusion</span><span class="pp-attr-value">
              ${mfaStatus.policyExcludedByGroup
                ? '<span class="badge badge-warning">Excluded by group policy</span>'
                : '<span class="badge badge-neutral">No exclusion</span>'}
            </span></div>
          </div>

          <!-- Enforcement actions -->
          <div style="background:var(--surface-3);border-radius:var(--radius);padding:0.85rem;margin-bottom:1rem;border:1px solid var(--border)">
            <div style="font-weight:600;font-size:0.875rem;margin-bottom:0.5rem">🔒 MFA Enforcement</div>
            <p class="muted" style="font-size:0.82rem;margin-bottom:0.65rem">
              Enforced users must complete MFA setup before accessing the portal, regardless of global policy.
            </p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
              <button class="btn btn-sm ${isEnforced ? 'btn-secondary' : 'btn-primary'}" id="pp-mfa-enforce">
                ${isEnforced ? '✓ Enforcement Active' : '🔒 Enforce MFA for this user'}
              </button>
              ${isEnforced ? `<button class="btn btn-sm btn-ghost" id="pp-mfa-unenforce">Remove Enforcement</button>` : ''}
            </div>
          </div>

          <!-- MFA management actions -->
          <div style="margin-bottom:0.75rem">
            <div style="font-weight:600;font-size:0.875rem;margin-bottom:0.5rem">MFA Management</div>
            <div id="pp-mfa-actions" style="display:flex;gap:0.5rem;flex-wrap:wrap"></div>
          </div>
          <div id="pp-mfa-msg" style="margin-top:0.75rem"></div>`;

        const actionsEl = body.querySelector('#pp-mfa-actions');
        const msgEl = body.querySelector('#pp-mfa-msg');

        // Enforce / un-enforce
        body.querySelector('#pp-mfa-enforce')?.addEventListener('click', async () => {
          if (isEnforced) return;
          if (!confirm(`Enforce MFA for ${emp.full_name || empId}? They will be required to enroll at next login.`)) return;
          try {
            await api.adminMfaEnforce(empId, true);
            msgEl.innerHTML = `<div class="pp-alert success">✓ MFA enforcement enabled. Reloading…</div>`;
            setTimeout(() => reloadProfile(true), 1000);
          } catch (e) { msgEl.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
        });
        body.querySelector('#pp-mfa-unenforce')?.addEventListener('click', async () => {
          try {
            await api.adminMfaEnforce(empId, false);
            msgEl.innerHTML = `<div class="pp-alert success">✓ MFA enforcement removed. Reloading…</div>`;
            setTimeout(() => reloadProfile(true), 1000);
          } catch (e) { msgEl.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
        });

        if (mfaStatus.enabled) {
          actionsEl.innerHTML = `
            <button class="btn btn-sm btn-secondary" id="pp-mfa-reset">↺ Reset MFA (force fresh enrollment)</button>
            <button class="btn btn-sm btn-secondary" id="pp-mfa-regen">Regenerate Backup Codes</button>
            <button class="btn btn-sm btn-danger" id="pp-mfa-disable">Disable MFA</button>`;

          body.querySelector('#pp-mfa-reset').addEventListener('click', async () => {
            if (!confirm(`Reset MFA for ${emp.full_name || empId}? Current MFA will be removed and fresh enrollment will be required at next login.`)) return;
            try {
              await api.adminMfaReset(empId, true);
              msgEl.innerHTML = `<div class="pp-alert success">✓ MFA reset. User must enroll again at next login.</div>`;
              reloadProfile(true);
            } catch (e) { msgEl.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
          });

          body.querySelector('#pp-mfa-regen').addEventListener('click', async () => {
            if (!confirm('Regenerate backup codes? Existing codes will stop working immediately.')) return;
            try {
              const r = await api.adminMfaRegenCodes(empId);
              msgEl.innerHTML = `<div class="pp-alert warning">
                <div style="font-weight:600;margin-bottom:0.5rem">Save these backup codes (shown once)</div>
                <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;font-family:var(--mono,'JetBrains Mono',monospace)">
                  ${(r.backupCodes || []).map((c) => `<code style="padding:0.35rem 0.5rem;background:rgba(0,0,0,0.05);border-radius:6px">${esc(c)}</code>`).join('')}
                </div>
              </div>`;
              reloadProfile(true);
            } catch (e) { msgEl.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
          });

          body.querySelector('#pp-mfa-disable').addEventListener('click', async () => {
            if (!confirm('Disable MFA for this user? They will login without second factor.')) return;
            try {
              await api.adminMfaDisable(empId);
              await api.adminMfaEnforce(empId, false);
              msgEl.innerHTML = `<div class="pp-alert success">MFA disabled for user.</div>`;
              reloadProfile(true);
            } catch (e) { msgEl.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
          });

        } else {
          actionsEl.innerHTML = `
            <button class="btn btn-sm btn-primary" id="pp-mfa-start">Start MFA Enrollment for User</button>
            <button class="btn btn-sm btn-secondary" id="pp-mfa-reset">↺ Reset MFA (force fresh enrollment)</button>`;
          const enrollDiv = document.createElement('div');
          enrollDiv.style.marginTop = '1rem';
          body.appendChild(enrollDiv);

          body.querySelector('#pp-mfa-reset').addEventListener('click', async () => {
            if (!confirm(`Reset MFA for ${emp.full_name || empId}? Any existing MFA setup will be cleared and fresh enrollment will be required at next login.`)) return;
            try {
              await api.adminMfaReset(empId, true);
              msgEl.innerHTML = `<div class="pp-alert success">✓ MFA reset. User must enroll again at next login.</div>`;
              reloadProfile(true);
            } catch (e) { msgEl.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
          });

          body.querySelector('#pp-mfa-start').addEventListener('click', async () => {
            const btn = body.querySelector('#pp-mfa-start');
            btn.disabled = true; btn.textContent = 'Generating…';
            try {
              const r = await api.adminMfaEnroll(empId);
              enrollDiv.innerHTML = `
                <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
                  <img src="${r.qrDataUrl}" alt="MFA QR" style="width:180px;height:180px;border:1px solid var(--border);border-radius:8px;background:#fff">
                  <div style="flex:1;min-width:240px">
                    <div class="muted" style="font-size:0.8rem;margin-bottom:0.35rem">Manual secret (if can't scan)</div>
                    <code style="display:block;padding:0.5rem;border-radius:6px;background:rgba(0,0,0,0.05);word-break:break-all">${esc(r.secret)}</code>
                    <div style="margin-top:0.85rem">
                      <label class="form-label">Verification code (6 digits)</label>
                      <input class="form-input" id="pp-mfa-code" type="password" maxlength="8" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••">
                      <button class="btn btn-primary btn-sm" id="pp-mfa-confirm" style="margin-top:0.5rem">Confirm MFA Setup</button>
                    </div>
                    <div id="pp-mfa-confirm-msg" style="margin-top:0.75rem"></div>
                  </div>
                </div>`;
              enrollDiv.querySelector('#pp-mfa-confirm').addEventListener('click', async () => {
                const code = enrollDiv.querySelector('#pp-mfa-code').value.trim();
                const out = enrollDiv.querySelector('#pp-mfa-confirm-msg');
                if (!/^\d{6}$/.test(code)) { out.innerHTML = `<div class="pp-alert error">Code must be 6 digits.</div>`; return; }
                try {
                  const r2 = await api.adminMfaConfirm(empId, code);
                  out.innerHTML = `<div class="pp-alert warning">
                    <div style="font-weight:600;margin-bottom:0.5rem">MFA enabled. Save backup codes (shown once)</div>
                    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;font-family:var(--mono,'JetBrains Mono',monospace)">
                      ${(r2.backupCodes || []).map((c) => `<code style="padding:0.35rem 0.5rem;background:rgba(0,0,0,0.05);border-radius:6px">${esc(c)}</code>`).join('')}
                    </div>
                  </div>`;
                  reloadProfile(true);
                } catch (e) { out.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
              });
            } catch (e) { enrollDiv.innerHTML = `<div class="pp-alert error">Failed: ${esc(e.message)}</div>`; }
            btn.disabled = false; btn.textContent = 'Start MFA Enrollment for User';
          });
        }
      }

      // ── Password Reset tab ───────────────────────────────────────────────────
      else if (tab === 'password') {
        const emp = profileData.employee || {};
        const activeSystems = links.filter(l => l.status === 'ACTIVE').map(l => l.system);
        const hasLocalLogin = emp.local_active === 1 || emp.local_active === true
          || /^LOC/i.test(emp.emp_id || '') || !!emp.email_corp;
        const systemsList   = hasLocalLogin ? ['LOCAL', ...activeSystems] : activeSystems;

        body.innerHTML = `
          <p class="pp-section-title">Reset Password</p>
          <p style="font-size:0.875rem;color:var(--text-muted);margin-bottom:1.25rem;line-height:1.6">
            The new password will be pushed to <strong>all linked systems simultaneously</strong>:
            ${systemsList.length ? systemsList.map(s => srcBadge(s)).join('') : '<span class="muted">No targets — add identity links or a corporate email</span>'}
          </p>
          ${hasLocalLogin ? `<p class="muted" style="font-size:0.8rem;margin:-0.75rem 0 1rem">Local password applies to <strong>/login</strong> (email + password). AD and Google passwords are updated when identity links exist — links are auto-created from corporate email on reset when connectors are active.</p>` : ''}

          <div class="form-group">
            <label class="form-label">New Password <span style="color:var(--danger)">*</span></label>
            <input type="password" class="form-input" id="pp-new-pwd"
              placeholder="Minimum 10 characters" autocomplete="new-password"
              style="font-family:var(--mono,'JetBrains Mono',monospace);letter-spacing:0.05em">
          </div>
          <div class="form-group" style="margin-top:-0.25rem">
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;cursor:pointer">
              <input type="checkbox" id="pp-notify-user"> Notify user by email
            </label>
          </div>
          <div style="display:flex;gap:0.75rem;margin-top:0.5rem">
            <button class="btn btn-primary" id="pp-reset-btn">Reset Password in All Systems</button>
            <button class="btn btn-secondary" id="pp-show-pwd">👁 Show</button>
          </div>
          <div id="pp-reset-results" style="margin-top:1rem">${lastPasswordResetHtml}</div>

          <div style="margin-top:2rem;padding:1rem;background:var(--surface-raised,#f8fafc);border-radius:8px;border:1px solid var(--border)">
            <p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim,#9ca3af);margin:0 0 0.5rem">Password Policy</p>
            <ul style="margin:0;padding-left:1.25rem;font-size:0.82rem;color:var(--text-muted);line-height:1.8">
              <li>Minimum 10 characters</li>
              <li>Writeback applies to Active Directory and Google Workspace when connectors are active (auto-linked by corporate email)</li>
              <li>User will be prompted to change password on next login (if notify is enabled)</li>
            </ul>
          </div>`;

        // Toggle password visibility
        const pwdInput = body.querySelector('#pp-new-pwd');
        body.querySelector('#pp-show-pwd').addEventListener('click', (e) => {
          const showing = pwdInput.type === 'text';
          pwdInput.type = showing ? 'password' : 'text';
          e.currentTarget.textContent = showing ? '👁 Show' : '🙈 Hide';
        });

        body.querySelector('#pp-reset-btn').addEventListener('click', async () => {
          const resetBtn  = body.querySelector('#pp-reset-btn');
          const resultsEl = body.querySelector('#pp-reset-results');
          const pwd       = pwdInput.value;
          const notify    = body.querySelector('#pp-notify-user').checked;

          if (!pwd || pwd.length < 10) {
            resultsEl.innerHTML = `<div class="pp-alert error">Password must be at least 10 characters.</div>`;
            return;
          }
          resetBtn.disabled    = true;
          resetBtn.textContent = '⟳ Resetting across all systems…';
          resultsEl.innerHTML  = '';

          try {
            const r = await api.adminResetPassword(empId, pwd, notify);
            lastPasswordResetHtml = formatPasswordResetResults(r);
            resultsEl.innerHTML = lastPasswordResetHtml;
            pwdInput.value = '';
            // Refresh profile data for Overview writeback log without wiping this tab
            api.getUserProfile(empId).then((data) => {
              profileData = data;
              renderHeader();
              if (activeTab === 'overview') renderTab('overview');
            }).catch(() => { /* keep reset results visible */ });
          } catch (e) {
            const body = e.body || {};
            if (body.results?.length || body.summary) {
              lastPasswordResetHtml = formatPasswordResetResults({
                success: false,
                summary: body.summary,
                results: body.results,
              });
            } else {
              lastPasswordResetHtml =
                `<div class="pp-alert error">Reset failed: ${esc(e.message)}</div>`;
            }
            resultsEl.innerHTML = lastPasswordResetHtml;
          }
          resetBtn.disabled    = false;
          resetBtn.textContent = 'Reset Password in All Systems';
        });
      }
    }

    // ── Wire tab clicks ─────────────────────────────────────────────────────────
    overlay.querySelectorAll('.pp-tab').forEach(t => {
      t.addEventListener('click', () => renderTab(t.dataset.tab));
    });

    // ── Load profile ────────────────────────────────────────────────────────────
    async function reloadProfile(keepTab = false) {
      if (!keepTab) {
        // Reset to loading state
        overlay.querySelector('#pp-name').textContent    = 'Loading…';
        overlay.querySelector('#pp-sub').textContent     = '';
        overlay.querySelector('#pp-badges').innerHTML    = '';
        overlay.querySelector('#pp-lifecycle').innerHTML = '';
        overlay.querySelector('#pp-body').innerHTML      = loading();
        overlay.querySelector('#pp-tab-id-count').style.display   = 'none';
        overlay.querySelector('#pp-tab-sess-count').style.display = 'none';
      }

      try {
        profileData = await api.getUserProfile(empId);
        renderHeader();
        renderTab(activeTab);
      } catch(e) {
        overlay.querySelector('#pp-name').textContent = 'Error';
        overlay.querySelector('#pp-sub').textContent  = '';
        overlay.querySelector('#pp-badges').innerHTML =
          `<span class="badge badge-danger">Failed to load</span>`;
        overlay.querySelector('#pp-body').innerHTML   =
          `<div class="pp-alert error" style="margin-top:1rem">
            <strong>Could not load profile</strong><br>
            <span style="font-size:0.85rem">${esc(e.message)}</span>
          </div>`;
      }
    }

    reloadProfile();
  }

  // ── Link Identity sub-modal ──────────────────────────────────────────────────
  function openLinkModal(empId, onDone) {
    const bd2 = openModal(`<div class="modal" style="width:480px;max-width:96vw">
      <div class="modal-header"><h2>Link External Identity</h2></div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Source System <span style="color:var(--danger)">*</span></label>
          <select class="form-select" id="lnk-sys">
            <option value="">— Choose —</option>
            <option value="AD">Active Directory</option>
            <option value="GOOGLE">Google Workspace</option>
            <option value="ZOHO">Zoho</option>
            <option value="SLACK">Slack</option>
            <option value="GITHUB">GitHub</option>
            <option value="HRMS">HRMS</option>
            <option value="NEXSID">NexSid</option>
            <option value="SALESMAN_OTP">Salesman OTP</option>
            <option value="BIGQUERY">BigQuery</option>
            <option value="AWS_IDC">AWS IDC</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">External ID <span style="color:var(--danger)">*</span></label>
          <input class="form-input" id="lnk-extid" placeholder="e.g. CN=john.doe,DC=corp,DC=com or john@company.com">
        </div>
        <div class="form-group">
          <label class="form-label">Auth Kind</label>
          <select class="form-select" id="lnk-auth">
            <option value="LDAP">LDAP</option>
            <option value="OIDC">OIDC</option>
            <option value="SAML">SAML</option>
            <option value="OTP">OTP</option>
            <option value="BIOMETRIC">Biometric</option>
          </select>
        </div>
        <div id="lnk-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="lnk-save">Link Identity</button>
        <button class="btn btn-secondary" id="lnk-cancel">Cancel</button>
      </div>
    </div>`);
    bd2.querySelector('#lnk-cancel').addEventListener('click', () => bd2.remove());
    bd2.querySelector('#lnk-save').addEventListener('click', async () => {
      const saveBtn = bd2.querySelector('#lnk-save');
      const sys    = bd2.querySelector('#lnk-sys').value;
      const extId  = bd2.querySelector('#lnk-extid').value.trim();
      const auth   = bd2.querySelector('#lnk-auth').value;
      if (!sys || !extId) {
        bd2.querySelector('#lnk-err').innerHTML = errHtml('Source and External ID are required.');
        return;
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Linking…';
      try {
        await api.linkIdentity(empId, { system: sys, externalId: extId, authKind: auth });
        bd2.remove();
        onDone();
      } catch(e) {
        bd2.querySelector('#lnk-err').innerHTML = errHtml(e.message);
        saveBtn.disabled = false; saveBtn.textContent = 'Link Identity';
      }
    });
  }

  // ── Create Local User modal ──────────────────────────────────────────────────
  function openCreateUserModal() {
    const bd = openModal(`<div class="modal" style="width:720px;max-width:96vw">
      <div class="modal-header"><h2>Create Local User</h2></div>
      <div class="modal-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 1rem">
          <div class="form-group"><label class="form-label">Employee ID *</label>
            <input class="form-input" id="cu-empid" placeholder="E12345"></div>
          <div class="form-group"><label class="form-label">Username *</label>
            <input class="form-input" id="cu-user" placeholder="jane.doe"></div>
          <div class="form-group"><label class="form-label">First Name *</label>
            <input class="form-input" id="cu-first"></div>
          <div class="form-group"><label class="form-label">Last Name *</label>
            <input class="form-input" id="cu-last"></div>
          <div class="form-group"><label class="form-label">Display Name</label>
            <input class="form-input" id="cu-display"></div>
          <div class="form-group"><label class="form-label">Email *</label>
            <input class="form-input" id="cu-email" type="email"></div>
          <div class="form-group"><label class="form-label">Department</label>
            <input class="form-input" id="cu-dept"></div>
          <div class="form-group"><label class="form-label">Designation</label>
            <input class="form-input" id="cu-desig"></div>
          <div class="form-group"><label class="form-label">Manager (emp ID)</label>
            <input class="form-input" id="cu-mgr"></div>
          <div class="form-group"><label class="form-label">Mobile Number</label>
            <input class="form-input" id="cu-mobile"></div>
          <div class="form-group"><label class="form-label">Location</label>
            <input class="form-input" id="cu-loc"></div>
          <div class="form-group"><label class="form-label">Country</label>
            <input class="form-input" id="cu-country"></div>
          <div class="form-group"><label class="form-label">Cost Center</label>
            <input class="form-input" id="cu-cc"></div>
          <div class="form-group"><label class="form-label">Employee Type</label>
            <select class="form-select" id="cu-emptype">
              <option value="CORPORATE">Corporate</option>
              <option value="STORE">Store</option>
              <option value="PLANT">Plant</option>
              <option value="DC">DC</option>
            </select></div>
          <div class="form-group"><label class="form-label">Joining Date</label>
            <input class="form-input" id="cu-join" type="date"></div>
          <div class="form-group"><label class="form-label">Status</label>
            <select class="form-select" id="cu-status">
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select></div>
        </div>
        <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 1rem">
          <div class="form-group"><label class="form-label">Password</label>
            <div class="form-check-row" style="margin-bottom:0.5rem">
              <input type="checkbox" id="cu-genpwd" checked> <label for="cu-genpwd">Generate automatically</label>
            </div>
            <input class="form-input" id="cu-pwd" type="password" placeholder="Manual password" disabled autocomplete="new-password">
          </div>
          <div class="form-group"><label class="form-label">Portal role</label>
            <select class="form-select" id="cu-role">
              <option value="USER">User</option>
              <option value="MANAGER">Manager</option>
              <option value="HRBP">HRBP</option>
              <option value="ADMIN">Admin</option>
              <option value="SUPER_ADMIN">Super Admin</option>
            </select>
            <div class="form-check-row" style="margin-top:0.75rem">
              <input type="checkbox" id="cu-welcome"> <label for="cu-welcome">Send welcome email</label>
            </div>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">Groups (comma-separated IDs)</label>
            <input class="form-input" id="cu-groups" placeholder="Optional local group UUIDs"></div>
        </div>
        <div id="cu-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cu-cancel">Cancel</button>
        <button class="btn btn-primary" id="cu-save">Create User</button>
      </div>
    </div>`);
    const syncPwd = () => {
      const gen = bd.querySelector('#cu-genpwd').checked;
      bd.querySelector('#cu-pwd').disabled = gen;
    };
    bd.querySelector('#cu-genpwd').addEventListener('change', syncPwd);
    bd.querySelector('#cu-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#cu-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#cu-save');
      const first = bd.querySelector('#cu-first').value.trim();
      const last = bd.querySelector('#cu-last').value.trim();
      const email = bd.querySelector('#cu-email').value.trim();
      const employeeId = bd.querySelector('#cu-empid').value.trim();
      const username = bd.querySelector('#cu-user').value.trim();
      const gen = bd.querySelector('#cu-genpwd').checked;
      const pwd = bd.querySelector('#cu-pwd').value;
      if (!employeeId || !username || !first || !last || !email) {
        bd.querySelector('#cu-err').innerHTML = errHtml('Employee ID, Username, First Name, Last Name, and Email are required.');
        return;
      }
      if (!gen && (!pwd || pwd.length < 10)) {
        bd.querySelector('#cu-err').innerHTML = errHtml('Password must be at least 10 characters.');
        return;
      }
      const groupsRaw = bd.querySelector('#cu-groups').value.trim();
      saveBtn.disabled = true; saveBtn.textContent = 'Creating…';
      try {
        const res = await api.createLocalUser({
          employeeId, username, firstName: first, lastName: last,
          displayName: bd.querySelector('#cu-display').value.trim() || undefined,
          email,
          department: bd.querySelector('#cu-dept').value.trim() || undefined,
          designation: bd.querySelector('#cu-desig').value.trim() || undefined,
          managerId: bd.querySelector('#cu-mgr').value.trim() || undefined,
          mobile: bd.querySelector('#cu-mobile').value.trim() || undefined,
          location: bd.querySelector('#cu-loc').value.trim() || undefined,
          country: bd.querySelector('#cu-country').value.trim() || undefined,
          costCenter: bd.querySelector('#cu-cc').value.trim() || undefined,
          empType: bd.querySelector('#cu-emptype').value,
          joiningDate: bd.querySelector('#cu-join').value || undefined,
          status: bd.querySelector('#cu-status').value,
          portalRole: bd.querySelector('#cu-role').value,
          generatePassword: gen,
          password: gen ? undefined : pwd,
          sendWelcomeEmail: bd.querySelector('#cu-welcome').checked,
          groupIds: groupsRaw ? groupsRaw.split(/[,;\s]+/).filter(Boolean) : undefined,
        });
        bd.remove();
        toast(res.generatedPassword
          ? `User created. Temporary password: ${res.generatedPassword}`
          : 'User created successfully.');
        const f = getFilters();
        loadUsers(f.q, f.state, f.source);
        if (res.empId) openProfileDrawer(res.empId);
      } catch (e) {
        bd.querySelector('#cu-err').innerHTML = errHtml(e.message);
        saveBtn.disabled = false; saveBtn.textContent = 'Create User';
      }
    });
  }

  function openBulkUploadModal() {
    const bd = openModal(`<div class="modal" style="width:760px;max-width:96vw">
      <div class="modal-header"><h2>Bulk Upload</h2></div>
      <div class="modal-body">
        <ol class="muted" style="font-size:0.85rem;margin:0 0 1rem;padding-left:1.2rem;line-height:1.6">
          <li>Download the CSV template</li>
          <li>Fill employee rows (Excel .xlsx can be saved as CSV)</li>
          <li>Upload, validate, preview, then import</li>
        </ol>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem">
          <a class="btn btn-secondary btn-sm" href="${api.bulkUsersTemplateUrl('csv')}" target="_blank">Download CSV Template</a>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">
            Choose file <input type="file" id="bu-file" accept=".csv,.xlsx,.xls,text/csv" hidden>
          </label>
        </div>
        <div id="bu-progress" hidden>
          <div class="muted" style="font-size:0.8rem;margin-bottom:0.35rem" id="bu-progress-label">Working…</div>
          <div style="height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden">
            <div id="bu-progress-bar" style="height:100%;width:0%;background:var(--accent,#4c8bf5);transition:width 0.2s"></div>
          </div>
        </div>
        <div id="bu-preview" style="margin-top:1rem"></div>
        <div id="bu-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="bu-cancel">Cancel</button>
        <button class="btn btn-secondary" id="bu-validate" disabled>Validate</button>
        <button class="btn btn-primary" id="bu-import" disabled>Import Users</button>
      </div>
    </div>`);

    let parsedRows = [];
    const setProgress = (pct, label) => {
      const wrap = bd.querySelector('#bu-progress');
      wrap.hidden = false;
      bd.querySelector('#bu-progress-bar').style.width = pct + '%';
      bd.querySelector('#bu-progress-label').textContent = label || '';
    };

    function parseCsvText(text) {
      const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/["']/g, ''));
      const idx = (names) => {
        for (const n of names) {
          const i = headers.indexOf(n);
          if (i >= 0) return i;
        }
        return -1;
      };
      const col = {
        employeeId: idx(['employee_id', 'employeeid', 'emp_id', 'empid']),
        firstName: idx(['first_name', 'firstname', 'first']),
        lastName: idx(['last_name', 'lastname', 'last']),
        email: idx(['email', 'email_corp', 'corporate_email']),
        department: idx(['department', 'dept_id', 'dept']),
        designation: idx(['designation', 'title', 'role']),
        username: idx(['username', 'user_name', 'login']),
        status: idx(['status', 'ilg_state', 'state']),
        manager: idx(['manager', 'manager_emp_id', 'manager_email']),
        mobile: idx(['mobile', 'phone', 'mobile_number']),
        location: idx(['location', 'city']),
        costCenter: idx(['cost_center', 'costcenter', 'cc']),
        employeeType: idx(['employee_type', 'employment_type', 'emptype']),
        joiningDate: idx(['joining_date', 'hire_date', 'joindate']),
        businessRole: idx(['business_role', 'businessrole']),
        groups: idx(['groups', 'group']),
      };
      const cell = (parts, i) => (i >= 0 ? (parts[i] || '').trim().replace(/^"|"$/g, '') : '');
      const out = [];
      for (let li = 1; li < lines.length; li++) {
        const parts = lines[li].match(/("([^"]|"")*"|[^,]*)/g)?.map((p) => p.replace(/^"|"$/g, '').replace(/""/g, '"')) || lines[li].split(',');
        const email = cell(parts, col.email);
        if (!email && !cell(parts, col.employeeId)) continue;
        const groupsRaw = cell(parts, col.groups);
        out.push({
          line: li + 1,
          employeeId: cell(parts, col.employeeId),
          firstName: cell(parts, col.firstName),
          lastName: cell(parts, col.lastName),
          email,
          department: cell(parts, col.department),
          designation: cell(parts, col.designation),
          username: cell(parts, col.username),
          status: cell(parts, col.status) || 'ACTIVE',
          manager: cell(parts, col.manager) || undefined,
          mobile: cell(parts, col.mobile) || undefined,
          location: cell(parts, col.location) || undefined,
          costCenter: cell(parts, col.costCenter) || undefined,
          employeeType: cell(parts, col.employeeType) || undefined,
          joiningDate: cell(parts, col.joiningDate) || undefined,
          businessRole: cell(parts, col.businessRole) || undefined,
          groups: groupsRaw ? groupsRaw.split(/[|;]/).map((g) => g.trim()).filter(Boolean) : undefined,
        });
      }
      return out;
    }

    bd.querySelector('#bu-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      bd.querySelector('#bu-err').innerHTML = '';
      setProgress(20, 'Reading file…');
      try {
        if (/\.xlsx?$/i.test(file.name)) {
          // Prefer CSV — ask user to export as CSV for now if SheetJS unavailable
          const text = await file.text().catch(() => '');
          if (!text.includes(',')) {
            throw new Error('Please save the Excel file as CSV and upload again.');
          }
          parsedRows = parseCsvText(text);
        } else {
          parsedRows = parseCsvText(await file.text());
        }
        setProgress(100, `Loaded ${parsedRows.length} rows`);
        bd.querySelector('#bu-validate').disabled = parsedRows.length === 0;
        bd.querySelector('#bu-import').disabled = true;
        bd.querySelector('#bu-preview').innerHTML = `<p class="muted" style="font-size:0.85rem">${parsedRows.length} rows ready. Click Validate.</p>`;
      } catch (err) {
        bd.querySelector('#bu-err').innerHTML = errHtml(err.message);
      }
    });

    bd.querySelector('#bu-validate').addEventListener('click', async () => {
      try {
        setProgress(40, 'Validating…');
        const r = await api.bulkUsersValidate(parsedRows);
        setProgress(100, `Valid ${r.valid} · Invalid ${r.invalid}`);
        const previewRows = (r.preview || []).slice(0, 50).map((p) => `
          <tr>
            <td>${esc(String(p.line || ''))}</td>
            <td>${esc(p.employeeId || '')}</td>
            <td>${esc(p.email || '')}</td>
            <td>${esc(p.department || '')}</td>
            <td>${p.valid ? '<span class="badge badge-success">OK</span>' : '<span class="badge badge-danger">Error</span>'}</td>
            <td class="muted" style="font-size:0.75rem">${esc((p.errors || []).join('; '))}</td>
          </tr>`).join('');
        bd.querySelector('#bu-preview').innerHTML = `
          <div class="kpi-strip" style="margin-bottom:0.75rem">
            <div class="kpi"><div class="kpi-val">${r.valid + r.invalid}</div><div class="kpi-label">Total</div></div>
            <div class="kpi"><div class="kpi-val">${r.valid}</div><div class="kpi-label">Valid</div></div>
            <div class="kpi"><div class="kpi-val">${r.invalid}</div><div class="kpi-label">Invalid</div></div>
          </div>
          <div class="table-wrap"><table class="dense-table">
            <thead><tr><th>Line</th><th>Emp ID</th><th>Email</th><th>Dept</th><th>Status</th><th>Errors</th></tr></thead>
            <tbody>${previewRows || '<tr><td colspan="6">No rows</td></tr>'}</tbody>
          </table></div>`;
        bd.querySelector('#bu-import').disabled = r.valid === 0;
      } catch (err) {
        bd.querySelector('#bu-err').innerHTML = errHtml(err.message);
      }
    });

    bd.querySelector('#bu-import').addEventListener('click', async () => {
      if (!confirm(`Import ${parsedRows.length} users?`)) return;
      try {
        setProgress(10, 'Importing…');
        const chunk = 200;
        let imported = 0, updated = 0, failed = 0, skipped = 0;
        let reportCsv = 'line,email,emp_id,action,error,code\n';
        for (let i = 0; i < parsedRows.length; i += chunk) {
          const part = parsedRows.slice(i, i + chunk);
          const r = await api.bulkUsersBatch(part, 'upsert');
          imported += r.imported ?? r.created ?? 0;
          updated += r.updated ?? 0;
          failed += r.failed ?? 0;
          skipped += r.skipped ?? 0;
          if (r.reportCsv) {
            const lines = r.reportCsv.split('\n').slice(1).filter(Boolean);
            reportCsv += lines.join('\n') + (lines.length ? '\n' : '');
          }
          setProgress(Math.round(((i + part.length) / parsedRows.length) * 100), `Imported ${i + part.length}/${parsedRows.length}`);
        }
        bd.querySelector('#bu-preview').innerHTML = `
          <div class="alert alert-success">Import complete</div>
          <div class="kpi-strip">
            <div class="kpi"><div class="kpi-val">${parsedRows.length}</div><div class="kpi-label">Total</div></div>
            <div class="kpi"><div class="kpi-val">${imported}</div><div class="kpi-label">Imported</div></div>
            <div class="kpi"><div class="kpi-val">${updated}</div><div class="kpi-label">Updated</div></div>
            <div class="kpi"><div class="kpi-val">${skipped}</div><div class="kpi-label">Skipped</div></div>
            <div class="kpi"><div class="kpi-val">${failed}</div><div class="kpi-label">Failed</div></div>
          </div>
          <button class="btn btn-secondary btn-sm" id="bu-dl-report" style="margin-top:0.75rem">Download error report</button>`;
        bd.querySelector('#bu-dl-report')?.addEventListener('click', () => {
          const blob = new Blob([reportCsv], { type: 'text/csv' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'bulk-import-report.csv';
          a.click();
        });
        toast(`Bulk import: ${imported} created, ${updated} updated, ${failed} failed`);
        const f = getFilters();
        loadUsers(f.q, f.state, f.source);
      } catch (err) {
        bd.querySelector('#bu-err').innerHTML = errHtml(err.message);
      }
    });

    bd.querySelector('#bu-cancel').addEventListener('click', () => bd.remove());
  }

  // ── Wire up search / filters ─────────────────────────────────────────────────
  function getFilters() {
    return {
      q:      panel.querySelector('#ud-search').value.trim(),
      state:  panel.querySelector('#ud-state-filter').value,
      source: panel.querySelector('#ud-src-filter').value,
    };
  }

  panel.querySelector('#ud-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const f = getFilters();
      loadUsers(f.q, f.state, f.source);
    }, 350);
  });
  persistSearch(panel.querySelector('#ud-search'), 'user-directory');

  ['#ud-src-filter', '#ud-state-filter'].forEach(sel => {
    panel.querySelector(sel).addEventListener('change', () => {
      const f = getFilters();
      loadUsers(f.q, f.state, f.source);
    });
  });

  panel.querySelector('#ud-refresh-btn').addEventListener('click', () => {
    const f = getFilters();
    loadUsers(f.q, f.state, f.source);
  });

  ['#ud-dept-filter', '#ud-mgr-filter', '#ud-loc-filter', '#ud-type-filter'].forEach((sel) => {
    panel.querySelector(sel)?.addEventListener('change', () => {
      const f = getFilters();
      loadUsers(f.q, f.state, f.source);
    });
    panel.querySelector(sel)?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const f = getFilters();
        loadUsers(f.q, f.state, f.source);
      }, 350);
    });
  });

  panel.querySelector('#ud-create-btn').addEventListener('click', openCreateUserModal);
  panel.querySelector('#ud-bulk-upload-btn')?.addEventListener('click', openBulkUploadModal);

  panel.querySelector('#ud-bulk-clear')?.addEventListener('click', () => {
    selected.clear();
    panel.querySelectorAll('.ud-check').forEach((c) => { c.checked = false; });
    updateBulkBar();
  });

  panel.querySelector('#ud-bulk-run')?.addEventListener('click', async () => {
    const action = panel.querySelector('#ud-bulk-action')?.value;
    if (!action) { toast('Select a bulk action', 'error'); return; }
    const empIds = [...selected];
    if (!empIds.length) return;
    if (['disable', 'delete', 'reset_password'].includes(action)) {
      if (!confirm(`Apply "${action}" to ${empIds.length} users?`)) return;
    }
    if (action === 'export') {
      // Client-side CSV of current selection
      const rows = allUsers.filter((u) => selected.has(u.emp_id));
      const csv = ['emp_id,employee_number,full_name,email,department,status',
        ...rows.map((u) => [u.emp_id, u.employee_number, u.full_name, u.email_corp, u.dept_id, u.ilg_state]
          .map((v) => JSON.stringify(v ?? '')).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'selected-users.csv';
      a.click();
      toast('Export downloaded');
      return;
    }
    try {
      const r = await api.bulkUserAction({ action, empIds });
      toast(`Bulk ${action}: ${r.succeeded} succeeded, ${r.failed} failed`, r.failed ? 'error' : 'success');
      const f = getFilters();
      loadUsers(f.q, f.state, f.source);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ── Initial load ─────────────────────────────────────────────────────────────
  if (!panel.querySelector('#ud-search').value) {
    const f0 = getFilters();
    loadUsers(f0.q, f0.state, f0.source);
  }
}

// ─── 11. Business Roles ───────────────────────────────────────────────────────
export async function viewRoles(content) {
  content.replaceChildren(el(`<div>${header('Business Roles', 'Manage roles and their entitlements', `<button class="btn btn-primary" id="new-role-btn">+ New Role</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const roles = norm(await api.listBusinessRoles());
      const rows = roles.length ? roles.map(r => `
        <tr>
          <td class="cell-strong">${esc(r.name)}</td>
          <td class="muted" style="font-size:0.875rem">${esc(r.description||'—')}</td>
          <td>${r.entitlement_count ?? '—'}</td>
          <td>${r.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary manage-ent" data-id="${esc(String(r.id))}" data-name="${esc(r.name)}">Entitlements</button>
            <button class="btn btn-sm btn-secondary edit-role" data-id="${esc(String(r.id))}" data-name="${esc(r.name)}" data-desc="${esc(r.description||'')}">Edit</button>
            <button class="btn btn-sm btn-danger del-role" data-id="${esc(String(r.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No business roles.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th>Entitlements</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

      wrap.querySelectorAll('.del-role').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this role?')) return;
          try { await api.deleteBusinessRole(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-role').forEach(btn => {
        btn.addEventListener('click', () => openRoleModal(btn.dataset.id, { name: btn.dataset.name, description: btn.dataset.desc }));
      });
      wrap.querySelectorAll('.manage-ent').forEach(btn => {
        btn.addEventListener('click', () => openEntModal(btn.dataset.id, btn.dataset.name));
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openRoleModal(id, d = {}) {
    const isEdit = !!id;
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Business Role</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="r-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="r-desc" rows="3">${esc(d.description||'')}</textarea></div>
      <div id="r-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="r-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="r-cancel">Cancel</button></div></div>`);
    bd.querySelector('#r-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#r-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#r-name').value, description: bd.querySelector('#r-desc').value };
      if (!data.name) { bd.querySelector('#r-err').innerHTML = errHtml('Name required'); return; }
      try {
        if (isEdit) await api.updateBusinessRole(id, data); else await api.createBusinessRole(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#r-err').innerHTML = errHtml(e.message); }
    });
  }

  async function openEntModal(roleId, roleName) {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Entitlements — ${esc(roleName)}</h2></div><div class="modal-body" id="ent-body">${loading()}</div><div class="modal-footer"><button class="btn btn-secondary" id="ent-close">Close</button></div></div>`);
    bd.querySelector('#ent-close').addEventListener('click', () => bd.remove());
    async function reloadEnt() {
      try {
        const ents = norm(await api.getRoleEntitlements(roleId));
        bd.querySelector('#ent-body').innerHTML = `
          <div style="margin-bottom:1rem;display:flex;gap:0.5rem">
            <input class="form-input" id="ent-add-id" placeholder="Entitlement ID" style="flex:1">
            <button class="btn btn-primary" id="ent-add-btn">Add</button>
          </div>
          ${ents.length ? `<div class="table-wrap"><table><thead><tr><th>Entitlement</th><th></th></tr></thead><tbody>
            ${ents.map(e => `<tr><td>${esc(e.entitlement_name||e.name||e.entitlement_id||'—')}</td><td><button class="btn btn-sm btn-danger rem-ent" data-id="${esc(String(e.entitlement_id||e.id||''))}">Remove</button></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No entitlements assigned.</p>'}
          <div id="ent-err"></div>`;
        bd.querySelector('#ent-add-btn').addEventListener('click', async () => {
          const entId = bd.querySelector('#ent-add-id').value.trim();
          if (!entId) return;
          try { await api.addRoleEntitlement(roleId, entId); await reloadEnt(); } catch(e) { bd.querySelector('#ent-err').innerHTML = errHtml(e.message); }
        });
        bd.querySelectorAll('.rem-ent').forEach(btn => {
          btn.addEventListener('click', async () => {
            try { await api.removeRoleEntitlement(roleId, btn.dataset.id); await reloadEnt(); } catch(e) { bd.querySelector('#ent-err').innerHTML = errHtml(e.message); }
          });
        });
      } catch(e) { bd.querySelector('#ent-body').innerHTML = errHtml(e.message); }
    }
    await reloadEnt();
  }

  wrap.querySelector('#new-role-btn').addEventListener('click', () => openRoleModal(null));
  await load();
}

// ─── 12. Birthright ───────────────────────────────────────────────────────────
/** Admin catalog of IGA entitlements (including harvested AD/Google groups). */
export async function viewEntitlementCatalog(content) {
  content.replaceChildren(el(`<div>${header('Entitlements Catalog', 'Roles and groups available for Request Access — including harvested directory entitlements', `<button class="btn btn-secondary" id="ec-refresh">Refresh</button>`)}
    <p class="muted" style="margin:-0.5rem 0 1rem">Harvested AD/Google <strong>groups are inventory only</strong> — they do <em>not</em> appear in Request Access. End users request apps (Access Policy / JIT) and curated entitlements only.</p>
    <div id="ec-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const [ents, connectors] = await Promise.all([
        api.igaEntitlements({ limit: 500, active: 1, requestable: 'all' }),
        api.igaConnectors().catch(() => ({ data: [] })),
      ]);
      const list = norm(ents);
      const connOpts = norm(connectors);
      const harvested = list.filter(e => e.external_id && e.connector_id);
      const rows = list.length ? list.map(e => {
        let source = 'Manual';
        try {
          const m = typeof e.metadata === 'string' ? JSON.parse(e.metadata || '{}') : (e.metadata || {});
          if (m.source) source = String(m.source);
        } catch { /* ignore */ }
        if (e.external_id && e.connector_id) source = source === 'Manual' ? 'Harvested' : source;
        return `<tr>
          <td class="cell-strong">${esc(e.name)}</td>
          <td><code style="font-size:0.75rem">${esc(e.slug || '')}</code></td>
          <td><span class="badge badge-info">${esc(e.type || '—')}</span></td>
          <td class="muted">${esc(e.connector_name || '—')}</td>
          <td class="muted" style="font-size:0.78rem;max-width:14rem;overflow:hidden;text-overflow:ellipsis" title="${esc(e.external_id || '')}">${esc(e.external_id || '—')}</td>
          <td><span class="badge ${source === 'Manual' ? 'badge-neutral' : 'badge-success'}">${esc(source)}</span></td>
          <td class="muted">${e.last_harvested_at ? fmtDate(e.last_harvested_at) : '—'}</td>
        </tr>`;
      }).join('') : `<tr><td colspan="7"><div class="empty-state"><p>No entitlements yet. Run <strong>Harvest Roles</strong> on a Connected AD/Google source, or create birthright rules.</p></div></td></tr>`;

      wrap.querySelector('#ec-area').innerHTML = `
        <div class="stat-grid" style="margin-bottom:1rem">
          <div class="stat-card"><div class="stat-value">${list.length}</div><div class="stat-label">Active entitlements</div></div>
          <div class="stat-card"><div class="stat-value">${harvested.length}</div><div class="stat-label">Harvested from connectors</div></div>
          <div class="stat-card"><div class="stat-value">${connOpts.length}</div><div class="stat-label">Directory sources</div></div>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>Name</th><th>Slug</th><th>Type</th><th>Connector</th><th>External ID</th><th>Source</th><th>Last harvest</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
        <p class="muted" style="margin-top:1rem;font-size:0.85rem">End users see these under <strong>Request Access → Entitlements</strong>. Granted memberships appear in <strong>My Access</strong>.</p>`;
    } catch (e) {
      wrap.querySelector('#ec-area').innerHTML = errHtml(e.message);
    }
  }

  wrap.querySelector('#ec-refresh')?.addEventListener('click', () => load());
  await load();
}

export async function viewBirthright(content) {
  content.replaceChildren(el(`<div>${header('Birthright Rules', 'Auto-grant entitlements when joiner attributes match a rule')}<div id="br-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  function parseRule(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return {}; }
  }
  function csv(v) { return Array.isArray(v) ? v.join(', ') : (v || ''); }
  function fromCsv(s) {
    return String(s || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
  }

  async function load() {
    try {
      const [list, apps, connectors, groups] = await Promise.all([
        api.listBirthrightRules().catch(() => ({ data: [] })),
        api.igaApps().catch(() => ({ data: [] })),
        api.igaConnectors().catch(() => ({ data: [] })),
        api.listGroups().catch(() => ({ data: [] })),
      ]);
      const rules = norm(list);
      const appOpts = norm(apps);
      const connOpts = norm(connectors);
      const groupOpts = norm(groups);

      const rows = rules.length ? rules.map(r => {
        const summary = r.rule_summary || csv(Object.keys(parseRule(r.birthright_rule))) || 'All ACTIVE';
        return `<tr>
          <td class="cell-strong">${esc(r.name || r.id)}</td>
          <td><code style="font-size:0.75rem">${esc(r.slug || '')}</code></td>
          <td class="muted" style="font-size:0.8rem">${esc(summary)}</td>
          <td class="muted">${esc(r.app_name || '—')}</td>
          <td class="muted">${esc(r.connector_name || '—')}</td>
          <td>${r.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary br-edit" data-id="${esc(String(r.id))}">Edit</button>
            <button class="btn btn-sm btn-danger br-del" data-id="${esc(String(r.id))}">Remove</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">◎</div><p>No birthright rules yet. Create one to grant entitlements on join.</p></div></td></tr>`;

      wrap.querySelector('#br-area').innerHTML = `
        <div style="display:flex;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap">
          <button class="btn btn-primary" id="br-new">+ New Rule</button>
          <button class="btn btn-secondary" id="br-dryrun">Dry Run</button>
          <button class="btn btn-primary" id="br-run">Run Now</button>
        </div>
        <div id="br-msg"></div>
        <div class="table-wrap"><table><thead><tr>
          <th>Entitlement</th><th>Slug</th><th>Rule</th><th>Application</th><th>Connector</th><th>Status</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;

      const openEditor = (existing) => {
        const rule = parseRule(existing?.birthright_rule);
        const bd = openModal(`<div class="modal" style="max-width:640px"><div class="modal-header"><h2>${existing ? 'Edit' : 'New'} Birthright Rule</h2></div><div class="modal-body">
          <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="br-name" value="${esc(existing?.name || '')}"></div>
          <div class="form-group"><label class="form-label">Slug (optional)</label><input class="form-input" id="br-slug" value="${esc(existing?.slug || '')}" placeholder="auto from name" ${existing ? 'disabled' : ''}></div>
          <div class="form-group"><label class="form-label">Application</label>
            <select class="form-select" id="br-app"><option value="">— none —</option>${appOpts.map(a => `<option value="${esc(String(a.id))}" ${existing?.app_id===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label class="form-label">Provision via connector</label>
            <select class="form-select" id="br-conn"><option value="">— none —</option>${connOpts.map(c => `<option value="${esc(String(c.id))}" ${existing?.connector_id===c.id?'selected':''}>${esc(c.name)} (${esc(c.connector_type||'')})</option>`).join('')}</select>
            <p class="muted" style="font-size:0.8rem;margin-top:0.25rem">When granted, kicks AD/Google sync so the account is provisioned outbound.</p>
          </div>
          <div class="form-group"><label class="form-label">Dept IDs (comma-separated)</label><input class="form-input" id="br-depts" value="${esc(csv(rule.dept_ids))}" placeholder="IT, HR — blank = any"></div>
          <div class="form-group"><label class="form-label">Employment types</label><input class="form-input" id="br-types" value="${esc(csv(rule.employment_types))}" placeholder="CORPORATE, STORE"></div>
          <div class="form-group"><label class="form-label">Job roles</label><input class="form-input" id="br-roles" value="${esc(csv(rule.roles))}" placeholder="Engineer, Manager"></div>
          <div class="form-group"><label class="form-label">Require group membership</label>
            <select class="form-select" id="br-groups" multiple size="4" style="min-height:6rem">
              ${groupOpts.map(g => `<option value="${esc(String(g.id))}" ${(rule.group_ids||[]).includes(g.id)?'selected':''}>${esc(g.name||g.id)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label class="form-label">Exclude dept IDs</label><input class="form-input" id="br-excl" value="${esc(csv(rule.exclude_dept_ids))}"></div>
          <div class="form-group"><label class="form-check"><input type="checkbox" id="br-active" ${existing?.active === 0 || existing?.active === false ? '' : 'checked'}> Active</label></div>
          <div id="br-err"></div>
        </div><div class="modal-footer"><button class="btn btn-primary" id="br-save">Save</button><button class="btn btn-secondary" id="br-cancel">Cancel</button></div></div>`);
        bd.querySelector('#br-cancel').addEventListener('click', () => bd.remove());
        bd.querySelector('#br-save').addEventListener('click', async () => {
          const groupSel = [...bd.querySelector('#br-groups').selectedOptions].map(o => o.value);
          const body = {
            name: bd.querySelector('#br-name').value.trim(),
            slug: bd.querySelector('#br-slug').value.trim() || undefined,
            app_id: bd.querySelector('#br-app').value || null,
            connector_id: bd.querySelector('#br-conn').value || null,
            active: bd.querySelector('#br-active').checked,
            birthright_rule: {
              dept_ids: fromCsv(bd.querySelector('#br-depts').value),
              employment_types: fromCsv(bd.querySelector('#br-types').value),
              roles: fromCsv(bd.querySelector('#br-roles').value),
              group_ids: groupSel,
              exclude_dept_ids: fromCsv(bd.querySelector('#br-excl').value),
            },
          };
          if (!body.name) { bd.querySelector('#br-err').innerHTML = errHtml('Name required'); return; }
          try {
            if (existing?.id) await api.updateBirthrightRule(existing.id, body);
            else await api.createBirthrightRule(body);
            bd.remove();
            await load();
          } catch (e) { bd.querySelector('#br-err').innerHTML = errHtml(e.message); }
        });
      };

      wrap.querySelector('#br-new')?.addEventListener('click', () => openEditor(null));
      wrap.querySelectorAll('.br-edit').forEach(btn => {
        const row = rules.find(r => String(r.id) === btn.dataset.id);
        btn.addEventListener('click', () => openEditor(row));
      });
      wrap.querySelectorAll('.br-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this birthright rule?')) return;
          try { await api.deleteBirthrightRule(btn.dataset.id); await load(); } catch (e) { alert(e.message); }
        });
      });
      wrap.querySelector('#br-dryrun').addEventListener('click', async () => {
        const btn = wrap.querySelector('#br-dryrun');
        btn.disabled = true; btn.textContent = 'Running…';
        try {
          const result = await api.birthrightDryRun();
          const data = Array.isArray(result?.data) ? result.data : [];
          const detail = data.slice(0, 10).map(u => `${esc(u.full_name||u.emp_id)} → ${(u.would_get||[]).map(esc).join(', ')}`).join('<br>');
          wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success"><strong>${data.length}</strong> users would receive new grants (sample up to 50).${detail ? `<div style="margin-top:0.5rem;font-size:0.85rem">${detail}</div>` : ''}</div>`;
        } catch (e) { wrap.querySelector('#br-msg').innerHTML = errHtml(e.message); }
        btn.disabled = false; btn.textContent = 'Dry Run';
      });
      wrap.querySelector('#br-run').addEventListener('click', async () => {
        if (!confirm('Reconcile birthright for all ACTIVE employees now?')) return;
        const btn = wrap.querySelector('#br-run');
        btn.disabled = true; btn.textContent = 'Running…';
        try {
          const result = await api.runBirthright();
          wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Done — granted <strong>${result.assigned ?? 0}</strong>, revoked <strong>${result.revoked ?? 0}</strong> across ${result.employees ?? 0} employees.${result.connectors_kicked ? ` Kicked ${result.connectors_kicked} connector sync(s).` : ''}</div>`;
        } catch (e) { wrap.querySelector('#br-msg').innerHTML = errHtml(e.message); }
        btn.disabled = false; btn.textContent = 'Run Now';
      });
    } catch (e) { wrap.querySelector('#br-area').innerHTML = errHtml(e.message); }
  }

  await load();
}

// ─── Application Access Policy ────────────────────────────────────────────────
export async function viewAppAccessPolicy(content) {
  content.replaceChildren(el(`<div class="aap-page">
    ${header('Application Access Policy', 'Who can launch apps + approval chains for access requests (not the same as Workflow Library / Event Triggers)')}
    <div id="aap-stats" class="stat-grid aap-stats">${loading()}</div>
    <div class="cfg-tab-bar inline-tabs aap-tabs">
      <button type="button" class="cfg-tab inline-tab active" data-tab="assign">Application Assignment</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="ip">IP Restrictions</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="workflow">JIT / Request Workflow</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="audit">Audit Log</button>
    </div>
    <div id="tab-assign"></div>
    <div id="tab-ip" style="display:none"></div>
    <div id="tab-workflow" style="display:none"></div>
    <div id="tab-audit" style="display:none"></div>
  </div>`));
  const wrap = content.firstChild;

  let appsCache = [];
  let tagGroupsCache = [];
  let identityGroupsCache = [];

  async function loadAppsAndGroups() {
    const [apps, tagGroups, identityGroups] = await Promise.all([
      api.listAppAccessApps().catch(() => ({ data: [] })),
      api.listTagGroups().catch(() => ({ data: [] })),
      api.listGroups().catch(() => ({ data: [] })),
    ]);
    appsCache = norm(apps);
    tagGroupsCache = norm(tagGroups);
    identityGroupsCache = norm(identityGroups);
  }

  function switchTab(name) {
    wrap.querySelectorAll('.cfg-tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
    });
    wrap.querySelector('#tab-assign').style.display   = name === 'assign' ? '' : 'none';
    wrap.querySelector('#tab-ip').style.display       = name === 'ip' ? '' : 'none';
    wrap.querySelector('#tab-workflow').style.display = name === 'workflow' ? '' : 'none';
    wrap.querySelector('#tab-audit').style.display    = name === 'audit' ? '' : 'none';
  }

  wrap.querySelectorAll('.cfg-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  async function loadStats() {
    try {
      const s = await api.appAccessSummary();
      wrap.querySelector('#aap-stats').innerHTML = `
        ${statCard('key', 'Active Assignments', s.activeAssignments)}
        ${statCard('users', 'Tag Groups', s.activeTagGroups, '', 'success')}
        ${statCard('flow', 'Workflows', s.activeWorkflows, '', 'warning')}
        ${statCard('list', 'Audit (30d)', s.auditEvents30d, '', 'neutral')}`;
    } catch (e) {
      wrap.querySelector('#aap-stats').innerHTML = errHtml(e.message);
    }
  }

  // ── Tab: Application Assignment ──
  async function loadAssignTab() {
    const area = wrap.querySelector('#tab-assign');
    area.innerHTML = loading();
    try {
      await loadAppsAndGroups();
      const assignments = norm(await api.listAppAssignments());
      const assignRows = assignments.length ? assignments.map(a => `
        <tr>
          <td class="cell-strong">${esc(a.app_name || '—')}</td>
          <td><span class="badge ${a.assignment_type === 'USER' ? 'badge-info' : 'badge-success'}">${esc(a.assignment_type)}</span></td>
          <td>${esc(a.target_name || a.target_id)}</td>
          <td class="muted">${a.granted_at ? fmtDate(a.granted_at) : '—'}</td>
          <td class="actions">
            <button class="btn btn-sm btn-secondary edit-assign"
              data-id="${esc(String(a.id))}"
              data-app="${esc(String(a.app_id))}"
              data-type="${esc(String(a.assignment_type))}"
              data-target="${esc(String(a.target_id))}">Edit</button>
            <button class="btn btn-sm btn-danger revoke-assign" data-id="${esc(String(a.id))}">Revoke</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No active assignments.</p></div></td></tr>`;

      const tgRows = tagGroupsCache.length ? tagGroupsCache.map(g => {
        let tags = '—';
        try { tags = (typeof g.tags === 'string' ? JSON.parse(g.tags) : g.tags || []).join(', '); } catch {}
        return `<tr>
          <td class="cell-strong">${esc(g.name)}</td>
          <td class="muted" style="font-size:0.82rem">${esc(tags)}</td>
          <td>${g.member_count ?? 0}</td>
          <td>
            <button class="btn btn-sm btn-secondary manage-tg" data-id="${esc(String(g.id))}" data-name="${esc(g.name)}">Members</button>
            <button class="btn btn-sm btn-danger del-tg" data-id="${esc(String(g.id))}">Delete</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="4"><div class="empty-state"><p>No tag groups yet.</p></div></td></tr>`;

      area.innerHTML = `
        <div class="aap-actions">
          <div>
            <h3 class="section-title">Application Assignment</h3>
            <p class="subtitle">Grant direct or group-based app access. Tag groups can also be managed under Identity → Groups → Tag Groups.</p>
          </div>
          <div class="aap-actions-btns">
            <button class="btn btn-primary" id="aap-assign-btn">+ Assign Access</button>
            <button class="btn btn-secondary" id="aap-tg-btn">+ Tag Group</button>
          </div>
        </div>
        <h3 class="section-title">Active Assignments</h3>
        <div class="table-wrap aap-table"><table>
          <thead><tr><th>Application</th><th>Type</th><th>Target</th><th>Granted</th><th></th></tr></thead>
          <tbody>${assignRows}</tbody>
        </table></div>
        <h3 class="section-title">Tag Groups</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Tags</th><th>Members</th><th></th></tr></thead>
          <tbody>${tgRows}</tbody>
        </table></div>`;

      area.querySelector('#aap-assign-btn').addEventListener('click', () => openAssignModal());
      area.querySelector('#aap-tg-btn').addEventListener('click', openTagGroupModal);
      area.querySelectorAll('.edit-assign').forEach(btn => {
        btn.addEventListener('click', () => openAssignModal({
          id: btn.dataset.id,
          appId: btn.dataset.app,
          assignmentType: btn.dataset.type,
          targetId: btn.dataset.target,
        }));
      });
      area.querySelectorAll('.revoke-assign').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Revoke this assignment?')) return;
          try { await api.revokeAppAssignment(btn.dataset.id); await loadAssignTab(); await loadStats(); } catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.del-tg').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this tag group?')) return;
          try { await api.deleteTagGroup(btn.dataset.id); await loadAssignTab(); await loadStats(); } catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.manage-tg').forEach(btn => {
        btn.addEventListener('click', () => openTagGroupMembersModal(btn.dataset.id, btn.dataset.name));
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  async function openAssignModal(existing) {
    try { await loadAppsAndGroups(); } catch (e) { alert(e.message); return; }

    const isEdit = !!(existing && existing.id);
    const appOpts = appsCache.length
      ? appsCache.map(a => `<option value="${esc(a.id)}"${isEdit && existing.appId === a.id ? ' selected' : ''}>${esc(a.name)}${a.has_saml ? ' (SAML)' : ''}</option>`).join('')
      : '<option value="" disabled>No applications — register SAML/IGA apps first</option>';
    const hasAnyGroup = identityGroupsCache.length || tagGroupsCache.length;
    const identityOpts = identityGroupsCache.length
      ? `<optgroup label="Identity Groups (Identity → Groups)">${identityGroupsCache.map(g =>
          `<option value="${esc(g.id)}" data-type="GROUP"${isEdit && existing.assignmentType === 'GROUP' && existing.targetId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</optgroup>`
      : '';
    const tagOpts = tagGroupsCache.length
      ? `<optgroup label="Tag Groups">${tagGroupsCache.map(g =>
          `<option value="${esc(g.id)}" data-type="TAG_GROUP"${isEdit && existing.assignmentType === 'TAG_GROUP' && existing.targetId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</optgroup>`
      : '';
    const tgOpts = hasAnyGroup
      ? identityOpts + tagOpts
      : '<option value="" disabled>No groups — create one under Identity → Groups or + Tag Group</option>';

    const startAsUser = isEdit ? existing.assignmentType === 'USER' : true;
    const typeUserSel = startAsUser ? ' selected' : '';
    const typeGroupSel = !startAsUser ? ' selected' : '';
    const empVal = isEdit && existing.assignmentType === 'USER' ? esc(existing.targetId || '') : '';

    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit Application Access' : 'Assign Application Access'}</h2></div><div class="modal-body">
      ${!appsCache.length ? '<div class="alert alert-info" style="margin-bottom:1rem;font-size:0.85rem">No applications in the catalog yet. Register a SAML app under <strong>Applications</strong> or add one in the IGA catalog — it will appear here automatically.</div>' : ''}
      ${!hasAnyGroup ? '<div class="alert alert-info" style="margin-bottom:1rem;font-size:0.85rem">No groups yet. Create one under <strong>Identity → Groups</strong> (recommended) or click <strong>+ Tag Group</strong> on this page.</div>' : ''}
      <div class="form-group"><label class="form-label">Application</label>
        <select class="form-select" id="aa-app"><option value="">— Select —</option>${appOpts}</select></div>
      <div class="form-group"><label class="form-label">Assignment Type</label>
        <select class="form-select" id="aa-type"><option value="USER"${typeUserSel}>User-based</option><option value="GROUP"${typeGroupSel}>Group-based</option></select></div>
      <div class="form-group" id="aa-user-wrap" style="${startAsUser ? '' : 'display:none'}">
        <label class="form-label">User (search name, email, or emp ID)</label>
        <input class="form-input" id="aa-emp-search" placeholder="Type to search…" autocomplete="off">
        <input type="hidden" id="aa-emp" value="${empVal}">
        <div id="aa-emp-picked" class="muted" style="margin-top:0.35rem;font-size:0.85rem">${empVal ? `Selected: <code>${empVal}</code>` : 'Or paste emp_id / corporate email below and Grant.'}</div>
        <div id="aa-emp-results" style="margin-top:0.5rem"></div>
        <label class="form-label" style="margin-top:0.75rem">Or enter emp_id / employee number / email</label>
        <input class="form-input" id="aa-emp-manual" placeholder="e.g. E12345 or user@lenskart.com" value="${empVal}">
      </div>
      <div class="form-group" id="aa-tg-wrap" style="${startAsUser ? 'display:none' : ''}"><label class="form-label">Group</label>
        <select class="form-select" id="aa-tg"><option value="">— Select —</option>${tgOpts}</select></div>
      <div id="aa-err"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="aa-save">${isEdit ? 'Save Changes' : 'Grant Access'}</button>
      <button class="btn btn-secondary" id="aa-cancel">Cancel</button>
    </div></div>`);
    const typeSel = bd.querySelector('#aa-type');
    typeSel.addEventListener('change', () => {
      const isUser = typeSel.value === 'USER';
      bd.querySelector('#aa-user-wrap').style.display = isUser ? '' : 'none';
      bd.querySelector('#aa-tg-wrap').style.display = isUser ? 'none' : '';
    });
    let searchTimer = null;
    bd.querySelector('#aa-emp-search')?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = bd.querySelector('#aa-emp-search').value.trim();
      const box = bd.querySelector('#aa-emp-results');
      if (q.length < 2) { box.innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        try {
          const r = await api.listUsersUnified(q, '', '', 8, 0);
          const items = r?.data || [];
          if (!items.length) {
            box.innerHTML = `<p class="muted" style="font-size:0.85rem">No active users matched.</p>`;
            return;
          }
          box.innerHTML = `<div class="table-wrap"><table><tbody>${items.map((u) => `
            <tr style="cursor:pointer" class="aa-pick-user" data-emp="${esc(u.emp_id)}" data-label="${esc(u.full_name || u.emp_id)} · ${esc(u.email_corp || '')}">
              <td class="cell-strong">${esc(u.full_name || u.emp_id)}</td>
              <td class="muted">${esc(u.email_corp || '—')}</td>
              <td><code style="font-size:0.78rem">${esc(u.emp_id)}</code></td>
            </tr>`).join('')}</tbody></table></div>`;
          box.querySelectorAll('.aa-pick-user').forEach((row) => {
            row.addEventListener('click', () => {
              bd.querySelector('#aa-emp').value = row.dataset.emp;
              bd.querySelector('#aa-emp-manual').value = row.dataset.emp;
              bd.querySelector('#aa-emp-picked').innerHTML = `Selected: <strong>${esc(row.dataset.label)}</strong>`;
              box.innerHTML = '';
              bd.querySelector('#aa-emp-search').value = '';
            });
          });
        } catch (e) {
          box.innerHTML = errHtml(e.message);
        }
      }, 280);
    });
    bd.querySelector('#aa-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#aa-save').addEventListener('click', async () => {
      const appId = bd.querySelector('#aa-app').value;
      let assignmentType = typeSel.value;
      let targetId = '';
      if (assignmentType === 'USER') {
        targetId = (bd.querySelector('#aa-emp').value || bd.querySelector('#aa-emp-manual').value || '').trim();
      } else {
        const tgSel = bd.querySelector('#aa-tg');
        const selected = tgSel.selectedOptions[0];
        targetId = tgSel.value;
        assignmentType = selected?.dataset.type || 'GROUP';
      }
      if (!appId || !targetId) { bd.querySelector('#aa-err').innerHTML = errHtml('Application and target are required'); return; }
      try {
        if (isEdit) {
          await api.updateAppAssignment(existing.id, { appId, assignmentType, targetId });
        } else {
          await api.createAppAssignment({ appId, assignmentType, targetId });
        }
        bd.remove(); await loadAssignTab(); await loadStats();
      } catch (e) { bd.querySelector('#aa-err').innerHTML = errHtml(e.message); }
    });
  }

  // ── Tab: IP Restrictions ──
  async function loadIpTab() {
    const area = wrap.querySelector('#tab-ip');
    area.innerHTML = loading();
    try {
      await loadAppsAndGroups();
      const rows = appsCache.length ? appsCache.map((a) => {
        const cidrs = Array.isArray(a.allowed_cidrs) ? a.allowed_cidrs : [];
        const summary = cidrs.length
          ? `<span class="badge badge-warning">${cidrs.length} rule${cidrs.length === 1 ? '' : 's'}</span> <span class="muted" style="font-size:0.8rem">${esc(cidrs.slice(0, 3).join(', '))}${cidrs.length > 3 ? '…' : ''}</span>`
          : '<span class="badge badge-neutral">Unrestricted</span>';
        return `<tr>
          <td class="cell-strong">${esc(a.name)}</td>
          <td class="muted"><code style="font-size:0.78rem">${esc(a.slug)}</code></td>
          <td>${summary}</td>
          <td><button class="btn btn-sm btn-secondary edit-ip" data-id="${esc(String(a.id))}" data-name="${esc(a.name)}" data-cidrs="${esc(JSON.stringify(cidrs))}">Edit IPs</button></td>
        </tr>`;
      }).join('') : `<tr><td colspan="4"><div class="empty-state"><p>No applications yet.</p></div></td></tr>`;

      area.innerHTML = `
        <div class="aap-actions">
          <div>
            <h3 class="section-title">IP Restrictions</h3>
            <p class="subtitle">Optional per-app allowlist. Apps stay visible on Home; IP is checked when the user launches SSO. Denied IPs see “Unrestricted IP — application access denied.” Empty = no IP restriction. Use CIDR (<code>10.0.0.0/8</code>), exact IP, or prefix (<code>10.0.</code>).</p>
          </div>
        </div>
        <div id="ip-msg" style="margin-bottom:0.75rem"></div>
        <div class="table-wrap aap-table"><table>
          <thead><tr><th>Application</th><th>Slug</th><th>Allowlist</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;

      area.querySelectorAll('.edit-ip').forEach((btn) => {
        btn.addEventListener('click', () => {
          let cidrs = [];
          try { cidrs = JSON.parse(btn.dataset.cidrs || '[]'); } catch { cidrs = []; }
          openIpModal(btn.dataset.id, btn.dataset.name, cidrs);
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  function openIpModal(appId, appName, cidrs) {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>IP allowlist — ${esc(appName)}</h2></div><div class="modal-body">
      <p class="muted" style="font-size:0.85rem;margin-bottom:0.75rem">One CIDR or IP per line. Examples: <code>10.0.0.0/8</code>, <code>203.0.113.10</code>, <code>192.168.1.</code>. Leave empty to remove restriction.</p>
      <div class="form-group"><label class="form-label">Allowed CIDRs / IPs</label>
        <textarea class="form-input" id="ip-cidrs" rows="8" style="font-family:ui-monospace,monospace;font-size:0.85rem">${esc((cidrs || []).join('\n'))}</textarea></div>
      <div id="ip-err"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="ip-save">Save</button>
      <button class="btn btn-secondary" id="ip-cancel">Cancel</button>
    </div></div>`);
    bd.querySelector('#ip-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#ip-save').addEventListener('click', async () => {
      const allowedCidrs = bd.querySelector('#ip-cidrs').value
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        await api.updateAppIpPolicy(appId, allowedCidrs);
        bd.remove();
        wrap.querySelector('#ip-msg').innerHTML = `<div class="alert alert-success">IP policy saved for ${esc(appName)}.</div>`;
        await loadIpTab();
      } catch (e) {
        bd.querySelector('#ip-err').innerHTML = errHtml(e.message);
      }
    });
  }

  function openTagGroupModal() {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>New Tag Group</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="tg-name"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="tg-desc"></div>
      <div class="form-group"><label class="form-label">Tags (comma-separated)</label>
        <input class="form-input" id="tg-tags" placeholder="finance, apac, contractors"></div>
      <div id="tg-err"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="tg-save">Create</button>
      <button class="btn btn-secondary" id="tg-cancel">Cancel</button>
    </div></div>`);
    bd.querySelector('#tg-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#tg-save').addEventListener('click', async () => {
      const name = bd.querySelector('#tg-name').value.trim();
      const tags = bd.querySelector('#tg-tags').value.split(',').map(t => t.trim()).filter(Boolean);
      if (!name || !tags.length) { bd.querySelector('#tg-err').innerHTML = errHtml('Name and at least one tag required'); return; }
      try {
        await api.createTagGroup({ name, description: bd.querySelector('#tg-desc').value, tags });
        bd.remove(); await loadAssignTab(); await loadStats();
      } catch (e) { bd.querySelector('#tg-err').innerHTML = errHtml(e.message); }
    });
  }

  async function openTagGroupMembersModal(groupId, groupName) {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Tag Group — ${esc(groupName)}</h2></div>
      <div class="modal-body"><div id="tg-m-list">${loading()}</div>
        <div class="form-group" style="margin-top:1rem"><label class="form-label">Add member (Employee ID)</label>
          <div style="display:flex;gap:0.5rem"><input class="form-input" id="tg-m-emp" placeholder="E12345" style="flex:1">
          <button class="btn btn-primary" id="tg-m-add">Add</button></div></div>
        <div id="tg-m-err"></div>
      </div><div class="modal-footer"><button class="btn btn-secondary" id="tg-m-close">Close</button></div></div>`);
    async function loadMembers() {
      try {
        const g = await api.getTagGroup(groupId);
        const members = g.members || [];
        const rows = members.length ? members.map(m => `
          <tr><td class="cell-strong">${esc(m.full_name || m.emp_id)}</td>
            <td class="muted">${esc(m.email_corp || '—')}</td>
            <td><button class="btn btn-sm btn-danger rm-m" data-emp="${esc(m.emp_id)}">Remove</button></td></tr>`).join('')
          : `<tr><td colspan="3"><p class="muted">No members.</p></td></tr>`;
        bd.querySelector('#tg-m-list').innerHTML = `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
        bd.querySelectorAll('.rm-m').forEach(btn => {
          btn.addEventListener('click', async () => {
            try { await api.removeTagGroupMember(groupId, btn.dataset.emp); await loadMembers(); } catch (e) { alert(e.message); }
          });
        });
      } catch (e) { bd.querySelector('#tg-m-list').innerHTML = errHtml(e.message); }
    }
    bd.querySelector('#tg-m-close').addEventListener('click', () => bd.remove());
    bd.querySelector('#tg-m-add').addEventListener('click', async () => {
      const empId = bd.querySelector('#tg-m-emp').value.trim();
      if (!empId) return;
      try { await api.addTagGroupMember(groupId, empId); bd.querySelector('#tg-m-emp').value = ''; await loadMembers(); }
      catch (e) { bd.querySelector('#tg-m-err').innerHTML = errHtml(e.message); }
    });
    await loadMembers();
  }

  // ── Tab: Group Access Workflow (JIT request + approval chains) ──
  async function loadWorkflowTab() {
    const area = wrap.querySelector('#tab-workflow');
    area.innerHTML = loading();
    try {
      await loadAppsAndGroups();
      const workflows = norm(await api.listAppAccessWorkflows());
      const groupNameById = new Map(identityGroupsCache.map(g => [String(g.id), g.name]));
      const rows = workflows.length ? workflows.map(w => {
        let levels = '—';
        try {
          const arr = typeof w.approval_levels === 'string' ? JSON.parse(w.approval_levels) : w.approval_levels;
          levels = Array.isArray(arr) ? arr.map(l => `L${l.level}:${l.approverType}`).join(' → ') : '—';
        } catch {}
        const reqGroups = Array.isArray(w.requester_group_ids) ? w.requester_group_ids : [];
        const reqLabel = reqGroups.length
          ? reqGroups.map(id => groupNameById.get(String(id)) || id).join(', ')
          : 'Any user';
        const jitBadge = w.app_requestable
          ? '<span class="badge badge-success">JIT</span>'
          : '<span class="badge badge-neutral">Off</span>';
        return `<tr>
          <td class="cell-strong">${esc(w.name)}</td>
          <td>${esc(w.app_name || '—')}</td>
          <td>${jitBadge}</td>
          <td class="muted" style="font-size:0.8rem">${esc(reqLabel)}</td>
          <td class="muted" style="font-size:0.8rem">${esc(levels)}</td>
          <td>${w.auto_provision ? '<span class="badge badge-success">Auto</span>' : '<span class="badge badge-neutral">Manual</span>'}</td>
          <td><button class="btn btn-sm btn-danger del-wf" data-id="${esc(String(w.id))}">Delete</button></td>
        </tr>`;
      }).join('') : `<tr><td colspan="7"><div class="empty-state"><p>No workflows configured.</p></div></td></tr>`;

      area.innerHTML = `
        <p class="muted aap-note">
          <strong>JIT / Request Access workflows</strong> — enable an app for the Request Access catalog,
          choose which identity groups may submit a request, and define the approval chain.
          Apps already assigned to a user never appear in their Request Access list.
        </p>
        <button class="btn btn-primary" id="wf-new" style="margin-bottom:1rem">+ New JIT Workflow</button>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Application</th><th>Request Access</th><th>Who can request</th><th>Approval Levels</th><th>Provisioning</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;

      area.querySelector('#wf-new').addEventListener('click', openWorkflowModal);
      area.querySelectorAll('.del-wf').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this workflow?')) return;
          try { await api.deleteAppAccessWorkflow(btn.dataset.id); await loadWorkflowTab(); await loadStats(); } catch (e) { alert(e.message); }
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  function openWorkflowModal() {
    const appOpts = appsCache.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    const tgOpts = `<option value="">— Any / app-wide —</option>`
      + tagGroupsCache.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
    const groupChecks = identityGroupsCache.length
      ? identityGroupsCache.map(g => `
          <label style="display:flex;align-items:center;gap:0.45rem;padding:0.25rem 0;cursor:pointer">
            <input type="checkbox" class="wf-req-group" value="${esc(g.id)}">
            <span style="font-size:0.85rem">${esc(g.name)}</span>
          </label>`).join('')
      : '<p class="muted" style="font-size:0.85rem">No identity groups yet — leave unchecked so any authenticated user can request. Create groups under Identity → Groups.</p>';

    const bd = openModal(`<div class="modal modal-wide"><div class="modal-header"><h2>New JIT Access Workflow</h2></div><div class="modal-body">
      <div class="form-2col">
        <div class="form-group"><label class="form-label">Workflow Name</label><input class="form-input" id="wf-name" placeholder="e.g. SentinelOne JIT"></div>
        <div class="form-group"><label class="form-label">Application</label><select class="form-select" id="wf-app">${appOpts}</select></div>
        <div class="form-group"><label class="form-label">Tag Group scope (optional)</label><select class="form-select" id="wf-tg">${tgOpts}</select></div>
        <div class="form-group"><label class="form-label">Auto-provision on approval</label>
          <select class="form-select" id="wf-auto"><option value="1">Yes</option><option value="0">No</option></select></div>
      </div>
      <div class="form-group" style="margin-top:0.75rem">
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
          <input type="checkbox" id="wf-jit" checked>
          <span><strong>Show in Request Access (JIT)</strong> — users can request this app from the portal</span>
        </label>
      </div>
      <div class="form-group" style="margin-top:0.75rem">
        <label class="form-label">Who can request (identity groups)</label>
        <p class="muted" style="font-size:0.8rem;margin:0 0 0.4rem">Leave all unchecked = any authenticated user can request. If you check groups, only members of those Identity → Groups appear in Request Access — add yourself to the group to test.</p>
        <div style="max-height:160px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);padding:0.5rem 0.75rem;background:var(--surface-2)">${groupChecks}</div>
      </div>
      <h3 style="font-size:0.9rem;margin:1rem 0 0.5rem">Approval Levels</h3>
      <div id="wf-levels">
        <div class="form-check-row wf-level" style="gap:0.5rem;margin-bottom:0.5rem">
          <input class="form-input" style="width:3rem" value="1" data-f="level" type="number" min="1">
          <select class="form-select" data-f="type" style="flex:1">
            <option value="MANAGER">Manager of requester</option>
            <option value="APP_OWNER">Application owner</option>
            <option value="ADMIN">Administrator</option>
            <option value="SPECIFIC">Specific approver</option>
          </select>
          <input class="form-input" data-f="emp" placeholder="Emp ID if SPECIFIC" style="flex:1">
        </div>
      </div>
      <button type="button" class="btn btn-sm btn-secondary" id="wf-add-level">+ Add Level</button>
      <div id="wf-err" style="margin-top:0.75rem"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="wf-save">Create Workflow</button>
      <button class="btn btn-secondary" id="wf-cancel">Cancel</button>
    </div></div>`);
    bd.querySelector('#wf-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#wf-add-level').addEventListener('click', () => {
      const n = bd.querySelectorAll('.wf-level').length + 1;
      const row = el(`<div class="form-check-row wf-level" style="gap:0.5rem;margin-bottom:0.5rem">
        <input class="form-input" style="width:3rem" value="${n}" data-f="level" type="number" min="1">
        <select class="form-select" data-f="type" style="flex:1">
          <option value="MANAGER">Manager of requester</option>
          <option value="APP_OWNER">Application owner</option>
          <option value="ADMIN">Administrator</option>
          <option value="SPECIFIC">Specific approver</option>
        </select>
        <input class="form-input" data-f="emp" placeholder="Emp ID if SPECIFIC" style="flex:1">
      </div>`);
      bd.querySelector('#wf-levels').appendChild(row);
    });
    bd.querySelector('#wf-save').addEventListener('click', async () => {
      const name = bd.querySelector('#wf-name').value.trim();
      const appId = bd.querySelector('#wf-app').value;
      const tagGroupId = bd.querySelector('#wf-tg').value || null;
      const requesterGroupIds = [...bd.querySelectorAll('.wf-req-group:checked')].map(n => n.value);
      const approvalLevels = [...bd.querySelectorAll('.wf-level')].map(row => {
        const level = parseInt(row.querySelector('[data-f="level"]').value, 10) || 1;
        const approverType = row.querySelector('[data-f="type"]').value;
        const emp = row.querySelector('[data-f="emp"]').value.trim();
        const o = { level, approverType };
        if (approverType === 'SPECIFIC' && emp) o.approverEmpId = emp;
        return o;
      });
      if (!name || !appId || !approvalLevels.length) {
        bd.querySelector('#wf-err').innerHTML = errHtml('Name, application, and at least one approval level required');
        return;
      }
      try {
        await api.createAppAccessWorkflow({
          appId, tagGroupId, name, approvalLevels,
          autoProvision: bd.querySelector('#wf-auto').value === '1',
          requestable: bd.querySelector('#wf-jit').checked,
          requesterGroupIds,
        });
        bd.remove(); await loadWorkflowTab(); await loadStats();
      } catch (e) { bd.querySelector('#wf-err').innerHTML = errHtml(e.message); }
    });
  }

  // ── Tab: Audit Log ──
  async function loadAuditTab() {
    const area = wrap.querySelector('#tab-audit');
    area.innerHTML = loading();
    try {
      const events = norm(await api.listAppAccessAudit());
      const actionBadge = a => ({
        ASSIGN_USER: 'badge-success', ASSIGN_GROUP: 'badge-success', PROVISION: 'badge-info',
        REQUEST: 'badge-warning', APPROVE: 'badge-success', REJECT: 'badge-danger', REVOKE: 'badge-danger',
      }[a] || 'badge-neutral');
      const rows = events.length ? events.map(e => `
        <tr>
          <td class="muted" style="white-space:nowrap">${e.created_at ? fmtDate(e.created_at) : '—'}</td>
          <td><span class="badge ${actionBadge(e.action)}">${esc(e.action)}</span></td>
          <td>${esc(e.app_name || '—')}</td>
          <td class="muted">${esc(e.actor_name || e.actor_emp_id || '—')}</td>
          <td class="muted">${esc(e.target_name || e.target_emp_id || e.tag_group_name || '—')}</td>
          <td class="muted" style="font-size:0.78rem">${esc(e.request_id || '—')}</td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><p>No audit events yet.</p></div></td></tr>`;

      area.innerHTML = `
        <p class="muted aap-note">Immutable log of assignments, access requests, approvals, provisioning, and revocations.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Action</th><th>Application</th><th>Actor</th><th>Target</th><th>Request</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  wrap.querySelectorAll('.cfg-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      if (tab.dataset.tab === 'assign') await loadAssignTab();
      if (tab.dataset.tab === 'ip') await loadIpTab();
      if (tab.dataset.tab === 'workflow') await loadWorkflowTab();
      if (tab.dataset.tab === 'audit') await loadAuditTab();
    });
  });

  await loadStats();
  await loadAssignTab();
}

// ─── 13. PAM Resources ────────────────────────────────────────────────────────
export async function viewPamResources(content) {
  content.replaceChildren(el(`<div>${header('PAM Resources', 'Privileged access targets — SSH, RDP, databases, web apps', `<button class="btn btn-primary" id="new-pam-btn">+ Add Resource</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const resources = norm(await api.listPamResources());
      const typeBadge = t => ({ SSH: 'badge-success', RDP: 'badge-info', DATABASE: 'badge-warning', DB: 'badge-warning', WEB: 'badge-neutral', WINDOWS: 'badge-neutral' }[t] || 'badge-neutral');
      const rows = resources.length ? resources.map(r => `
        <tr>
          <td class="cell-strong">${esc(r.name)}</td>
          <td><span class="badge ${typeBadge(r.type||r.resource_type)}">${esc(r.type||r.resource_type||'—')}</span></td>
          <td class="muted">${esc(r.hostname||'—')}</td>
          <td class="muted">${r.port ?? '—'}</td>
          <td>${r.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-pam" data-p="${escAttrJson({id:r.id,name:r.name,type:r.type||r.resource_type,hostname:r.hostname,port:r.port,description:r.description||""})}">Edit</button>
            <button class="btn btn-sm btn-danger del-pam" data-id="${esc(String(r.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No PAM resources.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Hostname</th><th>Port</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-pam').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this resource?')) return;
          try { await api.deletePamResource(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-pam').forEach(btn => {
        btn.addEventListener('click', () => { let p; try { p = JSON.parse(btn.dataset.p); } catch { p = {}; } openPamModal(p.id, p); });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openPamModal(id, d = {}) {
    const isEdit = !!id;
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'Add'} PAM Resource</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="pam-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Resource Type</label><select class="form-select" id="pam-type">
        <option value="SSH" ${(d.type||d.resource_type)==='SSH'?'selected':''}>SSH</option>
        <option value="RDP" ${(d.type||d.resource_type)==='RDP'?'selected':''}>RDP</option>
        <option value="DATABASE" ${(d.type||d.resource_type)==='DATABASE'?'selected':''}>Database</option>
        <option value="WEB" ${(d.type||d.resource_type)==='WEB'?'selected':''}>Web App</option>
        <option value="WINDOWS" ${(d.type||d.resource_type)==='WINDOWS'?'selected':''}>Windows</option>
      </select></div>
      <div class="form-group"><label class="form-label">Hostname</label><input class="form-input" id="pam-host" value="${esc(d.hostname||'')}"></div>
      <div class="form-group"><label class="form-label">Port</label><input class="form-input" id="pam-port" type="number" value="${esc(String(d.port||22))}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="pam-desc" value="${esc(d.description||'')}"></div>
      <div id="pam-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="pam-save">${isEdit ? 'Update' : 'Add'}</button><button class="btn btn-secondary" id="pam-cancel">Cancel</button></div></div>`);
    bd.querySelector('#pam-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#pam-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#pam-name').value, type: bd.querySelector('#pam-type').value, hostname: bd.querySelector('#pam-host').value, port: parseInt(bd.querySelector('#pam-port').value)||22, description: bd.querySelector('#pam-desc').value };
      if (!data.name || !data.hostname) { bd.querySelector('#pam-err').innerHTML = errHtml('Name and hostname are required'); return; }
      try {
        if (isEdit) await api.updatePamResource(id, data); else await api.createPamResource(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#pam-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#new-pam-btn').addEventListener('click', () => openPamModal(null));
  await load();
}

// ─── 14. PAM Sessions ─────────────────────────────────────────────────────────
export async function viewPamSessions(content) {
  content.replaceChildren(el(`<div>${header('PAM Sessions', 'Active and historical privileged sessions')}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const sessions = norm(await api.listPamSessions());
      const statusBadge = s => ({ ACTIVE: 'badge-success', ENDED: 'badge-neutral', TERMINATED: 'badge-danger' }[s] || 'badge-neutral');
      const rows = sessions.length ? sessions.map(s => `
        <tr>
          <td class="cell-strong">${esc(s.resource_name||s.resource_id||'—')}</td>
          <td class="muted">${esc(s.initiated_by||s.user_email||'—')}</td>
          <td class="muted">${s.started_at ? fmtDate(s.started_at) : '—'}</td>
          <td class="muted">${s.ended_at ? fmtDate(s.ended_at) : '—'}</td>
          <td><span class="badge ${statusBadge(s.status)}">${esc(s.status||'—')}</span></td>
          <td>${s.status === 'ACTIVE' ? `<button class="btn btn-sm btn-danger term-sess" data-id="${esc(String(s.id))}">Terminate</button>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No sessions found.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Resource</th><th>Initiated By</th><th>Started</th><th>Ended</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.term-sess').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Terminate this session?')) return;
          try { await api.terminatePamSession(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  await load();
}

// ─── 15. PAM Vault ────────────────────────────────────────────────────────────
export async function viewPamVault(content) {
  content.replaceChildren(el(`<div>${header('PAM Vault', 'Privileged credential vault — secure storage and checkout', `<button class="btn btn-primary" id="new-vault-btn">+ Add Entry</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const entries = norm(await api.listVaultEntries());
      const rows = entries.length ? entries.map(e => `
        <tr>
          <td class="cell-strong">${esc(e.name || e.label || '—')}</td>
          <td><span class="badge badge-info">${esc(e.type || 'PASSWORD')}</span></td>
          <td class="muted">${esc(e.username||'—')}</td>
          <td class="muted">${e.last_rotated_at ? fmtDate(e.last_rotated_at) : '—'}</td>
          <td class="muted">${e.next_rotation_at ? fmtDate(e.next_rotation_at) : '—'}</td>
          <td>
            <button class="btn btn-sm btn-secondary checkout-vault" data-id="${esc(String(e.id))}" data-label="${esc(e.name || e.label || '')}">Checkout</button>
            <button class="btn btn-sm btn-danger del-vault" data-id="${esc(String(e.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No vault entries.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Username</th><th>Last Rotated</th><th>Next Rotation</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-vault').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this vault entry?')) return;
          try { await api.deleteVaultEntry(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.checkout-vault').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const result = await api.checkoutVaultEntry(btn.dataset.id);
            openModal(`<div class="modal"><div class="modal-header"><h2>Checkout: ${esc(btn.dataset.label)}</h2></div><div class="modal-body">
              <p class="muted">This credential will be available for a limited time.</p>
              <div class="form-group"><label class="form-label">Secret</label><input class="form-input" value="${esc(result.secret||result.password||'(see response)')}" readonly onclick="this.select()" style="font-family:monospace"></div>
              ${result.expires_at ? `<p class="muted" style="font-size:0.85rem">Expires: ${esc(fmtDate(result.expires_at))}</p>` : ''}
            </div><div class="modal-footer"><button class="btn btn-primary" id="co-close">Done</button></div></div>`).querySelector('#co-close').addEventListener('click', e => e.target.closest('.modal-backdrop').remove());
          } catch(e) { alert('Checkout failed: ' + e.message); }
        });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  wrap.querySelector('#new-vault-btn').addEventListener('click', () => {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Add Vault Entry</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="v-label" placeholder="prod-db-admin"></div>
      <div class="form-group"><label class="form-label">Username</label><input class="form-input" id="v-user" placeholder="admin"></div>
      <div class="form-group"><label class="form-label">Secret</label><input class="form-input" id="v-secret" type="password" autocomplete="new-password" placeholder="Password, token, or key material"></div>
      <div class="form-group"><label class="form-label">Type</label><select class="form-select" id="v-stype"><option value="PASSWORD">PASSWORD</option><option value="SSH_KEY">SSH_KEY</option><option value="API_TOKEN">API_TOKEN</option><option value="DATABASE">DATABASE</option><option value="CERTIFICATE">CERTIFICATE</option></select></div>
      <div class="form-group"><label class="form-label">Rotation Days</label><input class="form-input" id="v-rot" type="number" value="90" min="1"></div>
      <div id="v-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="v-save">Add</button><button class="btn btn-secondary" id="v-cancel">Cancel</button></div></div>`);
    bd.querySelector('#v-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#v-save').addEventListener('click', async () => {
      const data = {
        name: bd.querySelector('#v-label').value.trim(),
        username: bd.querySelector('#v-user').value.trim() || undefined,
        secret: bd.querySelector('#v-secret').value,
        type: bd.querySelector('#v-stype').value,
        rotation_days: parseInt(bd.querySelector('#v-rot').value, 10) || 90,
      };
      if (!data.name) { bd.querySelector('#v-err').innerHTML = errHtml('Name required'); return; }
      if (!data.secret) { bd.querySelector('#v-err').innerHTML = errHtml('Secret required'); return; }
      try { await api.createVaultEntry(data); bd.remove(); await load(); } catch(e) { bd.querySelector('#v-err').innerHTML = errHtml(e.message); }
    });
  });

  await load();
}

// ─── 16. Workflow Library ─────────────────────────────────────────────────────
const WF_EVENTS = ['JOINER', 'LEAVER', 'MOVER', 'SUSPEND', 'UNSUSPEND', 'MFA_ENROLLED', 'SUSPICIOUS_LOGIN', 'ROLE_CHANGE', 'ACCESS_REQUEST'];
const WF_STEP_TYPES = [
  { value: 'GRANT_BIRTHRIGHT', label: 'Grant Birthright Entitlements' },
  { value: 'REVOKE_BIRTHRIGHT', label: 'Revoke Birthright Entitlements' },
  { value: 'NOTIFY', label: 'Send Notification' },
  { value: 'WEBHOOK', label: 'HTTP Webhook' },
];

function wfStepRow(step, idx) {
  const cfg = step.config || {};
  const extra = step.type === 'NOTIFY'
    ? `<div class="form-group"><label class="form-label">Channel</label><select class="form-select wf-step-channel" data-idx="${idx}"><option value="IN_APP" ${cfg.channel==='IN_APP'?'selected':''}>In-App</option><option value="EMAIL" ${cfg.channel==='EMAIL'?'selected':''}>Email</option><option value="SLACK" ${cfg.channel==='SLACK'?'selected':''}>Slack</option></select></div>
       <div class="form-group"><label class="form-label">Subject</label><input class="form-input wf-step-subject" data-idx="${idx}" value="${esc(cfg.subject||'')}"></div>
       <div class="form-group"><label class="form-label">Body</label><textarea class="form-textarea wf-step-body" data-idx="${idx}" rows="2">${esc(cfg.body||'')}</textarea></div>`
    : step.type === 'WEBHOOK'
      ? `<div class="form-group"><label class="form-label">Webhook URL</label><input class="form-input wf-step-url" data-idx="${idx}" value="${esc(cfg.url||'')}"></div>
         <div class="form-group"><label class="form-label">Secret (optional)</label><input class="form-input wf-step-secret" data-idx="${idx}" value="${esc(cfg.secret||'')}"></div>`
      : '';
  return `<div class="wf-step-card" data-idx="${idx}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
      <strong>Step ${idx + 1}</strong>
      <button type="button" class="btn btn-sm btn-danger wf-rm-step" data-idx="${idx}">Remove</button>
    </div>
    <div class="form-group"><label class="form-label">Action</label>
      <select class="form-select wf-step-type" data-idx="${idx}">
        ${WF_STEP_TYPES.map(t => `<option value="${t.value}" ${step.type===t.value?'selected':''}>${t.label}</option>`).join('')}
      </select>
    </div>
    ${extra}
  </div>`;
}

export async function viewWorkflowLibrary(content, initialTab = 'definitions') {
  const tabMap = { definitions: 'definitions', defs: 'definitions', triggers: 'triggers', runs: 'runs' };
  let activeTab = tabMap[initialTab] || 'definitions';
  content.replaceChildren(el(`<div class="ent-page">
    ${header('Workflows', 'Multi-step automations and single-action event hooks — Application Access Policy owns approval chains separately', `<button class="btn btn-primary" id="new-wf-btn">+ New Workflow</button><button class="btn btn-secondary" id="new-et-btn" hidden>+ New Trigger</button>`)}
    <div id="wf-stats" class="stat-grid" style="margin-bottom:1rem"></div>
    <div class="inline-tabs" id="wf-tabs" style="margin-bottom:1rem">
      <button type="button" class="inline-tab${activeTab === 'definitions' ? ' active' : ''}" data-tab="definitions">Definitions</button>
      <button type="button" class="inline-tab${activeTab === 'triggers' ? ' active' : ''}" data-tab="triggers">Event Triggers</button>
      <button type="button" class="inline-tab${activeTab === 'runs' ? ' active' : ''}" data-tab="runs">Run History</button>
    </div>
    <div id="tab-definitions" ${activeTab !== 'definitions' ? 'hidden' : ''}><div id="list-area">${loading()}</div></div>
    <div id="tab-triggers" ${activeTab !== 'triggers' ? 'hidden' : ''}><div id="triggers-area">${loading()}</div></div>
    <div id="tab-runs" ${activeTab !== 'runs' ? 'hidden' : ''}><div id="runs-area">${loading()}</div></div>
  </div>`));
  const wrap = content.firstChild;
  const newWfBtn = wrap.querySelector('#new-wf-btn');
  const newEtBtn = wrap.querySelector('#new-et-btn');

  async function loadDefs() {
    try {
      const workflows = norm(await api.listWorkflows());
      wrap.querySelector('#wf-stats').innerHTML = [
        statCard('flow', 'Active Workflows', workflows.filter(w => w.active).length, 'triggered on events', 'success'),
        statCard('list', 'Total Defined', workflows.length, 'in library', 'primary'),
      ].join('');
      const rows = workflows.length ? workflows.map(w => `
        <tr>
          <td class="cell-strong">${esc(w.name)}</td>
          <td><span class="badge badge-info">${esc(w.trigger_event||'—')}</span></td>
          <td>${w.steps_count ?? (Array.isArray(w.steps) ? w.steps.length : 0)}</td>
          <td>${w.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-wf" data-id="${esc(String(w.id))}" data-p="${escAttrJson({name:w.name,description:w.description||'',trigger_event:w.trigger_event||'',steps:w.steps||[]})}">Edit</button>
            <button class="btn btn-sm btn-danger del-wf" data-id="${esc(String(w.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No workflows defined. Create one to automate JOINER, LEAVER, or ACCESS_REQUEST events.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Trigger</th><th>Steps</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-wf').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this workflow?')) return;
          try { await api.deleteWorkflow(btn.dataset.id); await loadDefs(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-wf').forEach(btn => {
        btn.addEventListener('click', () => { let p; try { p = JSON.parse(btn.dataset.p); } catch { p = {}; } openWfModal(btn.dataset.id, p); });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  async function loadRuns() {
    try {
      const runs = norm(await api.listWorkflowRuns());
      const statusBadge = s => ({ COMPLETED: 'badge-success', RUNNING: 'badge-info', FAILED: 'badge-danger', HALTED: 'badge-warning' }[s] || 'badge-neutral');
      const rows = runs.length ? runs.map(r => `
        <tr>
          <td class="muted" style="font-size:0.8rem">${fmtDate(r.started_at)}</td>
          <td class="cell-strong">${esc(r.workflow_name||'—')}</td>
          <td>${esc(r.emp_name||r.emp_id)}</td>
          <td><span class="badge badge-info">${esc(r.trigger_event)}</span></td>
          <td>${r.current_step}/${r.steps_total}</td>
          <td><span class="badge ${statusBadge(r.status)}">${esc(r.status)}</span></td>
          <td class="muted" style="font-size:0.75rem">${esc(r.error_message||'')}</td>
        </tr>`).join('') : `<tr><td colspan="7"><div class="empty-state"><p>No workflow runs yet.</p></div></td></tr>`;
      wrap.querySelector('#runs-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Workflow</th><th>Employee</th><th>Event</th><th>Progress</th><th>Status</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } catch(e) { wrap.querySelector('#runs-area').innerHTML = errHtml(e.message); }
  }

  function collectSteps(bd) {
    const cards = [...bd.querySelectorAll('.wf-step-card')];
    return cards.map((card) => {
      const type = card.querySelector('.wf-step-type')?.value;
      const config = {};
      if (type === 'NOTIFY') {
        config.channel = card.querySelector('.wf-step-channel')?.value || 'IN_APP';
        config.subject = card.querySelector('.wf-step-subject')?.value || '';
        config.body = card.querySelector('.wf-step-body')?.value || '';
      } else if (type === 'WEBHOOK') {
        config.url = card.querySelector('.wf-step-url')?.value || '';
        config.secret = card.querySelector('.wf-step-secret')?.value || '';
      }
      return { type, config };
    });
  }

  function wireStepBuilder(bd, steps = []) {
    const area = bd.querySelector('#wf-steps-area');
    const render = () => {
      area.innerHTML = steps.map((s, i) => wfStepRow(s, i)).join('') || '<p class="muted">No steps yet — add at least one action.</p>';
      area.querySelectorAll('.wf-rm-step').forEach(btn => {
        btn.addEventListener('click', () => { steps = collectSteps(bd); steps.splice(Number(btn.dataset.idx), 1); render(); });
      });
      area.querySelectorAll('.wf-step-type').forEach(sel => {
        sel.addEventListener('change', () => { steps = collectSteps(bd); steps[Number(sel.dataset.idx)].type = sel.value; render(); });
      });
    };
    bd.querySelector('#wf-add-step').addEventListener('click', () => {
      steps = collectSteps(bd);
      steps.push({ type: 'GRANT_BIRTHRIGHT', config: {} });
      render();
    });
    render();
  }

  function openWfModal(id, d = {}) {
    const isEdit = !!id;
    const steps = Array.isArray(d.steps) ? d.steps : [];
    const bd = openModal(`<div class="modal" style="max-width:640px"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Workflow</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="wf-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="wf-desc" value="${esc(d.description||'')}"></div>
      <div class="form-group"><label class="form-label">Trigger Event</label>
        <select class="form-select" id="wf-event">
          <option value="">— Select event —</option>
          ${WF_EVENTS.map(e => `<option value="${e}" ${d.trigger_event===e?'selected':''}>${e}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:1rem 0 0.5rem">
        <label class="form-label" style="margin:0">Steps</label>
        <button type="button" class="btn btn-sm btn-secondary" id="wf-add-step">+ Add Step</button>
      </div>
      <div id="wf-steps-area"></div>
      <div id="wf-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="wf-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="wf-cancel">Cancel</button></div></div>`);
    wireStepBuilder(bd, steps.length ? steps : [{ type: 'GRANT_BIRTHRIGHT', config: {} }]);
    bd.querySelector('#wf-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#wf-save').addEventListener('click', async () => {
      const stepsOut = collectSteps(bd);
      const data = {
        name: bd.querySelector('#wf-name').value.trim(),
        description: bd.querySelector('#wf-desc').value.trim(),
        trigger_event: bd.querySelector('#wf-event').value,
        steps: stepsOut,
      };
      if (!data.name) { bd.querySelector('#wf-err').innerHTML = errHtml('Name required'); return; }
      if (!data.trigger_event) { bd.querySelector('#wf-err').innerHTML = errHtml('Trigger event required'); return; }
      if (!stepsOut.length) { bd.querySelector('#wf-err').innerHTML = errHtml('Add at least one step'); return; }
      try {
        if (isEdit) await api.updateWorkflow(id, data); else await api.createWorkflow(data);
        bd.remove(); await loadDefs();
      } catch(e) { bd.querySelector('#wf-err').innerHTML = errHtml(e.message); }
    });
  }

  async function loadTriggers() {
    const area = wrap.querySelector('#triggers-area');
    try {
      const triggers = norm(await api.listEventTriggers());
      const chBadge = ch => ({ WEBHOOK: 'badge-info', SLACK: 'badge-success', TEAMS: 'badge-warning', EMAIL: 'badge-neutral' }[ch] || 'badge-neutral');
      const rows = triggers.length ? triggers.map(t => `
        <tr>
          <td class="cell-strong">${esc(t.name)}</td>
          <td><span class="badge badge-info">${esc(t.event_type||'—')}</span></td>
          <td><span class="badge ${chBadge(t.channel)}">${esc(t.channel||'—')}</span></td>
          <td class="muted" style="font-size:0.8rem;max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(t.target_url||t.target||'—')}</td>
          <td>${t.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-et" data-p="${escAttrJson({id:t.id,name:t.name,event_type:t.event_type,channel:t.channel,target_url:t.target_url||t.target||"",secret:""})}">Edit</button>
            <button class="btn btn-sm btn-danger del-et" data-id="${esc(String(t.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No event triggers. Use single-action webhooks/Slack/email here; multi-step flows go under Definitions.</p></div></td></tr>`;
      area.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Event</th><th>Channel</th><th>Target</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      area.querySelectorAll('.del-et').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this trigger?')) return;
          try { await api.deleteEventTrigger(btn.dataset.id); await loadTriggers(); } catch(e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.edit-et').forEach(btn => {
        btn.addEventListener('click', () => { let p; try { p = JSON.parse(btn.dataset.p); } catch { p = {}; } openEtModal(p.id, p); });
      });
    } catch(e) { area.innerHTML = errHtml(e.message); }
  }

  function openEtModal(id, d = {}) {
    const isEdit = !!id;
    const events = ['JOINER','LEAVER','MOVER','SUSPEND','UNSUSPEND','MFA_ENROLLED','SUSPICIOUS_LOGIN','ROLE_CHANGE','ACCESS_REQUEST'];
    const channels = ['WEBHOOK','SLACK','TEAMS','EMAIL'];
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Event Trigger</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="et-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Event Type</label><select class="form-select" id="et-event">${events.map(e => `<option ${d.event_type===e?'selected':''}>${e}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Channel</label><select class="form-select" id="et-ch">${channels.map(c => `<option ${d.channel===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Target URL</label><input class="form-input" id="et-url" value="${esc(d.target_url||'')}" placeholder="https://hooks.example.com/..."></div>
      <div class="form-group"><label class="form-label">Signing Secret</label><input class="form-input" id="et-secret" value="" placeholder="${isEdit ? 'Leave blank to keep existing' : 'Optional HMAC secret'}"></div>
      <div id="et-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="et-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="et-cancel">Cancel</button></div></div>`);
    bd.querySelector('#et-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#et-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#et-name').value, event_type: bd.querySelector('#et-event').value, channel: bd.querySelector('#et-ch').value, target_url: bd.querySelector('#et-url').value };
      const secret = bd.querySelector('#et-secret').value;
      if (secret) data.secret = secret;
      if (!data.name || !data.target_url) { bd.querySelector('#et-err').innerHTML = errHtml('Name and target URL required'); return; }
      try {
        if (isEdit) await api.updateEventTrigger(id, data); else await api.createEventTrigger(data);
        bd.remove(); await loadTriggers();
      } catch(e) { bd.querySelector('#et-err').innerHTML = errHtml(e.message); }
    });
  }

  async function showWfTab(name) {
    activeTab = name;
    wrap.querySelectorAll('#wf-tabs .inline-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    wrap.querySelector('#tab-definitions').hidden = name !== 'definitions';
    wrap.querySelector('#tab-triggers').hidden = name !== 'triggers';
    wrap.querySelector('#tab-runs').hidden = name !== 'runs';
    newWfBtn.hidden = name !== 'definitions';
    newEtBtn.hidden = name !== 'triggers';
    syncAppUrl('workflowLibrary', name, 'definitions');
    if (name === 'definitions') await loadDefs();
    else if (name === 'triggers') await loadTriggers();
    else if (name === 'runs') await loadRuns();
  }

  newWfBtn.addEventListener('click', () => openWfModal(null));
  newEtBtn.addEventListener('click', () => openEtModal(null));
  wrap.querySelector('#wf-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) void showWfTab(btn.dataset.tab);
  });

  await showWfTab(activeTab);
}

/** @deprecated Use Workflows → Event Triggers tab */
export async function viewEventTriggers(content) {
  return viewWorkflowLibrary(content, 'triggers');
}

// ─── 18. Notifications ────────────────────────────────────────────────────────
export async function viewNotifications(content) {
  content.replaceChildren(el(`<div>${header('Notifications', 'Notification delivery stats and recent messages')}<div id="notif-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const [stats, _rawNotifs] = await Promise.all([api.notificationStats(), api.listNotifications()]);
      const notifs = norm(_rawNotifs);
      const byStatus = Object.fromEntries((stats?.byStatus || []).map(r => [r.status, Number(r.count) || 0]));
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const statusBadge = s => ({ SENT: 'badge-success', FAILED: 'badge-danger', PENDING: 'badge-warning', PROCESSING: 'badge-info' }[s] || 'badge-neutral');
      const rows = notifs.length ? notifs.map(n => `
        <tr>
          <td class="cell-strong">${esc(n.subject||'—')}</td>
          <td><span class="badge badge-info">${esc(n.channel||'—')}</span></td>
          <td class="muted">${esc(n.recipient_name||n.recipient_emp_id||n.recipient||'—')}</td>
          <td><span class="badge ${statusBadge(n.status)}">${esc(n.status||'—')}</span></td>
          <td class="muted">${n.created_at ? fmtDate(n.created_at) : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No notifications found.</p></div></td></tr>`;
      wrap.querySelector('#notif-area').innerHTML = `
        <div class="stat-grid" style="margin-bottom:1.5rem">
          <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total</div></div>
          <div class="stat-card"><div class="stat-value">${byStatus.SENT ?? 0}</div><div class="stat-label">Sent</div></div>
          <div class="stat-card"><div class="stat-value">${byStatus.FAILED ?? 0}</div><div class="stat-label">Failed</div></div>
          <div class="stat-card"><div class="stat-value">${byStatus.PENDING ?? 0}</div><div class="stat-label">Pending</div></div>
        </div>
        <div style="display:flex;gap:0.75rem;margin-bottom:1rem">
          <button class="btn btn-primary" id="dispatch-btn">Dispatch Pending</button>
          <button class="btn btn-secondary" id="send-test-btn">Send Test</button>
        </div>
        <div id="notif-msg"></div>
        <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Channel</th><th>Recipient</th><th>Status</th><th>Sent</th></tr></thead><tbody>${rows}</tbody></table></div>`;

      wrap.querySelector('#dispatch-btn').addEventListener('click', async () => {
        const btn = wrap.querySelector('#dispatch-btn');
        btn.disabled = true; btn.textContent = 'Dispatching…';
        try {
          const r = await api.dispatchNotifications();
          wrap.querySelector('#notif-msg').innerHTML = `<div class="alert alert-success">Dispatched. ${r?.dispatched ?? ''} notifications queued.</div>`;
          await load();
        } catch(e) { wrap.querySelector('#notif-msg').innerHTML = errHtml(e.message); btn.disabled = false; btn.textContent = 'Dispatch Pending'; }
      });
      wrap.querySelector('#send-test-btn').addEventListener('click', () => {
        const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Send Test Notification</h2></div><div class="modal-body">
          <div class="form-group"><label class="form-label">Channel</label><select class="form-select" id="tn-ch"><option>EMAIL</option><option>SLACK</option><option>WEBHOOK</option></select></div>
          <div class="form-group"><label class="form-label">Recipient (emp ID or email)</label><input class="form-input" id="tn-to" placeholder="E12345 or user@example.com"></div>
          <div class="form-group"><label class="form-label">Subject</label><input class="form-input" id="tn-subj" value="Test notification from Lenskart IdP"></div>
          <div class="form-group"><label class="form-label">Body</label><textarea class="form-textarea" id="tn-body" rows="3">This is a test notification.</textarea></div>
          <div id="tn-err"></div>
        </div><div class="modal-footer"><button class="btn btn-primary" id="tn-send">Send</button><button class="btn btn-secondary" id="tn-cancel">Cancel</button></div></div>`);
        bd.querySelector('#tn-cancel').addEventListener('click', () => bd.remove());
        bd.querySelector('#tn-send').addEventListener('click', async () => {
          const data = { channel: bd.querySelector('#tn-ch').value, recipient: bd.querySelector('#tn-to').value, subject: bd.querySelector('#tn-subj').value, body: bd.querySelector('#tn-body').value };
          if (!data.recipient) { bd.querySelector('#tn-err').innerHTML = errHtml('Recipient required'); return; }
          try { await api.sendTestNotification(data); bd.remove(); } catch(e) { bd.querySelector('#tn-err').innerHTML = errHtml(e.message); }
        });
      });
    } catch(e) { wrap.querySelector('#notif-area').innerHTML = errHtml(e.message); }
  }

  await load();
}

// ─── 19. SSO Reports ─────────────────────────────────────────────────────────
function csvDownload(filename, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  a.click();
}

export async function viewSsoReports(content, opts = {}) {
  const embed = !!opts.embed;
  content.replaceChildren(el(`<div class="${embed ? '' : 'ent-page'}">
    ${embed ? '' : header('SSO Reports', 'Login analytics, adoption and dormancy reports')}
    <div id="sso-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;
  const area = wrap.querySelector('#sso-area');

  function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  async function load(from = daysAgo(30), to = today()) {
    area.innerHTML = loading();
    try {
      const params = { from, to };
      const [summaryRes, failedRes, adoptionRes, dormantRes] = await Promise.all([
        api.ssoLoginSummary(params),
        api.ssoFailedLogins(params),
        api.ssoAppAdoption(params),
        api.ssoDormantUsers(params),
      ]);
      const summary = norm(summaryRes);
      const failed = norm(failedRes);
      const adoption = norm(adoptionRes);
      const dormant = norm(dormantRes);
      const meta = summaryRes.meta || failedRes.meta || { from, to, days: 30 };

      const summaryRows = summary.map(r => `<tr><td>${esc(r.app||r.application||'—')}</td><td>${r.count ?? 0}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">No data</td></tr>`;
      const failedRows = failed.map(r => `<tr><td>${esc(r.email||'—')}</td><td>${r.count ?? 0}</td><td class="muted">${r.last_attempt ? fmtDate(r.last_attempt) : '—'}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">No data</td></tr>`;
      const adoptionRows = adoption.map(r => `<tr><td>${esc(r.app||r.application||'—')}</td><td>${r.entitled ?? 0}</td><td>${r.signed_in ?? 0}</td><td>${r.adoption_pct != null ? r.adoption_pct+'%' : '—'}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">No data</td></tr>`;
      const dormantRows = dormant.map(r => `<tr><td>${esc(r.email||'—')}</td><td class="muted">${r.last_login ? fmtDate(r.last_login) : 'Never'}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">No data</td></tr>`;

      area.innerHTML = `
        <div class="ent-panel" style="margin-bottom:1rem">
          <div class="ent-panel-head">
            <div class="panel-meta">
              <h2>Report window</h2>
              <p class="subtitle">Analytics for SSO adoption, failures, and dormancy</p>
            </div>
            <div class="audit-preset-row">
              <button type="button" class="btn btn-sm btn-secondary sso-preset" data-days="7">7d</button>
              <button type="button" class="btn btn-sm btn-secondary sso-preset" data-days="30">30d</button>
              <button type="button" class="btn btn-sm btn-secondary sso-preset" data-days="90">90d</button>
            </div>
          </div>
          <div class="ent-panel-body">
            <div class="audit-filter-grid" style="max-width:520px">
              <div class="form-group"><label class="form-label">From</label>
                <input type="date" class="form-input" id="sso-from" value="${esc(from)}"></div>
              <div class="form-group"><label class="form-label">To</label>
                <input type="date" class="form-input" id="sso-to" value="${esc(to)}"></div>
            </div>
            <div class="audit-filter-actions">
              <button type="button" class="btn btn-primary" id="sso-apply">Apply</button>
              <span class="muted" style="font-size:0.8rem">Window: ${esc(meta.from || from)} → ${esc(meta.to || to || 'now')}</span>
            </div>
          </div>
        </div>
        <div class="mfa-delivery-split">
          <div class="ent-panel">
            <div class="ent-panel-head">
              <div class="panel-meta"><h2>Login summary</h2><p class="subtitle">SSO assertions per application</p></div>
              <button class="btn btn-sm btn-secondary" id="exp-summary">Export CSV</button>
            </div>
            <div class="ent-panel-body"><div class="table-wrap"><table><thead><tr><th>App</th><th>Logins</th></tr></thead><tbody>${summaryRows}</tbody></table></div></div>
          </div>
          <div class="ent-panel">
            <div class="ent-panel-head">
              <div class="panel-meta"><h2>Failed logins</h2><p class="subtitle">Portal auth failures by email</p></div>
              <button class="btn btn-sm btn-secondary" id="exp-failed">Export CSV</button>
            </div>
            <div class="ent-panel-body"><div class="table-wrap"><table><thead><tr><th>Email</th><th>Count</th><th>Last attempt</th></tr></thead><tbody>${failedRows}</tbody></table></div></div>
          </div>
          <div class="ent-panel">
            <div class="ent-panel-head">
              <div class="panel-meta"><h2>App adoption</h2><p class="subtitle">Active employees vs signed-in</p></div>
              <button class="btn btn-sm btn-secondary" id="exp-adoption">Export CSV</button>
            </div>
            <div class="ent-panel-body"><div class="table-wrap"><table><thead><tr><th>App</th><th>Entitled</th><th>Signed in</th><th>Adoption</th></tr></thead><tbody>${adoptionRows}</tbody></table></div></div>
          </div>
          <div class="ent-panel">
            <div class="ent-panel-head">
              <div class="panel-meta"><h2>Dormant users</h2><p class="subtitle">No session activity in window</p></div>
              <button class="btn btn-sm btn-secondary" id="exp-dormant">Export CSV</button>
            </div>
            <div class="ent-panel-body"><div class="table-wrap"><table><thead><tr><th>Email</th><th>Last login</th></tr></thead><tbody>${dormantRows}</tbody></table></div></div>
          </div>
        </div>`;

      area.querySelector('#sso-apply')?.addEventListener('click', () => {
        void load(area.querySelector('#sso-from').value, area.querySelector('#sso-to').value);
      });
      area.querySelectorAll('.sso-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          void load(daysAgo(Number(btn.dataset.days) || 30), today());
        });
      });
      area.querySelector('#exp-summary')?.addEventListener('click', () => csvDownload('login-summary.csv', [['App','Logins'], ...summary.map(r => [r.app||r.application||'', r.count||0])]));
      area.querySelector('#exp-failed')?.addEventListener('click', () => csvDownload('failed-logins.csv', [['Email','Count','Last Attempt'], ...failed.map(r => [r.email||'', r.count||0, r.last_attempt||''])]));
      area.querySelector('#exp-adoption')?.addEventListener('click', () => csvDownload('app-adoption.csv', [['App','Entitled','Signed In','Adoption %'], ...adoption.map(r => [r.app||r.application||'', r.entitled||0, r.signed_in||0, r.adoption_pct||''])]));
      area.querySelector('#exp-dormant')?.addEventListener('click', () => csvDownload('dormant-users.csv', [['Email','Last Login'], ...dormant.map(r => [r.email||'', r.last_login||'Never'])]));
    } catch (e) {
      area.innerHTML = errHtml(e.message);
    }
  }

  await load();
}

// ─── 20. General Settings ────────────────────────────────────────────────────
export async function viewGeneralSettings(content) {
  content.replaceChildren(el(`<div>${header('General Settings', 'Organisation-wide configuration')}<div id="gs-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const [s, ssl] = await Promise.all([api.getGeneralSettings(), api.getPortalSsl().catch(() => ({}))]);
    const chk = v => v ? 'checked' : '';

    // ── cert status badge ────────────────────────────────────────────────────
    const certBadge = ssl.has_cert
      ? (() => {
          const exp   = ssl.portal_ssl_expiry ? new Date(ssl.portal_ssl_expiry) : null;
          const days  = exp ? Math.floor((exp - Date.now()) / 86400000) : null;
          const color = days === null ? '#94a3b8' : days < 14 ? '#ef4444' : days < 30 ? '#f59e0b' : '#22c55e';
          const label = days === null ? 'Installed' : days < 0 ? 'EXPIRED' : `Expires in ${days}d`;
          return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:99px;font-size:0.75rem;font-weight:600">${label}</span>`;
        })()
      : `<span style="background:#94a3b8;color:#fff;padding:2px 8px;border-radius:99px;font-size:0.75rem">Not installed</span>`;

    wrap.querySelector('#gs-area').innerHTML = `
      <div class="ent-stack">

        <!-- ── General (fields match general_settings / PUT API) ─────────── -->
        <div class="card">
          <h2>Organisation</h2>
          <div class="form-group"><label class="form-label">Display Name</label><input class="form-input" id="gs-org" value="${esc(s.display_name||'')}"></div>
          <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" id="gs-email" value="${esc(s.support_email||'')}"></div>
          <h2 style="margin-top:1.5rem">Session</h2>
          <p class="muted" style="font-size:0.85rem;margin:0 0 0.75rem">Idle timeout ends the session after inactivity. Absolute cap is the hard maximum from sign-in, even with activity.</p>
          <div class="form-group"><label class="form-label">Idle timeout (hours)</label><input class="form-input" id="gs-ttl" type="number" min="1" max="720" value="${s.default_session_hours??8}"><p class="muted" style="font-size:0.75rem;margin:0.25rem 0 0">Default session / sliding window. Maps to <code>default_session_hours</code>.</p></div>
          <div class="form-group"><label class="form-label">Absolute session cap (hours)</label><input class="form-input" id="gs-abs" type="number" min="1" max="720" value="${s.session_absolute_hours??24}"><p class="muted" style="font-size:0.75rem;margin:0.25rem 0 0">Hard max from login. Must be ≥ idle timeout.</p></div>
          <h2 style="margin-top:1.5rem">Authentication</h2>
          <div class="form-group">
            <label class="form-check"><input type="checkbox" id="gs-local" ${chk(s.allow_local_login)}> Allow Local Login</label>
            <label class="form-check"><input type="checkbox" id="gs-google" ${chk(s.allow_google_login !== 0 && s.allow_google_login !== false)}> Allow Google Login</label>
          </div>
          <p class="muted" style="font-size:0.8rem;margin:0 0 0.75rem">MFA policy and SMTP/SMS delivery are configured under Authentication → Strong Auth Methods → MFA Methods.</p>
          <div class="form-group"><label class="form-label">Password Min Length</label><input class="form-input" id="gs-pwmin" type="number" value="${s.password_min_length??10}"></div>
          <div class="form-group"><label class="form-label">MFA Grace Period (days)</label><input class="form-input" id="gs-mfagrace" type="number" value="${s.mfa_grace_period_days??14}"></div>
          <div class="form-group"><label class="form-label">Audit Retention (days)</label><input class="form-input" id="gs-audit" type="number" value="${s.audit_retention_days??365}"></div>
          <h2 style="margin-top:1.5rem">Maintenance</h2>
          <div class="form-group">
            <label class="form-check"><input type="checkbox" id="gs-maint" ${chk(s.maintenance_mode)}> Maintenance Mode</label>
          </div>
          <div class="form-group"><label class="form-label">Maintenance Message</label><input class="form-input" id="gs-maintmsg" value="${esc(s.maintenance_msg||'')}"></div>
          <div id="gs-msg" style="margin-top:1rem"></div>
          <button class="btn btn-primary" id="gs-save" style="margin-top:0.5rem">Save Settings</button>
        </div>

        <!-- ── Portal SSL Certificate ────────────────────────────────────── -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem">
            <h2 style="margin:0">Portal SSL Certificate</h2>
            ${certBadge}
          </div>
          ${ssl.has_cert ? `
          <div style="background:var(--surface,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:0.75rem 1rem;margin-top:1rem;font-size:0.85rem;display:flex;flex-direction:column;gap:0.25rem">
            <div><strong>Common Name:</strong> ${esc(ssl.portal_ssl_cn||'—')}</div>
            <div><strong>Expires:</strong> ${ssl.portal_ssl_expiry ? new Date(ssl.portal_ssl_expiry).toUTCString() : '—'}</div>
            <div style="word-break:break-all"><strong>SANs:</strong> ${esc(ssl.portal_ssl_sans||'—')}</div>
          </div>` : `
          <p style="color:var(--muted);font-size:0.875rem;margin-top:0.75rem">
            No certificate installed. Upload a certificate and private key to enable HTTPS on this portal.
          </p>`}

          <div id="gs-ssl-upload" style="margin-top:1.25rem">
            <div class="form-group">
              <label class="form-label">Certificate PEM <span style="color:var(--muted);font-weight:400">(paste full chain incl. -----BEGIN CERTIFICATE-----)</span></label>
              <textarea class="form-textarea" id="gs-ssl-cert" rows="6" placeholder="-----BEGIN CERTIFICATE-----&#10;MIIDxTCCAq2gAwIBAgI...&#10;-----END CERTIFICATE-----"></textarea>
            </div>
            <div class="form-group">
              <label class="form-label">Private Key PEM <span style="color:var(--muted);font-weight:400">(RSA or EC — never leaves this server)</span></label>
              <textarea class="form-textarea" id="gs-ssl-key" rows="6" placeholder="-----BEGIN PRIVATE KEY-----&#10;MIIEvQIBADANBgkq...&#10;-----END PRIVATE KEY-----"></textarea>
            </div>
            <div class="form-group">
              <label class="form-label">CA / Intermediate Chain PEM <span style="color:var(--muted);font-weight:400">(required for Cloudflare — Thawte/DigiCert intermediate)</span></label>
              <textarea class="form-textarea" id="gs-ssl-ca" rows="4" placeholder="-----BEGIN CERTIFICATE-----&#10;(intermediate / root CA)&#10;-----END CERTIFICATE-----"></textarea>
            </div>
            <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
              <button class="btn btn-primary" id="gs-ssl-upload-btn">Upload &amp; Activate Certificate</button>
              ${ssl.has_cert ? `<button class="btn btn-danger" id="gs-ssl-remove-btn" style="background:transparent;border:1px solid #ef4444;color:#ef4444">Remove Certificate</button>` : ''}
            </div>
          </div>
          <div id="gs-ssl-msg" style="margin-top:0.75rem"></div>

          <!-- File upload helper -->
          <details style="margin-top:1rem;font-size:0.8rem;color:var(--muted)">
            <summary style="cursor:pointer">Prefer to upload files instead?</summary>
            <div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.5rem">
              <label>Certificate file (.crt / .pem): <input type="file" id="gs-ssl-cert-file" accept=".crt,.pem,.cer"></label>
              <label>Key file (.key / .pem): <input type="file" id="gs-ssl-key-file" accept=".key,.pem"></label>
              <label>CA chain file (optional): <input type="file" id="gs-ssl-ca-file" accept=".crt,.pem,.cer"></label>
            </div>
          </details>
        </div>

        <!-- ── Connection Settings ───────────────────────────────────────── -->
        <div class="card">
          <h2>Portal Connection</h2>
          <p style="color:var(--muted);font-size:0.875rem;margin-top:0.25rem">
            Control whether this portal accepts HTTP, HTTPS, or both. Disabling HTTP requires a valid SSL certificate.
          </p>
          <div style="display:flex;flex-direction:column;gap:1rem;margin-top:1.25rem">
            <label style="display:flex;align-items:flex-start;gap:0.75rem;cursor:pointer">
              <input type="checkbox" id="gs-https-enabled" ${chk(ssl.portal_https_enabled)} style="margin-top:3px">
              <div>
                <div style="font-weight:600">Enable HTTPS (port 443)</div>
                <div style="font-size:0.8rem;color:var(--muted)">Starts the HTTPS listener using the uploaded certificate. Requires a valid cert to be installed.</div>
              </div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:0.75rem;cursor:pointer">
              <input type="checkbox" id="gs-allow-http" ${chk(ssl.portal_allow_http ?? 1)} style="margin-top:3px">
              <div>
                <div style="font-weight:600">Allow plain HTTP</div>
                <div style="font-size:0.8rem;color:var(--muted)">When unchecked, all HTTP requests are automatically redirected to HTTPS (301). Only uncheck this when HTTPS is active.</div>
              </div>
            </label>
          </div>
          <div id="gs-conn-msg" style="margin-top:1rem"></div>
          <button class="btn btn-primary" id="gs-conn-save" style="margin-top:0.75rem">Save Connection Settings</button>
        </div>

      </div>`;

    // ── General Settings save ─────────────────────────────────────────────────
    wrap.querySelector('#gs-save').addEventListener('click', async () => {
      const data = {
        display_name: wrap.querySelector('#gs-org').value,
        support_email: wrap.querySelector('#gs-email').value || null,
        default_session_hours: parseInt(wrap.querySelector('#gs-ttl').value, 10) || 8,
        session_absolute_hours: parseInt(wrap.querySelector('#gs-abs').value, 10) || 24,
        allow_local_login: wrap.querySelector('#gs-local').checked,
        allow_google_login: wrap.querySelector('#gs-google').checked,
        password_min_length: parseInt(wrap.querySelector('#gs-pwmin').value, 10) || 10,
        mfa_grace_period_days: parseInt(wrap.querySelector('#gs-mfagrace').value, 10) || 14,
        audit_retention_days: parseInt(wrap.querySelector('#gs-audit').value, 10) || 365,
        maintenance_mode: wrap.querySelector('#gs-maint').checked,
        maintenance_msg: wrap.querySelector('#gs-maintmsg').value || null,
      };
      try {
        await api.saveGeneralSettings(data);
        wrap.querySelector('#gs-msg').innerHTML = `<div class="alert alert-success">Settings saved.</div>`;
        setTimeout(() => { if (wrap.querySelector('#gs-msg')) wrap.querySelector('#gs-msg').innerHTML = ''; }, 3000);
      } catch(e) { wrap.querySelector('#gs-msg').innerHTML = errHtml(e.message); }
    });

    // ── File-picker → textarea helpers ───────────────────────────────────────
    const readFileToTextarea = (inputId, textareaId) => {
      const inp = wrap.querySelector(inputId);
      if (!inp) return;
      inp.addEventListener('change', () => {
        const f = inp.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = e => { wrap.querySelector(textareaId).value = e.target.result.trim(); };
        reader.readAsText(f);
      });
    };
    readFileToTextarea('#gs-ssl-cert-file', '#gs-ssl-cert');
    readFileToTextarea('#gs-ssl-key-file',  '#gs-ssl-key');
    readFileToTextarea('#gs-ssl-ca-file',   '#gs-ssl-ca');

    // ── SSL upload ────────────────────────────────────────────────────────────
    wrap.querySelector('#gs-ssl-upload-btn').addEventListener('click', async () => {
      const btn  = wrap.querySelector('#gs-ssl-upload-btn');
      const msg  = wrap.querySelector('#gs-ssl-msg');
      const cert = wrap.querySelector('#gs-ssl-cert').value.trim();
      const key  = wrap.querySelector('#gs-ssl-key').value.trim();
      const ca   = wrap.querySelector('#gs-ssl-ca').value.trim();
      if (!cert || !key) { msg.innerHTML = errHtml('Certificate PEM and Private Key PEM are both required.'); return; }
      btn.disabled = true; btn.textContent = '⟳ Uploading…';
      try {
        const r = await api.uploadPortalSsl({ cert_pem: cert, key_pem: key, ca_pem: ca || undefined });
        msg.innerHTML = `<div class="alert alert-success">
          ✓ Certificate installed — <strong>${esc(r.cn)}</strong><br>
          Expires: ${new Date(r.expiry).toUTCString()}${r.warning ? `<br><span style="color:#f59e0b">⚠ ${esc(r.warning)}</span>` : ''}
          <br><small style="color:var(--muted)">HTTPS will hot-reload immediately if the HTTPS server is already running. Otherwise enable it below and restart.</small>
        </div>`;
        wrap.querySelector('#gs-ssl-cert').value = '';
        wrap.querySelector('#gs-ssl-key').value  = '';
        wrap.querySelector('#gs-ssl-ca').value   = '';
      } catch(e) {
        msg.innerHTML = errHtml(e.message);
      }
      btn.disabled = false; btn.textContent = 'Upload & Activate Certificate';
    });

    // ── SSL remove ────────────────────────────────────────────────────────────
    const removeBtn = wrap.querySelector('#gs-ssl-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm('Remove the SSL certificate? This will disable HTTPS on the portal.')) return;
        try {
          await api.deletePortalSsl();
          showToast('SSL certificate removed — portal will use HTTP only');
          viewGeneralSettings(content);
        } catch(e) { wrap.querySelector('#gs-ssl-msg').innerHTML = errHtml(e.message); }
      });
    }

    // ── Connection settings save ──────────────────────────────────────────────
    wrap.querySelector('#gs-conn-save').addEventListener('click', async () => {
      const btn         = wrap.querySelector('#gs-conn-save');
      const msg         = wrap.querySelector('#gs-conn-msg');
      const httpsOn     = wrap.querySelector('#gs-https-enabled').checked;
      const allowHttp   = wrap.querySelector('#gs-allow-http').checked;
      if (httpsOn && !allowHttp && !ssl.has_cert) {
        msg.innerHTML = errHtml('You must upload an SSL certificate before enabling HTTPS-only mode.');
        return;
      }
      if (!httpsOn && !allowHttp) {
        msg.innerHTML = errHtml('Cannot disable both HTTP and HTTPS — the portal would become unreachable.');
        return;
      }
      btn.disabled = true; btn.textContent = '⟳ Saving…';
      try {
        await api.savePortalConnection({ portal_https_enabled: httpsOn, portal_allow_http: allowHttp });
        msg.innerHTML = `<div class="alert alert-success">
          Connection settings saved.
          ${httpsOn && !allowHttp ? '<br><strong>HTTP→HTTPS redirect is now active.</strong>' : ''}
          ${httpsOn ? '<br>HTTPS server will be available on port 443.' : ''}
        </div>`;
        setTimeout(() => { if (wrap.querySelector('#gs-conn-msg')) wrap.querySelector('#gs-conn-msg').innerHTML = ''; }, 5000);
      } catch(e) { msg.innerHTML = errHtml(e.message); }
      btn.disabled = false; btn.textContent = 'Save Connection Settings';
    });

  } catch(e) { wrap.querySelector('#gs-area').innerHTML = errHtml(e.message); }
}

// ─── 21. Branding ─────────────────────────────────────────────────────────────
export async function viewBranding(content) {
  content.replaceChildren(el(`<div>${header('Branding & Login', 'Portal look and feel — login page, logos, colors, and custom CSS')}<div id="br-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const b = await api.getBranding();
    const orgName = b.org_name || 'Lenskart IdP';
    const heroTitle = b.login_hero_title || 'Welcome back';
    const heroSub = b.login_hero_sub || 'Sign in to your Lenskart account';
    wrap.querySelector('#br-area').innerHTML = `
      <div class="grid-main-side">
        <div class="card">
          <h2>Branding Settings</h2>
          <p class="muted" style="margin:0 0 1rem;font-size:0.82rem">This page is the single editor for login appearance (Login Customization redirects here).</p>
          <div class="form-group"><label class="form-label">Organisation / App Name</label><input class="form-input" id="br-appname" value="${esc(orgName)}"></div>
          <div class="form-group">
            <label class="form-label">Logo</label>
            <p class="muted" style="font-size:0.8rem;margin:0 0 0.5rem">Upload a PNG, JPEG, WebP, or GIF (max 400 KB), or paste an external URL.</p>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
              <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">
                Upload logo…
                <input type="file" id="br-logo-file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" hidden>
              </label>
              <button type="button" class="btn btn-sm btn-secondary" id="br-logo-clear" ${b.has_logo_upload || b.logo_url ? '' : 'disabled'}>Remove logo</button>
              <span class="muted" id="br-logo-status" style="font-size:0.78rem">${b.has_logo_upload ? 'Using uploaded logo' : ''}</span>
            </div>
            <input class="form-input" id="br-logo" value="${esc(b.logo_url||'')}" placeholder="https://…/logo.png or leave blank after upload">
          </div>
          <div class="form-group"><label class="form-label">Favicon URL</label><input class="form-input" id="br-fav" value="${esc(b.favicon_url||'')}"></div>
          <div class="form-group"><label class="form-label">Accent Color</label><input type="color" class="form-input" id="br-color" value="${esc(b.accent_color||'#0f4c81')}" style="height:2.5rem;padding:0.25rem"></div>
          <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" id="br-email" value="${esc(b.support_email||'')}"></div>
          <div class="form-group"><label class="form-label">Login Hero Title</label><input class="form-input" id="br-hero" value="${esc(heroTitle)}"></div>
          <div class="form-group"><label class="form-label">Login Hero Subtext</label><input class="form-input" id="br-sub" value="${esc(heroSub)}"></div>
          <div class="form-group"><label class="form-label">Login Background URL</label><input class="form-input" id="br-bg" value="${esc(b.login_bg_url||'')}"></div>
          <div class="form-group"><label class="form-label">Custom CSS</label><textarea class="form-textarea" id="br-css" rows="5" placeholder="/* Custom CSS overrides */">${esc(b.custom_css||'')}</textarea></div>
          <div id="br-msg"></div>
          <button class="btn btn-primary" id="br-save">Save Branding</button>
        </div>
        <div class="card">
          <h2>Login preview</h2>
          <div id="br-preview" style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-top:0.5rem;background:#eef3f9">
            <div style="padding:1.5rem 1.25rem">
              <div style="background:#fff;border:1px solid #dce3ec;border-radius:12px;padding:1.25rem;box-shadow:0 10px 28px rgba(15,76,129,0.1);text-align:center">
                <div id="br-prev-logo-wrap" style="min-height:2.5rem;margin-bottom:0.5rem;display:flex;align-items:center;justify-content:center">
                  ${b.logo_url ? `<img id="br-prev-logo" src="${esc(b.logo_url)}" alt="" style="max-height:44px;max-width:160px;object-fit:contain">` : `<div id="br-prev-mark" style="width:44px;height:44px;border-radius:10px;background:${esc(b.accent_color||'#0f4c81')};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.2rem">${esc((orgName.trim().charAt(0) || 'L').toUpperCase())}</div>`}
                </div>
                <div style="font-size:1.15rem;font-weight:700;color:${esc(b.accent_color||'#0f4c81')}" id="br-prev-title">${esc(orgName)}</div>
                <div style="margin-top:0.15rem;font-size:0.7rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#64748b">IdP</div>
                <div style="margin-top:0.75rem;font-size:0.78rem;font-weight:600;color:#0f172a" id="br-prev-hero">${esc(heroTitle)}</div>
                <div style="margin-top:0.35rem;font-size:0.72rem;color:#475569" id="br-prev-sub">${esc(heroSub)}</div>
                <div style="margin-top:1rem;text-align:left">
                  <div style="height:2rem;background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:0.5rem"></div>
                  <div id="br-prev-btn" style="height:2rem;border-radius:6px;background:${esc(b.accent_color||'#0f4c81')}"></div>
                </div>
              </div>
            </div>
          </div>
          <div style="margin-top:1rem;font-size:0.75rem;color:var(--muted)">Matches the light login page. Upload or URL + accent apply after save (upload updates the login logo immediately).</div>
        </div>
      </div>`;

    const logoStatus = wrap.querySelector('#br-logo-status');
    const logoClearBtn = wrap.querySelector('#br-logo-clear');
    const setLogoStatus = (text) => { if (logoStatus) logoStatus.textContent = text || ''; };
    const syncPreviewLogo = () => {
      const logoUrl = wrap.querySelector('#br-logo').value.trim();
      const color = wrap.querySelector('#br-color').value || '#0f4c81';
      const name = wrap.querySelector('#br-appname').value || 'Lenskart';
      const host = wrap.querySelector('#br-prev-logo-wrap');
      if (!host) return;
      if (logoUrl) {
        host.innerHTML = `<img id="br-prev-logo" src="${esc(logoUrl)}" alt="" style="max-height:44px;max-width:160px;object-fit:contain">`;
      } else {
        host.innerHTML = `<div id="br-prev-mark" style="width:44px;height:44px;border-radius:10px;background:${esc(color)};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.2rem">${esc((name.trim().charAt(0) || 'L').toUpperCase())}</div>`;
      }
      if (logoClearBtn) logoClearBtn.disabled = !logoUrl;
    };
    const colorInput = wrap.querySelector('#br-color');
    colorInput.addEventListener('input', () => {
      wrap.querySelector('#br-prev-btn').style.background = colorInput.value;
      wrap.querySelector('#br-prev-title').style.color = colorInput.value;
      const mark = wrap.querySelector('#br-prev-mark');
      if (mark) mark.style.background = colorInput.value;
    });
    wrap.querySelector('#br-appname').addEventListener('input', e => {
      wrap.querySelector('#br-prev-title').textContent = e.target.value || 'Lenskart IdP';
      syncPreviewLogo();
    });
    wrap.querySelector('#br-logo').addEventListener('input', () => {
      setLogoStatus('');
      syncPreviewLogo();
    });
    wrap.querySelector('#br-hero').addEventListener('input', e => { wrap.querySelector('#br-prev-hero').textContent = e.target.value; });
    wrap.querySelector('#br-sub').addEventListener('input', e => { wrap.querySelector('#br-prev-sub').textContent = e.target.value; });

    wrap.querySelector('#br-logo-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 400 * 1024) {
        wrap.querySelector('#br-msg').innerHTML = errHtml('Logo must be 400 KB or smaller.');
        return;
      }
      setLogoStatus('Uploading…');
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        const r = await api.uploadBrandingLogo({
          imageBase64: String(dataUrl),
          mimeType: file.type || undefined,
          fileName: file.name,
        });
        wrap.querySelector('#br-logo').value = r.logo_url || '';
        setLogoStatus('Uploaded — shown on login');
        syncPreviewLogo();
        wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Logo uploaded.</div>`;
        setTimeout(() => { if (wrap.querySelector('#br-msg')) wrap.querySelector('#br-msg').innerHTML = ''; }, 3000);
      } catch (err) {
        setLogoStatus('');
        wrap.querySelector('#br-msg').innerHTML = errHtml(err.message || 'Upload failed');
      }
    });

    logoClearBtn?.addEventListener('click', async () => {
      try {
        const logoVal = wrap.querySelector('#br-logo').value.trim();
        if (logoVal.includes('/api/public/branding/logo') || b.has_logo_upload) {
          await api.deleteBrandingLogo();
        }
        wrap.querySelector('#br-logo').value = '';
        setLogoStatus('');
        syncPreviewLogo();
        wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Logo removed. Save branding if you also changed other fields.</div>`;
        setTimeout(() => { if (wrap.querySelector('#br-msg')) wrap.querySelector('#br-msg').innerHTML = ''; }, 3000);
      } catch (err) {
        wrap.querySelector('#br-msg').innerHTML = errHtml(err.message || 'Could not remove logo');
      }
    });

    wrap.querySelector('#br-save').addEventListener('click', async () => {
      const data = {
        org_name: wrap.querySelector('#br-appname').value,
        logo_url: wrap.querySelector('#br-logo').value || null,
        favicon_url: wrap.querySelector('#br-fav').value || null,
        accent_color: wrap.querySelector('#br-color').value,
        support_email: wrap.querySelector('#br-email').value || null,
        login_hero_title: wrap.querySelector('#br-hero').value,
        login_hero_sub: wrap.querySelector('#br-sub').value,
        login_bg_url: wrap.querySelector('#br-bg').value || null,
        custom_css: wrap.querySelector('#br-css').value || null,
      };
      try {
        await api.saveBranding(data);
        wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Branding saved.</div>`;
        setTimeout(() => { if (wrap.querySelector('#br-msg')) wrap.querySelector('#br-msg').innerHTML = ''; }, 3000);
      } catch(e) { wrap.querySelector('#br-msg').innerHTML = errHtml(e.message); }
    });
  } catch(e) { wrap.querySelector('#br-area').innerHTML = errHtml(e.message); }
}

// ─── 22. License ─────────────────────────────────────────────────────────────
export async function viewLicense(content) {
  content.replaceChildren(el(`<div>${header('License & Edition', 'Product edition, features and support')}<div id="lic-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const s = await api.getGeneralSettings();
    const features = [
      { name: 'SSO / SAML 2.0', status: 'live' },
      { name: 'Multi-Factor Auth (TOTP)', status: 'live' },
      { name: 'IGA / Access Reviews', status: 'live' },
      { name: 'OIDC Client Registry', status: 'live' },
      { name: 'OIDC / OAuth Issuer', status: 'live' },
      { name: 'Directory Sync', status: 'live' },
      { name: 'Connector Provisioning', status: 'live' },
      { name: 'Attendance IGA', status: 'live' },
      { name: 'PAM / Credential Vault', status: 'live' },
      { name: 'Birthright Rules', status: 'live' },
      { name: 'WebAuthn / Passkeys', status: 'planned' },
      { name: 'App Discovery', status: 'live' },
    ];
    const featureHtml = features.map(f => {
      const badge = f.status === 'live' ? 'badge-success' : f.status === 'progress' ? 'badge-warning' : 'badge-neutral';
      const label = f.status === 'live' ? 'Live' : f.status === 'progress' ? 'Progress' : 'Planned';
      return `<div class="ent-feature-row"><span>${esc(f.name)}</span><span class="badge ${badge}">${label}</span></div>`;
    }).join('');
    // Use a real <table> for edition rows — never nested .kv grids (those crush value columns).
    wrap.querySelector('#lic-area').innerHTML = `
      <div class="lic-layout">
        <div class="card">
          <h2>Edition Details</h2>
          <table class="lic-table">
            <tbody>
              <tr><th scope="row">Organisation</th><td>${esc(s.display_name||s.org_name||'—')}</td></tr>
              <tr><th scope="row">Edition</th><td><span class="badge badge-success">Enterprise Self-Hosted</span></td></tr>
              <tr><th scope="row">Version</th><td>1.0.0</td></tr>
              <tr><th scope="row">Build</th><td><code>lilg-idp-2026</code></td></tr>
              <tr><th scope="row">License Type</th><td>Perpetual + SaaS Option</td></tr>
            </tbody>
          </table>
          <h2 style="margin-top:1.35rem">Feature Matrix</h2>
          <div class="ent-feature-grid">${featureHtml}</div>
          <div style="display:flex;gap:0.45rem;flex-wrap:wrap;margin-top:1.25rem;justify-content:flex-end">
            <a class="btn btn-secondary" href="mailto:support@lenskart.com">Contact Support</a>
            <a class="btn btn-secondary" href="/healthz" target="_blank">Health Check</a>
          </div>
        </div>
        <div class="card">
          <h2>Legend</h2>
          <div class="ent-feature-grid" style="margin-top:0.5rem">
            <div class="ent-feature-row"><span class="muted">Live in production</span><span class="badge badge-success">Live</span></div>
            <div class="ent-feature-row"><span class="muted">In progress</span><span class="badge badge-warning">Progress</span></div>
            <div class="ent-feature-row"><span class="muted">Planned / roadmap</span><span class="badge badge-neutral">Planned</span></div>
          </div>
          <h2 style="margin-top:1.35rem">System Links</h2>
          <div style="display:grid;gap:0.4rem;margin-top:0.5rem">
            ${['/healthz','/readyz','/diagz','/metrics'].map(p => `<a href="${p}" target="_blank" class="btn btn-sm btn-secondary" style="justify-content:flex-start;font-family:var(--font-mono)">${p}</a>`).join('')}
          </div>
        </div>
      </div>`;
  } catch(e) { wrap.querySelector('#lic-area').innerHTML = errHtml(e.message); }
}

// ─── 23. Tickets ─────────────────────────────────────────────────────────────
export async function viewTickets(content) {
  content.replaceChildren(el(`<div>${header('Tickets', 'Access requests, incidents and support tickets', `<button class="btn btn-primary" id="new-tk-btn">+ New Ticket</button>`)}<div class="card" style="margin-bottom:1rem;display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
    <label class="form-label" style="margin:0">Status:</label>
    <select class="form-select" id="tk-status" style="width:auto"><option value="">ALL</option><option>OPEN</option><option>IN_PROGRESS</option><option>RESOLVED</option><option>CLOSED</option></select>
    <label class="form-label" style="margin:0;margin-left:1rem">Category:</label>
    <select class="form-select" id="tk-cat" style="width:auto"><option value="">ALL</option><option value="ACCESS_REQUEST">ACCESS_REQUEST</option><option value="PASSWORD_RESET">PASSWORD_RESET</option><option value="MFA_RESET">MFA_RESET</option><option value="ACCOUNT_ISSUE">ACCOUNT_ISSUE</option><option value="OTHER">OTHER</option></select>
  </div><div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    const status = wrap.querySelector('#tk-status').value;
    const cat = wrap.querySelector('#tk-cat').value;
    try {
      const tickets = norm(await api.listTickets(status || undefined, cat || undefined));
      const priColor = p => ({ HIGH: 'badge-danger', MEDIUM: 'badge-warning', LOW: 'badge-neutral', CRITICAL: 'badge-danger' }[p] || 'badge-neutral');
      const stColor = s => ({ OPEN: 'badge-info', IN_PROGRESS: 'badge-warning', RESOLVED: 'badge-success', CLOSED: 'badge-neutral' }[s] || 'badge-neutral');
      const rows = tickets.length ? tickets.map(t => `
        <tr class="tk-row" data-p="${escAttrJson({id:t.id,subject:t.subject||t.title,category:t.category,status:t.status,priority:t.priority,description:t.description||"",requester_name:t.requester_name||t.requester_id||"",created_at:t.created_at||""})}" style="cursor:pointer">
          <td class="cell-strong">${esc(t.subject||t.title||'—')}</td>
          <td><span class="badge badge-info">${esc(t.category||'—')}</span></td>
          <td><span class="badge ${stColor(t.status)}">${esc(t.status||'—')}</span></td>
          <td><span class="badge ${priColor(t.priority)}">${esc(t.priority||'—')}</span></td>
          <td class="muted">${esc(t.requester_name||t.requester_id||'—')}</td>
          <td class="muted">${t.created_at ? fmtDate(t.created_at) : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No tickets found.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Category</th><th>Status</th><th>Priority</th><th>Requester</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.tk-row').forEach(row => {
        row.addEventListener('click', () => { let p; try { p = JSON.parse(row.dataset.p); } catch { p = {}; } openTkDetail(p); });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openTkDetail(t) {
    const statuses = ['OPEN','IN_PROGRESS','RESOLVED','CLOSED'];
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${esc(t.subject||t.title||'Ticket')}</h2></div><div class="modal-body">
      <div class="kv-list">
        <div class="kv"><span class="k">Category</span><span class="v">${esc(t.category||'—')}</span></div>
        <div class="kv"><span class="k">Priority</span><span class="v">${esc(t.priority||'—')}</span></div>
        <div class="kv"><span class="k">Requester</span><span class="v">${esc(t.requester_name||t.created_by||'—')}</span></div>
        <div class="kv"><span class="k">Created</span><span class="v">${t.created_at ? fmtDate(t.created_at) : '—'}</span></div>
      </div>
      ${t.description ? `<p style="margin-top:1rem">${esc(t.description)}</p>` : ''}
      <div class="form-group" style="margin-top:1rem">
        <label class="form-label">Update Status</label>
        <div style="display:flex;gap:0.5rem">
          <select class="form-select" id="tk-new-status">${statuses.map(s => `<option ${s===t.status?'selected':''}>${s}</option>`).join('')}</select>
          <button class="btn btn-primary" id="tk-update-btn">Update</button>
        </div>
      </div>
      <div id="tk-det-err"></div>
    </div><div class="modal-footer"><button class="btn btn-secondary" id="tk-close">Close</button></div></div>`);
    bd.querySelector('#tk-close').addEventListener('click', () => bd.remove());
    bd.querySelector('#tk-update-btn').addEventListener('click', async () => {
      const newStatus = bd.querySelector('#tk-new-status').value;
      try { await api.updateTicket(t.id, { status: newStatus }); bd.remove(); await load(); } catch(e) { bd.querySelector('#tk-det-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#tk-status').addEventListener('change', load);
  wrap.querySelector('#tk-cat').addEventListener('change', load);
  wrap.querySelector('#new-tk-btn').addEventListener('click', () => {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>New Ticket</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Subject</label><input class="form-input" id="tk-title"></div>
      <div class="form-group"><label class="form-label">Category</label><select class="form-select" id="tk-cat-new"><option value="ACCESS_REQUEST">ACCESS_REQUEST</option><option value="PASSWORD_RESET">PASSWORD_RESET</option><option value="MFA_RESET">MFA_RESET</option><option value="ACCOUNT_ISSUE">ACCOUNT_ISSUE</option><option value="OTHER">OTHER</option></select></div>
      <div class="form-group"><label class="form-label">Priority</label><select class="form-select" id="tk-pri"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="tk-desc" rows="4"></textarea></div>
      <div id="tk-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="tk-save">Submit</button><button class="btn btn-secondary" id="tk-cancel">Cancel</button></div></div>`);
    bd.querySelector('#tk-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#tk-save').addEventListener('click', async () => {
      const data = { subject: bd.querySelector('#tk-title').value.trim(), category: bd.querySelector('#tk-cat-new').value, priority: bd.querySelector('#tk-pri').value, description: bd.querySelector('#tk-desc').value };
      if (!data.subject) { bd.querySelector('#tk-err').innerHTML = errHtml('Subject required'); return; }
      try { await api.createTicket(data); bd.remove(); await load(); } catch(e) { bd.querySelector('#tk-err').innerHTML = errHtml(e.message); }
    });
  });

  await load();
}

// ─── 24. System Health ────────────────────────────────────────────────────────
export async function viewSystemHealth(content) {
  content.replaceChildren(el(`<div>${header('System Health', 'Infrastructure status and diagnostics', `<button class="btn btn-secondary" id="health-refresh">↺ Refresh</button>`)}<div id="health-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  function fmtUptime(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '—';
    const s = Math.floor(Number(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  function serviceOk(v) {
    if (v === true) return true;
    if (v === false) return false;
    return v?.ok === true || v?.status === 'ok' || v?.connected === true;
  }

  async function load() {
    wrap.querySelector('#health-area').innerHTML = loading();
    try {
      const h = await api.systemHealth();
      const statusBadge = (ok, label) => ok
        ? `<span class="badge badge-success">${label || 'OK'}</span>`
        : `<span class="badge badge-danger">${label || 'ERROR'}</span>`;

      const dbOk = serviceOk(h.db) || h.database === 'ok';
      const redisOk = serviceOk(h.redis);
      const outbox = h.outbox || {};
      const connectors = h.connectors || [];
      const migrationCount = (h.migrations || []).length;
      const uptimeSec = h.uptime_seconds ?? h.uptime;

      wrap.querySelector('#health-area').innerHTML = `
        <div class="stat-grid" style="margin-bottom:1.5rem">
          <div class="stat-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div class="stat-label">Database</div>${statusBadge(dbOk)}
            </div>
            <div class="stat-value" style="font-size:1rem;margin-top:0.5rem">${h.db?.latency_ms != null ? esc(String(h.db.latency_ms) + 'ms') : '—'}</div>
          </div>
          <div class="stat-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div class="stat-label">Redis</div>${statusBadge(redisOk)}
            </div>
            <div class="stat-value" style="font-size:1rem;margin-top:0.5rem">${h.redis?.latency_ms != null ? esc(String(h.redis.latency_ms) + 'ms') : '—'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">API Uptime</div>
            <div class="stat-value" style="font-size:1rem;margin-top:0.5rem">${esc(fmtUptime(uptimeSec))}</div>
            <div class="stat-sub">${migrationCount ? esc(String(migrationCount) + ' migrations applied') : 'No migrations recorded'}</div>
          </div>
        </div>
        <div class="grid-main-side">
          <div class="card">
            <h2>Connectors</h2>
            ${connectors.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th></tr></thead><tbody>
              ${connectors.map(c => `<tr><td>${esc(c.name||'—')}</td><td class="muted">${esc(c.type||c.connector_type||'—')}</td><td>${(['ok','ACTIVE','CONNECTED','CONFIGURED'].includes(String(c.status||'').toUpperCase()) || c.status==='ok')?'<span class="badge badge-success">OK</span>':'<span class="badge badge-neutral">'+esc(c.status||'Unknown')+'</span>'}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No connectors configured.</p>'}
          </div>
          <div class="card">
            <h2>Outbox Depth</h2>
            <div style="display:grid;gap:0.5rem;margin-top:0.75rem">
              ${['PENDING','PROCESSING','DONE','DEAD'].map(k => `<div style="display:flex;justify-content:space-between"><span class="muted">${k}</span><strong>${outbox[k.toLowerCase()] ?? outbox[k] ?? 0}</strong></div>`).join('')}
            </div>
          </div>
        </div>`;
    } catch(e) {
      wrap.querySelector('#health-area').innerHTML = errHtml(e.message);
    }
  }

  wrap.querySelector('#health-refresh').addEventListener('click', () => load());
  await load();
}

// ─── Attendance IGA ───────────────────────────────────────────────────────────
function aigDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (t) => parts.find(p => p.type === t)?.value ?? '00';
  return { yyyy: pick('year'), mm: pick('month'), dd: pick('day') };
}
function aigExpandTemplate(template, offsetDays = 0, timeZone = 'Asia/Kolkata') {
  if (!template) return '';
  const shifted = new Date(Date.now() + offsetDays * 86400000);
  const { yyyy, mm, dd } = aigDateParts(shifted, timeZone);
  return template
    .replace(/\{YYYY-MM-DD\}/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/\{YYYYMMDD\}/gi, `${yyyy}${mm}${dd}`)
    .replace(/\{DD-MM-YYYY\}/gi, `${dd}-${mm}-${yyyy}`)
    .replace(/\{DD\/MM\/YYYY\}/gi, `${dd}/${mm}/${yyyy}`)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{date\}/gi, `${yyyy}-${mm}-${dd}`);
}
function aigPreviewPath(s) {
  const tz = s.timezone || 'Asia/Kolkata';
  const dir = (s.remoteDir || '').trim().replace(/\/$/, '');
  const lookback = Number(s.lookbackDays ?? 1);
  const base = Number(s.dateOffsetDays ?? 0);
  const paths = [];
  if (s.fileNameTemplate?.trim()) {
    for (let i = 0; i <= lookback; i++) {
      const name = aigExpandTemplate(s.fileNameTemplate.trim(), base - i, tz);
      paths.push(dir ? `${dir}/${name}` : (name.startsWith('/') ? name : name));
    }
    return paths;
  }
  if (s.remotePath?.trim()) {
    paths.push(aigExpandTemplate(s.remotePath.trim(), base, tz));
    return paths;
  }
  return paths;
}
function aigStatusBadge(enabled, status) {
  if (!enabled) return '<span class="badge badge-neutral">Disabled</span>';
  if (status === 'OK') return '<span class="badge badge-success">Healthy</span>';
  if (status === 'PARTIAL') return '<span class="badge badge-warning">Partial</span>';
  if (status === 'FAILED') return '<span class="badge badge-danger">Failed</span>';
  return '<span class="badge badge-info">Idle</span>';
}

export async function viewAttendanceIga(content, initialTab = 'dash') {
  const aigTabIds = ['dash', 'policy', 'config', 'exclusions', 'imports', 'approvals', 'executions', 'rollbacks'];
  const startTab = aigTabIds.includes(initialTab) ? initialTab : 'dash';
  content.replaceChildren(el(`<div class="aig-page">
    ${header('Attendance IGA', 'Multiple revoke policies — each with its own API/SFTP source, schedule, and employee scope', `
      <div class="aig-actions">
        <button class="btn btn-secondary" id="aig-run-sftp">Run SFTP Import</button>
        <button class="btn btn-secondary" id="aig-run-api">Run API Import</button>
        <button class="btn btn-primary" id="aig-run-manual">Evaluate Rules</button>
      </div>
    `)}
    <div id="aig-config-bar" class="aig-config-bar" style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin:0 0 1rem;padding:0.75rem 1rem;background:var(--surface,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px">
      <label class="muted" style="font-size:0.85rem;font-weight:600">Active policy</label>
      <select class="form-select" id="aig-config-select" style="min-width:220px"></select>
      <span class="muted" style="font-size:0.8rem;margin-left:auto" id="aig-config-hint">Manage policies on the Policy tab · API/SFTP credentials on Configuration</span>
    </div>
    <div id="aig-status-bar" class="aig-status-bar">${loading()}</div>
    <div id="aig-stats" class="stat-grid aap-stats">${loading()}</div>
    <div class="cfg-tab-bar inline-tabs aig-tabs">
      <button type="button" class="cfg-tab inline-tab${startTab === 'dash' ? ' active' : ''}" data-tab="dash">Overview</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'policy' ? ' active' : ''}" data-tab="policy">Policy</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'config' ? ' active' : ''}" data-tab="config">Configuration</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'exclusions' ? ' active' : ''}" data-tab="exclusions">Global Exclusions</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'imports' ? ' active' : ''}" data-tab="imports">Import History</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'approvals' ? ' active' : ''}" data-tab="approvals">Approvals</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'executions' ? ' active' : ''}" data-tab="executions">Executions</button>
      <button type="button" class="cfg-tab inline-tab${startTab === 'rollbacks' ? ' active' : ''}" data-tab="rollbacks">Rollbacks</button>
    </div>
    <div id="tab-dash" style="${startTab === 'dash' ? '' : 'display:none'}"></div>
    <div id="tab-policy" style="${startTab === 'policy' ? '' : 'display:none'}"></div>
    <div id="tab-config" style="${startTab === 'config' ? '' : 'display:none'}"></div>
    <div id="tab-exclusions" style="${startTab === 'exclusions' ? '' : 'display:none'}"></div>
    <div id="tab-imports" style="${startTab === 'imports' ? '' : 'display:none'}"></div>
    <div id="tab-approvals" style="${startTab === 'approvals' ? '' : 'display:none'}"></div>
    <div id="tab-executions" style="${startTab === 'executions' ? '' : 'display:none'}"></div>
    <div id="tab-rollbacks" style="${startTab === 'rollbacks' ? '' : 'display:none'}"></div>
  </div>`));
  const wrap = content.firstChild;
  let configCache = null;
  let selectedConfigId = Number(localStorage.getItem('aig_config_id') || 1) || 1;
  let configList = [];

  async function refreshConfigList() {
    const r = await api.attendanceIgaConfigs();
    configList = r.data || [];
    if (!configList.find((c) => c.id === selectedConfigId)) {
      selectedConfigId = configList[0]?.id || 1;
    }
    const sel = wrap.querySelector('#aig-config-select');
    sel.innerHTML = configList.map((c) =>
      `<option value="${c.id}" ${c.id === selectedConfigId ? 'selected' : ''}>${esc(c.name)} (${esc(c.source_type || '—')})${c.enabled ? '' : ' · off'}</option>`,
    ).join('');
  }

  function setSelectedConfig(id) {
    selectedConfigId = Number(id) || 1;
    localStorage.setItem('aig_config_id', String(selectedConfigId));
    configCache = null;
  }

  async function loadStatusBar() {
    try {
      const c = configCache || await api.attendanceIgaConfig(selectedConfigId);
      configCache = c;
      const scope = c.employee_scope || {};
      const depts = (scope.departments || []).join(', ') || 'all depts';
      const types = (scope.employment_types || []).join(', ') || 'all types';
      wrap.querySelector('#aig-status-bar').innerHTML = `
        <div class="aig-status-left">
          ${aigStatusBadge(c.enabled, c.last_sync_status)}
          <div class="aig-status-meta">
            <strong>${esc(c.name || 'Default')}</strong>
            · Source <strong>${esc(c.source_type || '—')}</strong>
            · Polling <strong>${esc(c.polling_interval || 'manual')}</strong>
            · Scope <strong>${esc(depts)}</strong> / <strong>${esc(types)}</strong>
            ${c.last_sync_at ? ` · Last sync <strong>${fmtDate(c.last_sync_at)}</strong>` : ' · <span class="text-dim">Never synced</span>'}
            ${c.sftp_last_file ? ` · File <strong>${esc(c.sftp_last_file)}</strong>` : ''}
          </div>
        </div>
        <div class="aig-status-meta">${c.emergency_mode ? '<span class="badge badge-danger">Emergency mode</span>' : ''}${c.approval_enabled ? ' <span class="badge badge-warning">Approval required</span>' : ''}</div>`;
    } catch (e) {
      wrap.querySelector('#aig-status-bar').innerHTML = errHtml(e.message);
    }
  }

  async function loadStats() {
    try {
      const d = await api.attendanceIgaDashboard(selectedConfigId);
      wrap.querySelector('#aig-stats').innerHTML = [
        statCard('refresh', 'Today\'s Imports', d.todayImports ?? 0, d.lastSyncAt ? `Synced ${fmtDate(d.lastSyncAt)}` : 'No sync yet', 'primary'),
        statCard('users', 'Users Suspended', d.latestRun?.users_suspended ?? 0, 'latest run', 'warning'),
        statCard('alert', 'Pending Approvals', d.pendingApprovals ?? 0, 'awaiting decision', 'warning'),
        statCard('shield', 'Failed Executions', d.failedExecutions ?? 0, 'today', 'danger'),
        statCard('activity', 'Sync Status', d.lastSyncStatus ?? '—', d.connectorHealth ?? 'unknown', d.lastSyncStatus === 'OK' ? 'success' : 'neutral'),
        statCard('list', 'Rollbacks Today', d.rollbackCount ?? 0, 'restored access', 'neutral'),
      ].join('');
    } catch (e) {
      wrap.querySelector('#aig-stats').innerHTML = errHtml(e.message);
    }
  }

  async function loadDash() {
    const area = wrap.querySelector('#tab-dash');
    area.innerHTML = loading();
    try {
      const d = await api.attendanceIgaDashboard(selectedConfigId);
      const run = d.latestRun || {};
      const statusBadge = s => ({ COMPLETED: 'badge-success', PARTIAL: 'badge-warning', FAILED: 'badge-danger', RUNNING: 'badge-info' }[s] || 'badge-neutral');
      area.innerHTML = `<div class="aig-dash-grid">
        <div class="card aig-run-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h2 style="margin:0">Latest Pipeline Run</h2>
            <span class="badge ${statusBadge(run.status)}">${esc(run.status || '—')}</span>
          </div>
          <div class="kv-list">
            <div class="kv"><span class="k">Source</span><span class="v">${esc(run.source || '—')}</span></div>
            <div class="kv"><span class="k">Records</span><span class="v">${esc(String(run.total_records ?? 0))} total · ${esc(String(run.successful ?? 0))} ok · ${esc(String(run.failed ?? 0))} failed</span></div>
            <div class="kv"><span class="k">Users processed</span><span class="v">${esc(String(run.users_processed ?? 0))}</span></div>
            <div class="kv"><span class="k">Suspended</span><span class="v">${esc(String(run.users_suspended ?? 0))}</span></div>
            <div class="kv"><span class="k">Disabled</span><span class="v">${esc(String(run.users_disabled ?? 0))}</span></div>
            <div class="kv"><span class="k">Apps removed</span><span class="v">${esc(String(run.apps_removed ?? 0))}</span></div>
            <div class="kv"><span class="k">Started</span><span class="v">${run.started_at ? fmtDate(run.started_at) : '—'}</span></div>
          </div>
        </div>
        <div class="card">
          <h2 style="margin:0 0 1rem">Operational Summary</h2>
          <div class="kv-list">
            <div class="kv"><span class="k">Pending approvals</span><span class="v">${d.pendingApprovals ?? 0}</span></div>
            <div class="kv"><span class="k">Failed executions (today)</span><span class="v">${d.failedExecutions ?? 0}</span></div>
            <div class="kv"><span class="k">Rollbacks (today)</span><span class="v">${d.rollbackCount ?? 0}</span></div>
            <div class="kv"><span class="k">Connector health</span><span class="v">${esc(d.connectorHealth ?? '—')}</span></div>
            <div class="kv"><span class="k">Last sync</span><span class="v">${d.lastSyncAt ? fmtDate(d.lastSyncAt) : 'Never'}</span></div>
          </div>
        </div>
      </div>`;
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  function wireSftpPreview(area) {
    const previewEl = area.querySelector('#aig-sftp-preview');
    if (!previewEl) return;
    const update = () => {
      const shared = aigSharedDateOpts(area);
      const cfg = {
        remoteDir: area.querySelector('#aig-sftp-dir')?.value.trim(),
        fileNameTemplate: area.querySelector('#aig-sftp-template')?.value.trim(),
        timezone: shared.timezone,
        dateOffsetDays: shared.dateOffsetDays,
        lookbackDays: shared.lookbackDays,
      };
      const paths = aigPreviewPath(cfg);
      previewEl.innerHTML = paths.length
        ? paths.map((p, i) => `<div>${i === 0 ? 'Primary' : `Fallback -${i}`}: ${esc(p)}</div>`).join('')
        : '<span class="muted">Set directory + file name template to preview</span>';
    };
    ['#aig-sftp-dir', '#aig-sftp-template', '#aig-timezone', '#aig-date-offset', '#aig-lookback'].forEach(sel => {
      area.querySelector(sel)?.addEventListener('input', update);
      area.querySelector(sel)?.addEventListener('change', update);
    });
    update();
  }

  function aigSharedDateOpts(area) {
    return {
      timezone: area.querySelector('#aig-timezone')?.value.trim() || 'Asia/Kolkata',
      dateOffsetDays: Number(area.querySelector('#aig-date-offset')?.value || 0),
      lookbackDays: Number(area.querySelector('#aig-lookback')?.value || 1),
    };
  }

  function buildApiPayload(area, c) {
    const tokenInput = area.querySelector('#aig-api-token')?.value.trim() || '';
    const shared = aigSharedDateOpts(area);
    const method = area.querySelector('#aig-api-method')?.value || 'GET';
    return {
      api_provider: 'TRUIN',
      api_url: area.querySelector('#aig-api-url')?.value.trim() || '',
      api_method: method,
      api_auth_type: 'BEARER',
      api_auth_config: tokenInput ? { token: tokenInput } : {},
      configId: selectedConfigId,
      api_config: {
        endpoint: area.querySelector('#aig-api-endpoint')?.value.trim() || '/api/attendance/daily',
        dateParam: area.querySelector('#aig-api-date-param')?.value.trim() || 'date',
        method,
        timezone: shared.timezone,
        dateOffsetDays: shared.dateOffsetDays,
        lookbackDays: shared.lookbackDays,
        ...(area.querySelector('#aig-api-site')?.value.trim()
          ? { siteId: area.querySelector('#aig-api-site').value.trim() } : {}),
        ...(area.querySelector('#aig-api-records-path')?.value.trim()
          ? { recordsPath: area.querySelector('#aig-api-records-path').value.trim() } : {}),
      },
    };
  }

  function wireApiPreview(area) {
    const previewEl = area.querySelector('#aig-api-preview');
    if (!previewEl) return;
    const update = () => {
      const base = area.querySelector('#aig-api-url')?.value.trim();
      const endpoint = area.querySelector('#aig-api-endpoint')?.value.trim() || '/api/attendance/daily';
      const dateParam = area.querySelector('#aig-api-date-param')?.value.trim() || 'date';
      const method = area.querySelector('#aig-api-method')?.value || 'GET';
      const shared = aigSharedDateOpts(area);
      if (!base) {
        previewEl.innerHTML = '<span class="muted">Enter base URL to preview</span>';
        return;
      }
      const today = aigExpandTemplate('{YYYY-MM-DD}', shared.dateOffsetDays, shared.timezone);
      const url = `${base.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}?${encodeURIComponent(dateParam)}=${today}`;
      previewEl.innerHTML = `<div><strong>${esc(method)}</strong> ${esc(url)}</div><div class="muted" style="margin-top:0.35rem">Authorization: Bearer &lt;token&gt;</div>`;
    };
    ['#aig-api-url', '#aig-api-endpoint', '#aig-api-date-param', '#aig-api-method', '#aig-timezone', '#aig-date-offset'].forEach(sel => {
      area.querySelector(sel)?.addEventListener('input', update);
      area.querySelector(sel)?.addEventListener('change', update);
    });
    update();
  }

  function buildSftpPayload(area, s) {
    const host = area.querySelector('#aig-sftp-host')?.value.trim() || '';
    const username = area.querySelector('#aig-sftp-user')?.value.trim() || '';
    if (!host && !username) return null; // clear saved SFTP
    if (!host || !username) return undefined; // incomplete — leave unchanged
    const shared = aigSharedDateOpts(area);
    const after = area.querySelector('#aig-sftp-after')?.value || 'keep';
    return {
      host,
      port: Number(area.querySelector('#aig-sftp-port')?.value) || 22,
      username,
      ...(area.querySelector('#aig-sftp-pass')?.value
        ? { password: area.querySelector('#aig-sftp-pass').value }
        : (s.password ? { password: s.password } : {})),
      ...(area.querySelector('#aig-sftp-key')?.value.trim()
        ? { privateKey: area.querySelector('#aig-sftp-key').value.trim() }
        : (s.privateKey ? { privateKey: s.privateKey } : {})),
      ...(area.querySelector('#aig-sftp-dir')?.value.trim()
        ? { remoteDir: area.querySelector('#aig-sftp-dir').value.trim() } : {}),
      fileNameTemplate: area.querySelector('#aig-sftp-template')?.value.trim() || 'attendance_{YYYY-MM-DD}.csv',
      timezone: shared.timezone,
      dateOffsetDays: shared.dateOffsetDays,
      lookbackDays: shared.lookbackDays,
      ...(after === 'archive' && area.querySelector('#aig-sftp-archive')?.value.trim()
        ? { archiveDir: area.querySelector('#aig-sftp-archive').value.trim() } : {}),
      deleteAfterFetch: after === 'delete',
    };
  }

  function wireSftpAfter(area) {
    const sel = area.querySelector('#aig-sftp-after');
    const archiveWrap = area.querySelector('#aig-sftp-archive-wrap');
    if (!sel || !archiveWrap) return;
    const sync = () => { archiveWrap.style.display = sel.value === 'archive' ? '' : 'none'; };
    sel.addEventListener('change', sync);
    sync();
  }

  function aigField(id, label, controlHtml, hint = '', extraClass = '') {
    return `<div class="form-group aig-field ${extraClass}"><label class="form-label" for="${id}">${label}</label>${controlHtml}${hint ? `<span class="form-hint">${hint}</span>` : ''}</div>`;
  }

  async function loadPolicy() {
    const area = wrap.querySelector('#tab-policy');
    area.innerHTML = loading();
    try {
      await refreshConfigList();
      const sourceLabel = {
        REST_API: 'Truein API', SFTP: 'SFTP', BOTH: 'API + SFTP', FILE_UPLOAD: 'Manual',
      };
      const pollLabel = {
        '5m': 'Every 5 min', '15m': 'Every 15 min', '1h': 'Hourly', '1d': 'Daily', manual: 'Manual',
      };
      const rows = configList.length ? configList.map((c) => {
        const scope = c.employee_scope || {};
        const depts = (scope.departments || []).join(', ') || 'All depts';
        const types = (scope.employment_types || []).join(', ') || 'All types';
        const mode = c.emergency_mode ? 'Emergency' : (c.approval_enabled ? 'Approval' : 'Auto');
        const active = Number(c.id) === selectedConfigId;
        return `<tr class="${active ? 'row-active' : ''}">
          <td class="cell-strong">${esc(c.name || 'Policy')}${active ? ' <span class="badge badge-info">Selected</span>' : ''}</td>
          <td><span class="badge badge-info">${esc(sourceLabel[c.source_type] || c.source_type || '—')}</span></td>
          <td class="muted" style="font-size:0.8rem;max-width:220px">${esc(depts)} · ${esc(types)}</td>
          <td class="muted" style="font-size:0.8rem">${esc(pollLabel[c.polling_interval] || c.polling_interval || '—')}</td>
          <td>${c.enabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-neutral">Disabled</span>'}</td>
          <td><span class="badge badge-neutral">${esc(mode)}</span></td>
          <td style="white-space:nowrap">
            <button type="button" class="btn btn-sm btn-secondary aig-pol-edit" data-id="${esc(String(c.id))}">Edit</button>
            <button type="button" class="btn btn-sm btn-secondary aig-pol-cfg" data-id="${esc(String(c.id))}">Feeds</button>
            <button type="button" class="btn btn-sm btn-secondary aig-pol-clone" data-id="${esc(String(c.id))}">Clone</button>
            <button type="button" class="btn btn-sm btn-danger aig-pol-del" data-id="${esc(String(c.id))}" ${Number(c.id) === 1 ? 'disabled title="Cannot delete Default"' : ''}>Delete</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="7"><div class="empty-state"><p>No revoke policies yet.</p></div></td></tr>`;

      area.innerHTML = `
        <div class="aap-actions">
          <div>
            <h3 class="section-title">Revoke policies</h3>
            <p class="subtitle">Create and edit attendance revoke policies (scope, source, schedule, approval). Configure API/SFTP credentials with Feeds.</p>
          </div>
          <div class="aap-actions-btns">
            <button type="button" class="btn btn-primary" id="aig-pol-new">+ New Policy</button>
          </div>
        </div>
        <div class="table-wrap aap-table"><table>
          <thead><tr><th>Name</th><th>Source</th><th>Scope</th><th>Schedule</th><th>Status</th><th>Workflow</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;

      area.querySelector('#aig-pol-new').addEventListener('click', () => { void openPolicyModal(null); });
      area.querySelectorAll('.aig-pol-edit').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const full = await api.attendanceIgaConfig(Number(btn.dataset.id));
            await openPolicyModal(full);
          } catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.aig-pol-cfg').forEach((btn) => {
        btn.addEventListener('click', async () => {
          setSelectedConfig(btn.dataset.id);
          await refreshConfigList();
          await loadStatusBar();
          await loadStats();
          await showAigTab('config');
        });
      });
      area.querySelectorAll('.aig-pol-clone').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const cur = configList.find((c) => String(c.id) === btn.dataset.id);
          const name = prompt('Clone as:', `${cur?.name || 'Policy'} (copy)`);
          if (!name?.trim()) return;
          try {
            const r = await api.createAttendanceIgaConfig({ name: name.trim(), cloneFromId: Number(btn.dataset.id) });
            setSelectedConfig(r.id);
            await refreshConfigList();
            await loadStatusBar();
            await loadStats();
            await loadPolicy();
            const full = await api.attendanceIgaConfig(r.id);
            await openPolicyModal(full);
          } catch (e) { alert(e.message); }
        });
      });
      area.querySelectorAll('.aig-pol-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.dataset.id);
          if (id === 1) { alert('Cannot delete the Default policy.'); return; }
          if (!confirm('Delete this policy and its rules/exclusions? Import history stays for audit.')) return;
          try {
            await api.deleteAttendanceIgaConfig(id);
            if (selectedConfigId === id) setSelectedConfig(1);
            await refreshConfigList();
            await loadStatusBar();
            await loadStats();
            await loadPolicy();
          } catch (e) { alert(e.message); }
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  const AIG_PUNCH_PRESETS = {
    NONE: { label: 'No action', actions: [] },
    SUSPEND: { label: 'Suspend user (block SSO)', actions: ['SUSPEND_USER'] },
    SUSPEND_SESSIONS: { label: 'Suspend user + revoke sessions', actions: ['SUSPEND_USER', 'REVOKE_SESSIONS'] },
    DISABLE: { label: 'Disable / deprovision user', actions: ['DISABLE_USER'] },
    DISABLE_APPS: { label: 'Disable user + revoke all app access', actions: ['DISABLE_USER', 'REMOVE_ALL_APPS'] },
    REVOKE_APPS: { label: 'Revoke all app access only', actions: ['REMOVE_ALL_APPS'] },
  };

  function aigActionsToPreset(actions) {
    const list = [...(actions || [])].map(String);
    if (list.length === 0) return 'NONE';
    const key = JSON.stringify(list.slice().sort());
    for (const [id, p] of Object.entries(AIG_PUNCH_PRESETS)) {
      if (JSON.stringify([...p.actions].sort()) === key) return id;
    }
    if (list.includes('DISABLE_USER') && list.includes('REMOVE_ALL_APPS')) return 'DISABLE_APPS';
    if (list.includes('DISABLE_USER')) return 'DISABLE';
    if (list.includes('SUSPEND_USER') && list.includes('REVOKE_SESSIONS')) return 'SUSPEND_SESSIONS';
    if (list.includes('REMOVE_ALL_APPS')) return 'REVOKE_APPS';
    return 'SUSPEND';
  }

  function aigPunchPresetOptions(selected) {
    return Object.entries(AIG_PUNCH_PRESETS).map(([id, p]) =>
      `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(p.label)}</option>`,
    ).join('');
  }

  async function openPolicyModal(existing) {
    const isEdit = Boolean(existing?.id);
    const scope = existing?.employee_scope || { departments: [], employment_types: [] };
    const deptsVal = (scope.departments || []).join(', ');
    const empTypes = new Set(scope.employment_types || []);
    const idField = existing?.identifier_field === 'EMPLOYEE_CODE' ? 'EMPLOYEE_ID' : (existing?.identifier_field || 'EMPLOYEE_ID');
    const actionMode = existing?.emergency_mode ? 'emergency' : (existing?.approval_enabled ? 'approval' : 'auto');
    const src = existing?.source_type || 'REST_API';
    const enabled = existing ? (existing.enabled ? 1 : 0) : 0;
    const poll = existing?.polling_interval || 'manual';
    const cutoff = String(existing?.cutoff_time || '10:00:00').slice(0, 5);
    const days = existing?.consecutive_days ?? 3;
    const evalMode = existing?.evaluation_mode === 'CONSECUTIVE_ABSENT' ? 'CONSECUTIVE_ABSENT' : 'DAILY_LIVE';
    const punch = existing?.punch_rule_actions || {
      no_punch_today: ['SUSPEND_USER'],
      no_punch_consecutive: ['DISABLE_USER'],
    };
    const missPreset = aigActionsToPreset(punch.no_punch_today);
    const consecPreset = aigActionsToPreset(punch.no_punch_consecutive);

    const bd = openModal(`<div class="modal modal-wide" role="dialog">
      <div class="modal-header"><h2>${isEdit ? 'Edit policy' : 'New policy'}</h2></div>
      <div class="modal-body">
        <div id="aig-pol-err"></div>
        <h3 style="font-size:0.9rem;margin:0 0 0.75rem">Policy &amp; scope</h3>
        <div class="form-2col">
          <div class="form-group"><label class="form-label">Policy name</label>
            <input class="form-input" id="aig-name" value="${esc(existing?.name || '')}" placeholder="e.g. Store no-punch revoke"></div>
          <div class="form-group"><label class="form-label">Status</label>
            <select class="form-select" id="aig-enabled">
              <option value="1" ${enabled ? 'selected' : ''}>Enabled</option>
              <option value="0" ${!enabled ? 'selected' : ''}>Disabled</option>
            </select></div>
        </div>
        <div class="form-group">
          <label class="form-label">Departments (scope)</label>
          <input class="form-input" id="aig-depts" value="${esc(deptsVal)}" placeholder="Retail, Store Ops — leave blank for all">
          <p class="muted" style="font-size:0.78rem;margin:0.35rem 0 0">Comma-separated. Matched against employee department. Blank = all.</p>
        </div>
        <div class="form-group">
          <label class="form-label">Employment types (scope)</label>
          <div style="display:flex;gap:1.25rem;flex-wrap:wrap;margin-top:0.35rem">
            ${['CORPORATE','STORE','PLANT','DC'].map((t) =>
              `<label class="form-check-row" style="margin:0;gap:0.4rem;white-space:nowrap"><input type="checkbox" class="form-check aig-emp-type" value="${t}" ${empTypes.has(t) ? 'checked' : ''}> ${t}</label>`
            ).join('')}
          </div>
          <p class="muted" style="font-size:0.78rem;margin:0.35rem 0 0">Leave all unchecked to include every employment type.</p>
        </div>

        <h3 style="font-size:0.9rem;margin:1.25rem 0 0.75rem">Source</h3>
        <div class="form-group">
          <label class="form-label">Attendance source</label>
          <select class="form-select" id="aig-source">
            <option value="REST_API" ${src==='REST_API'?'selected':''}>Truein API</option>
            <option value="SFTP" ${src==='SFTP'?'selected':''}>SFTP file</option>
            <option value="BOTH" ${src==='BOTH'?'selected':''}>API + SFTP</option>
            <option value="FILE_UPLOAD" ${src==='FILE_UPLOAD'?'selected':''}>Manual CSV only</option>
          </select>
          <p class="muted" style="font-size:0.78rem;margin:0.35rem 0 0">After saving, use <strong>Feeds</strong> to enter API token or SFTP host/path.</p>
        </div>

        <h3 style="font-size:0.9rem;margin:1.25rem 0 0.75rem">Schedule</h3>
        <div class="form-2col">
          <div class="form-group"><label class="form-label">Run schedule</label>
            <select class="form-select" id="aig-poll">
              <option value="15m" ${poll==='15m'?'selected':''}>Every 15 minutes</option>
              <option value="5m" ${poll==='5m'?'selected':''}>Every 5 minutes</option>
              <option value="1h" ${poll==='1h'?'selected':''}>Hourly</option>
              <option value="1d" ${poll==='1d'?'selected':''}>Daily</option>
              <option value="manual" ${poll==='manual'?'selected':''}>Manual only</option>
            </select></div>
          <div class="form-group"><label class="form-label">Match employees by</label>
            <select class="form-select" id="aig-id-field">
              <option value="EMPLOYEE_ID" ${idField==='EMPLOYEE_ID'?'selected':''}>Employee ID</option>
              <option value="EMAIL" ${idField==='EMAIL'?'selected':''}>Email</option>
              <option value="USERNAME" ${idField==='USERNAME'?'selected':''}>Username</option>
            </select></div>
        </div>

        <h3 style="font-size:0.9rem;margin:1.25rem 0 0.75rem">Attendance evaluation data</h3>
        <p class="muted" style="font-size:0.8rem;margin:0 0 0.75rem">Choose whether this policy uses <strong>today’s live punch</strong> or only people who have <strong>not punched for N consecutive days</strong> (API/SFTP then consumes that N-day window).</p>
        <div class="form-group">
          <label class="form-label">Evaluation mode</label>
          <select class="form-select" id="aig-eval-mode">
            <option value="DAILY_LIVE" ${evalMode==='DAILY_LIVE'?'selected':''}>Daily live punch (today after cutoff)</option>
            <option value="CONSECUTIVE_ABSENT" ${evalMode==='CONSECUTIVE_ABSENT'?'selected':''}>Not punched for N consecutive days only</option>
          </select>
        </div>
        <div class="form-2col">
          <div class="form-group aig-daily-only"><label class="form-label">Punch cutoff (daily mode)</label>
            <input class="form-input" id="aig-cutoff" type="time" value="${esc(cutoff)}"></div>
          <div class="form-group"><label class="form-label">Absent-day window</label>
            <select class="form-select" id="aig-days">
              <option value="3" ${Number(days)===3?'selected':''}>3 days</option>
              <option value="5" ${Number(days)===5?'selected':''}>5 days</option>
              <option value="7" ${Number(days)===7?'selected':''}>7 days</option>
              <option value="custom" ${![3,5,7].includes(Number(days))?'selected':''}>Custom…</option>
            </select>
            <p class="muted" style="font-size:0.75rem;margin:0.35rem 0 0">In consecutive mode the feed pulls this many days of punch data.</p></div>
        </div>
        <div class="form-group aig-custom-days" style="${[3,5,7].includes(Number(days))?'display:none':''}">
          <label class="form-label">Custom absent days (1–30)</label>
          <input class="form-input" id="aig-days-custom" type="number" min="1" max="30" value="${esc(String(days))}">
        </div>

        <h3 style="font-size:0.9rem;margin:1.25rem 0 0.75rem">Revoke actions</h3>
        <p class="muted" style="font-size:0.8rem;margin:0 0 0.75rem">Choose what happens when attendance rules match. <strong>No action</strong> only records the evaluation. Suspend blocks SSO; disable/deprovision is stronger; app revoke removes application assignments.</p>
        <div class="form-2col">
          <div class="form-group aig-daily-only"><label class="form-label">Missed punch (today after cutoff)</label>
            <select class="form-select" id="aig-miss-punch">${aigPunchPresetOptions(missPreset)}</select></div>
          <div class="form-group"><label class="form-label">Consecutive absences (N-day window)</label>
            <select class="form-select" id="aig-consec-punch">${aigPunchPresetOptions(consecPreset)}</select></div>
        </div>

        <h3 style="font-size:0.9rem;margin:1.25rem 0 0.75rem">Approval workflow</h3>
        <div class="form-group">
          <label class="form-label">When to run actions</label>
          <select class="form-select" id="aig-action-mode">
            <option value="auto" ${actionMode==='auto'?'selected':''}>Auto-execute immediately</option>
            <option value="approval" ${actionMode==='approval'?'selected':''}>Approval workflow — queue on Approvals tab first</option>
            <option value="emergency" ${actionMode==='emergency'?'selected':''}>Emergency — bypass approval</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="aig-pol-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="aig-pol-save">${isEdit ? 'Save changes' : 'Create policy'}</button>
      </div>
    </div>`);

    const syncEvalModeUi = () => {
      const consec = bd.querySelector('#aig-eval-mode').value === 'CONSECUTIVE_ABSENT';
      bd.querySelectorAll('.aig-daily-only').forEach((el) => { el.style.display = consec ? 'none' : ''; });
    };
    const syncDaysUi = () => {
      const custom = bd.querySelector('#aig-days').value === 'custom';
      const box = bd.querySelector('.aig-custom-days');
      if (box) box.style.display = custom ? '' : 'none';
    };
    bd.querySelector('#aig-eval-mode').addEventListener('change', syncEvalModeUi);
    bd.querySelector('#aig-days').addEventListener('change', syncDaysUi);
    syncEvalModeUi();
    syncDaysUi();

    bd.querySelector('#aig-pol-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#aig-pol-save').addEventListener('click', async () => {
      const errEl = bd.querySelector('#aig-pol-err');
      errEl.innerHTML = '';
      const name = bd.querySelector('#aig-name').value.trim();
      if (!name) { errEl.innerHTML = errHtml('Policy name is required'); return; }
      const depts = (bd.querySelector('#aig-depts').value || '').split(',').map((x) => x.trim()).filter(Boolean);
      const employment_types = [...bd.querySelectorAll('.aig-emp-type:checked')].map((el) => el.value);
      const mode = bd.querySelector('#aig-action-mode').value;
      const cutoffVal = bd.querySelector('#aig-cutoff').value;
      const missKey = bd.querySelector('#aig-miss-punch').value;
      const consecKey = bd.querySelector('#aig-consec-punch').value;
      const evalModeVal = bd.querySelector('#aig-eval-mode').value;
      const daysSel = bd.querySelector('#aig-days').value;
      const daysVal = daysSel === 'custom'
        ? (Number(bd.querySelector('#aig-days-custom')?.value) || 3)
        : (Number(daysSel) || 3);
      const payload = {
        name,
        employee_scope: { departments: depts, employment_types },
        enabled: Number(bd.querySelector('#aig-enabled').value),
        source_type: bd.querySelector('#aig-source').value,
        polling_interval: bd.querySelector('#aig-poll').value,
        cutoff_time: cutoffVal.length === 5 ? cutoffVal + ':00' : cutoffVal,
        evaluation_mode: evalModeVal,
        consecutive_days: Math.min(30, Math.max(1, daysVal)),
        approval_enabled: mode === 'approval' ? 1 : 0,
        emergency_mode: mode === 'emergency' ? 1 : 0,
        identifier_field: bd.querySelector('#aig-id-field').value,
        punch_rule_actions: {
          no_punch_today: AIG_PUNCH_PRESETS[missKey]?.actions ?? ['SUSPEND_USER'],
          no_punch_consecutive: AIG_PUNCH_PRESETS[consecKey]?.actions ?? ['DISABLE_USER'],
        },
      };
      try {
        let id = existing?.id;
        if (isEdit) {
          await api.updateAttendanceIgaConfig(payload, id);
        } else {
          const created = await api.createAttendanceIgaConfig({
            name,
            cloneFromId: selectedConfigId || 1,
            employee_scope: payload.employee_scope,
          });
          id = created.id;
          await api.updateAttendanceIgaConfig(payload, id);
        }
        setSelectedConfig(id);
        configCache = null;
        bd.remove();
        await refreshConfigList();
        await loadStatusBar();
        await loadStats();
        await loadPolicy();
      } catch (e) { errEl.innerHTML = errHtml(e.message); }
    });
  }

  async function loadGlobalExclusions() {
    const area = wrap.querySelector('#tab-exclusions');
    area.innerHTML = loading();
    try {
      const r = await api.attendanceIgaGlobalExclusions();
      const rows = r.data || [];
      const tableRows = rows.length
        ? rows.map((row) => `<tr>
            <td>${esc(row.email)}</td>
            <td>${esc(row.full_name || '—')}</td>
            <td style="font-family:var(--mono,'JetBrains Mono',monospace);font-size:0.82rem">${esc(row.emp_id || '—')}</td>
            <td class="muted" style="font-size:0.82rem">${esc(row.notes || '—')}</td>
            <td style="white-space:nowrap"><button class="btn btn-sm btn-ghost aig-excl-remove" data-id="${esc(row.id)}">Remove</button></td>
          </tr>`).join('')
        : `<tr><td colspan="5" class="muted" style="padding:1rem">No exclusions yet — add emails below.</td></tr>`;

      area.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
          <div class="aig-section-head" style="margin-bottom:1rem">
            <h3 style="margin:0">Global exclusion list</h3>
            <p class="muted" style="margin:0.35rem 0 0">Users on this list are <strong>never suspended or disabled</strong> by Attendance IGA across all policies. Applies by corporate email (and resolved employee id).</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Email</th><th>Name</th><th>Employee ID</th><th>Notes</th><th></th></tr></thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
        </div>
        <div class="aig-dash-grid">
          <div class="card">
            <h3 style="margin:0 0 0.75rem">Add by email</h3>
            <div class="form-group">
              <label class="form-label">Corporate email</label>
              <input class="form-input" id="aig-excl-email" type="email" placeholder="user@lenskart.com" autocomplete="off">
            </div>
            <div class="form-group">
              <label class="form-label">Notes (optional)</label>
              <input class="form-input" id="aig-excl-notes" placeholder="e.g. VIP, on leave, contractor">
            </div>
            <div id="aig-excl-add-msg"></div>
            <button class="btn btn-primary" id="aig-excl-add">Add to exclusion list</button>
          </div>
          <div class="card">
            <h3 style="margin:0 0 0.75rem">Import from CSV</h3>
            <p class="muted" style="font-size:0.85rem;margin-bottom:0.75rem">One email per line, or a column named <code>email</code> / <code>email_corp</code>.</p>
            <textarea class="form-textarea" id="aig-excl-csv" rows="8" placeholder="email&#10;vip1@lenskart.com&#10;vip2@lenskart.com"></textarea>
            <div id="aig-excl-import-msg" style="margin-top:0.75rem"></div>
            <button class="btn btn-secondary" id="aig-excl-import" style="margin-top:0.75rem">Import CSV</button>
          </div>
        </div>`;

      area.querySelector('#aig-excl-add').addEventListener('click', async () => {
        const msg = area.querySelector('#aig-excl-add-msg');
        msg.innerHTML = '';
        const email = area.querySelector('#aig-excl-email').value.trim();
        const notes = area.querySelector('#aig-excl-notes').value.trim();
        if (!email) { msg.innerHTML = errHtml('Email is required'); return; }
        try {
          const result = await api.addAttendanceIgaGlobalExclusion({ email, notes: notes || undefined });
          const warn = result.unknownEmail
            ? `<div class="alert alert-warning" style="margin-top:0.5rem">Added, but no employee record matched this email yet — exclusion still applies when the email matches at run time.</div>`
            : '';
          msg.innerHTML = `<div class="alert alert-success">Added ${esc(result.email)}</div>${warn}`;
          await loadGlobalExclusions();
        } catch (e) { msg.innerHTML = errHtml(e.message); }
      });

      area.querySelector('#aig-excl-import').addEventListener('click', async () => {
        const msg = area.querySelector('#aig-excl-import-msg');
        msg.innerHTML = '';
        const csvText = area.querySelector('#aig-excl-csv').value;
        if (!csvText.trim()) { msg.innerHTML = errHtml('Paste CSV content first'); return; }
        try {
          const result = await api.importAttendanceIgaGlobalExclusions(csvText);
          const unknown = (result.unknownEmails || []).length
            ? `<div class="alert alert-warning" style="margin-top:0.5rem">${result.unknownEmails.length} email(s) not found in directory — still excluded by email at run time.</div>`
            : '';
          msg.innerHTML = `<div class="alert alert-success">Imported ${result.added} email(s)${result.skipped ? ` · ${result.skipped} skipped` : ''}</div>${unknown}`;
          await loadGlobalExclusions();
        } catch (e) { msg.innerHTML = errHtml(e.message); }
      });

      area.querySelectorAll('.aig-excl-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this email from the global exclusion list?')) return;
          try {
            await api.deleteAttendanceIgaGlobalExclusion(btn.dataset.id);
            await loadGlobalExclusions();
          } catch (e) { alert(e.message); }
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  async function loadConfig() {
    const area = wrap.querySelector('#tab-config');
    area.innerHTML = loading();
    try {
      const c = await api.attendanceIgaConfig(selectedConfigId);
      configCache = c;
      const s = c.sftp_config || {};
      const ac = c.api_config || {};
      const hasToken = Boolean(c.api_auth_config?.token);
      const hasKey = Boolean(s.privateKey);
      const src = c.source_type || 'REST_API';
      const tz = ac.timezone || s.timezone || 'Asia/Kolkata';
      const offset = ac.dateOffsetDays ?? s.dateOffsetDays ?? 0;
      const lookback = ac.lookbackDays ?? s.lookbackDays ?? 1;
      const sftpAfter = s.archiveDir ? 'archive' : (s.deleteAfterFetch ? 'delete' : 'keep');

      area.innerHTML = `
        <div class="aig-settings">
          <aside class="aig-settings-nav">
            <div class="aig-settings-nav-label">Data source</div>
            <button type="button" class="aig-nav-item active" data-section="source"><span class="aig-nav-title">Source</span><span class="aig-nav-desc">API, SFTP, or both</span></button>
            <button type="button" class="aig-nav-item" data-section="api"><span class="aig-nav-title">Truein API</span><span class="aig-nav-desc">Token &amp; endpoint</span></button>
            <button type="button" class="aig-nav-item" data-section="sftp"><span class="aig-nav-title">SFTP</span><span class="aig-nav-desc">Daily CSV file</span></button>
            <button type="button" class="aig-nav-item" data-section="manual"><span class="aig-nav-title">Manual Import</span><span class="aig-nav-desc">One-off CSV</span></button>
            <button type="button" class="aig-nav-item" data-section="exclusions"><span class="aig-nav-title">Global Exclusions</span><span class="aig-nav-desc">Skip suspend list</span></button>
          </aside>
          <div class="aig-settings-main">
            <div class="aig-settings-scroll">
              <section class="aig-section active" data-section="source">
                <div class="aig-section-head">
                  <h3>Attendance source</h3>
                  <p>Choose how this policy fetches punches. Connection details are under Truein API and SFTP. Scope and schedule are on the <strong>Policy</strong> tab.</p>
                </div>
                <div class="aig-source-cards">
                  <label class="aig-source-card ${src==='REST_API'?'active':''}"><input type="radio" name="aig-source" value="REST_API" ${src==='REST_API'?'checked':''}><strong>Truein API</strong><span>Fetch daily attendance with Bearer token + date</span></label>
                  <label class="aig-source-card ${src==='SFTP'?'active':''}"><input type="radio" name="aig-source" value="SFTP" ${src==='SFTP'?'checked':''}><strong>SFTP file</strong><span>Download dated CSV from drop folder</span></label>
                  <label class="aig-source-card ${src==='BOTH'?'active':''}"><input type="radio" name="aig-source" value="BOTH" ${src==='BOTH'?'checked':''}><strong>API + SFTP</strong><span>Merge both sources each run</span></label>
                  <label class="aig-source-card ${src==='FILE_UPLOAD'?'active':''}"><input type="radio" name="aig-source" value="FILE_UPLOAD" ${src==='FILE_UPLOAD'?'checked':''}><strong>Manual only</strong><span>Scheduler off — CSV upload when needed</span></label>
                </div>
                <input type="hidden" id="aig-source" value="${esc(src)}">
                <div class="aig-field-grid" style="margin-top:1.25rem">
                  ${aigField('aig-timezone', 'Timezone', `<input class="form-input" id="aig-timezone" value="${esc(tz)}">`, 'Used for API date, SFTP filename, and weekend checks.')}
                  ${aigField('aig-date-offset', 'Attendance date', `<select class="form-select" id="aig-date-offset"><option value="0" ${Number(offset)===0?'selected':''}>Today</option><option value="-1" ${Number(offset)===-1?'selected':''}>Yesterday</option></select>`, 'Which calendar day to fetch.')}
                  ${aigField('aig-lookback', 'Retry previous days', `<input class="form-input" id="aig-lookback" type="number" min="0" max="7" value="${esc(String(lookback))}">`, 'If today\'s feed is empty, try N prior days.')}
                </div>
              </section>

              <section class="aig-section" data-section="api">
                <div class="aig-section-head">
                  <h3>Truein API</h3>
                  <p>Bearer token authentication. Date uses timezone and attendance date from Source.</p>
                </div>
                <div class="aig-field-grid">
                  ${aigField('aig-api-url', 'Base URL', `<input class="form-input" id="aig-api-url" value="${esc(c.api_url||ac.baseUrl||'')}" placeholder="https://api.truein.com">`, 'From Truein support.')}
                  ${aigField('aig-api-endpoint', 'Endpoint', `<input class="form-input" id="aig-api-endpoint" value="${esc(ac.endpoint||'/api/attendance/daily')}" placeholder="/api/v1/getDailyAttendance">`)}
                  ${aigField('aig-api-token', 'API token', `<input class="form-input" id="aig-api-token" type="password" autocomplete="new-password" placeholder="${hasToken ? 'Saved — leave blank to keep' : 'Bearer token'}">`, hasToken ? 'Token is stored. Enter a new value only to replace it.' : 'Required for Truein.')}
                  ${aigField('aig-api-method', 'Method', `<select class="form-select" id="aig-api-method"><option value="GET" ${(ac.method||c.api_method||'GET')==='GET'?'selected':''}>GET</option><option value="POST" ${(ac.method||c.api_method)==='POST'?'selected':''}>POST</option></select>`)}
                  ${aigField('aig-api-date-param', 'Date parameter', `<input class="form-input" id="aig-api-date-param" value="${esc(ac.dateParam||'date')}">`, 'Query/body field name for the attendance date.')}
                  ${aigField('aig-api-site', 'Site ID', `<input class="form-input" id="aig-api-site" value="${esc(ac.siteId||'')}" placeholder="Optional">`)}
                  <div class="span-2">${aigField('aig-api-records-path', 'JSON array path', `<input class="form-input" id="aig-api-records-path" value="${esc(ac.recordsPath||'')}" placeholder="data.attendance">`, 'Optional. Leave blank to auto-detect common keys.')}</div>
                </div>
                <div class="aig-preview"><div class="aig-preview-label">Request preview</div><div id="aig-api-preview" class="muted">Enter base URL</div></div>
                <div class="aig-inline-actions">
                  <button type="button" class="btn btn-secondary" id="aig-api-test">Test connection</button>
                  <span class="muted" style="font-size:0.78rem">Uses current form values (save not required).</span>
                </div>
                <div id="aig-api-test-result" style="margin-top:0.75rem"></div>
              </section>

              <section class="aig-section" data-section="sftp">
                <div class="aig-section-head">
                  <h3>SFTP</h3>
                  <p>Download a dated CSV. Filename tokens use timezone and attendance date from Source.</p>
                </div>
                <div class="aig-field-grid">
                  ${aigField('aig-sftp-host', 'Host', `<input class="form-input" id="aig-sftp-host" value="${esc(s.host||'')}" placeholder="sftp.company.com">`)}
                  ${aigField('aig-sftp-port', 'Port', `<input class="form-input" id="aig-sftp-port" type="number" value="${esc(String(s.port||22))}">`)}
                  ${aigField('aig-sftp-user', 'Username', `<input class="form-input" id="aig-sftp-user" value="${esc(s.username||'')}">`)}
                  ${aigField('aig-sftp-pass', 'Password', `<input class="form-input" id="aig-sftp-pass" type="password" autocomplete="new-password" placeholder="${s.password ? 'Saved — leave blank to keep' : 'Password'}">`)}
                  ${aigField('aig-sftp-dir', 'Remote directory', `<input class="form-input" id="aig-sftp-dir" value="${esc(s.remoteDir||'')}" placeholder="/hr/attendance/incoming">`)}
                  ${aigField('aig-sftp-template', 'File name template', `<input class="form-input" id="aig-sftp-template" value="${esc(s.fileNameTemplate||'attendance_{YYYY-MM-DD}.csv')}">`, 'Tokens: {YYYY-MM-DD} · {YYYYMMDD} · {date}')}
                  ${aigField('aig-sftp-after', 'After successful fetch', `<select class="form-select" id="aig-sftp-after"><option value="keep" ${sftpAfter==='keep'?'selected':''}>Keep file</option><option value="archive" ${sftpAfter==='archive'?'selected':''}>Move to archive</option><option value="delete" ${sftpAfter==='delete'?'selected':''}>Delete file</option></select>`)}
                  <div id="aig-sftp-archive-wrap">${aigField('aig-sftp-archive', 'Archive directory', `<input class="form-input" id="aig-sftp-archive" value="${esc(s.archiveDir||'')}" placeholder="/hr/attendance/processed">`)}</div>
                  <div class="span-2">${aigField('aig-sftp-key', 'Private key (optional)', `<textarea class="form-textarea" id="aig-sftp-key" rows="3" placeholder="${hasKey ? 'Key saved — paste a new PEM only to replace' : 'Paste PEM if not using password'}"></textarea>`, hasKey ? 'A private key is stored. Leave blank to keep it.' : '')}</div>
                </div>
                <div class="aig-token-hints"><span class="muted" style="font-size:0.74rem">Tokens</span><code>{YYYY-MM-DD}</code><code>{YYYYMMDD}</code><code>{DD-MM-YYYY}</code><code>{date}</code></div>
                <div class="aig-preview"><div class="aig-preview-label">Resolved path</div><div id="aig-sftp-preview"></div></div>
                ${c.sftp_last_file ? `<p class="muted" style="margin-top:0.75rem;font-size:0.8rem">Last fetch: <strong>${esc(c.sftp_last_file)}</strong></p>` : ''}
              </section>

              <section class="aig-section" data-section="manual">
                <div class="aig-section-head">
                  <h3>Manual CSV import</h3>
                  <p>One-off import when HR sends a file outside the scheduled feed. Match columns to the Policy “Match employees by” field.</p>
                </div>
                <div class="aig-csv-box">
                  <label class="form-label" for="aig-csv">Attendance CSV</label>
                  <textarea class="form-textarea" id="aig-csv" rows="8" placeholder="employee_id,email,date,in_time&#10;E001,user@company.com,2026-07-18,09:15"></textarea>
                  <span class="form-hint">Header row required.</span>
                  <div class="aig-inline-actions">
                    <button class="btn btn-secondary" id="aig-upload-run">Import CSV &amp; run pipeline</button>
                  </div>
                </div>
              </section>

              <section class="aig-section" data-section="exclusions">
                <div class="aig-section-head">
                  <h3>Global exclusion list</h3>
                  <p>Users on this list are never suspended or disabled by Attendance IGA (all policies). Manage the full list on the <strong>Global Exclusions</strong> tab.</p>
                </div>
                <button class="btn btn-secondary" id="aig-open-exclusions">Open Global Exclusions</button>
              </section>
            </div>
            <div class="aig-settings-footer">
              <div id="aig-cfg-err"></div>
              <button class="btn btn-primary" id="aig-save-config">Save configuration</button>
            </div>
          </div>
        </div>`;

      area.querySelectorAll('.aig-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.section;
          area.querySelectorAll('.aig-nav-item').forEach(b => b.classList.toggle('active', b === btn));
          area.querySelectorAll('.aig-section').forEach(sec => sec.classList.toggle('active', sec.dataset.section === name));
        });
      });

      const sourceHidden = area.querySelector('#aig-source');
      area.querySelectorAll('input[name="aig-source"]').forEach(radio => {
        radio.addEventListener('change', () => {
          sourceHidden.value = radio.value;
          area.querySelectorAll('.aig-source-card').forEach(card => {
            card.classList.toggle('active', card.querySelector('input')?.value === radio.value);
          });
        });
      });

      wireSftpPreview(area);
      wireApiPreview(area);
      wireSftpAfter(area);

      area.querySelector('#aig-open-exclusions')?.addEventListener('click', () => { void showAigTab('exclusions'); });

      area.querySelector('#aig-api-test')?.addEventListener('click', async () => {
        const box = area.querySelector('#aig-api-test-result');
        box.innerHTML = loading();
        try {
          const draft = buildApiPayload(area, c);
          const r = await api.attendanceIgaApiTest(draft);
          box.innerHTML = `<div class="alert alert-success">${esc(r.message || 'OK')}${r.requestUrl ? ` · ${esc(r.requestUrl)}` : ''}</div>`;
        } catch (e) {
          box.innerHTML = errHtml(e.message);
        }
      });

      area.querySelector('#aig-save-config').addEventListener('click', async () => {
        const errBox = area.querySelector('#aig-cfg-err');
        try {
          const sftpPayload = buildSftpPayload(area, s);
          const apiPayload = buildApiPayload(area, c);
          await api.updateAttendanceIgaConfig({
            source_type: area.querySelector('#aig-source').value,
            ...apiPayload,
            ...(sftpPayload === null ? { sftp_config: null } : (sftpPayload ? { sftp_config: sftpPayload } : {})),
          }, selectedConfigId);
          configCache = null;
          errBox.innerHTML = '<div class="alert alert-success">Configuration saved.</div>';
          await refreshConfigList();
          await loadStats(); await loadStatusBar();
        } catch (e) { errBox.innerHTML = errHtml(e.message); }
      });
      area.querySelector('#aig-upload-run').addEventListener('click', async () => {
        const errBox = area.querySelector('#aig-cfg-err');
        try {
          const r = await api.runAttendanceIga({ source: 'FILE_UPLOAD', csvText: area.querySelector('#aig-csv').value, configId: selectedConfigId });
          errBox.innerHTML = `<div class="alert alert-success">Import ${esc(r.status)} — ${esc(String(r.report?.successful??0))} ok, ${esc(String(r.report?.failed??0))} failed</div>`;
          await loadStats(); await loadImports(); await loadDash();
        } catch (e) { errBox.innerHTML = errHtml(e.message); }
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  async function loadImports() {
    const area = wrap.querySelector('#tab-imports');
    area.innerHTML = loading();
    try {
      const rows = norm(await api.attendanceIgaImports(20, selectedConfigId));
      const statusBadge = s => ({ COMPLETED: 'badge-success', PARTIAL: 'badge-warning', FAILED: 'badge-danger', RUNNING: 'badge-info' }[s] || 'badge-neutral');
      const noFeedData = (r) => Number(r.total_records || 0) === 0
        && Number(r.successful || 0) === 0
        && Number(r.failed || 0) === 0;
      const outcomeNote = (r) => {
        if (r.status === 'FAILED' && noFeedData(r)) {
          const msg = String(r.error_message || '');
          if (/disabled/i.test(msg)) {
            return '<span class="badge badge-neutral">Policy off — no feed, no actions</span>';
          }
          if (msg) {
            return '<span class="badge badge-danger">No connection / feed failed</span>';
          }
          return '<span class="badge badge-danger">No feed data — no policy actions</span>';
        }
        if (r.status === 'COMPLETED' && noFeedData(r)) {
          return '<span class="badge badge-neutral">Empty feed — no actions</span>';
        }
        return '';
      };
      area.innerHTML = `
        <div class="aap-actions"><div>
          <h3 class="section-title">Import History</h3>
          <p class="subtitle">Staging results per pipeline run. <strong>Total = 0</strong> means no attendance rows were loaded (policy disabled, connection/credentials failed, or empty feed) — <strong>no suspend/disable actions</strong> ran for that run.</p>
        </div></div>
        <div class="table-wrap aap-table"><table><thead><tr>
          <th>Started</th><th>Source</th><th>Status</th><th>Total</th><th>OK</th><th>Failed</th><th>Dupes</th><th>Unmatched</th><th>Outcome</th><th>Detail</th>
        </tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr class="${r.status === 'FAILED' && noFeedData(r) ? 'row-warn' : ''}">
          <td>${fmtDate(r.started_at)}</td>
          <td><span class="badge badge-info">${esc(r.source)}</span></td>
          <td><span class="badge ${statusBadge(r.status)}">${esc(r.status)}</span></td>
          <td>${esc(String(r.total_records ?? 0))}</td>
          <td>${esc(String(r.successful ?? 0))}</td>
          <td>${esc(String(r.failed ?? 0))}</td>
          <td>${esc(String(r.duplicates ?? 0))}</td>
          <td>${esc(String(r.unmatched ?? 0))}</td>
          <td>${outcomeNote(r) || '<span class="muted">—</span>'}</td>
          <td style="max-width:280px;font-size:0.78rem">${r.error_message
            ? `<span class="muted" title="${esc(r.error_message)}">${esc(String(r.error_message).slice(0, 180))}</span>`
            : '<span class="muted">—</span>'}</td>
        </tr>`).join('') : '<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">◎</div><p>No imports yet.</p></div></td></tr>'}
      </tbody></table></div>`;
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  async function loadApprovals() {
    const area = wrap.querySelector('#tab-approvals');
    area.innerHTML = loading();
    try {
      const rows = norm(await api.attendanceIgaApprovals('PENDING'));
      area.innerHTML = `
        <div class="aap-actions"><div><h3 class="section-title">Pending Approvals</h3><p class="subtitle">Review recommended access actions before execution.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Rule</th><th>Created</th><th>Decision</th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr><td class="cell-strong">${esc(r.full_name||r.emp_id)}</td><td><span class="badge badge-warning">${esc(r.rule_key)}</span></td><td class="muted">${fmtDate(r.created_at)}</td><td>
          <button class="btn btn-sm btn-primary aig-appr" data-id="${esc(r.id)}" data-dec="APPROVE">Approve</button>
          <button class="btn btn-sm btn-secondary aig-appr" data-id="${esc(r.id)}" data-dec="REJECT">Reject</button>
          <button class="btn btn-sm btn-danger aig-appr" data-id="${esc(r.id)}" data-dec="SKIP">Skip</button>
        </td></tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><p>No pending approvals.</p></div></td></tr>'}
      </tbody></table></div>`;
      area.querySelectorAll('.aig-appr').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api.attendanceIgaApprovalDecision(btn.dataset.id, { decision: btn.dataset.dec }); await loadApprovals(); await loadStats(); }
          catch (e) { alert(e.message); }
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  // Default: show only rows that can still be rolled back (so checkboxes always appear for IT).
  const execFilters = { q: '', status: '', rule: '', rolledBack: '0', action: '', from: '', to: '', importRunId: '' };

  function aigExecDateKey(raw) {
    if (!raw) return 'unknown';
    const s = String(raw);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return 'unknown';
    return d.toISOString().slice(0, 10);
  }
  function aigFmtDayLabel(isoDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
    try {
      return new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch { return isoDate; }
  }

  async function loadExecutions() {
    const area = wrap.querySelector('#tab-executions');
    area.innerHTML = loading();
    try {
      const resp = await api.attendanceIgaExecutions({
        configId: selectedConfigId,
        limit: 1000,
        q: execFilters.q || undefined,
        status: execFilters.status || undefined,
        rule: execFilters.rule || undefined,
        rolledBack: execFilters.rolledBack,
        action: execFilters.action || undefined,
        from: execFilters.from || undefined,
        to: execFilters.to || undefined,
        importRunId: execFilters.importRunId || undefined,
      });
      const rows = norm(resp);
      const jobs = Array.isArray(resp?.jobs) ? resp.jobs : [];
      const groups = Array.isArray(resp?.groups) && resp.groups.length
        ? resp.groups
        : (() => {
            const map = new Map();
            for (const r of rows) {
              const k = aigExecDateKey(r.executed_at);
              if (!map.has(k)) map.set(k, []);
              map.get(k).push(r);
            }
            return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => ({
              date, count: items.length, items,
              suspended: items.filter((i) => i.policy_action === 'SUSPEND').length,
              disabled: items.filter((i) => i.policy_action === 'DISABLE').length,
              failed: items.filter((i) => i.failed).length,
              rolled_back: items.filter((i) => i.rolled_back).length,
            }));
          })();
      const policy = resp?.policy || {};
      const exceptions = Array.isArray(resp?.exceptions) ? resp.exceptions : [];
      const statusBadge = s => ({ SUCCESS: 'badge-success', PARTIAL: 'badge-warning', FAILED: 'badge-danger' }[s] || 'badge-neutral');
      const actionBadge = (pa) => {
        if (pa === 'DISABLE') return '<span class="badge badge-danger">Disable (policy)</span>';
        if (pa === 'SUSPEND') return '<span class="badge badge-warning">Suspend (policy)</span>';
        return pa ? `<span class="badge badge-neutral">${esc(pa)}</span>` : '—';
      };
      const todayActs = (policy.actions?.no_punch_today || []).join(', ') || 'SUSPEND_USER';
      const consecActs = (policy.actions?.no_punch_consecutive || []).join(', ') || 'DISABLE_USER';
      const exTypeLabel = (t) => ({ VIP_USER: 'VIP', EMPLOYEE: 'Employee', DEPARTMENT: 'Department' }[t] || t);
      const rollbackable = rows.filter(r => !Number(r.rolled_back));
      const renderRow = (r) => {
        const canRb = !Number(r.rolled_back);
        return `<tr class="${r.failed ? 'row-warn' : ''}" data-run="${esc(r.import_run_id || '')}">
          <td style="text-align:center">${canRb
            ? `<input type="checkbox" class="aig-exec-cb" value="${esc(r.id)}" style="width:1.1rem;height:1.1rem;cursor:pointer" />`
            : ''}</td>
          <td class="muted">${fmtDate(r.executed_at)}</td>
          <td class="cell-strong">${esc(r.full_name||r.emp_id)}<div class="muted" style="font-size:0.72rem">${esc(r.emp_id)}${r.email_corp ? ` · ${esc(r.email_corp)}` : ''}</div></td>
          <td><span class="badge badge-neutral">${esc(r.rule_key)}</span></td>
          <td>${r.absent_days != null ? `<strong>${esc(String(r.absent_days))}</strong>` : '—'}</td>
          <td>${actionBadge(r.policy_action)}</td>
          <td><span class="badge ${statusBadge(r.status)}">${esc(r.status)}</span></td>
          <td style="max-width:220px;font-size:0.78rem">${r.failure_reason
            ? `<span class="badge badge-danger">Failed</span> <span class="muted" title="${esc(r.failure_reason)}">${esc(String(r.failure_reason).slice(0, 120))}</span>`
            : '<span class="muted">—</span>'}</td>
          <td>${canRb
            ? `<button class="btn btn-sm btn-secondary aig-rb" data-id="${esc(r.id)}">Rollback</button>`
            : '<span class="badge badge-neutral">Rolled back</span>'}</td>
        </tr>`;
      };
      const jobsWithPending = jobs.filter((j) => Number(j.pending_rollback) > 0);
      area.innerHTML = `
        <div class="aap-actions" style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start">
          <div>
            <h3 class="section-title">Action Executions</h3>
            <p class="subtitle">Enterprise undo: select rows / day / entire import job. Default filter shows only rows still open for rollback.</p>
          </div>
        </div>
        <div class="card" id="aig-rb-toolbar" style="position:sticky;top:0;z-index:5;margin-bottom:1rem;padding:0.85rem 1rem;display:flex;flex-wrap:wrap;gap:0.65rem;align-items:center;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);box-shadow:0 1px 3px rgba(0,0,0,.06)">
          <label style="display:flex;gap:0.4rem;align-items:center;margin:0;font-weight:600;font-size:0.85rem;cursor:pointer">
            <input type="checkbox" id="aig-exec-all" ${rollbackable.length ? '' : 'disabled'} style="width:1.15rem;height:1.15rem;cursor:pointer" />
            Select all open (${rollbackable.length})
          </label>
          <button type="button" class="btn btn-primary btn-sm" id="aig-bulk-rb" ${rollbackable.length ? '' : 'disabled'}>Rollback selected (0)</button>
          <button type="button" class="btn btn-secondary btn-sm" id="aig-rb-matching">Rollback all matching filters</button>
          <span style="flex:1"></span>
          <label class="btn btn-secondary btn-sm" style="margin:0;cursor:pointer">
            Import CSV
            <input type="file" id="aig-exec-csv" accept=".csv,text/csv" style="display:none" />
          </label>
          <button type="button" class="btn btn-secondary btn-sm" id="aig-exec-export">Export CSV</button>
        </div>
        <div class="card" style="margin-bottom:1rem;padding:1rem 1.15rem">
          <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center;margin-bottom:0.65rem">
            <div>
              <h4 style="margin:0 0 0.25rem;font-size:0.95rem">Complete job rollback</h4>
              <p class="muted" style="margin:0;font-size:0.8rem">One click undoes every open execution from an import / evaluate run (max 2000).</p>
            </div>
            ${execFilters.importRunId ? `<button type="button" class="btn btn-secondary btn-sm" id="aig-clear-job">Clear job filter</button>` : ''}
          </div>
          ${jobs.length ? `<div class="table-wrap"><table><thead><tr>
            <th>Job started</th><th>Source</th><th>Status</th><th>Executions</th><th>Open</th><th>Rolled back</th><th></th>
          </tr></thead><tbody>
          ${jobs.map((j) => {
            const pending = Number(j.pending_rollback) || 0;
            const total = Number(j.executions) || 0;
            const done = Number(j.rolled_back) || 0;
            return `<tr>
              <td class="muted">${fmtDate(j.started_at)}<div class="mono" style="font-size:0.68rem">${esc(String(j.id || '').slice(0, 8))}…</div></td>
              <td><span class="badge badge-info">${esc(j.source || '—')}</span></td>
              <td><span class="badge badge-neutral">${esc(j.status || '—')}</span></td>
              <td>${esc(String(total))}</td>
              <td><strong>${esc(String(pending))}</strong></td>
              <td>${esc(String(done))}</td>
              <td style="display:flex;gap:0.35rem;flex-wrap:wrap">
                <button type="button" class="btn btn-sm btn-secondary aig-view-job" data-run="${esc(j.id)}">View</button>
                ${pending
                  ? `<button type="button" class="btn btn-sm btn-primary aig-rb-job" data-run="${esc(j.id)}" data-n="${pending}">Rollback job (${pending})</button>`
                  : '<span class="badge badge-neutral">Fully rolled back</span>'}
              </td>
            </tr>`;
          }).join('')}
          </tbody></table></div>`
            : '<div class="empty-state"><p>No import jobs with executions yet.</p></div>'}
          ${jobsWithPending.length ? '' : '<p class="muted" style="margin:0.65rem 0 0;font-size:0.78rem">No jobs currently have open (not rolled back) executions.</p>'}
        </div>
        <div class="card" style="margin-bottom:1rem;padding:1rem 1.15rem">
          <div style="display:flex;flex-wrap:wrap;gap:0.75rem 1.5rem;align-items:center;margin-bottom:0.65rem">
            <strong>${esc(policy.name || 'Policy')}</strong>
            <span class="badge ${policy.enabled ? 'badge-success' : 'badge-danger'}">${policy.enabled ? 'ENABLED' : 'DISABLED'}</span>
            <span class="badge badge-info">${policy.evaluation_mode === 'CONSECUTIVE_ABSENT' ? 'Consecutive absent only' : 'Daily live punch'}</span>
            ${policy.evaluation_mode === 'CONSECUTIVE_ABSENT'
              ? `<span class="muted" style="font-size:0.82rem">Window <strong>${esc(String(policy.consecutive_days ?? '—'))}</strong> days (feed consumes this range)</span>`
              : `<span class="muted" style="font-size:0.82rem">Cutoff ${esc(policy.cutoff_time || '—')}</span>
                 <span class="muted" style="font-size:0.82rem">Also consecutive ≥ <strong>${esc(String(policy.consecutive_days ?? '—'))}</strong> days</span>`}
          </div>
          <div class="muted" style="font-size:0.8rem;line-height:1.5">
            ${policy.evaluation_mode === 'CONSECUTIVE_ABSENT'
              ? `<div><strong>NO_PUNCH_CONSECUTIVE</strong> (≥${esc(String(policy.consecutive_days ?? 3))} days) → ${esc(consecActs)}</div>
                 <div>Daily missed-punch rule is off for this policy.</div>`
              : `<div><strong>NO_PUNCH_TODAY</strong> → ${esc(todayActs)}</div>
                 <div><strong>NO_PUNCH_CONSECUTIVE</strong> (≥${esc(String(policy.consecutive_days ?? 3))} days) → ${esc(consecActs)}</div>`}
          </div>
        </div>
        <div class="card" style="margin-bottom:1rem;padding:1rem 1.15rem">
          <h4 style="margin:0 0 0.5rem;font-size:0.95rem">Exception users / exclusions</h4>
          <p class="muted" style="margin:0 0 0.65rem;font-size:0.8rem">These identities are skipped by Attendance IGA (VIP, employee, or department).</p>
          <div class="table-wrap"><table><thead><tr><th>Type</th><th>Value</th><th>Name</th><th>Notes</th></tr></thead><tbody>
          ${exceptions.length ? exceptions.map(ex => `<tr>
            <td><span class="badge badge-info">${esc(exTypeLabel(ex.exclusion_type))}</span></td>
            <td class="mono">${esc(ex.value)}</td>
            <td>${esc(ex.full_name || '—')}</td>
            <td class="muted">${esc(ex.notes || '—')}</td>
          </tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><p>No exception users configured for this policy.</p></div></td></tr>'}
          </tbody></table></div>
        </div>
        <form id="aig-exec-filters" class="card" style="margin-bottom:1rem;padding:0.85rem 1rem;display:flex;flex-wrap:wrap;gap:0.65rem;align-items:end">
          <div class="field" style="margin:0;min-width:160px;flex:1">
            <label>Search</label>
            <input name="q" class="form-input" placeholder="Name, emp id, email" value="${esc(execFilters.q)}" />
          </div>
          <div class="field" style="margin:0;min-width:130px">
            <label>From date</label>
            <input name="from" type="date" class="form-input" value="${esc(execFilters.from)}" />
          </div>
          <div class="field" style="margin:0;min-width:130px">
            <label>To date</label>
            <input name="to" type="date" class="form-input" value="${esc(execFilters.to)}" />
          </div>
          <div class="field" style="margin:0;min-width:120px">
            <label>Status</label>
            <select name="status" class="form-select">
              <option value="">All</option>
              <option value="SUCCESS" ${execFilters.status==='SUCCESS'?'selected':''}>Success</option>
              <option value="PARTIAL" ${execFilters.status==='PARTIAL'?'selected':''}>Partial</option>
              <option value="FAILED" ${execFilters.status==='FAILED'?'selected':''}>Failed</option>
            </select>
          </div>
          <div class="field" style="margin:0;min-width:140px">
            <label>Rule</label>
            <select name="rule" class="form-select">
              <option value="">All</option>
              <option value="NO_PUNCH_TODAY" ${execFilters.rule==='NO_PUNCH_TODAY'?'selected':''}>NO_PUNCH_TODAY</option>
              <option value="NO_PUNCH_CONSECUTIVE" ${execFilters.rule==='NO_PUNCH_CONSECUTIVE'?'selected':''}>NO_PUNCH_CONSECUTIVE</option>
              <option value="TERMINATED" ${execFilters.rule==='TERMINATED'?'selected':''}>TERMINATED</option>
            </select>
          </div>
          <div class="field" style="margin:0;min-width:130px">
            <label>Action</label>
            <select name="action" class="form-select">
              <option value="">All</option>
              <option value="SUSPEND" ${execFilters.action==='SUSPEND'?'selected':''}>Suspend</option>
              <option value="DISABLE" ${execFilters.action==='DISABLE'?'selected':''}>Disable</option>
              <option value="FAILED" ${execFilters.action==='FAILED'?'selected':''}>Failed / partial</option>
            </select>
          </div>
          <div class="field" style="margin:0;min-width:130px">
            <label>Rollback</label>
            <select name="rolledBack" class="form-select">
              <option value="">All</option>
              <option value="0" ${execFilters.rolledBack==='0'?'selected':''}>Not rolled back</option>
              <option value="1" ${execFilters.rolledBack==='1'?'selected':''}>Rolled back</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary btn-sm">Apply filters</button>
          <button type="button" class="btn btn-secondary btn-sm" id="aig-exec-clear">Clear</button>
        </form>
        ${execFilters.importRunId ? `<div class="card" style="margin-bottom:0.65rem;padding:0.65rem 1rem;display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;background:#f0f9ff;border-color:#bae6fd">
          <span class="badge badge-info">Job filter</span>
          <span class="mono" style="font-size:0.78rem">${esc(execFilters.importRunId)}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="aig-clear-job-banner">Clear job filter</button>
        </div>` : ''}
        <div class="muted" style="font-size:0.8rem;margin:0 0 0.5rem">${rows.length} result(s) · ${groups.length} day(s)${rollbackable.length ? ` · <strong>${rollbackable.length} open for rollback</strong>` : ' · none open for rollback (switch Rollback filter to All to audit history)'}</div>
        ${groups.length ? groups.map((g) => {
          const openN = (g.items || []).filter((r) => !Number(r.rolled_back)).length;
          return `
          <div class="card" style="margin-bottom:0.85rem;padding:0;overflow:hidden" data-date-group="${esc(g.date)}">
            <div style="display:flex;flex-wrap:wrap;gap:0.65rem 1rem;align-items:center;justify-content:space-between;padding:0.7rem 1rem;background:var(--surface,#f8fafc);border-bottom:1px solid var(--border,#e2e8f0)">
              <div style="display:flex;flex-wrap:wrap;gap:0.5rem 0.85rem;align-items:center">
                <strong>${esc(aigFmtDayLabel(g.date))}</strong>
                <span class="badge badge-neutral">${esc(String(g.count))} execution(s)</span>
                ${g.suspended ? `<span class="badge badge-warning">${esc(String(g.suspended))} suspend</span>` : ''}
                ${g.disabled ? `<span class="badge badge-danger">${esc(String(g.disabled))} disable</span>` : ''}
                ${g.failed ? `<span class="badge badge-danger">${esc(String(g.failed))} failed</span>` : ''}
                ${g.rolled_back ? `<span class="badge badge-info">${esc(String(g.rolled_back))} rolled back</span>` : ''}
                ${openN ? `<span class="badge badge-success">${esc(String(openN))} open</span>` : ''}
              </div>
              <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
                ${openN ? `<label style="font-size:0.78rem;display:flex;gap:0.35rem;align-items:center;margin:0;font-weight:600;cursor:pointer">
                  <input type="checkbox" class="aig-exec-day" data-date="${esc(g.date)}" style="width:1.1rem;height:1.1rem;cursor:pointer" /> Select day (${openN})
                </label>
                <button type="button" class="btn btn-sm btn-primary aig-rb-day" data-date="${esc(g.date)}" data-n="${openN}">Rollback day (${openN})</button>` : '<span class="muted" style="font-size:0.78rem">Nothing open this day</span>'}
              </div>
            </div>
            <div class="table-wrap" style="margin:0;border:0"><table><thead><tr>
              <th style="width:2.5rem;text-align:center">☐</th>
              <th>Time</th><th>Employee</th><th>Rule</th><th>Absent days</th><th>Policy action</th><th>Status</th><th>Failure detail</th><th>Undo</th>
            </tr></thead><tbody>
              ${(g.items || []).map(renderRow).join('')}
            </tbody></table></div>
          </div>`;
        }).join('') : '<div class="empty-state"><p>No executions match these filters. Tip: set Rollback to “Not rolled back” to see selectable rows.</p></div>'}`;

      const bulkBtn = area.querySelector('#aig-bulk-rb');
      const selectAll = area.querySelector('#aig-exec-all');
      const syncBulk = () => {
        const boxes = [...area.querySelectorAll('.aig-exec-cb')];
        const n = boxes.filter((cb) => cb.checked).length;
        if (bulkBtn) {
          bulkBtn.disabled = n === 0;
          bulkBtn.textContent = `Rollback selected (${n})`;
        }
        if (selectAll && boxes.length) {
          selectAll.checked = n === boxes.length;
          selectAll.indeterminate = n > 0 && n < boxes.length;
        }
      };
      selectAll?.addEventListener('change', (e) => {
        area.querySelectorAll('.aig-exec-cb').forEach((cb) => { cb.checked = e.target.checked; });
        syncBulk();
      });
      area.querySelectorAll('.aig-exec-day').forEach((dayCb) => {
        dayCb.addEventListener('change', () => {
          const card = dayCb.closest('[data-date-group]');
          card?.querySelectorAll('.aig-exec-cb').forEach((cb) => { cb.checked = dayCb.checked; });
          syncBulk();
        });
      });
      area.querySelectorAll('.aig-exec-cb').forEach((cb) => cb.addEventListener('change', syncBulk));
      syncBulk();

      const runBulkIds = async (ids, label) => {
        if (!ids.length) return;
        if (!confirm(`${label}\n\n${ids.length} execution(s) will be rolled back and prior access restored.`)) return;
        if (bulkBtn) bulkBtn.disabled = true;
        try {
          const r = await api.bulkRollbackAttendanceIgaExecutions(ids, selectedConfigId);
          alert(`Rollback: ${r.rolledBack || 0} ok, ${r.failed || 0} failed`);
          await loadExecutions();
          await loadStats();
        } catch (e) {
          alert(e.message);
          if (bulkBtn) bulkBtn.disabled = false;
          syncBulk();
        }
      };

      bulkBtn?.addEventListener('click', () => {
        const ids = [...area.querySelectorAll('.aig-exec-cb:checked')].map((cb) => cb.value);
        void runBulkIds(ids, 'Rollback selected executions?');
      });

      area.querySelectorAll('.aig-rb-day').forEach((btn) => {
        btn.addEventListener('click', () => {
          const card = btn.closest('[data-date-group]');
          const ids = [...(card?.querySelectorAll('.aig-exec-cb') || [])].map((cb) => cb.value);
          void runBulkIds(ids, `Rollback entire day ${btn.dataset.date}?`);
        });
      });

      const clearJobFilter = () => {
        execFilters.importRunId = '';
        void loadExecutions();
      };
      area.querySelector('#aig-clear-job')?.addEventListener('click', clearJobFilter);
      area.querySelector('#aig-clear-job-banner')?.addEventListener('click', clearJobFilter);

      area.querySelectorAll('.aig-view-job').forEach((btn) => {
        btn.addEventListener('click', () => {
          execFilters.importRunId = btn.dataset.run || '';
          execFilters.rolledBack = '';
          void loadExecutions();
        });
      });

      area.querySelectorAll('.aig-rb-job').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const runId = btn.dataset.run;
          const n = btn.dataset.n || '?';
          if (!runId) return;
          if (!confirm(`COMPLETE JOB ROLLBACK\n\nThis undoes all ${n} open execution(s) from this import/evaluate run and restores prior access.\n\nJob: ${runId}\n\nContinue?`)) return;
          btn.disabled = true;
          try {
            const r = await api.rollbackJobAttendanceIgaExecutions(runId, selectedConfigId);
            alert(`Job rollback: ${r.rolledBack || 0} ok, ${r.failed || 0} failed (${r.requested || 0} requested)`);
            await loadExecutions();
            await loadStats();
          } catch (e) {
            alert(e.message);
            btn.disabled = false;
          }
        });
      });

      area.querySelector('#aig-rb-matching')?.addEventListener('click', async () => {
        const label = [
          execFilters.from && `from ${execFilters.from}`,
          execFilters.to && `to ${execFilters.to}`,
          execFilters.status && `status=${execFilters.status}`,
          execFilters.rule && `rule=${execFilters.rule}`,
          execFilters.action && `action=${execFilters.action}`,
          execFilters.q && `q=${execFilters.q}`,
          execFilters.importRunId && `job=${execFilters.importRunId}`,
        ].filter(Boolean).join(', ') || 'current filters (not rolled back)';
        if (!confirm(`Rollback ALL matching open executions for this policy?\n\n${label}\n\nMax 2000 rows. This restores prior access from snapshots.`)) return;
        const btn = area.querySelector('#aig-rb-matching');
        if (btn) btn.disabled = true;
        try {
          const r = await api.rollbackMatchingAttendanceIgaExecutions({
            configId: selectedConfigId,
            q: execFilters.q || undefined,
            status: execFilters.status || undefined,
            rule: execFilters.rule || undefined,
            action: execFilters.action || undefined,
            from: execFilters.from || undefined,
            to: execFilters.to || undefined,
            importRunId: execFilters.importRunId || undefined,
            rolledBack: '0',
          });
          alert(`Rollback matching: ${r.rolledBack || 0} ok, ${r.failed || 0} failed (${r.requested || 0} requested)`);
          await loadExecutions();
          await loadStats();
        } catch (e) { alert(e.message); }
        finally { if (btn) btn.disabled = false; }
      });

      area.querySelector('#aig-exec-csv')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        try {
          const text = await file.text();
          if (!text.trim()) { alert('CSV is empty'); return; }
          if (!confirm(`Import CSV "${file.name}" and rollback matching executions for this policy?`)) return;
          const r = await api.csvRollbackAttendanceIgaExecutions({
            csv: text,
            configId: selectedConfigId,
          });
          alert(`CSV rollback: ${r.rolledBack || 0} ok, ${r.failed || 0} failed (${r.requested || 0} requested)`);
          await loadExecutions();
          await loadStats();
        } catch (e) { alert(e.message || 'CSV rollback failed'); }
      });

      area.querySelector('#aig-exec-export')?.addEventListener('click', async () => {
        const btn = area.querySelector('#aig-exec-export');
        const url = api.attendanceIgaExecutionsExportUrl({
          configId: selectedConfigId,
          q: execFilters.q || undefined,
          status: execFilters.status || undefined,
          rule: execFilters.rule || undefined,
          rolledBack: execFilters.rolledBack,
          action: execFilters.action || undefined,
          from: execFilters.from || undefined,
          to: execFilters.to || undefined,
          importRunId: execFilters.importRunId || undefined,
        });
        const filename = `attendance-iga-executions-${selectedConfigId}-${execFilters.from || 'all'}-${execFilters.to || 'all'}.csv`;
        if (btn) btn.disabled = true;
        try {
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
        } catch (e) { alert(e.message || 'Export failed'); }
        finally { if (btn) btn.disabled = false; }
      });

      area.querySelector('#aig-exec-filters')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        execFilters.q = String(fd.get('q') || '').trim();
        execFilters.from = String(fd.get('from') || '').trim();
        execFilters.to = String(fd.get('to') || '').trim();
        execFilters.status = String(fd.get('status') || '');
        execFilters.rule = String(fd.get('rule') || '');
        execFilters.action = String(fd.get('action') || '');
        execFilters.rolledBack = String(fd.get('rolledBack') || '');
        void loadExecutions();
      });
      area.querySelector('#aig-exec-clear')?.addEventListener('click', () => {
        execFilters.q = '';
        execFilters.from = '';
        execFilters.to = '';
        execFilters.status = '';
        execFilters.rule = '';
        execFilters.action = '';
        execFilters.rolledBack = '0';
        execFilters.importRunId = '';
        void loadExecutions();
      });

      area.querySelectorAll('.aig-rb').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Restore access from rollback snapshot?')) return;
          try { await api.rollbackAttendanceIgaExecution(btn.dataset.id); await loadExecutions(); await loadStats(); }
          catch (e) { alert(e.message); }
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  async function loadRollbacks() {
    const area = wrap.querySelector('#tab-rollbacks');
    area.innerHTML = loading();
    try {
      const hist = await api.attendanceIgaRollbacks(selectedConfigId);
      const rows = norm(hist);
      area.innerHTML = `
        <div class="aap-actions" style="margin-bottom:1rem">
          <div>
            <h3 class="section-title">Complete execution rollback</h3>
            <p class="subtitle">Rollback every matching execution for the active policy (by date / status / rule), or import a CSV of <code>execution_id</code> / <code>emp_id</code>.</p>
          </div>
        </div>
        <div class="card" style="margin-bottom:1rem;padding:1rem 1.15rem">
          <h4 style="margin:0 0 0.65rem;font-size:0.95rem">Rollback all matching</h4>
          <form id="aig-rb-all-form" style="display:flex;flex-wrap:wrap;gap:0.65rem;align-items:end">
            <div class="field" style="margin:0;min-width:140px">
              <label>From date</label>
              <input name="from" type="date" class="form-input" />
            </div>
            <div class="field" style="margin:0;min-width:140px">
              <label>To date</label>
              <input name="to" type="date" class="form-input" />
            </div>
            <div class="field" style="margin:0;min-width:130px">
              <label>Status</label>
              <select name="status" class="form-select">
                <option value="">All</option>
                <option value="SUCCESS">Success</option>
                <option value="PARTIAL" selected>Partial</option>
                <option value="FAILED">Failed</option>
              </select>
            </div>
            <div class="field" style="margin:0;min-width:160px">
              <label>Rule</label>
              <select name="rule" class="form-select">
                <option value="">All</option>
                <option value="NO_PUNCH_TODAY">NO_PUNCH_TODAY</option>
                <option value="NO_PUNCH_CONSECUTIVE">NO_PUNCH_CONSECUTIVE</option>
              </select>
            </div>
            <div class="field" style="margin:0;min-width:140px">
              <label>Action</label>
              <select name="action" class="form-select">
                <option value="">All</option>
                <option value="SUSPEND">Suspend</option>
                <option value="DISABLE">Disable</option>
                <option value="FAILED">Failed / partial</option>
              </select>
            </div>
            <button type="submit" class="btn btn-primary btn-sm">Rollback all matching</button>
          </form>
          <p class="muted" style="margin:0.65rem 0 0;font-size:0.78rem">Only rows not already rolled back. Cap 2000. Tip: set From/To to one day (e.g. Jul 30) to undo that batch.</p>
        </div>
        <div class="card" style="margin-bottom:1rem;padding:1rem 1.15rem">
          <h4 style="margin:0 0 0.5rem;font-size:0.95rem">CSV import rollback</h4>
          <p class="muted" style="margin:0 0 0.65rem;font-size:0.8rem">
            Columns: <code>execution_id</code>, <code>emp_id</code>, and/or <code>email</code> / <code>email_id</code> (header optional).
            Export from Executions includes <code>execution_id</code> + <code>email</code> — edit and re-import here.
          </p>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
            <label class="btn btn-secondary btn-sm" style="margin:0;cursor:pointer">
              Choose CSV file
              <input type="file" id="aig-rb-csv-file" accept=".csv,text/csv" style="display:none" />
            </label>
            <span class="muted" style="font-size:0.8rem" id="aig-rb-csv-name">No file chosen</span>
          </div>
          <textarea id="aig-rb-csv-text" class="form-input" rows="6" style="margin-top:0.75rem;font-family:ui-monospace,monospace;font-size:0.8rem"
            placeholder="execution_id,emp_id,email&#10;uuid-here,AD-6D24D77465E8,user@lenskart.com&#10;,,other@lenskart.com"></textarea>
          <div style="margin-top:0.65rem">
            <button type="button" class="btn btn-primary btn-sm" id="aig-rb-csv-run">Run CSV rollback</button>
          </div>
        </div>
        <div class="card" style="padding:1rem 1.15rem">
          <h4 style="margin:0 0 0.65rem;font-size:0.95rem">Recent rollback history</h4>
          <div class="table-wrap"><table><thead><tr>
            <th>When</th><th>Employee</th><th>Email</th><th>Rule</th><th>Execution</th><th>By</th>
          </tr></thead><tbody>
          ${rows.length ? rows.map((r) => `<tr>
            <td class="muted">${fmtDate(r.rolled_back_at)}</td>
            <td class="cell-strong">${esc(r.full_name || r.emp_id)}<div class="muted" style="font-size:0.72rem">${esc(r.emp_id)}</div></td>
            <td class="muted" style="font-size:0.8rem">${esc(r.email_corp || '—')}</td>
            <td><span class="badge badge-neutral">${esc(r.rule_key || '—')}</span></td>
            <td class="mono" style="font-size:0.72rem">${esc(String(r.execution_id || '').slice(0, 8))}…</td>
            <td class="muted">${esc(r.rolled_back_by || '—')}</td>
          </tr>`).join('') : '<tr><td colspan="6"><div class="empty-state"><p>No rollbacks recorded yet for this policy.</p></div></td></tr>'}
          </tbody></table></div>
        </div>`;

      area.querySelector('#aig-rb-all-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = {
          configId: selectedConfigId,
          from: String(fd.get('from') || '').trim() || undefined,
          to: String(fd.get('to') || '').trim() || undefined,
          status: String(fd.get('status') || '') || undefined,
          rule: String(fd.get('rule') || '') || undefined,
          action: String(fd.get('action') || '') || undefined,
          rolledBack: '0',
        };
        const tip = [payload.from && `from ${payload.from}`, payload.to && `to ${payload.to}`, payload.status && `status=${payload.status}`]
          .filter(Boolean).join(', ') || 'all not-rolled-back';
        if (!confirm(`Rollback ALL matching executions?\n\n${tip}\n\nMax 2000.`)) return;
        const btn = e.target.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const r = await api.rollbackMatchingAttendanceIgaExecutions(payload);
          alert(`Complete rollback: ${r.rolledBack || 0} ok, ${r.failed || 0} failed (${r.requested || 0} requested)`);
          await loadRollbacks();
          await loadStats();
        } catch (err) { alert(err.message); }
        finally { if (btn) btn.disabled = false; }
      });

      area.querySelector('#aig-rb-csv-file')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        const nameEl = area.querySelector('#aig-rb-csv-name');
        const ta = area.querySelector('#aig-rb-csv-text');
        if (!file) return;
        if (nameEl) nameEl.textContent = file.name;
        ta.value = await file.text();
      });

      area.querySelector('#aig-rb-csv-run')?.addEventListener('click', async () => {
        const ta = area.querySelector('#aig-rb-csv-text');
        const text = String(ta?.value || '').trim();
        if (!text) { alert('Paste CSV or choose a file first'); return; }
        if (!confirm('Run CSV rollback for this policy?')) return;
        const btn = area.querySelector('#aig-rb-csv-run');
        if (btn) btn.disabled = true;
        try {
          const r = await api.csvRollbackAttendanceIgaExecutions({ csv: text, configId: selectedConfigId });
          alert(`CSV rollback: ${r.rolledBack || 0} ok, ${r.failed || 0} failed (${r.requested || 0} requested)`);
          await loadRollbacks();
          await loadStats();
        } catch (err) { alert(err.message); }
        finally { if (btn) btn.disabled = false; }
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  async function showAigTab(name) {
    const tab = aigTabIds.includes(name) ? name : 'dash';
    wrap.querySelectorAll('.aig-tabs .cfg-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    aigTabIds.forEach((id) => {
      wrap.querySelector(`#tab-${id}`).style.display = id === tab ? '' : 'none';
    });
    syncAppUrl('attendanceIga', tab, 'dash');
    if (tab === 'dash') await loadDash();
    if (tab === 'policy') await loadPolicy();
    if (tab === 'config') await loadConfig();
    if (tab === 'exclusions') await loadGlobalExclusions();
    if (tab === 'imports') await loadImports();
    if (tab === 'approvals') await loadApprovals();
    if (tab === 'executions') await loadExecutions();
    if (tab === 'rollbacks') await loadRollbacks();
  }

  wrap.querySelectorAll('.aig-tabs .cfg-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => { void showAigTab(tabBtn.dataset.tab); });
  });

  async function runPipeline(source, label) {
    try {
      const r = await api.runAttendanceIga({ source, configId: selectedConfigId });
      alert(`${label}: ${r.status}\n${r.report?.successful ?? 0} records imported · ${r.executions ?? 0} actions · ${r.approvalsCreated ?? 0} approvals`);
      await loadStats(); await loadStatusBar(); await loadDash(); await loadImports();
    } catch (e) { alert(e.message); }
  }

  wrap.querySelector('#aig-run-api').addEventListener('click', () => runPipeline('REST_API', 'API import'));
  wrap.querySelector('#aig-run-sftp').addEventListener('click', () => runPipeline('SFTP', 'SFTP import'));
  wrap.querySelector('#aig-run-manual').addEventListener('click', async () => {
    try {
      const r = await api.runAttendanceIga({ source: 'MANUAL', emergencyMode: false, configId: selectedConfigId });
      alert(`Rule evaluation ${r.status}: ${r.evaluations} employees evaluated`);
      await loadStats(); await loadDash();
    } catch (e) { alert(e.message); }
  });

  wrap.querySelector('#aig-config-select').addEventListener('change', async (e) => {
    setSelectedConfig(e.target.value);
    await loadStatusBar(); await loadStats(); await loadDash();
    const activeTab = wrap.querySelector('.aig-tabs .cfg-tab.active')?.dataset.tab;
    if (activeTab === 'policy') await loadPolicy();
    if (activeTab === 'config') await loadConfig();
    if (activeTab === 'imports') await loadImports();
    if (activeTab === 'executions') await loadExecutions();
    if (activeTab === 'rollbacks') await loadRollbacks();
  });

  await refreshConfigList();
  await loadStatusBar();
  await loadStats();
  await showAigTab(startTab);
}
/* ---------- VPN / RADIUS ---------- */
export async function viewRadiusVpn(content, initialTab = 'overview') {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'clients', label: 'RADIUS clients' },
    { id: 'policies', label: 'Auth policies' },
    { id: 'vpn', label: 'VPN profiles' },
    { id: 'logs', label: 'Auth log' },
    { id: 'test', label: 'Test auth' },
  ];
  const valid = tabs.some((t) => t.id === initialTab) ? initialTab : 'overview';
  const wrap = el(`<div class="ent-page">
    ${header('VPN / RADIUS', 'Network AAA for VPN gateways — FreeRADIUS REST backend + optional UDP PAP listener')}
    <div class="inline-tabs" id="rad-tabs" style="margin-bottom:1rem">
      ${tabs.map((t) => `<button type="button" class="inline-tab${t.id === valid ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="rad-panel"><div class="loading-row"><span class="spinner"></span></div></div>
  </div>`);
  content.replaceChildren(wrap);
  const panel = wrap.querySelector('#rad-panel');
  let active = valid;

  wrap.querySelectorAll('#rad-tabs .inline-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      active = btn.dataset.tab;
      wrap.querySelectorAll('#rad-tabs .inline-tab').forEach((b) => b.classList.toggle('active', b === btn));
      syncAppUrl('radiusVpn', active, 'overview');
      void load();
    });
  });

  async function load() {
    panel.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      if (active === 'overview') await loadOverview();
      else if (active === 'clients') await loadClients();
      else if (active === 'policies') await loadPolicies();
      else if (active === 'vpn') await loadVpn();
      else if (active === 'logs') await loadLogs();
      else await loadTest();
    } catch (err) {
      panel.innerHTML = errHtml(err.message);
    }
  }

  async function loadOverview() {
    const r = await api.radiusOverview();
    const d = r.data || {};
    panel.innerHTML = `
      <div class="stat-grid" style="margin-bottom:1rem">
        <div class="stat-card"><div class="stat-label">RADIUS clients</div><div class="stat-value">${esc(String(d.activeClients ?? 0))}</div></div>
        <div class="stat-card"><div class="stat-label">Auth policies</div><div class="stat-value">${esc(String(d.activePolicies ?? 0))}</div></div>
        <div class="stat-card"><div class="stat-label">VPN profiles</div><div class="stat-value">${esc(String(d.activeVpnProfiles ?? 0))}</div></div>
        <div class="stat-card"><div class="stat-label">Accepts (24h)</div><div class="stat-value">${esc(String(d.accepts24h ?? 0))}</div></div>
        <div class="stat-card"><div class="stat-label">Rejects (24h)</div><div class="stat-value">${esc(String(d.rejects24h ?? 0))}</div></div>
      </div>
      <div class="card">
        <h2>Integration</h2>
        <p class="subtitle">Point FreeRADIUS <code>rlm_rest</code> (or the VPN NAS) at this IdP. Shared secrets are stored encrypted.</p>
        <ul style="margin:0.75rem 0 0;padding-left:1.25rem;line-height:1.6">
          <li><strong>REST</strong> — <code>POST ${esc(d.restEndpoint || '/api/internal/radius/authenticate')}</code> with header <code>X-Internal-Token</code></li>
          <li><strong>UDP</strong> — ${d.udpEnabled ? `listening on port <code>${esc(String(d.udpPort))}</code> (PAP Access-Request)` : 'disabled — set <code>RADIUS_UDP_ENABLED=true</code> in .env'}</li>
          <li><strong>MFA</strong> — enable on a policy; users append TOTP (<code>password\\123456</code> or trailing 6 digits)</li>
        </ul>
        <pre style="margin-top:1rem;padding:0.85rem;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);overflow:auto;font-size:0.78rem"># FreeRADIUS mods-available/rest (excerpt)
url = "https://idp.lenskart.com/api/internal/radius/authenticate"
body = '{"username":"%{User-Name}","password":"%{User-Password}","nasIp":"%{NAS-IP-Address}","callingStationId":"%{Calling-Station-Id}"}'
header = "Content-Type: application/json"
header = "X-Internal-Token: &lt;INTERNAL_TOKEN&gt;"</pre>
      </div>`;
  }

  async function loadClients() {
    const r = await api.radiusClients();
    const rows = r.data || [];
    panel.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">
        <button type="button" class="btn btn-primary" id="rad-client-add">+ Add client</button>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>NAS IP / CIDR</th><th>Type</th><th>Vendor</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cell-strong">${esc(row.name)}</td>
          <td><code>${esc(row.nas_ip)}</code></td>
          <td>${esc(row.client_type)}</td>
          <td class="muted">${esc(row.vendor || '—')}</td>
          <td>${row.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td style="white-space:nowrap">
            <button type="button" class="btn btn-sm btn-secondary rad-reveal" data-id="${esc(row.id)}">Reveal secret</button>
            <button type="button" class="btn btn-sm btn-secondary rad-edit" data-id="${esc(row.id)}">Edit</button>
            <button type="button" class="btn btn-sm btn-danger rad-del" data-id="${esc(row.id)}">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table></div>` : `<div class="card empty-state">No RADIUS clients yet — add your VPN gateway NAS IP</div>`}`;

    panel.querySelector('#rad-client-add')?.addEventListener('click', () => openClientModal());
    panel.querySelectorAll('.rad-edit').forEach((btn) => {
      const row = rows.find((x) => x.id === btn.dataset.id);
      btn.addEventListener('click', () => openClientModal(row));
    });
    panel.querySelectorAll('.rad-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this RADIUS client?')) return;
        await api.deleteRadiusClient(btn.dataset.id);
        await loadClients();
      });
    });
    panel.querySelectorAll('.rad-reveal').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const s = await api.revealRadiusSecret(btn.dataset.id);
          alert(`Shared secret:\n${s.secret}`);
        } catch (e) { alert(e.message); }
      });
    });
  }

  function openClientModal(row = null) {
    const bd = openModal(`<div class="modal" style="max-width:520px">
      <div class="modal-header"><h2>${row ? 'Edit' : 'Add'} RADIUS client</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Name</label>
          <input class="form-input" id="rc-name" value="${esc(row?.name || '')}"></div>
        <div class="form-group"><label class="form-label">NAS IP or CIDR</label>
          <input class="form-input" id="rc-nas" placeholder="10.0.0.5 or 10.0.0.0/24" value="${esc(row?.nas_ip || '')}"></div>
        <div class="form-group"><label class="form-label">Shared secret${row ? ' (leave blank to keep)' : ''}</label>
          <input class="form-input" id="rc-secret" type="password" autocomplete="new-password"></div>
        <div class="form-row-2">
          <div class="form-group"><label class="form-label">Type</label>
            <select class="form-select" id="rc-type">
              ${['VPN','WIRELESS','SWITCH','OTHER'].map((t) => `<option ${row?.client_type===t?'selected':''}>${t}</option>`).join('')}
            </select></div>
          <div class="form-group"><label class="form-label">Vendor</label>
            <select class="form-select" id="rc-vendor">
              ${[['','—'],['cisco_anyconnect','Cisco AnyConnect'],['globalprotect','Palo Alto GlobalProtect'],['fortinet','FortiClient'],['openvpn','OpenVPN'],['other','Other']].map(([v,l]) =>
                `<option value="${v}" ${((row?.vendor||'')===v)?'selected':''}>${l}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-group"><label class="form-label">Description</label>
          <input class="form-input" id="rc-desc" value="${esc(row?.description || '')}"></div>
        <div id="rc-msg"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="rc-save">Save</button>
        <button class="btn btn-secondary" id="rc-cancel">Cancel</button>
      </div>
    </div>`);
    bd.querySelector('#rc-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#rc-save').addEventListener('click', async () => {
      const payload = {
        name: bd.querySelector('#rc-name').value.trim(),
        nasIp: bd.querySelector('#rc-nas').value.trim(),
        clientType: bd.querySelector('#rc-type').value,
        vendor: bd.querySelector('#rc-vendor').value || null,
        description: bd.querySelector('#rc-desc').value.trim() || null,
      };
      const secret = bd.querySelector('#rc-secret').value;
      if (secret) payload.sharedSecret = secret;
      try {
        if (row) await api.updateRadiusClient(row.id, payload);
        else {
          if (!payload.sharedSecret) throw new Error('Shared secret required');
          await api.createRadiusClient(payload);
        }
        bd.remove();
        await loadClients();
      } catch (e) {
        bd.querySelector('#rc-msg').innerHTML = errHtml(e.message);
      }
    });
  }

  async function loadPolicies() {
    const r = await api.radiusPolicies();
    const rows = r.data || [];
    panel.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">
        <button type="button" class="btn btn-primary" id="rad-pol-add">+ Add policy</button>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Priority</th><th>Name</th><th>Scope</th><th>MFA</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td>${row.priority}</td>
          <td class="cell-strong">${esc(row.name)}<br><span class="muted" style="font-size:0.75rem">${esc(row.description || '')}</span></td>
          <td>${esc(row.client_type)}${row.vendor ? ` · ${esc(row.vendor)}` : ''}</td>
          <td>${row.require_mfa ? 'OTP append' : (row.require_mfa_enrolled ? 'Enrolled' : '—')}</td>
          <td>${row.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button type="button" class="btn btn-sm btn-secondary rad-pol-edit" data-id="${esc(row.id)}">Edit</button>
            <button type="button" class="btn btn-sm btn-danger rad-pol-del" data-id="${esc(row.id)}">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table></div>` : `<div class="card empty-state">No policies</div>`}`;

    panel.querySelector('#rad-pol-add')?.addEventListener('click', () => openPolicyModal());
    panel.querySelectorAll('.rad-pol-edit').forEach((btn) => {
      const row = rows.find((x) => x.id === btn.dataset.id);
      btn.addEventListener('click', () => openPolicyModal(row));
    });
    panel.querySelectorAll('.rad-pol-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this policy?')) return;
        await api.deleteRadiusPolicy(btn.dataset.id);
        await loadPolicies();
      });
    });
  }

  function openPolicyModal(row = null) {
    let reply = row?.reply_attributes;
    if (typeof reply === 'string') {
      try { reply = JSON.parse(reply); } catch { reply = {}; }
    }
    const replyText = reply && typeof reply === 'object'
      ? Object.entries(reply).map(([k, v]) => `${k}=${v}`).join('\n')
      : 'Session-Timeout=28800\nFilter-Id=vpn-users';
    const bd = openModal(`<div class="modal" style="max-width:560px">
      <div class="modal-header"><h2>${row ? 'Edit' : 'Add'} auth policy</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Name</label>
          <input class="form-input" id="rp-name" value="${esc(row?.name || '')}"></div>
        <div class="form-group"><label class="form-label">Description</label>
          <input class="form-input" id="rp-desc" value="${esc(row?.description || '')}"></div>
        <div class="form-row-2">
          <div class="form-group"><label class="form-label">Priority</label>
            <input type="number" class="form-input" id="rp-pri" value="${esc(String(row?.priority ?? 100))}"></div>
          <div class="form-group"><label class="form-label">Client type</label>
            <select class="form-select" id="rp-type">
              ${['ANY','VPN','WIRELESS','SWITCH','OTHER'].map((t) => `<option ${((row?.client_type||'ANY')===t)?'selected':''}>${t}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-group" style="margin-top:0.25rem">
          <label class="form-check-row" for="rp-mfa">
            <input type="checkbox" class="form-check" id="rp-mfa" ${row?.require_mfa ? 'checked' : ''}>
            Require MFA (password + TOTP)
          </label>
          <label class="form-check-row" for="rp-enroll">
            <input type="checkbox" class="form-check" id="rp-enroll" ${row?.require_mfa_enrolled ? 'checked' : ''}>
            Require MFA enrolled
          </label>
        </div>
        <div class="form-group"><label class="form-label">Reply attributes (one KEY=value per line)</label>
          <textarea class="form-input" id="rp-reply" rows="4">${esc(replyText)}</textarea></div>
        <div id="rp-msg"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="rp-save">Save</button>
        <button class="btn btn-secondary" id="rp-cancel">Cancel</button>
      </div>
    </div>`);
    bd.querySelector('#rp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#rp-save').addEventListener('click', async () => {
      const replyAttributes = {};
      bd.querySelector('#rp-reply').value.split('\n').forEach((line) => {
        const m = line.trim().match(/^([^=]+)=(.*)$/);
        if (m) replyAttributes[m[1].trim()] = m[2].trim();
      });
      const payload = {
        name: bd.querySelector('#rp-name').value.trim(),
        description: bd.querySelector('#rp-desc').value.trim() || null,
        priority: Number(bd.querySelector('#rp-pri').value) || 100,
        clientType: bd.querySelector('#rp-type').value,
        requireMfa: bd.querySelector('#rp-mfa').checked,
        requireMfaEnrolled: bd.querySelector('#rp-enroll').checked,
        replyAttributes,
      };
      try {
        if (row) await api.updateRadiusPolicy(row.id, payload);
        else await api.createRadiusPolicy(payload);
        bd.remove();
        await loadPolicies();
      } catch (e) {
        bd.querySelector('#rp-msg').innerHTML = errHtml(e.message);
      }
    });
  }

  async function loadVpn() {
    const [vr, cr, pr] = await Promise.all([api.vpnProfiles(), api.radiusClients(), api.radiusPolicies()]);
    const rows = vr.data || [];
    const clients = cr.data || [];
    const policies = pr.data || [];
    panel.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">
        <button type="button" class="btn btn-primary" id="rad-vpn-add">+ Add VPN profile</button>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Vendor</th><th>Gateway</th><th>RADIUS client</th><th>Policy</th><th></th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cell-strong">${esc(row.name)}<br><span class="muted" style="font-size:0.75rem">${esc(row.slug)}</span></td>
          <td>${esc(row.vendor)}</td>
          <td class="muted">${esc(row.connection_hint || '—')}</td>
          <td class="muted">${esc(row.radius_client_name || '—')}</td>
          <td class="muted">${esc(row.policy_name || '—')}</td>
          <td>
            <button type="button" class="btn btn-sm btn-secondary rad-vpn-edit" data-id="${esc(row.id)}">Edit</button>
            <button type="button" class="btn btn-sm btn-danger rad-vpn-del" data-id="${esc(row.id)}">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table></div>` : `<div class="card empty-state">No VPN profiles — document AnyConnect / GlobalProtect gateways here</div>`}`;

    const openVpn = (row = null) => {
      const bd = openModal(`<div class="modal" style="max-width:560px">
        <div class="modal-header"><h2>${row ? 'Edit' : 'Add'} VPN profile</h2></div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">Name</label>
            <input class="form-input" id="vp-name" value="${esc(row?.name || '')}"></div>
          <div class="form-group"><label class="form-label">Slug</label>
            <input class="form-input" id="vp-slug" value="${esc(row?.slug || '')}" placeholder="corp-vpn"></div>
          <div class="form-row-2">
            <div class="form-group"><label class="form-label">Vendor</label>
              <select class="form-select" id="vp-vendor">
                ${['cisco_anyconnect','globalprotect','fortinet','openvpn','other'].map((v) =>
                  `<option value="${v}" ${(row?.vendor||'other')===v?'selected':''}>${v}</option>`).join('')}
              </select></div>
            <div class="form-group"><label class="form-label">Gateway / portal</label>
              <input class="form-input" id="vp-hint" value="${esc(row?.connection_hint || '')}" placeholder="vpn.lenskart.com"></div>
          </div>
          <div class="form-group"><label class="form-label">RADIUS client</label>
            <select class="form-select" id="vp-client">
              <option value="">—</option>
              ${clients.map((c) => `<option value="${esc(c.id)}" ${row?.radius_client_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
            </select></div>
          <div class="form-group"><label class="form-label">Auth policy</label>
            <select class="form-select" id="vp-pol">
              <option value="">—</option>
              ${policies.map((p) => `<option value="${esc(p.id)}" ${row?.policy_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="form-group"><label class="form-label">Instructions</label>
            <textarea class="form-input" id="vp-inst" rows="3">${esc(row?.instructions || '')}</textarea></div>
          <div id="vp-msg"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="vp-save">Save</button>
          <button class="btn btn-secondary" id="vp-cancel">Cancel</button>
        </div>
      </div>`);
      bd.querySelector('#vp-cancel').addEventListener('click', () => bd.remove());
      bd.querySelector('#vp-save').addEventListener('click', async () => {
        const payload = {
          name: bd.querySelector('#vp-name').value.trim(),
          slug: bd.querySelector('#vp-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          vendor: bd.querySelector('#vp-vendor').value,
          connectionHint: bd.querySelector('#vp-hint').value.trim() || null,
          radiusClientId: bd.querySelector('#vp-client').value || null,
          policyId: bd.querySelector('#vp-pol').value || null,
          instructions: bd.querySelector('#vp-inst').value.trim() || null,
        };
        try {
          if (row) await api.updateVpnProfile(row.id, payload);
          else await api.createVpnProfile(payload);
          bd.remove();
          await loadVpn();
        } catch (e) {
          bd.querySelector('#vp-msg').innerHTML = errHtml(e.message);
        }
      });
    };

    panel.querySelector('#rad-vpn-add')?.addEventListener('click', () => openVpn());
    panel.querySelectorAll('.rad-vpn-edit').forEach((btn) => {
      const row = rows.find((x) => x.id === btn.dataset.id);
      btn.addEventListener('click', () => openVpn(row));
    });
    panel.querySelectorAll('.rad-vpn-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this VPN profile?')) return;
        await api.deleteVpnProfile(btn.dataset.id);
        await loadVpn();
      });
    });
  }

  async function loadLogs() {
    const r = await api.radiusLogs({ limit: '100' });
    const rows = r.data || [];
    panel.innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Time</th><th>Result</th><th>User</th><th>NAS</th><th>Protocol</th><th>Reason</th></tr></thead>
          <tbody>${rows.map((row) => `<tr>
            <td class="muted">${fmtDate(row.ts)}</td>
            <td><span class="badge badge-${row.result === 'ACCEPT' ? 'success' : 'danger'}">${esc(row.result)}</span></td>
            <td>${esc(row.username)}${row.emp_id ? `<br><span class="muted" style="font-size:0.75rem">${esc(row.emp_id)}</span>` : ''}</td>
            <td class="muted">${esc(row.nas_ip || '—')}</td>
            <td class="muted">${esc(row.protocol)}</td>
            <td class="muted">${esc(row.reason || '—')}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state">No RADIUS auth attempts yet</div>`;
  }

  async function loadTest() {
    panel.innerHTML = `<div class="card" style="max-width:480px">
      <h2>Test authentication</h2>
      <p class="subtitle">Runs the same path as FreeRADIUS / UDP (logged to auth log)</p>
      <div class="form-group"><label class="form-label">Username (email)</label>
        <input class="form-input" id="rt-user" autocomplete="username"></div>
      <div class="form-group"><label class="form-label">Password (+ OTP if policy requires)</label>
        <input class="form-input" id="rt-pass" type="password" autocomplete="current-password"></div>
      <div class="form-group"><label class="form-label">NAS IP (optional)</label>
        <input class="form-input" id="rt-nas" placeholder="10.0.0.5"></div>
      <button type="button" class="btn btn-primary" id="rt-go">Authenticate</button>
      <div id="rt-out" style="margin-top:1rem"></div>
    </div>`;
    panel.querySelector('#rt-go').addEventListener('click', async () => {
      const out = panel.querySelector('#rt-out');
      out.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
      try {
        const r = await api.radiusTestAuth({
          username: panel.querySelector('#rt-user').value.trim(),
          password: panel.querySelector('#rt-pass').value,
          nasIp: panel.querySelector('#rt-nas').value.trim() || undefined,
        });
        const d = r.data || {};
        out.innerHTML = `<div class="alert alert-${d.result === 'ACCEPT' ? 'success' : 'error'}">
          <strong>${esc(d.result)}</strong>${d.reason ? ` — ${esc(d.reason)}` : ''}
          ${d.empId ? `<br>empId: ${esc(d.empId)}` : ''}
          ${d.reply ? `<pre style="margin:0.5rem 0 0;font-size:0.8rem">${esc(JSON.stringify(d.reply, null, 2))}</pre>` : ''}
        </div>`;
      } catch (e) {
        out.innerHTML = errHtml(e.message);
      }
    });
  }

  await load();
}
