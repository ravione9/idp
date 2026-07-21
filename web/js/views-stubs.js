import { api } from './api.js';
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
  bd.addEventListener('click', (e) => { if (e.target === bd) bd.remove(); });
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
            <input class="form-input" id="gm-emp" placeholder="Or enter Employee ID" style="width:160px">
            <button class="btn btn-primary" id="gm-add">Add</button>
          </div>
          <div id="gm-pick" style="margin-top:0.5rem"></div>
        </div>`}
        <div id="gm-err"></div>
      </div><div class="modal-footer"><button class="btn btn-secondary" id="gm-close">Close</button></div></div>`);

    async function loadMembers() {
      try {
        const g = await api.getGroup(groupId);
        const members = g.members || [];
        const rows = members.length ? members.map(m => `
          <tr>
            <td class="cell-strong">${esc(m.full_name || m.emp_id)}</td>
            <td class="muted">${esc(m.email_corp || '—')}</td>
            <td class="muted">${esc(m.emp_id)}</td>
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
            pick.innerHTML = users.length ? users.map(u => `
              <button type="button" class="btn btn-sm btn-secondary gm-pick" style="margin:0.25rem 0.25rem 0 0"
                data-emp="${esc(u.emp_id)}" data-label="${esc(u.full_name || u.emp_id)}">
                ${esc(u.full_name || u.emp_id)} <span class="muted">(${esc(u.email_corp || u.emp_id)})</span>
              </button>`).join('') : '<span class="muted">No users found</span>';
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
          await loadMembers(); await load();
        } catch (e) { bd.querySelector('#gm-err').innerHTML = errHtml(e.message); }
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
        <p class="muted" style="font-size:0.85rem;margin:0 0 0.75rem">Configure <strong>Sync Groups</strong> on your Google or AD connector (Connections → Directory Sync), then click <strong>Sync from Directory</strong>.</p>
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

  const methods = [
    { key: 'totp',         label: 'Authenticator App (TOTP)', badge: 'badge-success', badgeText: '● Live',   desc: 'Time-based one-time passwords via Google Authenticator, Authy, etc.' },
    { key: 'backup_codes', label: 'Backup Codes',             badge: 'badge-success', badgeText: '● Live',   desc: 'Single-use emergency recovery codes.' },
    { key: 'webauthn',     label: 'WebAuthn / Passkeys',      badge: 'badge-warning', badgeText: '○ Planned', desc: 'Hardware security keys and biometric passkeys (schema only today).' },
    { key: 'email_otp',    label: 'Email OTP',                badge: 'badge-warning', badgeText: '○ Planned',desc: 'One-time code sent to registered email address.' },
    { key: 'sms_otp',      label: 'SMS OTP',                  badge: 'badge-warning', badgeText: '○ Planned',desc: 'One-time code sent via SMS.' },
  ];

  async function loadMfaPage() {
    try {
      const [status, policyRes, groupsRes] = await Promise.all([
        api.mfaStatus().catch(() => ({})),
        api.getMfaPolicy().catch(() => ({ data: {} })),
        api.listGroups().catch(() => ({ data: [] })),
      ]);
      const policy = policyRes?.data || {};
      const groups = norm(groupsRes);
      const enrolled = status?.methods || [];
      const liveOrSchemaCount = methods.filter(m => m.badge === 'badge-success').length;
      const enrolledCount = enrolled.length;
      const globalEnforce = !!policy['global_enforce'];
      const enforceAdmins = policy['enforce_for_admins'] !== false;
      const gracePeriod   = policy['grace_period_hours'] ?? 24;
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
      const excludedGroupSet = new Set(excludedGroupIds);
      const groupRows = groups.length
        ? groups.map((g) => `
          <label class="mfa-exclude-row" data-label="${esc(String(g.name || g.id).toLowerCase())}"
            style="display:flex;align-items:center;gap:0.55rem;padding:0.45rem 0.55rem;border-bottom:1px solid var(--border);cursor:pointer">
            <input type="checkbox" class="mfa-exclude-group" value="${esc(String(g.id))}" ${excludedGroupSet.has(String(g.id)) ? 'checked' : ''}>
            <span style="font-size:0.85rem">${esc(g.name || g.id)}</span>
            <span class="muted" style="margin-left:auto;font-size:0.75rem">${esc(g.source_system || 'LOCAL')}</span>
          </label>`).join('')
        : `<div class="muted" style="padding:0.55rem;font-size:0.82rem">No groups found. Create/sync groups first in Identity → Groups.</div>`;

      const cards = methods.map(m => `
        <div class="card" style="position:relative">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
            <strong>${esc(m.label)}</strong>
            <span class="badge ${m.badge}">${m.badgeText}</span>
          </div>
          <p class="muted" style="font-size:0.875rem;margin-bottom:0.75rem">${esc(m.desc)}</p>
          ${enrolled.includes(m.key)
            ? '<span class="badge badge-success">● Enrolled</span>'
            : '<span class="badge badge-neutral">Not enrolled</span>'}
        </div>`).join('');

      wrap.querySelector('#mfa-area').innerHTML = `
        <!-- ── Stats ── -->
        <div class="stat-grid" style="margin-bottom:1.5rem">
          ${statCard('shieldCheck', 'Methods Enrolled',   enrolledCount,      status?.enabled ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Not active</span>', 'primary')}
          ${statCard('check',       'Live / Schema',      liveOrSchemaCount,  'available now',            'success')}
          ${statCard('bolt',        'Planned',            3,                  'arriving in next milestone','warning')}
          ${statCard('shield',      'Global Enforce',     globalEnforce ? 'ON' : 'OFF', globalEnforce ? '<span class="badge badge-danger">MFA required for all</span>' : '<span class="badge badge-neutral">Off</span>', globalEnforce ? 'danger' : 'primary')}
        </div>

        <!-- ── Method cards ── -->
        <div class="section-title">Available Methods</div>
        <div class="grid-3" style="margin-bottom:1.5rem">${cards}</div>

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
              <label class="form-label" style="font-weight:600">Always Enforce for Admins</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Admins and Super-Admins always require MFA.</p>
              <select class="form-select" id="policy-admins">
                <option value="1" ${enforceAdmins?'selected':''}>Yes — admins must always have MFA</option>
                <option value="0" ${!enforceAdmins?'selected':''}>No — follow global policy only</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" style="font-weight:600">Grace Period (hours)</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Allow login without MFA for this many hours after enforcement begins.</p>
              <input class="form-input" type="number" id="policy-grace" value="${esc(String(gracePeriod))}" min="0" max="168" />
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label" style="font-weight:600">Exclude Groups from Policy MFA</label>
              <p class="muted" style="font-size:0.8rem;margin-bottom:0.4rem">Members of selected groups are excluded from global/admin MFA policy. Per-user enforce still applies.</p>
              <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;margin-bottom:0.45rem;flex-wrap:wrap">
                <input class="form-input" id="policy-exclude-search" placeholder="Search groups..." style="max-width:260px" />
                <span class="muted" style="font-size:0.78rem"><span id="policy-exclude-count">0</span> groups selected</span>
              </div>
              <div id="policy-exclude-list" style="border:1px solid var(--border);border-radius:8px;max-height:210px;overflow:auto;background:var(--surface-2)">
                ${groupRows}
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
        </div>`;

      const excludeSearchEl = wrap.querySelector('#policy-exclude-search');
      const excludeRows = Array.from(wrap.querySelectorAll('.mfa-exclude-row'));
      const excludeChecks = Array.from(wrap.querySelectorAll('.mfa-exclude-group'));
      const excludeCountEl = wrap.querySelector('#policy-exclude-count');

      function updateExcludeCount() {
        if (!excludeCountEl) return;
        excludeCountEl.textContent = String(excludeChecks.filter((cb) => cb.checked).length);
      }
      excludeChecks.forEach((cb) => cb.addEventListener('change', updateExcludeCount));
      excludeSearchEl?.addEventListener('input', () => {
        const q = excludeSearchEl.value.trim().toLowerCase();
        excludeRows.forEach((row) => {
          const label = (row.dataset.label || '').toLowerCase();
          row.style.display = (!q || label.includes(q)) ? 'flex' : 'none';
        });
      });
      updateExcludeCount();

      // ── Save policy ────────────────────────────────────────────────────────
      wrap.querySelector('#save-policy-btn').addEventListener('click', async () => {
        const msg = wrap.querySelector('#policy-msg');
        msg.innerHTML = '';
        const excludedGroups = Array
          .from(wrap.querySelectorAll('.mfa-exclude-group:checked'))
          .map((n) => n.value);
        try {
          await api.updateMfaPolicy({
            global_enforce:     parseInt(wrap.querySelector('#policy-global').value) === 1,
            enforce_for_admins: parseInt(wrap.querySelector('#policy-admins').value) === 1,
            grace_period_hours: parseInt(wrap.querySelector('#policy-grace').value) || 24,
            excluded_group_ids: excludedGroups,
          });
          msg.innerHTML = `<div class="alert alert-success">Policy saved successfully.</div>`;
          await loadMfaPage();
        } catch (e) { msg.innerHTML = errHtml(e.message); }
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
          await api.adminMfaDisable(selectedUser.emp_id);
          await api.adminMfaEnforce(selectedUser.emp_id, true);
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
  _app('custom-oidc',    'Custom OIDC App',        null,                  'Custom',          _O, 'Register any application that supports OpenID Connect / OAuth 2.0.', ['openid','email','profile'], ['authorization_code','refresh_token']),
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

  const initial = {
    name:           app.name,
    catalog_slug:   app.id,
    category:       app.cat,
    redirectsRaw:   '',
    grants:         [...(app.grants || ['authorization_code'])],
    scopes:         [...(app.scopes || ['openid', 'email', 'profile'])],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
  };

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
            <strong>How this works</strong>
            <ol class="wiz-tip-list">
              <li>Copy the <strong>IdP OIDC endpoints</strong> from step 2 into ${esc(app.name)}'s OAuth / OIDC settings.</li>
              <li>Paste the <strong>redirect URIs</strong> that ${esc(app.name)} gives you into step 3.</li>
              <li>Click <strong>Register</strong> — this IdP <em>auto-generates</em> a <strong>Client ID</strong> and <strong>Client Secret</strong>. Copy both into ${esc(app.name)}; the secret is shown <strong>once</strong>.</li>
            </ol>
          </div>
          <h3 style="font-size:0.95rem;margin:1.25rem 0 0.5rem">Vendor setup steps</h3>
          <ol class="wiz-tip-list">
            ${tips.setupSteps.map((s) => `<li>${s}</li>`).join('')}
          </ol>
          ${tips.docsUrl ? `<p style="font-size:0.85rem;margin-top:1rem"><a href="${esc(tips.docsUrl)}" target="_blank" rel="noopener">Open ${esc(app.name)} OIDC documentation →</a></p>` : ''}
        `,
      },
      {
        id: 'idp', label: 'IdP Details',
        render: () => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
            Open <strong>${esc(app.name)}</strong>'s OAuth / OpenID Connect settings and paste these IdP values.
            Most apps accept the <strong>Discovery URL</strong> alone and fetch the rest automatically.
          </p>
          <div class="alert alert-success" style="margin-bottom:1rem;font-size:0.85rem">
            OIDC issuer is <strong>live</strong> — authorization code + PKCE, token, refresh, UserInfo, and JWKS.
          </div>
          <div class="form-group">
            <label class="form-label">Issuer</label>
            ${readonlyInput(idpIssuer, 'oidc-iss')}
          </div>
          <div class="form-group">
            <label class="form-label">OpenID Discovery URL <span class="muted" style="font-weight:400;font-size:0.78rem">(recommended — paste once)</span></label>
            ${readonlyInput(idpDiscovery, 'oidc-disc')}
          </div>
          <div class="form-group">
            <label class="form-label">Authorization Endpoint</label>
            ${readonlyInput(idpAuthorize, 'oidc-authz')}
          </div>
          <div class="form-group">
            <label class="form-label">Token Endpoint</label>
            ${readonlyInput(idpToken, 'oidc-token')}
          </div>
          <div class="form-group">
            <label class="form-label">UserInfo Endpoint</label>
            ${readonlyInput(idpUserinfo, 'oidc-userinfo')}
          </div>
          <div class="form-group">
            <label class="form-label">JWKS URI</label>
            ${readonlyInput(idpJwks, 'oidc-jwks')}
          </div>
        `,
      },
      {
        id: 'redirects', label: 'Redirect URIs',
        render: (d) => `
          <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
            One per line. ${esc(app.name)} will send users to one of these URLs after they authenticate.
          </p>
          <div class="form-group">
            <label class="form-label">Allowed Redirect URIs <span style="color:var(--danger)">*</span></label>
            <textarea class="form-textarea" id="w-uris" rows="5" placeholder="https://app.example.com/callback&#10;https://app.example.com/auth/callback">${esc(d.redirectsRaw || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Display Name</label>
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
              The defaults work for most apps. Adjust if ${esc(app.name)}'s docs require something different.
            </p>
            <div class="form-2col">
              <div class="form-group">
                <label class="form-label">Grant Types</label>
                <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-code" ${grant('authorization_code')}><label for="gt-code">authorization_code</label></div>
                <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-refresh" ${grant('refresh_token')}><label for="gt-refresh">refresh_token</label></div>
                <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-creds" ${grant('client_credentials')}><label for="gt-creds">client_credentials</label></div>
              </div>
              <div class="form-group">
                <label class="form-label">Scopes</label>
                ${['openid','email','profile','groups','roles'].map((s) => `
                  <div class="form-check-row"><input type="checkbox" class="form-check" id="sc-${s}" ${scope(s)}><label for="sc-${s}">${esc(s)}</label></div>
                `).join('')}
              </div>
              <div class="form-group span2">
                <label class="form-label">Token Endpoint Auth Method</label>
                <select class="form-select" id="w-tea">
                  <option value="client_secret_basic">client_secret_basic (recommended)</option>
                  <option value="client_secret_post">client_secret_post</option>
                  <option value="none">none (public clients / PKCE)</option>
                </select>
              </div>
            </div>
          `;
        },
        bind: (body, d) => {
          body.querySelector('#w-tea').value = d.token_endpoint_auth_method;
        },
        validate: (_d, body) => {
          const grants = ['gt-code','gt-refresh','gt-creds']
            .filter((id) => body.querySelector('#' + id).checked);
          if (!grants.length) return 'Select at least one grant type.';
          return null;
        },
        collect: (d, body) => {
          d.grants = [];
          if (body.querySelector('#gt-code').checked)    d.grants.push('authorization_code');
          if (body.querySelector('#gt-refresh').checked) d.grants.push('refresh_token');
          if (body.querySelector('#gt-creds').checked)   d.grants.push('client_credentials');
          d.scopes = ['openid','email','profile','groups','roles']
            .filter((s) => body.querySelector('#sc-' + s).checked);
          d.token_endpoint_auth_method = body.querySelector('#w-tea').value;
        },
      },
      {
        id: 'review', label: 'Activate',
        finishLabel: '✓ Register & Reveal Secret',
        render: (d) => {
          const uris = (d.redirectsRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
          return `
            <p class="muted" style="font-size:0.85rem;margin-bottom:1rem">
              Review the values below. Clicking <strong>Register</strong> creates the client in this IdP and
              <strong>auto-generates</strong> a Client ID and Client Secret (shown on the next screen only).
            </p>
            <div class="card">
              <div class="kv"><div class="k">Name</div><div class="v">${esc(d.name)}</div></div>
              <div class="kv"><div class="k">Redirect URIs</div><div class="v" style="word-break:break-all">${uris.map((u) => `<code style="font-size:0.78rem;display:block">${esc(u)}</code>`).join('')}</div></div>
              <div class="kv"><div class="k">Grant Types</div><div class="v">${d.grants.map((g) => `<span class="badge badge-info" style="margin-right:0.25rem">${esc(g)}</span>`).join('')}</div></div>
              <div class="kv"><div class="k">Scopes</div><div class="v">${d.scopes.map((s) => `<span class="badge badge-neutral" style="margin-right:0.25rem">${esc(s)}</span>`).join('')}</div></div>
              <div class="kv"><div class="k">Token Auth</div><div class="v"><code>${esc(d.token_endpoint_auth_method)}</code></div></div>
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
          <h3>${esc(d.name)} is registered</h3>
          <p class="muted">Copy the credentials below — the secret will <strong>not</strong> be shown again.</p>
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
  const actionBtn = `<button class="btn btn-primary" id="new-oidc-btn">+ Register Custom App</button>`;
  content.replaceChildren(el(`<div>
    ${embed
      ? `<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">${actionBtn}</div>`
      : header('OIDC / OAuth Applications',
        'OAuth 2.0 and OpenID Connect — registered clients and pre-built integrations',
        actionBtn)}

    <!-- ── Registered Clients ───────────────────────────────────────────── -->
    <div id="list-area" style="margin-bottom:2.5rem">${loading()}</div>

  </div>`));
  const wrap = content.firstChild;

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

  // ── My Applications tab ────────────────────────────────────────────────────
  async function load() {
    try {
      const r = await api.listOidcClients();
      // Backend returns { data: [...] } — normalise
      const clients = Array.isArray(r) ? r : (r && r.data ? r.data : []);
      const rows = clients.length ? clients.map(c => `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:0.6rem">
              <div style="width:32px;height:32px;border-radius:8px;background:${
                ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444'][
                  (c.name||'?').charCodeAt(0)%6]};
                color:#fff;font-weight:700;font-size:0.875rem;display:flex;
                align-items:center;justify-content:center;flex-shrink:0">
                ${esc((c.name||c.client_name||'?')[0].toUpperCase())}
              </div>
              <span class="cell-strong">${esc(c.name || c.client_name || '—')}</span>
            </div>
          </td>
          <td><code style="font-size:0.75rem;user-select:all">${esc(c.client_id)}</code></td>
          <td class="muted" style="font-size:0.8rem">${esc(parseJsonArr(c.grant_types).join(', ') || '—')}</td>
          <td class="muted" style="font-size:0.75rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(parseJsonArr(c.redirect_uris).join(', '))}">${esc(parseJsonArr(c.redirect_uris).join(', ') || '—')}</td>
          <td>${c.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary edit-oidc" data-id="${esc(String(c.id))}">Edit</button>
            <button class="btn btn-sm btn-secondary rotate-oidc" data-id="${esc(String(c.id))}" data-name="${esc(c.name||c.client_name||'')}">↻ Rotate</button>
            <button class="btn btn-sm btn-danger del-oidc" data-id="${esc(String(c.id))}">Delete</button>
          </td>
        </tr>`).join('')
        : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No OIDC clients registered yet — use the Pre-built Integrations tab or register a custom app.</p></div></td></tr>`;

      const clientCount = clients.length;
      const origin = window.location.origin;
      wrap.querySelector('#list-area').innerHTML = `
        <div class="info-box" style="margin-bottom:1rem;font-size:0.85rem">
          <strong>Issuer endpoints</strong> —
          Discovery: <code>${esc(origin)}/.well-known/openid-configuration</code>
          · Authorize: <code>/oauth/authorize</code>
          · Token: <code>/oauth/token</code>
          · UserInfo: <code>/oauth/userinfo</code>
          · JWKS: <code>/.well-known/jwks.json</code>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem">
          <h2 style="margin:0;font-size:1.05rem;font-weight:700">Registered Clients
            ${clientCount ? `<span class="badge badge-info" style="font-size:0.75rem;margin-left:0.4rem">${clientCount}</span>` : ''}
          </h2>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>App Name</th><th>Client ID</th><th>Grant Types</th><th>Redirect URIs</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;

      wrap.querySelectorAll('.del-oidc').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this OIDC client?')) return;
          try { await api.deleteOidcClient(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.rotate-oidc').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Rotate secret for "${btn.dataset.name}"? The current secret will stop working immediately.`)) return;
          try {
            const result = await api.rotateOidcSecret(btn.dataset.id);
            showSecretModal(null, result.client_secret, async () => await load());
          } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-oidc').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const c = await api.getOidcClient(btn.dataset.id);
            openEditOidcModal(c, async () => await load());
          } catch (e) { alert(e.message); }
        });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openEditOidcModal(c, onDone) {
    const uris = parseJsonArr(c.redirect_uris).join('\n');
    const scopes = parseJsonArr(c.scopes).join(' ');
    const grants = parseJsonArr(c.grant_types);
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Edit OIDC Client</h2></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Display Name</label>
          <input class="form-input" id="e-name" value="${esc(c.name || '')}"></div>
        <div class="form-group"><label class="form-label">Client ID</label>
          <input class="form-input" value="${esc(c.client_id)}" readonly></div>
        <div class="form-group"><label class="form-label">Redirect URIs (one per line)</label>
          <textarea class="form-textarea" id="e-uris" rows="4">${esc(uris)}</textarea></div>
        <div class="form-group"><label class="form-label">Scopes (space-separated)</label>
          <input class="form-input" id="e-scopes" value="${esc(scopes || 'openid email profile')}"></div>
        <div class="form-group"><label class="form-label">Grant types</label>
          <label style="display:block;margin:0.25rem 0"><input type="checkbox" id="e-g-code" ${grants.includes('authorization_code') ? 'checked' : ''}> authorization_code</label>
          <label style="display:block;margin:0.25rem 0"><input type="checkbox" id="e-g-refresh" ${grants.includes('refresh_token') ? 'checked' : ''}> refresh_token</label>
        </div>
        <div class="form-group"><label class="form-label">Status</label>
          <select class="form-input" id="e-active">
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
      if (!scopesArr.includes('openid')) { errEl.innerHTML = `<div class="alert alert-error">scopes must include openid.</div>`; return; }
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

  // ── parse JSON-stored arrays (DB stores as JSON strings) ────────────────────
  function parseJsonArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }

  // ── show secret in modal (secret rotation) ──────────────────────────────────
  function showSecretModal(clientId, secret, onDone) {
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>🔑 Save Your Client Secret</h2></div>
      <div class="modal-body">
        <div class="info-box">This secret will <strong>not</strong> be shown again. Copy it now and store it securely.</div>
        ${clientId ? `<div class="form-group"><label class="form-label">Client ID</label><input class="form-input" value="${esc(clientId)}" readonly onclick="this.select()"></div>` : ''}
        <div class="form-group"><label class="form-label">Client Secret</label><input class="form-input" id="secret-val" value="${esc(secret||'')}" readonly onclick="this.select()" style="font-family:var(--font-mono);letter-spacing:0.04em"></div>
        <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard?.writeText(document.querySelector('#secret-val').value).then(()=>this.textContent='✓ Copied!');this.textContent='✓ Copied!'">Copy to Clipboard</button>
      </div>
      <div class="modal-footer"><button class="btn btn-primary" id="sec-done">Done — I've saved the secret</button></div>
    </div>`);
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
  let searchQ   = '';

  function renderGrid() {
    const q = searchQ.toLowerCase();
    const visible = SSO_CATALOG.filter(a =>
      (activeCat === 'All' || a.cat === activeCat) &&
      (!q || a.name.toLowerCase().includes(q) || a.cat.toLowerCase().includes(q))
    );

    wrap.querySelector('#pbi-grid').innerHTML = visible.map(app => `
      <div class="card" style="padding:1rem;cursor:default;position:relative">
        <div style="display:flex;align-items:center;gap:0.65rem;margin-bottom:0.6rem">
          ${catalogIcon(app)}
          <div>
            <div style="font-weight:600;font-size:0.875rem;line-height:1.2">${esc(app.name)}</div>
            <span class="badge ${app.protocol==='OIDC'?'badge-info':'badge-warning'}" style="font-size:0.62rem">${esc(app.protocol)}</span>
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
  content.replaceChildren(el(`<div>
    ${embed ? '' : header('App Discovery', 'Shadow IT and application usage discovery')}
    <div id="disc-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;
  try {
    const r = await api.igaConnectors();
    const allConnectors = Array.isArray(r) ? r : (r && r.data ? r.data : []);
    const disc = allConnectors.filter(c => (c.connector_type || c.type || '') === 'DISCOVERY');
    wrap.querySelector('#disc-area').innerHTML = `
      <div class="card" style="margin-bottom:1rem">
        <strong>Shadow IT Discovery</strong>
        <p class="muted" style="margin-top:0.25rem">Surfaces unsanctioned SaaS from SSO logs, Workspace audit trails, and proxy logs. Register DISCOVERY connectors below; full log-ingestion ships in Phase 5.</p>
      </div>
      ${disc.length
        ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Last Run</th></tr></thead><tbody>
            ${disc.map(c => `<tr>
              <td class="cell-strong">${esc(c.name)}</td>
              <td><span class="badge badge-info">${esc(c.connector_type||c.type||'DISCOVERY')}</span></td>
              <td>${['ACTIVE','CONNECTED'].includes(c.status) ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">'+esc(c.status||'Unknown')+'</span>'}</td>
              <td class="muted">${c.last_sync_at ? fmtDate(c.last_sync_at) : '—'}</td>
            </tr>`).join('')}
          </tbody></table></div>`
        : `<div class="empty-state"><div class="empty-icon">🔍</div><p>No discovery connectors configured yet.</p><p class="muted" style="font-size:0.8rem;margin-top:0.5rem">Go to <strong>Directory Sync → Add Directory Source</strong> and choose a type to begin.</p></div>`
      }`;
  } catch(e) { wrap.querySelector('#disc-area').innerHTML = errHtml(e.message); }
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

const CONNECTOR_TYPES = {
  AD:               { label: 'Active Directory', icon: '🏢', badge: 'badge-info',    desc: 'Microsoft Active Directory / LDAP',
    fields: ['host','port','bindDn','bindPassword','baseDn','targetOu','upnDomain','useSsl','syncGroups'],
    connectionFields: ['host','port','bindDn','bindPassword','baseDn','targetOu','upnDomain','useSsl'],
    scopeFields: ['syncGroups'] },
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
  syncGroups:         'Sync Groups (Google: group email; AD: CN, sAMAccountName, full DN, or * for all security groups)',
  syncGroupMemberships: 'Mirror group membership into IdP Groups (recommended when Sync Groups is set)',
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
  const map = { CONNECTED:'badge-success', ACTIVE:'badge-success', CONFIGURED:'badge-info', ERROR:'badge-danger', DISABLED:'badge-neutral' };
  return `<span class="badge ${map[status]||'badge-neutral'}">${esc(status||'—')}</span>`;
}

export async function viewDirectorySync(content, initialTab = 'sources', me = null) {
  const validTab = initialTab === 'users' ? 'users' : 'sources';
  content.replaceChildren(el(`<div class="admin-page">
    ${header('Universal Directory', 'Identity sources and hybrid users across AD, Google, and local directories', `<button class="btn btn-primary btn-sm" id="ds-add-header-btn">+ Add Source</button>`)}
    <div class="tabs tabs--compact">
      <button class="tab${validTab === 'sources' ? ' active' : ''}" data-tab="sources">Directory Sources</button>
      <button class="tab${validTab === 'users' ? ' active' : ''}" data-tab="users">Users</button>
    </div>
    <div id="tab-sources"></div>
    <div id="tab-users" style="display:none"></div>
  </div>`));
  const wrap = content.firstChild;

  function showTab(name) {
    wrap.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    wrap.querySelector('#tab-sources').style.display = name === 'sources' ? '' : 'none';
    wrap.querySelector('#tab-users').style.display = name === 'users' ? '' : 'none';
    syncAppUrl('directorySync', name, 'sources');
  }
  wrap.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
  });

  // ── initialise both tabs ─────────────────────────────────────────────────────
  initSourcesTab(wrap.querySelector('#tab-sources'));
  initUsersTab(wrap.querySelector('#tab-users'), me);
  showTab(validTab);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  TAB 1: Directory Sources (connector management)            ║
// ╚══════════════════════════════════════════════════════════════╝
function initSourcesTab(panel) {
  panel.innerHTML = `
    <div class="page-toolbar" id="ds-toolbar" hidden>
      <div id="ds-stats" class="kpi-strip"></div>
    </div>
    <div id="ds-area">${loading()}</div>`;

  function renderSourceStats(connectors) {
    const total = connectors.length;
    const active = connectors.filter((c) => ['CONNECTED', 'ACTIVE'].includes(c.status)).length;
    const errors = connectors.filter((c) => c.status === 'ERROR').length;
    const lastSync = connectors.reduce((best, c) => {
      if (!c.last_sync_at) return best;
      return !best || new Date(c.last_sync_at) > new Date(best) ? c.last_sync_at : best;
    }, null);
    const toolbar = panel.querySelector('#ds-toolbar');
    toolbar.hidden = false;
    panel.querySelector('#ds-stats').innerHTML = kpiStrip([
      [total, 'Sources', 'accent'],
      [active, 'Connected', 'success'],
      [errors, 'Errors', errors ? 'danger' : 'neutral'],
      [lastSync ? fmtDate(lastSync) : '—', 'Last sync', 'neutral'],
    ]);
  }

  function renderSourceTable(connectors) {
    const rows = connectors.map((c) => {
      const meta = CONNECTOR_TYPES[normalizeConnectorType(c.connector_type)] || { label: c.connector_type, icon: '⚙️', badge: 'badge-neutral' };
      const errHint = c.last_error
        ? `<span class="text-danger" title="${esc(c.last_error)}" style="margin-left:0.25rem">⚠</span>`
        : '';
      return `<tr data-cid="${esc(String(c.id))}">
        <td>
          <div class="connector-cell">
            <div class="connector-cell-icon">${meta.icon}</div>
            <div class="connector-cell-body">
              <div class="connector-cell-name">${esc(c.name)}</div>
              <div class="connector-cell-meta">${esc(meta.label)} · ${esc(c.sync_mode || 'INCREMENTAL')}</div>
            </div>
          </div>
        </td>
        <td><span class="badge badge-neutral">${esc(c.direction || '—')}</span></td>
        <td class="muted">${c.sync_schedule ? esc(c.sync_schedule) : 'Manual'}</td>
        <td class="muted">${c.last_sync_at ? fmtDate(c.last_sync_at) : 'Never'}</td>
        <td>${connectorStatusBadge(c.status)}${errHint}</td>
        <td class="actions">
          <div class="row-actions">
            <button class="btn btn-sm btn-primary ds-sync" data-id="${esc(String(c.id))}">Sync</button>
            <button class="btn btn-sm btn-secondary ds-test" data-id="${esc(String(c.id))}">Test</button>
            <button class="btn btn-sm btn-ghost ds-edit" data-id="${esc(String(c.id))}" data-type="${esc(c.connector_type)}" data-name="${esc(c.name)}" data-mode="${esc(c.sync_mode || '')}" data-sched="${esc(c.sync_schedule || '')}">Edit</button>
            <button class="btn btn-sm btn-ghost ds-logs" data-id="${esc(String(c.id))}" data-name="${esc(c.name)}">History</button>
            <button class="btn btn-sm btn-danger ds-del" data-id="${esc(String(c.id))}">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    panel.querySelector('#ds-area').innerHTML = `
      <div class="table-wrap table-wrap--flat">
        <table class="dense-table">
          <thead><tr>
            <th>Source</th><th>Direction</th><th>Schedule</th><th>Last sync</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    bindCardActions();
  }

  // ── render connector list ──────────────────────────────────────────────────
  async function load() {
    try {
      const r = await api.igaConnectors();
      const connectors = (r && r.data) ? r.data : (Array.isArray(r) ? r : []);

      if (!connectors.length) {
        panel.querySelector('#ds-toolbar').hidden = true;
        panel.querySelector('#ds-area').innerHTML = `
          <div class="empty-panel">
            <div class="empty-panel-icon">🔌</div>
            <h2>No directory sources configured</h2>
            <p class="muted">Connect Active Directory, Google Workspace, Azure AD, or any SCIM directory to start syncing identities.</p>
            <button class="btn btn-primary btn-sm" id="ds-empty-add">+ Add Directory Source</button>
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
          const r = await api.igaConnectors(); // ping to confirm alive
          await fetch(`/api/iga/connectors/${btn.dataset.id}/sync`, { method: 'POST', credentials: 'include' });
          showToast('Sync triggered — check history for results.');
          await load();
        } catch(e) { alert('Sync failed: ' + e.message); btn.disabled = false; btn.textContent = '▶ Sync Now'; }
      });
    });

    // Test Connection
    panel.querySelectorAll('.ds-test').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '⟳ Testing…';
        try {
          const r = await api.testConnector(btn.dataset.id);
          showToast(r.message || (r.success ? '✓ Connection successful' : '✗ Test failed'));
        } catch(e) {
          const detail = e.body && e.body.detail ? `\n${e.body.detail}` : '';
          showToast('✗ ' + e.message + detail, true);
        }
        btn.disabled = false; btn.textContent = '✓ Test Connection';
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
      `<div class="ds-type-card" data-type="${k}" style="cursor:pointer;border:2px solid var(--border);border-radius:8px;
        padding:1rem;display:flex;align-items:center;gap:0.75rem;transition:border-color 0.15s">
        <span style="font-size:1.75rem">${v.icon}</span>
        <div>
          <div style="font-weight:600">${esc(v.label)}</div>
          <div class="muted" style="font-size:0.78rem">${esc(v.desc)}</div>
        </div>
      </div>`).join('');

    const bd = openModal(`<div class="modal" style="width:600px;max-width:96vw">
      <div class="modal-header"><h2>Add Directory Source — Step 1: Choose Type</h2></div>
      <div class="modal-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">${typeCards}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="wiz-cancel">Cancel</button>
      </div>
    </div>`);

    bd.querySelector('#wiz-cancel').addEventListener('click', () => bd.remove());

    bd.querySelectorAll('.ds-type-card').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
      card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border)'; });
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
    const useScopeTabs = isGoogle || isAd;

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
      if (f === 'syncGroups' && (isGoogle || connectorType === 'AD')) {
        const ph = isGoogle
          ? 'sales-team@company.com&#10;it-admins@company.com'
          : 'IT-Admins&#10;VPN-Users&#10;*';
        const hint = connectorType === 'AD'
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
    const redirectUri = `${window.location.origin}/auth/google/callback`;
    const oidcClientId = esc(String(defaults.oidcClientId || ''));
    const oidcHasSecret = defaults.oidcHasClientSecret ? true : false;

    const googleAuthFields = `
          <p class="muted" style="font-size:0.82rem;margin:0 0 1rem">OAuth <strong>Web client</strong> for <em>Continue with Google</em> on the login page. The service account on the Connection tab is for directory sync only.</p>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">OAuth Client ID</label>
            <input class="form-input" id="cfg-oidcClientId" value="${oidcClientId}" placeholder="123456789.apps.googleusercontent.com">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">OAuth Client Secret</label>
            <input class="form-input" id="cfg-oidcClientSecret" type="password" placeholder="${oidcHasSecret ? 'Saved (leave blank to keep current)' : 'GOCSPX-...'}">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">OAuth JSON (optional)</label>
            <textarea class="form-textarea" id="cfg-oidcOAuthJson" rows="3" placeholder='Paste OAuth Web client JSON from Google Cloud Console'></textarea>
          </div>
          <div class="alert alert-info" style="font-size:0.8rem;margin-bottom:0">
            In Google Cloud Console → Credentials → OAuth Web client, add redirect URI:<br>
            <code style="font-size:0.75rem">${esc(redirectUri)}</code>
          </div>`;

    const scopedFieldsBlock = useScopeTabs ? `
        <div class="cfg-tab-bar" style="display:flex;gap:0.5rem;margin-bottom:1rem;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <button type="button" class="cfg-tab btn btn-sm btn-secondary active" data-pane="conn" style="border-radius:6px 6px 0 0;margin-bottom:-1px">🔌 Connection</button>
          ${isGoogle ? `<button type="button" class="cfg-tab btn btn-sm btn-secondary" data-pane="auth" style="border-radius:6px 6px 0 0;margin-bottom:-1px">🔑 Portal sign-in</button>` : ''}
          <button type="button" class="cfg-tab btn btn-sm btn-secondary" data-pane="scope" style="border-radius:6px 6px 0 0;margin-bottom:-1px">🎯 Sync Scope</button>
        </div>
        <div id="cfg-pane-conn" class="cfg-pane">
          <div style="display:grid;grid-template-columns:1fr;gap:0">${isGoogle ? googleConnFields : adConnFields}</div>
          ${isGoogle ? `<div class="alert alert-info" style="font-size:0.8rem;margin-top:1rem;line-height:1.45">
            <strong>Domain-wide delegation</strong> (one-time in Google): Cloud Console → Service account → enable delegation → Admin Console → API controls → add SA Client ID with scope
            <code style="font-size:0.72rem">https://www.googleapis.com/auth/admin.directory.user</code>
          </div>` : ''}
        </div>
        ${isGoogle ? `<div id="cfg-pane-auth" class="cfg-pane" style="display:none">${googleAuthFields}</div>` : ''}
        <div id="cfg-pane-scope" class="cfg-pane" style="display:none">
          ${isGoogle
            ? '<p class="muted" style="font-size:0.82rem;margin:0 0 1rem">Choose which OUs, groups, and users to import. Leave all blank to sync the <strong>entire</strong> Google directory.</p>'
            : '<p class="muted" style="font-size:0.82rem;margin:0 0 1rem">List AD groups to mirror into <strong>Identity → Groups</strong>. User sync must run first so members can be linked. Leave blank to auto-sync up to <strong>200 security groups</strong>.</p>'}
          <div style="display:grid;grid-template-columns:1fr;gap:0">${isGoogle ? googleScopeFields : adScopeFields}</div>
        </div>` : `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 1rem">${configFields}</div>`;

    const bd = openModal(`<div class="modal" style="width:680px;max-width:96vw">
      <div class="modal-header">
        <h2>${isEdit ? 'Edit' : 'Configure'} — ${esc(meta.icon||'')} ${esc(meta.label||connectorType)}</h2>
      </div>
      <div class="modal-body" style="max-height:72vh;overflow-y:auto">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 1rem">
          <div class="form-group">
            <label class="form-label">Display Name <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="cfg-name" value="${esc(defaults.name||meta.label||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Slug <span class="muted" style="font-size:0.75rem">(URL-safe ID)</span></label>
            <input class="form-input" id="cfg-slug" value="${esc(defaults.slug||connectorType.toLowerCase().replace(/_/g,'-'))}">
          </div>
          <div class="form-group">
            <label class="form-label">Direction</label>
            <select class="form-select" id="cfg-direction">
              <option ${defaults.direction==='INBOUND'?'selected':''} value="INBOUND">INBOUND (read users from source)</option>
              <option ${defaults.direction==='OUTBOUND'?'selected':''} value="OUTBOUND">OUTBOUND (provision to source)</option>
              <option ${(!defaults.direction||defaults.direction==='BIDIRECTIONAL')?'selected':''} value="BIDIRECTIONAL">BIDIRECTIONAL</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Sync Schedule <span class="muted" style="font-size:0.75rem">(cron or blank for manual)</span></label>
            <input class="form-input" id="cfg-schedule" value="${esc(defaults.sync_schedule||'0 */6 * * *')}" placeholder="0 */6 * * *">
          </div>
        </div>
        ${isGoogle ? '' : `<hr style="border:none;border-top:1px solid var(--border);margin:0.5rem 0 1rem">
        <h3 style="font-size:0.9rem;font-weight:600;margin-bottom:0.75rem;color:var(--text-dim)">CONNECTION SETTINGS</h3>`}
        ${isGoogle ? `<h3 style="font-size:0.9rem;font-weight:600;margin:0.5rem 0 0.75rem;color:var(--text-dim)">GOOGLE WORKSPACE</h3>` : ''}
        ${scopedFieldsBlock}
        <div id="cfg-err"></div>
      </div>
      <div class="modal-footer" style="gap:0.5rem">
        ${!isEdit ? `<button class="btn btn-secondary" id="cfg-back">‹ Back</button>` : ''}
        <button class="btn btn-secondary" id="cfg-test-btn">✓ Test Connection</button>
        <button class="btn btn-primary"   id="cfg-save">${isEdit ? 'Save Changes' : 'Add Source'}</button>
        <button class="btn btn-secondary" id="cfg-cancel">Cancel</button>
      </div>
    </div>`);

    if (!isEdit) bd.querySelector('#cfg-back').addEventListener('click', () => { bd.remove(); openAddWizard(); });
    bd.querySelector('#cfg-cancel').addEventListener('click', () => bd.remove());

    if (useScopeTabs) {
      bd.querySelectorAll('.cfg-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          bd.querySelectorAll('.cfg-tab').forEach(t => {
            t.classList.remove('active');
            t.classList.add('btn-secondary');
            t.classList.remove('btn-primary');
          });
          tab.classList.add('active', 'btn-primary');
          tab.classList.remove('btn-secondary');
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
    if (!payload.hostedDomain && !payload.clientId && !payload.oauthClientJson) return;
    await api.saveGoogleOidcSettings(payload);
  }

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
      }
      else if (el2.value.trim() !== '') configJson[f] = el2.value.trim();
    }
    return {
      name:          bd.querySelector('#cfg-name').value.trim(),
      slug:          bd.querySelector('#cfg-slug').value.trim(),
      connectorType,
      direction:     bd.querySelector('#cfg-direction').value,
      syncSchedule:  bd.querySelector('#cfg-schedule').value.trim() || null,
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
  async function openLogsModal(connectorId, connectorName) {
    const bd = openModal(`<div class="modal" style="width:760px;max-width:96vw">
      <div class="modal-header"><h2>Sync History — ${esc(connectorName)}</h2></div>
      <div class="modal-body" id="logs-body">${loading()}</div>
      <div class="modal-footer"><button class="btn btn-secondary" id="logs-close">Close</button></div>
    </div>`);
    bd.querySelector('#logs-close').addEventListener('click', () => bd.remove());
    try {
      const r = await api.getConnectorRuns(connectorId, 20);
      const runs = (r && r.data) ? r.data : [];
      if (!runs.length) {
        bd.querySelector('#logs-body').innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><p>No sync runs yet.</p></div>`;
        return;
      }
      const rows = runs.map(r2 => `<tr>
        <td class="muted" style="font-size:0.8rem">${r2.started_at ? fmtDate(r2.started_at) : '—'}</td>
        <td><span class="badge badge-neutral">${esc(r2.run_type||'—')}</span></td>
        <td><span class="badge ${r2.status==='SUCCESS'?'badge-success':r2.status==='FAILED'?'badge-danger':'badge-warning'}">${esc(r2.status||'—')}</span></td>
        <td>${r2.items_processed ?? '—'}</td>
        <td style="color:var(--success)">${r2.items_succeeded ?? '—'}</td>
        <td style="color:${r2.items_failed?'var(--danger)':'inherit'}">${r2.items_failed ?? '—'}</td>
        <td class="muted" style="font-size:0.78rem;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${esc(r2.error_summary||'')}">${r2.error_summary ? esc(r2.error_summary.slice(0,80)) : '—'}</td>
      </tr>`).join('');
      bd.querySelector('#logs-body').innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Processed</th><th>OK</th><th>Failed</th><th>Error</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
    } catch(e) { bd.querySelector('#logs-body').innerHTML = errHtml(e.message); }
  }

  panel.querySelector('#ds-add-btn')?.addEventListener('click', openAddWizard);
  panel.closest('.admin-page')?.querySelector('#ds-add-header-btn')?.addEventListener('click', openAddWizard);
  load();
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
    return `<span style="display:inline-block;padding:0.15rem 0.45rem;border-radius:4px;
      font-size:0.72rem;font-weight:600;margin-right:0.25rem;
      background:${b.bg};color:${b.color};border:1px solid ${b.color}33">${esc(b.label)}</span>`;
  }

  function stateBadge(s) {
    const map = { ACTIVE:'badge-success', SUSPENDED:'badge-warning', TERMINATED:'badge-danger', INACTIVE:'badge-neutral' };
    return `<span class="badge ${map[s]||'badge-neutral'}">${esc(s||'—')}</span>`;
  }

  // ── Build shell ──────────────────────────────────────────────────────────────
  panel.innerHTML = `
    <div class="filter-toolbar">
      <input class="form-input filter-toolbar-search" id="ud-search" placeholder="Search name, email, ID…">
      <select class="form-select" id="ud-src-filter">
        <option value="">All Sources</option>
        <option value="AD">Active Directory</option>
        <option value="GOOGLE">Google Workspace</option>
        <option value="LOCAL">Local Only</option>
        <option value="ZOHO">Zoho</option>
        <option value="SLACK">Slack</option>
        <option value="GITHUB">GitHub</option>
        <option value="HRMS">HRMS</option>
        <option value="AWS_IDC">AWS IDC</option>
      </select>
      <select class="form-select" id="ud-state-filter">
        <option value="">Available</option>
        <option value="SUSPENDED">Suspended</option>
        <option value="__all__">All states</option>
      </select>
      <div class="filter-toolbar-spacer"></div>
      <button class="btn btn-secondary btn-sm" id="ud-refresh-btn">Refresh</button>
      <button class="btn btn-primary btn-sm" id="ud-create-btn">+ Local User</button>
    </div>
    <div id="ud-stats" class="kpi-strip kpi-strip--spaced" hidden></div>
    <div id="ud-table-area">${loading()}</div>`;

  let allUsers = [];
  let searchTimer = null;

  // ── Load & render user list ──────────────────────────────────────────────────
  async function loadUsers(q = '', state = '', source = '') {
    panel.querySelector('#ud-table-area').innerHTML = loading();
    try {
      const includeInactive = state === '__all__';
      const apiState = includeInactive ? '' : state;
      const r = await api.listUsersUnified(q, apiState, source, 200, 0, includeInactive);
      allUsers = Array.isArray(r) ? r : (r?.data ?? []);
      renderStats(allUsers);
      renderTable(allUsers);
    } catch(e) {
      panel.querySelector('#ud-table-area').innerHTML = errHtml(e.message);
    }
  }

  function renderStats(users) {
    const total   = users.length;
    const withAD  = users.filter(u => (u.identity_sources||'').includes('AD')).length;
    const withG   = users.filter(u => (u.identity_sources||'').includes('GOOGLE')).length;
    const local   = users.filter(u => !(u.identity_sources||'').replace(/^,+|,+$/g,'').length || u.local_active).length;
    const statsEl = panel.querySelector('#ud-stats');
    statsEl.hidden = false;
    statsEl.innerHTML = kpiStrip([
      [total, 'Users', 'accent'],
      [withAD, 'With AD', 'info'],
      [withG, 'With Google', 'success'],
      [local, 'Local only', 'neutral'],
    ]);
  }

  function renderTable(users) {
    if (!users.length) {
      panel.querySelector('#ud-table-area').innerHTML = `
        <div class="empty-panel empty-panel--compact">
          <div class="empty-panel-icon">👤</div>
          <p class="muted">No users match your filter.</p>
        </div>`;
      return;
    }

    const rows = users.map(u => {
      const sources = (u.identity_sources || '').split(',').filter(Boolean);
      const badges  = sources.length ? sources.map(srcBadge).join('') : srcBadge('LOCAL');
      const init = (u.full_name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      return `<tr style="cursor:pointer" class="ud-row" data-empid="${esc(u.emp_id)}">
        <td>
          <div class="user-cell">
            <div class="user-cell-avatar">${esc(init)}</div>
            <div>
              <div class="user-cell-name">${esc(u.full_name||'—')}</div>
              <div class="user-cell-meta">${esc(u.emp_id)}</div>
            </div>
          </div>
        </td>
        <td class="muted">${esc(u.email_corp||'—')}</td>
        <td class="muted">${esc(u.dept_id||'—')}</td>
        <td>${stateBadge(u.ilg_state)}</td>
        <td>${badges}</td>
        <td class="actions">
          <button class="btn btn-sm btn-secondary ud-profile-btn" data-empid="${esc(u.emp_id)}">Profile</button>
        </td>
      </tr>`;
    }).join('');

    panel.querySelector('#ud-table-area').innerHTML = `
      <div class="table-wrap table-wrap--flat">
        <table class="dense-table">
          <thead><tr><th>User</th><th>Email</th><th>Department</th><th>State</th><th>Sources</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    panel.querySelectorAll('.ud-row, .ud-profile-btn').forEach(el2 => {
      el2.addEventListener('click', (e) => {
        e.stopPropagation();
        const empId = el2.dataset.empid || el2.closest('tr')?.dataset?.empid;
        if (empId) openProfilePanel(empId);
      });
    });
  }

  // ── Full profile slide-in drawer (godmode) ──────────────────────────────────
  async function openProfilePanel(empId) {
    // Remove any existing panel
    document.querySelector('.profile-panel-overlay')?.remove();

    // Build overlay + slide-in panel
    const overlay = document.createElement('div');
    overlay.className = 'profile-panel-overlay';
    overlay.innerHTML = `
      <div class="profile-panel" id="pp-panel">
        <button class="pp-close-x" id="pp-close-x" title="Close (Esc)">✕</button>

        <!-- ── Header ───────────────────────────────────────────────────────── -->
        <div class="pp-header" id="pp-header">
          <div class="pp-avatar" id="pp-avatar">?</div>
          <div>
            <div class="pp-name" id="pp-name">Loading…</div>
            <div class="pp-sub" id="pp-sub"></div>
            <div class="pp-badges" id="pp-badges"></div>
          </div>
          <div class="pp-lifecycle" id="pp-lifecycle"></div>
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

    // Close helpers
    function closePanel() {
      const panel2 = overlay.querySelector('#pp-panel');
      panel2.classList.remove('pp-open');
      panel2.addEventListener('transitionend', () => overlay.remove(), { once: true });
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
    overlay.querySelector('#pp-close-x').addEventListener('click', closePanel);
    const onKey = (e) => { if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', onKey); } };
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
        [emp.emp_id, emp.email_corp, emp.dept_id].filter(Boolean).join('  ·  ');

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
      const body         = overlay.querySelector('#pp-body');

      // ── Overview tab ─────────────────────────────────────────────────────────
      if (tab === 'overview') {
        const attrs = [
          ['Employee ID',      esc(emp.emp_id     || '—')],
          ['Corporate Email',  esc(emp.email_corp || '—')],
          ['Department',       esc(emp.dept_id    || '—')],
          ['Employment Type',  esc(emp.employment_type || '—')],
          ['State',            stateBadge(emp.ilg_state)],
          ['Designation',      emp.role ? esc(emp.role) : '<span class="muted">—</span>'],
          ['Portal Administrator', emp.portal_role
            ? `<span class="badge badge-primary">${esc(emp.portal_role)}</span>`
            : '<span class="muted">None — assign from Identity → Administrators</span>'],
          ['Hire Date',        emp.hire_date ? fmtDate(emp.hire_date) : '—'],
          ['Last Login',       emp.last_login_at ? fmtDate(emp.last_login_at) : '—'],
          ['Manager',          emp.manager_name
            ? `${esc(emp.manager_name)} <span class="muted" style="font-size:0.8rem">&lt;${esc(emp.manager_email||'')}&gt;</span>`
            : '—'],
          ['Manager ID',       esc(emp.manager_emp_id || '—')],
        ];

        body.innerHTML = `
          <p class="pp-section-title">Account Details</p>
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
          : mfaStatus.enrolled
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
              await api.adminMfaDisable(empId);
              await api.adminMfaEnforce(empId, true);
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
            <button class="btn btn-sm btn-primary" id="pp-mfa-start">Start MFA Enrollment for User</button>`;
          const enrollDiv = document.createElement('div');
          enrollDiv.style.marginTop = '1rem';
          body.appendChild(enrollDiv);

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
                      <input class="form-input" id="pp-mfa-code" maxlength="6" placeholder="123456">
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
    const bd = openModal(`<div class="modal" style="width:580px;max-width:96vw">
      <div class="modal-header"><h2>Create Local User</h2></div>
      <div class="modal-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 1rem">
          <div class="form-group">
            <label class="form-label">Full Name <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="cu-name" placeholder="Jane Doe">
          </div>
          <div class="form-group">
            <label class="form-label">Corporate Email <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="cu-email" type="email" placeholder="jane.doe@company.com">
          </div>
          <div class="form-group">
            <label class="form-label">Password <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="cu-pwd" type="password" placeholder="Min. 10 characters" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="form-label">Role</label>
            <select class="form-select" id="cu-role">
              <option value="USER">User</option>
              <option value="MANAGER">Manager</option>
              <option value="HRBP">HRBP</option>
              <option value="ADMIN">Admin</option>
              <option value="SUPER_ADMIN">Super Admin</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Department ID</label>
            <input class="form-input" id="cu-dept" placeholder="e.g. DEPT-ENG">
          </div>
          <div class="form-group">
            <label class="form-label">Employment Type</label>
            <select class="form-select" id="cu-emptype">
              <option value="CORPORATE">Corporate</option>
              <option value="STORE">Store</option>
              <option value="PLANT">Plant</option>
              <option value="DC">Distribution Center</option>
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">Manager Employee ID</label>
            <input class="form-input" id="cu-mgr" placeholder="e.g. EMP-00042">
          </div>
        </div>
        <div id="cu-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary"   id="cu-save">Create User</button>
        <button class="btn btn-secondary" id="cu-cancel">Cancel</button>
      </div>
    </div>`);
    bd.querySelector('#cu-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#cu-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#cu-save');
      const name  = bd.querySelector('#cu-name').value.trim();
      const email = bd.querySelector('#cu-email').value.trim();
      const pwd   = bd.querySelector('#cu-pwd').value;
      const role  = bd.querySelector('#cu-role').value;
      const dept  = bd.querySelector('#cu-dept').value.trim();
      const etype = bd.querySelector('#cu-emptype').value;
      const mgr   = bd.querySelector('#cu-mgr').value.trim();
      if (!name || !email || !pwd) {
        bd.querySelector('#cu-err').innerHTML = errHtml('Name, email, and password are required.'); return;
      }
      if (pwd.length < 10) {
        bd.querySelector('#cu-err').innerHTML = errHtml('Password must be at least 10 characters.'); return;
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Creating…';
      try {
        const res = await api.createLocalUser({
          fullName: name, email, password: pwd, role,
          deptId:  dept  || undefined,
          empType: etype,
          managerId: mgr || undefined,
        });
        bd.remove();
        // refresh table
        const q      = panel.querySelector('#ud-search').value.trim();
        const src    = panel.querySelector('#ud-src-filter').value;
        const state  = panel.querySelector('#ud-state-filter').value;
        loadUsers(q, state, src);
        // Auto-open the new user's profile
        if (res.empId) openProfilePanel(res.empId);
      } catch(e) {
        bd.querySelector('#cu-err').innerHTML = errHtml(e.message);
        saveBtn.disabled = false; saveBtn.textContent = 'Create User';
      }
    });
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

  panel.querySelector('#ud-create-btn').addEventListener('click', openCreateUserModal);

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
export async function viewBirthright(content) {
  content.replaceChildren(el(`<div>${header('Birthright Provisioning', 'Automatically provision entitlements based on joiner rules')}<div id="br-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const list = norm(await api.listBirthrightRules());
    const rows = list.length ? list.map(r => {
      let ruleSummary = '—';
      try { const j = JSON.parse(r.birthright_rule || '{}'); ruleSummary = Object.keys(j).join(', ') || '—'; } catch {}
      return `<tr>
        <td class="cell-strong">${esc(r.name||r.entitlement_name||r.id)}</td>
        <td class="muted" style="font-size:0.8rem">${esc(ruleSummary)}</td>
        <td class="muted">${esc(r.application||r.app_name||'—')}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="3"><div class="empty-state"><div class="empty-icon">◎</div><p>No birthright entitlements.</p></div></td></tr>`;
    wrap.querySelector('#br-area').innerHTML = `
      <div style="display:flex;gap:0.75rem;margin-bottom:1rem">
        <button class="btn btn-secondary" id="br-dryrun">Dry Run</button>
        <button class="btn btn-primary" id="br-run">Run Now</button>
      </div>
      <div id="br-msg"></div>
      <div class="table-wrap"><table><thead><tr><th>Entitlement</th><th>Rule Summary</th><th>Application</th></tr></thead><tbody>${rows}</tbody></table></div>`;

    wrap.querySelector('#br-dryrun').addEventListener('click', async () => {
      const btn = wrap.querySelector('#br-dryrun');
      btn.disabled = true; btn.textContent = 'Running…';
      try {
        const result = await api.birthrightDryRun();
        const n = Array.isArray(result?.data) ? result.data.length : (result.affected_count ?? result.count ?? 0);
        wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Dry run complete: <strong>${n}</strong> users would receive birthright entitlements (sample up to 50).</div>`;
      } catch(e) { wrap.querySelector('#br-msg').innerHTML = errHtml(e.message); }
      btn.disabled = false; btn.textContent = 'Dry Run';
    });
    wrap.querySelector('#br-run').addEventListener('click', async () => {
      if (!confirm('Run birthright provisioning now?')) return;
      const btn = wrap.querySelector('#br-run');
      btn.disabled = true; btn.textContent = 'Running…';
      try {
        await api.runBirthright();
        wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Birthright provisioning completed.</div>`;
      } catch(e) { wrap.querySelector('#br-msg').innerHTML = errHtml(e.message); }
      btn.disabled = false; btn.textContent = 'Run Now';
    });
  } catch(e) { wrap.querySelector('#br-area').innerHTML = errHtml(e.message); }
}

// ─── Application Access Policy ────────────────────────────────────────────────
export async function viewAppAccessPolicy(content) {
  content.replaceChildren(el(`<div class="aap-page">
    ${header('Application Access Policy', 'Who can launch apps + approval chains for access requests (not the same as Workflow Library / Event Triggers)')}
    <div id="aap-stats" class="stat-grid aap-stats">${loading()}</div>
    <div class="cfg-tab-bar inline-tabs aap-tabs">
      <button type="button" class="cfg-tab inline-tab active" data-tab="assign">Application Assignment</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="workflow">Group Access Workflow</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="audit">Audit Log</button>
    </div>
    <div id="tab-assign"></div>
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
          <td><button class="btn btn-sm btn-danger revoke-assign" data-id="${esc(String(a.id))}">Revoke</button></td>
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

      area.querySelector('#aap-assign-btn').addEventListener('click', openAssignModal);
      area.querySelector('#aap-tg-btn').addEventListener('click', openTagGroupModal);
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

  async function openAssignModal() {
    try { await loadAppsAndGroups(); } catch (e) { alert(e.message); return; }

    const appOpts = appsCache.length
      ? appsCache.map(a => `<option value="${esc(a.id)}">${esc(a.name)}${a.has_saml ? ' (SAML)' : ''}</option>`).join('')
      : '<option value="" disabled>No applications — register SAML/IGA apps first</option>';
    const hasAnyGroup = identityGroupsCache.length || tagGroupsCache.length;
    const identityOpts = identityGroupsCache.length
      ? `<optgroup label="Identity Groups (Identity → Groups)">${identityGroupsCache.map(g =>
          `<option value="${esc(g.id)}" data-type="GROUP">${esc(g.name)}</option>`).join('')}</optgroup>`
      : '';
    const tagOpts = tagGroupsCache.length
      ? `<optgroup label="Tag Groups">${tagGroupsCache.map(g =>
          `<option value="${esc(g.id)}" data-type="TAG_GROUP">${esc(g.name)}</option>`).join('')}</optgroup>`
      : '';
    const tgOpts = hasAnyGroup
      ? identityOpts + tagOpts
      : '<option value="" disabled>No groups — create one under Identity → Groups or + Tag Group</option>';
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>Assign Application Access</h2></div><div class="modal-body">
      ${!appsCache.length ? '<div class="alert alert-info" style="margin-bottom:1rem;font-size:0.85rem">No applications in the catalog yet. Register a SAML app under <strong>Applications</strong> or add one in the IGA catalog — it will appear here automatically.</div>' : ''}
      ${!hasAnyGroup ? '<div class="alert alert-info" style="margin-bottom:1rem;font-size:0.85rem">No groups yet. Create one under <strong>Identity → Groups</strong> (recommended) or click <strong>+ Tag Group</strong> on this page.</div>' : ''}
      <div class="form-group"><label class="form-label">Application</label>
        <select class="form-select" id="aa-app"><option value="">— Select —</option>${appOpts}</select></div>
      <div class="form-group"><label class="form-label">Assignment Type</label>
        <select class="form-select" id="aa-type"><option value="USER">User-based</option><option value="GROUP">Group-based</option></select></div>
      <div class="form-group" id="aa-user-wrap"><label class="form-label">Employee ID</label>
        <input class="form-input" id="aa-emp" placeholder="e.g. E12345"></div>
      <div class="form-group" id="aa-tg-wrap" style="display:none"><label class="form-label">Group</label>
        <select class="form-select" id="aa-tg"><option value="">— Select —</option>${tgOpts}</select></div>
      <div id="aa-err"></div>
    </div><div class="modal-footer">
      <button class="btn btn-primary" id="aa-save">Grant Access</button>
      <button class="btn btn-secondary" id="aa-cancel">Cancel</button>
    </div></div>`);
    const typeSel = bd.querySelector('#aa-type');
    typeSel.addEventListener('change', () => {
      const isUser = typeSel.value === 'USER';
      bd.querySelector('#aa-user-wrap').style.display = isUser ? '' : 'none';
      bd.querySelector('#aa-tg-wrap').style.display = isUser ? 'none' : '';
    });
    bd.querySelector('#aa-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#aa-save').addEventListener('click', async () => {
      const appId = bd.querySelector('#aa-app').value;
      let assignmentType = typeSel.value;
      let targetId = '';
      if (assignmentType === 'USER') {
        targetId = bd.querySelector('#aa-emp').value.trim();
      } else {
        const tgSel = bd.querySelector('#aa-tg');
        const selected = tgSel.selectedOptions[0];
        targetId = tgSel.value;
        assignmentType = selected?.dataset.type || 'GROUP';
      }
      if (!appId || !targetId) { bd.querySelector('#aa-err').innerHTML = errHtml('Application and target are required'); return; }
      try {
        await api.createAppAssignment({ appId, assignmentType, targetId });
        bd.remove(); await loadAssignTab(); await loadStats();
      } catch (e) { bd.querySelector('#aa-err').innerHTML = errHtml(e.message); }
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

  // ── Tab: Group Access Workflow ──
  async function loadWorkflowTab() {
    const area = wrap.querySelector('#tab-workflow');
    area.innerHTML = loading();
    try {
      await loadAppsAndGroups();
      const workflows = norm(await api.listAppAccessWorkflows());
      const rows = workflows.length ? workflows.map(w => {
        let levels = '—';
        try {
          const arr = typeof w.approval_levels === 'string' ? JSON.parse(w.approval_levels) : w.approval_levels;
          levels = Array.isArray(arr) ? arr.map(l => `L${l.level}:${l.approverType}`).join(' → ') : '—';
        } catch {}
        return `<tr>
          <td class="cell-strong">${esc(w.name)}</td>
          <td>${esc(w.app_name || '—')}</td>
          <td>${esc(w.tag_group_name || 'Any group')}</td>
          <td class="muted" style="font-size:0.8rem">${esc(levels)}</td>
          <td>${w.auto_provision ? '<span class="badge badge-success">Auto</span>' : '<span class="badge badge-neutral">Manual</span>'}</td>
          <td><button class="btn btn-sm btn-danger del-wf" data-id="${esc(String(w.id))}">Delete</button></td>
        </tr>`;
      }).join('') : `<tr><td colspan="6"><div class="empty-state"><p>No workflows configured.</p></div></td></tr>`;

      area.innerHTML = `
        <p class="muted aap-note">
          Users requesting access to application tag groups are routed through these approval chains before access is provisioned.
        </p>
        <button class="btn btn-primary" id="wf-new" style="margin-bottom:1rem">+ New Workflow</button>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Application</th><th>Tag Group</th><th>Approval Levels</th><th>Provisioning</th><th></th></tr></thead>
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
    const bd = openModal(`<div class="modal modal-wide"><div class="modal-header"><h2>New Group Access Workflow</h2></div><div class="modal-body">
      <div class="form-2col">
        <div class="form-group"><label class="form-label">Workflow Name</label><input class="form-input" id="wf-name"></div>
        <div class="form-group"><label class="form-label">Application</label><select class="form-select" id="wf-app">${appOpts}</select></div>
        <div class="form-group"><label class="form-label">Tag Group (optional)</label><select class="form-select" id="wf-tg">${tgOpts}</select></div>
        <div class="form-group"><label class="form-label">Auto-provision on approval</label>
          <select class="form-select" id="wf-auto"><option value="1">Yes</option><option value="0">No</option></select></div>
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
      <div class="form-group"><label class="form-label">Type</label><select class="form-select" id="v-stype"><option value="PASSWORD">PASSWORD</option><option value="SSH_KEY">SSH_KEY</option><option value="API_KEY">API_KEY</option><option value="TOKEN">TOKEN</option></select></div>
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
  content.replaceChildren(el(`<div>
    ${embed ? '' : header('SSO Reports', 'Login analytics, adoption and dormancy reports')}
    <div id="sso-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;
  try {
    const [summary, failed, adoption, dormant] = (await Promise.all([
      api.ssoLoginSummary(), api.ssoFailedLogins(), api.ssoAppAdoption(), api.ssoDormantUsers()
    ])).map(norm);

    const summaryRows = summary.map(r => `<tr><td>${esc(r.app||r.application||'—')}</td><td>${r.count ?? 0}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">No data</td></tr>`;
    const failedRows = failed.map(r => `<tr><td>${esc(r.email||'—')}</td><td>${r.count ?? 0}</td><td class="muted">${r.last_attempt ? fmtDate(r.last_attempt) : '—'}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">No data</td></tr>`;
    const adoptionRows = adoption.map(r => `<tr><td>${esc(r.app||r.application||'—')}</td><td>${r.entitled ?? 0}</td><td>${r.signed_in ?? 0}</td><td>${r.adoption_pct != null ? r.adoption_pct+'%' : '—'}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">No data</td></tr>`;
    const dormantRows = dormant.map(r => `<tr><td>${esc(r.email||'—')}</td><td class="muted">${r.last_login ? fmtDate(r.last_login) : 'Never'}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">No data</td></tr>`;

    wrap.querySelector('#sso-area').innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
            <h2 style="margin:0">Login Summary</h2>
            <button class="btn btn-sm btn-secondary" id="exp-summary">Export CSV</button>
          </div>
          <div class="table-wrap"><table><thead><tr><th>App</th><th>Logins</th></tr></thead><tbody>${summaryRows}</tbody></table></div>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
            <h2 style="margin:0">Failed Logins</h2>
            <button class="btn btn-sm btn-secondary" id="exp-failed">Export CSV</button>
          </div>
          <div class="table-wrap"><table><thead><tr><th>Email</th><th>Count</th><th>Last Attempt</th></tr></thead><tbody>${failedRows}</tbody></table></div>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
            <h2 style="margin:0">App Adoption</h2>
            <button class="btn btn-sm btn-secondary" id="exp-adoption">Export CSV</button>
          </div>
          <div class="table-wrap"><table><thead><tr><th>App</th><th>Entitled</th><th>Signed In</th><th>Adoption</th></tr></thead><tbody>${adoptionRows}</tbody></table></div>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
            <h2 style="margin:0">Dormant Users</h2>
            <button class="btn btn-sm btn-secondary" id="exp-dormant">Export CSV</button>
          </div>
          <div class="table-wrap"><table><thead><tr><th>Email</th><th>Last Login</th></tr></thead><tbody>${dormantRows}</tbody></table></div>
        </div>
      </div>`;

    wrap.querySelector('#exp-summary').addEventListener('click', () => csvDownload('login-summary.csv', [['App','Logins'], ...summary.map(r => [r.app||r.application||'', r.count||0])]));
    wrap.querySelector('#exp-failed').addEventListener('click', () => csvDownload('failed-logins.csv', [['Email','Count','Last Attempt'], ...failed.map(r => [r.email||'', r.count||0, r.last_attempt||''])]));
    wrap.querySelector('#exp-adoption').addEventListener('click', () => csvDownload('app-adoption.csv', [['App','Entitled','Signed In','Adoption %'], ...adoption.map(r => [r.app||r.application||'', r.entitled||0, r.signed_in||0, r.adoption_pct||''])]));
    wrap.querySelector('#exp-dormant').addEventListener('click', () => csvDownload('dormant-users.csv', [['Email','Last Login'], ...dormant.map(r => [r.email||'', r.last_login||'Never'])]));
  } catch(e) { wrap.querySelector('#sso-area').innerHTML = errHtml(e.message); }
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
          <div class="form-group"><label class="form-label">Default Session (hours)</label><input class="form-input" id="gs-ttl" type="number" value="${s.default_session_hours??8}"></div>
          <div class="form-group"><label class="form-label">Absolute Session Cap (hours)</label><input class="form-input" id="gs-abs" type="number" value="${s.session_absolute_hours??24}"></div>
          <h2 style="margin-top:1.5rem">Authentication</h2>
          <div class="form-group">
            <label class="form-check"><input type="checkbox" id="gs-local" ${chk(s.allow_local_login)}> Allow Local Login</label>
            <label class="form-check"><input type="checkbox" id="gs-google" ${chk(s.allow_google_login !== 0 && s.allow_google_login !== false)}> Allow Google Login</label>
          </div>
          <p class="muted" style="font-size:0.8rem;margin:0 0 0.75rem">MFA policy, lockout, and SMTP are configured via Strong Auth / env — not this form.</p>
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
          <div class="form-group"><label class="form-label">Logo URL</label><input class="form-input" id="br-logo" value="${esc(b.logo_url||'')}"></div>
          <div class="form-group"><label class="form-label">Favicon URL</label><input class="form-input" id="br-fav" value="${esc(b.favicon_url||'')}"></div>
          <div class="form-group"><label class="form-label">Accent Color</label><input type="color" class="form-input" id="br-color" value="${esc(b.accent_color||'#2563eb')}" style="height:2.5rem;padding:0.25rem"></div>
          <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" id="br-email" value="${esc(b.support_email||'')}"></div>
          <div class="form-group"><label class="form-label">Login Hero Title</label><input class="form-input" id="br-hero" value="${esc(heroTitle)}"></div>
          <div class="form-group"><label class="form-label">Login Hero Subtext</label><input class="form-input" id="br-sub" value="${esc(heroSub)}"></div>
          <div class="form-group"><label class="form-label">Login Background URL</label><input class="form-input" id="br-bg" value="${esc(b.login_bg_url||'')}"></div>
          <div class="form-group"><label class="form-label">Custom CSS</label><textarea class="form-textarea" id="br-css" rows="5" placeholder="/* Custom CSS overrides */">${esc(b.custom_css||'')}</textarea></div>
          <div id="br-msg"></div>
          <button class="btn btn-primary" id="br-save">Save Branding</button>
        </div>
        <div class="card">
          <h2>Preview</h2>
          <div id="br-preview" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:0.5rem">
            <div id="br-prev-header" style="background:${esc(b.accent_color||'#2563eb')};padding:2rem 1.5rem;text-align:center">
              <div style="font-size:1.25rem;font-weight:700;color:#fff" id="br-prev-title">${esc(orgName)}</div>
            </div>
            <div style="padding:1rem;background:#f9f9f9">
              <div style="font-size:0.8rem;font-weight:600;color:#333;text-align:center" id="br-prev-hero">${esc(heroTitle)}</div>
              <div style="margin-top:0.4rem;font-size:0.7rem;color:#888;text-align:center" id="br-prev-sub">${esc(heroSub)}</div>
              <div style="margin-top:1rem;background:#fff;border-radius:4px;padding:0.75rem;border:1px solid #e2e8f0">
                <div style="height:0.5rem;background:#e2e8f0;border-radius:2px;margin-bottom:0.5rem"></div>
                <div style="height:0.5rem;background:#e2e8f0;border-radius:2px;width:70%"></div>
                <div id="br-prev-btn" style="margin-top:0.75rem;height:1.5rem;border-radius:4px;background:${esc(b.accent_color||'#2563eb')}"></div>
              </div>
            </div>
          </div>
          <div style="margin-top:1rem;font-size:0.75rem;color:var(--muted)">Live preview updates as you type.</div>
        </div>
      </div>`;

    const colorInput = wrap.querySelector('#br-color');
    colorInput.addEventListener('input', () => {
      wrap.querySelector('#br-prev-header').style.background = colorInput.value;
      wrap.querySelector('#br-prev-btn').style.background = colorInput.value;
    });
    wrap.querySelector('#br-appname').addEventListener('input', e => { wrap.querySelector('#br-prev-title').textContent = e.target.value || 'Lenskart IdP'; });
    wrap.querySelector('#br-hero').addEventListener('input', e => { wrap.querySelector('#br-prev-hero').textContent = e.target.value; });
    wrap.querySelector('#br-sub').addEventListener('input', e => { wrap.querySelector('#br-prev-sub').textContent = e.target.value; });

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
      { name: 'OIDC Client Registry', status: 'progress' },
      { name: 'OIDC / OAuth Issuer', status: 'planned' },
      { name: 'Directory Sync', status: 'live' },
      { name: 'Connector Provisioning', status: 'progress' },
      { name: 'Attendance IGA', status: 'live' },
      { name: 'PAM / Vault (base64)', status: 'progress' },
      { name: 'Birthright Rules', status: 'progress' },
      { name: 'WebAuthn / Passkeys', status: 'planned' },
      { name: 'App Discovery', status: 'planned' },
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

export async function viewAttendanceIga(content) {
  content.replaceChildren(el(`<div class="aig-page">
    ${header('Attendance IGA', 'Automated access governance driven by daily punch-in compliance', `
      <div class="aig-actions">
        <button class="btn btn-secondary" id="aig-run-sftp">Run SFTP Import</button>
        <button class="btn btn-secondary" id="aig-run-api">Run API Import</button>
        <button class="btn btn-primary" id="aig-run-manual">Evaluate Rules</button>
      </div>
    `)}
    <div id="aig-status-bar" class="aig-status-bar">${loading()}</div>
    <div id="aig-stats" class="stat-grid aap-stats">${loading()}</div>
    <div class="cfg-tab-bar inline-tabs aig-tabs">
      <button type="button" class="cfg-tab inline-tab active" data-tab="dash">Overview</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="config">Configuration</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="imports">Import History</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="approvals">Approvals</button>
      <button type="button" class="cfg-tab inline-tab" data-tab="executions">Executions</button>
    </div>
    <div id="tab-dash"></div>
    <div id="tab-config" style="display:none"></div>
    <div id="tab-imports" style="display:none"></div>
    <div id="tab-approvals" style="display:none"></div>
    <div id="tab-executions" style="display:none"></div>
  </div>`));
  const wrap = content.firstChild;
  let configCache = null;

  async function loadStatusBar() {
    try {
      const c = configCache || await api.attendanceIgaConfig();
      configCache = c;
      wrap.querySelector('#aig-status-bar').innerHTML = `
        <div class="aig-status-left">
          ${aigStatusBadge(c.enabled, c.last_sync_status)}
          <div class="aig-status-meta">
            Source <strong>${esc(c.source_type || '—')}</strong>
            · Polling <strong>${esc(c.polling_interval || 'manual')}</strong>
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
      const d = await api.attendanceIgaDashboard();
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
      const d = await api.attendanceIgaDashboard();
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

  async function loadConfig() {
    const area = wrap.querySelector('#tab-config');
    area.innerHTML = loading();
    try {
      const c = await api.attendanceIgaConfig();
      configCache = c;
      const s = c.sftp_config || {};
      const ac = c.api_config || {};
      const hasToken = Boolean(c.api_auth_config?.token);
      const hasKey = Boolean(s.privateKey);
      const src = c.source_type || 'REST_API';
      const tz = ac.timezone || s.timezone || 'Asia/Kolkata';
      const offset = ac.dateOffsetDays ?? s.dateOffsetDays ?? 0;
      const lookback = ac.lookbackDays ?? s.lookbackDays ?? 1;
      const idField = c.identifier_field === 'EMPLOYEE_CODE' ? 'EMPLOYEE_ID' : (c.identifier_field || 'EMPLOYEE_ID');
      const actionMode = c.emergency_mode ? 'emergency' : (c.approval_enabled ? 'approval' : 'auto');
      const sftpAfter = s.archiveDir ? 'archive' : (s.deleteAfterFetch ? 'delete' : 'keep');

      area.innerHTML = `
        <div class="aig-settings">
          <aside class="aig-settings-nav">
            <div class="aig-settings-nav-label">Settings</div>
            <button type="button" class="aig-nav-item active" data-section="general"><span class="aig-nav-title">General</span><span class="aig-nav-desc">Source, schedule, rules</span></button>
            <button type="button" class="aig-nav-item" data-section="api"><span class="aig-nav-title">Truein API</span><span class="aig-nav-desc">Token &amp; endpoint</span></button>
            <button type="button" class="aig-nav-item" data-section="sftp"><span class="aig-nav-title">SFTP</span><span class="aig-nav-desc">Daily CSV file</span></button>
            <button type="button" class="aig-nav-item" data-section="manual"><span class="aig-nav-title">Manual Import</span><span class="aig-nav-desc">One-off CSV</span></button>
          </aside>
          <div class="aig-settings-main">
            <div class="aig-settings-scroll">
              <section class="aig-section active" data-section="general">
                <div class="aig-section-head">
                  <h3>General</h3>
                  <p>Choose how attendance is imported, when the job runs, and how access actions are approved.</p>
                </div>
                <div class="aig-source-cards">
                  <label class="aig-source-card ${src==='REST_API'?'active':''}"><input type="radio" name="aig-source" value="REST_API" ${src==='REST_API'?'checked':''}><strong>Truein API</strong><span>Fetch daily attendance with Bearer token + date</span></label>
                  <label class="aig-source-card ${src==='SFTP'?'active':''}"><input type="radio" name="aig-source" value="SFTP" ${src==='SFTP'?'checked':''}><strong>SFTP file</strong><span>Download dated CSV from drop folder</span></label>
                  <label class="aig-source-card ${src==='BOTH'?'active':''}"><input type="radio" name="aig-source" value="BOTH" ${src==='BOTH'?'checked':''}><strong>API + SFTP</strong><span>Merge both sources each run</span></label>
                  <label class="aig-source-card ${src==='FILE_UPLOAD'?'active':''}"><input type="radio" name="aig-source" value="FILE_UPLOAD" ${src==='FILE_UPLOAD'?'checked':''}><strong>Manual only</strong><span>Scheduler off — CSV upload when needed</span></label>
                </div>
                <input type="hidden" id="aig-source" value="${esc(src)}">
                <div class="aig-field-grid">
                  ${aigField('aig-enabled', 'Module', `<select class="form-select" id="aig-enabled"><option value="1" ${c.enabled?'selected':''}>Enabled</option><option value="0" ${!c.enabled?'selected':''}>Disabled</option></select>`)}
                  ${aigField('aig-poll', 'Schedule', `<select class="form-select" id="aig-poll"><option value="15m" ${c.polling_interval==='15m'?'selected':''}>Every 15 minutes</option><option value="5m" ${c.polling_interval==='5m'?'selected':''}>Every 5 minutes</option><option value="1h" ${c.polling_interval==='1h'?'selected':''}>Hourly</option><option value="1d" ${c.polling_interval==='1d'?'selected':''}>Daily</option><option value="manual" ${c.polling_interval==='manual'?'selected':''}>Manual only</option></select>`, 'Prefer a run after punch cutoff.')}
                  ${aigField('aig-timezone', 'Timezone', `<input class="form-input" id="aig-timezone" value="${esc(tz)}">`, 'Shared by API date, SFTP filename, weekend & cutoff checks.')}
                  ${aigField('aig-date-offset', 'Attendance date', `<select class="form-select" id="aig-date-offset"><option value="0" ${Number(offset)===0?'selected':''}>Today</option><option value="-1" ${Number(offset)===-1?'selected':''}>Yesterday</option></select>`, 'Which calendar day to fetch.')}
                  ${aigField('aig-lookback', 'Retry previous days', `<input class="form-input" id="aig-lookback" type="number" min="0" max="7" value="${esc(String(lookback))}">`, 'If today\'s feed is empty, try N prior days.')}
                  ${aigField('aig-id-field', 'Match employees by', `<select class="form-select" id="aig-id-field"><option value="EMPLOYEE_ID" ${idField==='EMPLOYEE_ID'?'selected':''}>Employee ID</option><option value="EMAIL" ${idField==='EMAIL'?'selected':''}>Email</option><option value="USERNAME" ${idField==='USERNAME'?'selected':''}>Username</option></select>`)}
                  ${aigField('aig-cutoff', 'Punch cutoff', `<input class="form-input" id="aig-cutoff" type="time" value="${esc(String(c.cutoff_time||'10:00:00').slice(0,5))}">`, 'No punch after this time may trigger suspend.')}
                  ${aigField('aig-days', 'Consecutive absences', `<input class="form-input" id="aig-days" type="number" min="1" max="30" value="${esc(String(c.consecutive_days??3))}">`, 'Working days without punch before disable.')}
                  <div class="span-2">${aigField('aig-action-mode', 'Action mode', `<select class="form-select" id="aig-action-mode"><option value="auto" ${actionMode==='auto'?'selected':''}>Auto-execute actions</option><option value="approval" ${actionMode==='approval'?'selected':''}>Require approval first</option><option value="emergency" ${actionMode==='emergency'?'selected':''}>Emergency — bypass approval</option></select>`, 'Replaces separate approval + emergency toggles.')}</div>
                </div>
              </section>

              <section class="aig-section" data-section="api">
                <div class="aig-section-head">
                  <h3>Truein API</h3>
                  <p>Bearer token authentication. Date is applied automatically from General settings.</p>
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
                  <p>Download a dated CSV. Filename tokens use the timezone and date from General.</p>
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
                  <p>One-off import when HR sends a file outside the scheduled feed.</p>
                </div>
                <div class="aig-csv-box">
                  <label class="form-label" for="aig-csv">Attendance CSV</label>
                  <textarea class="form-textarea" id="aig-csv" rows="8" placeholder="employee_id,email,date,in_time&#10;E001,user@company.com,2026-07-18,09:15"></textarea>
                  <span class="form-hint">Header row required. Columns must match the employee match field in General.</span>
                  <div class="aig-inline-actions">
                    <button class="btn btn-secondary" id="aig-upload-run">Import CSV &amp; run pipeline</button>
                  </div>
                </div>
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
          const mode = area.querySelector('#aig-action-mode').value;
          const sftpPayload = buildSftpPayload(area, s);
          const apiPayload = buildApiPayload(area, c);
          const cutoff = area.querySelector('#aig-cutoff').value;
          await api.updateAttendanceIgaConfig({
            enabled: Number(area.querySelector('#aig-enabled').value),
            source_type: area.querySelector('#aig-source').value,
            polling_interval: area.querySelector('#aig-poll').value,
            cutoff_time: cutoff.length === 5 ? cutoff + ':00' : cutoff,
            consecutive_days: Number(area.querySelector('#aig-days').value),
            approval_enabled: mode === 'approval' ? 1 : 0,
            emergency_mode: mode === 'emergency' ? 1 : 0,
            identifier_field: area.querySelector('#aig-id-field').value,
            ...apiPayload,
            ...(sftpPayload === null ? { sftp_config: null } : (sftpPayload ? { sftp_config: sftpPayload } : {})),
          });
          configCache = null;
          errBox.innerHTML = '<div class="alert alert-success">Configuration saved.</div>';
          await loadStats(); await loadStatusBar();
        } catch (e) { errBox.innerHTML = errHtml(e.message); }
      });
      area.querySelector('#aig-upload-run').addEventListener('click', async () => {
        const errBox = area.querySelector('#aig-cfg-err');
        try {
          const r = await api.runAttendanceIga({ source: 'FILE_UPLOAD', csvText: area.querySelector('#aig-csv').value });
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
      const rows = norm(await api.attendanceIgaImports());
      const statusBadge = s => ({ COMPLETED: 'badge-success', PARTIAL: 'badge-warning', FAILED: 'badge-danger', RUNNING: 'badge-info' }[s] || 'badge-neutral');
      area.innerHTML = `
        <div class="aap-actions"><div><h3 class="section-title">Import History</h3><p class="subtitle">Staging validation results for each pipeline run.</p></div></div>
        <div class="table-wrap aap-table"><table><thead><tr><th>Started</th><th>Source</th><th>Status</th><th>Total</th><th>OK</th><th>Failed</th><th>Dupes</th><th>Unmatched</th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr><td>${fmtDate(r.started_at)}</td><td><span class="badge badge-info">${esc(r.source)}</span></td><td><span class="badge ${statusBadge(r.status)}">${esc(r.status)}</span></td><td>${r.total_records}</td><td>${r.successful}</td><td>${r.failed}</td><td>${r.duplicates}</td><td>${r.unmatched}</td></tr>`).join('') : '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">◎</div><p>No imports yet.</p></div></td></tr>'}
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

  async function loadExecutions() {
    const area = wrap.querySelector('#tab-executions');
    area.innerHTML = loading();
    try {
      const rows = norm(await api.attendanceIgaExecutions());
      const statusBadge = s => ({ SUCCESS: 'badge-success', PARTIAL: 'badge-warning', FAILED: 'badge-danger' }[s] || 'badge-neutral');
      area.innerHTML = `
        <div class="aap-actions"><div><h3 class="section-title">Action Executions</h3><p class="subtitle">Audit trail of suspend, disable, and access removal actions.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Employee</th><th>Rule</th><th>Status</th><th>Actions</th><th></th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr>
          <td class="muted">${fmtDate(r.executed_at)}</td><td class="cell-strong">${esc(r.full_name||r.emp_id)}</td><td>${esc(r.rule_key)}</td>
          <td><span class="badge ${statusBadge(r.status)}">${esc(r.status)}</span></td>
          <td class="muted" style="font-size:0.78rem;max-width:220px">${esc(String(r.actions_taken||''))}</td>
          <td>${r.rolled_back ? '<span class="badge badge-neutral">Rolled back</span>' : `<button class="btn btn-sm btn-secondary aig-rb" data-id="${esc(r.id)}">Rollback</button>`}</td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty-state"><p>No executions yet.</p></div></td></tr>'}
      </tbody></table></div>`;
      area.querySelectorAll('.aig-rb').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Restore access from rollback snapshot?')) return;
          try { await api.rollbackAttendanceIgaExecution(btn.dataset.id); await loadExecutions(); await loadStats(); }
          catch (e) { alert(e.message); }
        });
      });
    } catch (e) { area.innerHTML = errHtml(e.message); }
  }

  wrap.querySelectorAll('.aig-tabs .cfg-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      wrap.querySelectorAll('.aig-tabs .cfg-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      ['dash','config','imports','approvals','executions'].forEach(id => {
        wrap.querySelector(`#tab-${id}`).style.display = id === name ? '' : 'none';
      });
      if (name === 'dash') await loadDash();
      if (name === 'config') await loadConfig();
      if (name === 'imports') await loadImports();
      if (name === 'approvals') await loadApprovals();
      if (name === 'executions') await loadExecutions();
    });
  });

  async function runPipeline(source, label) {
    try {
      const r = await api.runAttendanceIga({ source });
      alert(`${label}: ${r.status}\n${r.report?.successful ?? 0} records imported · ${r.executions ?? 0} actions · ${r.approvalsCreated ?? 0} approvals`);
      await loadStats(); await loadStatusBar(); await loadDash(); await loadImports();
    } catch (e) { alert(e.message); }
  }

  wrap.querySelector('#aig-run-api').addEventListener('click', () => runPipeline('REST_API', 'API import'));
  wrap.querySelector('#aig-run-sftp').addEventListener('click', () => runPipeline('SFTP', 'SFTP import'));
  wrap.querySelector('#aig-run-manual').addEventListener('click', async () => {
    try {
      const r = await api.runAttendanceIga({ source: 'MANUAL', emergencyMode: false });
      alert(`Rule evaluation ${r.status}: ${r.evaluations} employees evaluated`);
      await loadStats(); await loadDash();
    } catch (e) { alert(e.message); }
  });

  await loadStatusBar();
  await loadStats();
  await loadDash();
}
