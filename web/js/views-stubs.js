import { api } from './api.js';
import { el, esc, fmtDate } from './ui.js';
import { icon as svgIcon } from './icons.js';

function header(title, subtitle, action = '') {
  return `<div class="page-header"><div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${action}</div>`;
}

function statCard(iconName, label, value, sub = '', cls = 'primary') {
  return `<div class="stat-card">
    <div class="stat-icon ${cls}">${svgIcon(iconName)}</div>
    <div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
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

/* Normalise backend responses — all list endpoints return {data:[...]} */
const norm = r => Array.isArray(r) ? r : (r?.data ?? []);

// ─── 1. Groups ────────────────────────────────────────────────────────────────
export async function viewGroups(content) {
  content.replaceChildren(el(`<div>${header('Groups', 'Manage static and dynamic groups', `<button class="btn btn-primary" id="new-group-btn">+ New Group</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const groups = norm(await api.listGroups());
      const rows = groups.length ? groups.map(g => `
        <tr>
          <td class="cell-strong">${esc(g.name)}</td>
          <td>${g.type === 'STATIC' ? '<span class="badge badge-info">STATIC</span>' : '<span class="badge badge-success">DYNAMIC</span>'}</td>
          <td>${g.member_count ?? 0}</td>
          <td>${g.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td><button class="btn btn-sm btn-danger del-group" data-id="${esc(String(g.id))}">Delete</button></td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No groups yet.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Members</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-group').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this group?')) return;
          try { await api.deleteGroup(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  wrap.querySelector('#new-group-btn').addEventListener('click', () => {
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

  await load();
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
          <td class="muted">${esc(u.resource_id || '—')}</td>
          <td class="muted">${u.created_at ? fmtDate(u.created_at) : '—'}</td>
          <td><button class="btn btn-sm btn-danger del-su" data-id="${esc(String(u.id))}">Delete</button></td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No service accounts.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Username</th><th>Type</th><th>Resource</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
      <div class="form-group"><label class="form-label">Type</label><select class="form-select" id="su-type"><option>SERVICE</option><option>BOT</option><option>INTEGRATION</option></select></div>
      <div class="form-group"><label class="form-label">Resource ID</label><input class="form-input" id="su-res" placeholder="Optional resource ID"></div>
      <div id="su-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="su-save">Create</button><button class="btn btn-secondary" id="su-cancel">Cancel</button></div></div>`);
    bd.querySelector('#su-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#su-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#su-user').value, type: bd.querySelector('#su-type').value, resource_id: bd.querySelector('#su-res').value };
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
          <td>${p.priority ?? '—'}</td>
          <td>${p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-ip" data-id="${esc(String(p.id))}" data-name="${esc(p.name)}" data-desc="${esc(p.description||'')}" data-src="${esc(p.population||p.source_type||'')}" data-pri="${esc(String(p.priority||0))}">Edit</button>
            <button class="btn btn-sm btn-danger del-ip" data-id="${esc(String(p.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No identity profiles.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Source Type</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

      wrap.querySelectorAll('.del-ip').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this profile?')) return;
          try { await api.deleteIdentityProfile(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-ip').forEach(btn => {
        btn.addEventListener('click', () => openIpModal(btn.dataset.id, { name: btn.dataset.name, description: btn.dataset.desc, population: btn.dataset.src, priority: btn.dataset.pri }));
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
      <div class="form-group"><label class="form-label">Priority</label><input class="form-input" id="ip-pri" type="number" value="${esc(String(defaults.priority||1))}"></div>
      <div id="ip-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="ip-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="ip-cancel">Cancel</button></div></div>`);
    bd.querySelector('#ip-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#ip-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#ip-name').value, description: bd.querySelector('#ip-desc').value, population: bd.querySelector('#ip-src').value, priority: parseInt(bd.querySelector('#ip-pri').value) || 1 };
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
  content.replaceChildren(el(`<div>${header('MFA Methods', 'Multi-factor authentication enrollment and policy')}<div id="mfa-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const status = await api.mfaStatus();
    const methods = [
      { key: 'totp', label: 'Authenticator App (TOTP)', badge: 'badge-success', badgeText: '● Live', desc: 'Time-based one-time passwords via Google Authenticator, Authy, etc.' },
      { key: 'backup_codes', label: 'Backup Codes', badge: 'badge-success', badgeText: '● Live', desc: 'Single-use emergency recovery codes.' },
      { key: 'webauthn', label: 'WebAuthn / Passkeys', badge: 'badge-info', badgeText: '◍ Schema', desc: 'Hardware security keys and biometric passkeys.' },
      { key: 'email_otp', label: 'Email OTP', badge: 'badge-warning', badgeText: '○ Planned', desc: 'One-time code sent to registered email address.' },
      { key: 'sms_otp', label: 'SMS OTP', badge: 'badge-warning', badgeText: '○ Planned', desc: 'One-time code sent via SMS.' },
    ];
    const enrolled = status?.methods || [];
    const cards = methods.map(m => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
          <strong>${esc(m.label)}</strong>
          <span class="badge ${m.badge}">${m.badgeText}</span>
        </div>
        <p class="muted" style="font-size:0.875rem;margin-bottom:0.75rem">${esc(m.desc)}</p>
        ${enrolled.includes(m.key) ? '<span class="badge badge-success">Enrolled</span>' : '<span class="badge badge-neutral">Not enrolled</span>'}
      </div>`).join('');
    const liveOrSchemaCount = methods.filter(m=>['badge-success','badge-info'].includes(m.badge)).length;
    const enrolledCount = enrolled.length;
    const enrollmentBadge = status?.enabled
      ? '<span class="badge badge-success">Active</span>'
      : status?.enrolled
        ? '<span class="badge badge-warning">Pending</span>'
        : '<span class="badge badge-neutral">Not enrolled</span>';
    wrap.querySelector('#mfa-area').innerHTML = `
      <div class="stat-grid" style="margin-bottom:1.5rem">
        ${statCard('shieldCheck', 'Methods Enrolled', enrolledCount,    enrollmentBadge,                'primary')}
        ${statCard('check',       'Live / Schema',   liveOrSchemaCount, 'available now',                'success')}
        ${statCard('bolt',        'Planned',         2,                 'arriving in next milestone',   'warning')}
      </div>
      <div class="grid-3">${cards}</div>
      <div style="margin-top:1rem"><a href="/?v=settings" class="btn btn-primary">Manage Enrollment →</a></div>`;
  } catch(e) { wrap.querySelector('#mfa-area').innerHTML = errHtml(e.message); }
}

// ─── 5. Adaptive Auth ─────────────────────────────────────────────────────────
export async function viewAdaptiveAuth(content) {
  content.replaceChildren(el(`<div>${header('Adaptive Authentication', 'Risk-based authentication policies', `<button class="btn btn-primary" id="new-aa-btn">+ New Policy</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const policies = norm(await api.listAdaptivePolicies());
      const actionBadge = a => ({ ALLOW: 'badge-success', MFA_REQUIRED: 'badge-warning', DENY: 'badge-danger', BLOCK: 'badge-danger' }[a] || 'badge-neutral');
      const rows = policies.length ? policies.map(p => {
        let condSummary = '';
        try { const c = JSON.parse(p.conditions_json || '{}'); condSummary = Object.keys(c).join(', ') || '—'; } catch { condSummary = '—'; }
        return `<tr>
          <td class="cell-strong">${esc(p.name)}</td>
          <td class="muted" style="font-size:0.8rem">${esc(condSummary)}</td>
          <td><span class="badge ${actionBadge(p.action)}">${esc(p.action)}</span></td>
          <td>${p.priority ?? '—'}</td>
          <td>${p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-aa" data-id="${esc(String(p.id))}" data-name="${esc(p.name)}" data-desc="${esc(p.description||'')}" data-cond="${esc(p.conditions_json||'{}')}" data-action="${esc(p.action||'ALLOW')}" data-pri="${esc(String(p.priority||0))}">Edit</button>
            <button class="btn btn-sm btn-danger del-aa" data-id="${esc(String(p.id))}">Delete</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No adaptive policies.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Conditions</th><th>Action</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-aa').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this policy?')) return;
          try { await api.deleteAdaptivePolicy(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-aa').forEach(btn => {
        btn.addEventListener('click', () => openAaModal(btn.dataset.id, { name: btn.dataset.name, description: btn.dataset.desc, conditions_json: btn.dataset.cond, action: btn.dataset.action, priority: btn.dataset.pri }));
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openAaModal(id, defaults = {}) {
    const isEdit = !!id;
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Adaptive Policy</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="aa-name" value="${esc(defaults.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="aa-desc" value="${esc(defaults.description||'')}"></div>
      <div class="form-group"><label class="form-label">Conditions JSON</label><textarea class="form-textarea" id="aa-cond" rows="4">${esc(defaults.conditions_json||'{}')}</textarea></div>
      <div class="form-group"><label class="form-label">Action</label><select class="form-select" id="aa-action">
        <option ${defaults.action==='ALLOW'?'selected':''}>ALLOW</option>
        <option ${defaults.action==='MFA_REQUIRED'?'selected':''}>MFA_REQUIRED</option>
        <option ${defaults.action==='DENY'?'selected':''}>DENY</option>
        <option ${defaults.action==='BLOCK'?'selected':''}>BLOCK</option>
      </select></div>
      <div class="form-group"><label class="form-label">Priority</label><input class="form-input" id="aa-pri" type="number" value="${esc(String(defaults.priority||10))}"></div>
      <div id="aa-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="aa-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="aa-cancel">Cancel</button></div></div>`);
    bd.querySelector('#aa-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#aa-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#aa-name').value, description: bd.querySelector('#aa-desc').value, conditions_json: bd.querySelector('#aa-cond').value, action: bd.querySelector('#aa-action').value, priority: parseInt(bd.querySelector('#aa-pri').value)||10 };
      if (!data.name) { bd.querySelector('#aa-err').innerHTML = errHtml('Name required'); return; }
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
          <td>${[p.require_upper && 'U', p.require_lower && 'l', p.require_digit && '0', p.require_special && '#'].filter(Boolean).join(' ')}</td>
          <td>${p.max_age_days ?? '—'}</td>
          <td>${p.history_count ?? '—'}</td>
          <td>${p.lockout_threshold ?? '—'}</td>
          <td>${p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-pp" data-p='${JSON.stringify({id:p.id,name:p.name,min_length:p.min_length,require_upper:p.require_upper,require_lower:p.require_lower,require_digit:p.require_digit,require_special:p.require_special,max_age_days:p.max_age_days,history_count:p.history_count,lockout_threshold:p.lockout_threshold,lockout_duration_minutes:p.lockout_duration_minutes})}'>Edit</button>
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
      <div class="form-group"><label class="form-label">Min Length</label><input class="form-input" id="pp-minlen" type="number" value="${d.min_length||8}"></div>
      <div class="form-group" style="display:flex;gap:1rem;flex-wrap:wrap">
        <label class="form-check"><input type="checkbox" id="pp-upper" ${chk(d.require_upper)}> Uppercase</label>
        <label class="form-check"><input type="checkbox" id="pp-lower" ${chk(d.require_lower)}> Lowercase</label>
        <label class="form-check"><input type="checkbox" id="pp-digit" ${chk(d.require_digit)}> Digit</label>
        <label class="form-check"><input type="checkbox" id="pp-special" ${chk(d.require_special)}> Special char</label>
      </div>
      <div class="form-group"><label class="form-label">Max Age (days)</label><input class="form-input" id="pp-maxage" type="number" value="${d.max_age_days||90}"></div>
      <div class="form-group"><label class="form-label">History Count</label><input class="form-input" id="pp-hist" type="number" value="${d.history_count||5}"></div>
      <div class="form-group"><label class="form-label">Lockout Threshold</label><input class="form-input" id="pp-lock" type="number" value="${d.lockout_threshold||5}"></div>
      <div class="form-group"><label class="form-label">Lockout Duration (min)</label><input class="form-input" id="pp-lockdur" type="number" value="${d.lockout_duration_minutes||15}"></div>
      <div id="pp-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="pp-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="pp-cancel">Cancel</button></div></div>`);
    bd.querySelector('#pp-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#pp-save').addEventListener('click', async () => {
      const data = {
        name: bd.querySelector('#pp-name').value,
        min_length: parseInt(bd.querySelector('#pp-minlen').value)||8,
        require_upper: bd.querySelector('#pp-upper').checked,
        require_lower: bd.querySelector('#pp-lower').checked,
        require_digit: bd.querySelector('#pp-digit').checked,
        require_special: bd.querySelector('#pp-special').checked,
        max_age_days: parseInt(bd.querySelector('#pp-maxage').value)||90,
        history_count: parseInt(bd.querySelector('#pp-hist').value)||5,
        lockout_threshold: parseInt(bd.querySelector('#pp-lock').value)||5,
        lockout_duration_minutes: parseInt(bd.querySelector('#pp-lockdur').value)||15,
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

// ─── 7. Login Customization ───────────────────────────────────────────────────
export async function viewLoginCustomization(content) {
  content.replaceChildren(el(`<div>${header('Login Customization', 'Customize the login page appearance')}<div id="lc-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const b = await api.getBranding();
    wrap.querySelector('#lc-area').innerHTML = `
      <div class="grid-3">
        <div class="card" style="grid-column:span 2">
          <h2>Login Page Settings</h2>
          <div class="form-group"><label class="form-label">App Name</label><input class="form-input" id="lc-appname" value="${esc(b.app_name||'Lenskart IdP')}"></div>
          <div class="form-group"><label class="form-label">Logo URL</label><input class="form-input" id="lc-logo" value="${esc(b.logo_url||'')}"></div>
          <div class="form-group"><label class="form-label">Favicon URL</label><input class="form-input" id="lc-fav" value="${esc(b.favicon_url||'')}"></div>
          <div class="form-group"><label class="form-label">Accent Color</label><input type="color" class="form-input" id="lc-color" value="${esc(b.accent_color||'#4f46e5')}" style="height:2.5rem;padding:0.25rem"></div>
          <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" id="lc-email" value="${esc(b.support_email||'')}"></div>
          <div class="form-group"><label class="form-label">Footer Text</label><input class="form-input" id="lc-footer" value="${esc(b.footer_text||'')}"></div>
          <div class="form-group"><label class="form-label">Hero Heading</label><input class="form-input" id="lc-hero" value="${esc(b.login_hero_heading||'')}"></div>
          <div class="form-group"><label class="form-label">Hero Subtext</label><input class="form-input" id="lc-sub" value="${esc(b.login_hero_subtext||'')}"></div>
          <div id="lc-msg"></div>
          <button class="btn btn-primary" id="lc-save">Save Changes</button>
        </div>
        <div class="card">
          <h2>Preview</h2>
          <div id="lc-preview" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:0.5rem">
            <div id="lc-prev-header" style="background:${esc(b.accent_color||'#4f46e5')};padding:1.5rem;text-align:center">
              <div style="font-size:1.25rem;font-weight:700;color:#fff" id="lc-prev-title">${esc(b.app_name||'Lenskart IdP')}</div>
            </div>
            <div style="padding:1rem;background:#f9f9f9">
              <div style="font-size:0.75rem;color:#666;text-align:center" id="lc-prev-hero">${esc(b.login_hero_heading||'Sign in to continue')}</div>
              <div style="margin-top:0.5rem;font-size:0.7rem;color:#999;text-align:center" id="lc-prev-sub">${esc(b.login_hero_subtext||'')}</div>
            </div>
          </div>
        </div>
      </div>`;

    const colorInput = wrap.querySelector('#lc-color');
    colorInput.addEventListener('input', () => {
      wrap.querySelector('#lc-prev-header').style.background = colorInput.value;
    });
    wrap.querySelector('#lc-appname').addEventListener('input', (e) => {
      wrap.querySelector('#lc-prev-title').textContent = e.target.value || 'Lenskart IdP';
    });
    wrap.querySelector('#lc-hero').addEventListener('input', (e) => {
      wrap.querySelector('#lc-prev-hero').textContent = e.target.value;
    });
    wrap.querySelector('#lc-sub').addEventListener('input', (e) => {
      wrap.querySelector('#lc-prev-sub').textContent = e.target.value;
    });

    wrap.querySelector('#lc-save').addEventListener('click', async () => {
      const data = {
        app_name: wrap.querySelector('#lc-appname').value,
        logo_url: wrap.querySelector('#lc-logo').value,
        favicon_url: wrap.querySelector('#lc-fav').value,
        accent_color: wrap.querySelector('#lc-color').value,
        support_email: wrap.querySelector('#lc-email').value,
        footer_text: wrap.querySelector('#lc-footer').value,
        login_hero_heading: wrap.querySelector('#lc-hero').value,
        login_hero_subtext: wrap.querySelector('#lc-sub').value,
      };
      try {
        await api.saveBranding(data);
        wrap.querySelector('#lc-msg').innerHTML = `<div class="alert alert-success">Saved successfully.</div>`;
        setTimeout(() => { if (wrap.querySelector('#lc-msg')) wrap.querySelector('#lc-msg').innerHTML = ''; }, 3000);
      } catch(e) { wrap.querySelector('#lc-msg').innerHTML = errHtml(e.message); }
    });
  } catch(e) { wrap.querySelector('#lc-area').innerHTML = errHtml(e.message); }
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

// ─── 8. OIDC / OAuth Applications ────────────────────────────────────────────
// Single unified page: registered clients + pre-built catalog (no tabs)
export async function viewOidcApps(content) {
  content.replaceChildren(el(`<div>
    ${header('OIDC / OAuth Applications',
      'OAuth 2.0 and OpenID Connect — registered clients and pre-built integrations',
      `<button class="btn btn-primary" id="new-oidc-btn">+ Register Custom App</button>`)}

    <!-- ── Registered Clients ───────────────────────────────────────────── -->
    <div id="list-area" style="margin-bottom:2.5rem">${loading()}</div>

    <!-- ── Pre-built Integrations Catalog ──────────────────────────────── -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <div>
        <h2 style="margin:0;font-size:1.05rem;font-weight:700">Pre-built Integrations</h2>
        <p class="muted" style="margin:0.2rem 0 0;font-size:0.82rem">
          ${SSO_CATALOG.length} integrations — click to auto-configure
        </p>
      </div>
      <div style="display:flex;gap:0.6rem;align-items:center">
        <input class="form-input" id="cat-search" placeholder="Search integrations…" style="max-width:220px">
      </div>
    </div>
    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem" id="cat-filters">
      ${['All',...new Set(SSO_CATALOG.map(a=>a.cat))].map(c =>
        `<button class="btn btn-sm ${c==='All'?'btn-primary':'btn-secondary'} cat-filter" data-cat="${esc(c)}">${esc(c)}</button>`
      ).join('')}
    </div>
    <div id="cat-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:0.85rem"></div>
  </div>`));
  const wrap = content.firstChild;

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
            <button class="btn btn-sm btn-secondary rotate-oidc" data-id="${esc(String(c.id))}" data-name="${esc(c.name||c.client_name||'')}">↻ Rotate</button>
            <button class="btn btn-sm btn-danger del-oidc" data-id="${esc(String(c.id))}">Delete</button>
          </td>
        </tr>`).join('')
        : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No OIDC clients registered yet — use the pre-built integrations below or register a custom app.</p></div></td></tr>`;

      const clientCount = clients.length;
      wrap.querySelector('#list-area').innerHTML = `
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem">
          <h2 style="margin:0;font-size:1.05rem;font-weight:700">Registered Clients
            ${clientCount ? `<span class="badge badge-info" style="font-size:0.75rem;margin-left:0.4rem">${clientCount}</span>` : ''}
          </h2>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>App Name</th><th>Client ID</th><th>Grant Types</th><th>Redirect URIs</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;

      wrap.querySelector('#new-oidc-btn').addEventListener('click', () => openRegisterModal());

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
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  // ── parse JSON-stored arrays (DB stores as JSON strings) ────────────────────
  function parseJsonArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }

  // ── register modal (custom or from catalog) ─────────────────────────────────
  function openRegisterModal(prefill = {}) {
    const bd = openModal(`<div class="modal" style="width:580px;max-width:96vw">
      <div class="modal-header"><h2>${prefill.name ? 'Add — ' + esc(prefill.name) : 'Register OIDC Application'}</h2></div>
      <div class="modal-body">
        ${prefill.hint ? `<div class="info-box" style="margin-bottom:1rem">ℹ️ ${esc(prefill.hint)}</div>` : ''}
        <div class="form-2col">
          <div class="form-group span2">
            <label class="form-label">Application Name <span style="color:var(--danger)">*</span></label>
            <input class="form-input" id="oidc-name" value="${esc(prefill.name||'')}" placeholder="e.g. Slack">
          </div>
          <div class="form-group span2">
            <label class="form-label">Redirect URIs <span class="muted" style="font-weight:400">(one per line)</span></label>
            <textarea class="form-textarea" id="oidc-uris" rows="3" placeholder="https://app.example.com/callback&#10;https://app.example.com/auth/callback">${esc((prefill.redirect_uris||[]).join('\n'))}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Grant Types</label>
            <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-code" ${(prefill.grants||['authorization_code']).includes('authorization_code')?'checked':''}><label for="gt-code">authorization_code</label></div>
            <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-refresh" ${(prefill.grants||[]).includes('refresh_token')?'checked':''}><label for="gt-refresh">refresh_token</label></div>
            <div class="form-check-row"><input type="checkbox" class="form-check" id="gt-creds" ${(prefill.grants||[]).includes('client_credentials')?'checked':''}><label for="gt-creds">client_credentials</label></div>
          </div>
          <div class="form-group">
            <label class="form-label">Scopes</label>
            ${['openid','email','profile','groups','roles'].map(s => `
            <div class="form-check-row"><input type="checkbox" class="form-check" id="sc-${s}" ${(prefill.scopes||['openid','email','profile']).includes(s)?'checked':''}><label for="sc-${s}">${esc(s)}</label></div>`).join('')}
          </div>
        </div>
        <div id="oidc-err"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="oidc-save">Register Application</button>
        <button class="btn btn-secondary" id="oidc-cancel">Cancel</button>
      </div>
    </div>`);

    bd.querySelector('#oidc-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#oidc-save').addEventListener('click', async () => {
      const saveBtn = bd.querySelector('#oidc-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Registering…';
      const grants = [];
      if (bd.querySelector('#gt-code').checked)    grants.push('authorization_code');
      if (bd.querySelector('#gt-refresh').checked) grants.push('refresh_token');
      if (bd.querySelector('#gt-creds').checked)   grants.push('client_credentials');
      const scopes = ['openid','email','profile','groups','roles'].filter(s => bd.querySelector(`#sc-${s}`)?.checked);
      const urisRaw = bd.querySelector('#oidc-uris').value;
      const data = {
        name: bd.querySelector('#oidc-name').value.trim(),     // backend expects 'name' not 'client_name'
        redirect_uris: urisRaw.split('\n').map(s => s.trim()).filter(Boolean),
        grant_types: grants,
        scopes,
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      };
      if (!data.name) { bd.querySelector('#oidc-err').innerHTML = errHtml('Application name is required'); saveBtn.disabled=false; saveBtn.textContent='Register Application'; return; }
      try {
        const result = await api.createOidcClient(data);
        bd.remove();
        showSecretModal(result.client_id, result.client_secret, async () => {
          // Switch to My Applications tab and reload
          wrap.querySelectorAll('.inline-tab')[0].click();
          await load();
        });
      } catch(e) {
        bd.querySelector('#oidc-err').innerHTML = errHtml(e.message);
        saveBtn.disabled=false; saveBtn.textContent='Register Application';
      }
    });
  }

  // ── show secret in modal ────────────────────────────────────────────────────
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

  // ── Inline Pre-built Integrations catalog ──────────────────────────────────
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

    wrap.querySelector('#cat-grid').innerHTML = visible.map(app => `
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
      || `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><p>No integrations match "${esc(q)}"</p></div>`;

    wrap.querySelectorAll('[data-app]').forEach(btn => {
      btn.addEventListener('click', () => {
        const app = SSO_CATALOG.find(a => a.id === btn.dataset.app);
        if (!app) return;
        if (app.protocol === 'SAML') {
          openModal(`<div class="modal"><div class="modal-header"><h2>${esc(app.name)} — SAML 2.0</h2></div>
            <div class="modal-body">
              <div class="info-box">ℹ️ ${esc(app.name)} uses <strong>SAML 2.0</strong>. Configure it under
                <strong>SAML Applications</strong>, then paste the IdP metadata URL below into ${esc(app.name)}'s SSO settings.</div>
              <div class="form-group"><label class="form-label">IdP Metadata URL</label>
                <input class="form-input" value="${esc(window.location.origin)}/auth/saml/metadata" readonly onclick="this.select()"></div>
              <div class="form-group"><label class="form-label">IdP SSO URL</label>
                <input class="form-input" value="${esc(window.location.origin)}/auth/saml/sso" readonly onclick="this.select()"></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-primary" onclick="this.closest('.modal-backdrop').remove(); window.LILG_NAV && window.LILG_NAV('saml-apps');">Go to SAML Apps →</button>
              <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Close</button>
            </div>
          </div>`);
        } else {
          openRegisterModal({ name: app.name, scopes: app.scopes, grants: app.grants, hint: app.hint });
        }
      });
    });
  }

  // Wire catalog search + category filters
  wrap.querySelector('#cat-search').addEventListener('input', e => { searchQ = e.target.value; renderGrid(); });
  wrap.querySelectorAll('.cat-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCat = btn.dataset.cat;
      wrap.querySelectorAll('.cat-filter').forEach(b => {
        b.classList.toggle('btn-primary',   b.dataset.cat === activeCat);
        b.classList.toggle('btn-secondary', b.dataset.cat !== activeCat);
      });
      renderGrid();
    });
  });

  renderGrid();
  await load();
}

// ─── 9. App Discovery ─────────────────────────────────────────────────────────
export async function viewAppDiscovery(content) {
  content.replaceChildren(el(`<div>${header('App Discovery', 'Shadow IT and application usage discovery')}<div id="disc-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const r = await api.igaConnectors();
    // igaConnectors returns { data: [...] } — normalise to array
    const allConnectors = Array.isArray(r) ? r : (r && r.data ? r.data : []);
    const disc = allConnectors.filter(c => (c.connector_type || c.type || '') === 'DISCOVERY');
    wrap.querySelector('#disc-area').innerHTML = `
      <div class="card" style="margin-bottom:1rem;display:flex;gap:1rem;align-items:flex-start">
        <div style="font-size:2rem">🔭</div>
        <div>
          <strong>Shadow IT Discovery</strong>
          <p class="muted" style="margin-top:0.25rem">Automatic discovery by analysing SSO logs, Google Workspace audit trails, and proxy logs surfaces unsanctioned SaaS in use across your organisation. Currently, register connectors of type DISCOVERY below; full log-ingestion ships in Phase 5.</p>
        </div>
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
const CONNECTOR_TYPES = {
  AD:               { label: 'Active Directory', icon: '🏢', badge: 'badge-info',    desc: 'Microsoft Active Directory / LDAP',           fields: ['host','port','bindDn','bindPassword','baseDn','useSsl'] },
  LDAP:             { label: 'LDAP',             icon: '📂', badge: 'badge-info',    desc: 'Generic LDAP v3 directory server',             fields: ['host','port','bindDn','bindPassword','baseDn','useSsl'] },
  GOOGLE_WORKSPACE: { label: 'Google Workspace', icon: '🔵', badge: 'badge-success', desc: 'Google Workspace / G Suite directory',          fields: ['customerDomain','serviceAccountEmail','serviceAccountKey','adminEmail'] },
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
  baseDn:             'Base DN',
  useSsl:             'Use SSL/TLS',
  customerDomain:     'Customer Domain',
  serviceAccountEmail:'Service Account Email',
  serviceAccountKey:  'Service Account JSON Key',
  adminEmail:         'Admin Email (for impersonation)',
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

export async function viewDirectorySync(content) {
  // ── tab shell ────────────────────────────────────────────────────────────────
  content.replaceChildren(el(`<div>
    ${header('Universal Directory', 'Manage identity sources and all user identities across AD, Google, local and more')}
    <div class="tabs" style="margin-bottom:1.5rem">
      <button class="tab active" data-tab="sources">🔌 Directory Sources</button>
      <button class="tab" data-tab="users">👤 Users</button>
    </div>
    <div id="tab-sources"></div>
    <div id="tab-users" style="display:none"></div>
  </div>`));
  const wrap = content.firstChild;

  // ── tab switching ────────────────────────────────────────────────────────────
  wrap.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      wrap.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      wrap.querySelector('#tab-sources').style.display = t.dataset.tab === 'sources' ? '' : 'none';
      wrap.querySelector('#tab-users').style.display = t.dataset.tab === 'users' ? '' : 'none';
    });
  });

  // ── initialise both tabs ─────────────────────────────────────────────────────
  initSourcesTab(wrap.querySelector('#tab-sources'));
  initUsersTab(wrap.querySelector('#tab-users'));
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  TAB 1: Directory Sources (connector management)            ║
// ╚══════════════════════════════════════════════════════════════╝
function initSourcesTab(panel) {
  panel.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:1rem">
      <button class="btn btn-primary" id="ds-add-btn">+ Add Directory Source</button>
    </div>
    <div id="ds-stats" style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1.5rem"></div>
    <div id="ds-area">${loading()}</div>`;

  // ── render connector cards ──────────────────────────────────────────────────
  async function load() {
    try {
      const r = await api.igaConnectors();
      const connectors = (r && r.data) ? r.data : (Array.isArray(r) ? r : []);

      // stats bar
      const total  = connectors.length;
      const active = connectors.filter(c => ['CONNECTED','ACTIVE'].includes(c.status)).length;
      const errors = connectors.filter(c => c.status === 'ERROR').length;
      const lastSync = connectors.reduce((best, c) => {
        if (!c.last_sync_at) return best;
        return !best || new Date(c.last_sync_at) > new Date(best) ? c.last_sync_at : best;
      }, null);
      panel.querySelector('#ds-stats').innerHTML = `
        <div class="card" style="text-align:center;padding:1rem">
          <div style="font-size:1.75rem;font-weight:700;color:var(--accent)">${total}</div>
          <div class="muted" style="font-size:0.8rem;margin-top:0.25rem">Total Sources</div>
        </div>
        <div class="card" style="text-align:center;padding:1rem">
          <div style="font-size:1.75rem;font-weight:700;color:var(--success)">${active}</div>
          <div class="muted" style="font-size:0.8rem;margin-top:0.25rem">Connected</div>
        </div>
        <div class="card" style="text-align:center;padding:1rem">
          <div style="font-size:1.75rem;font-weight:700;color:${errors?'var(--danger)':'var(--text-dim)'}">${errors}</div>
          <div class="muted" style="font-size:0.8rem;margin-top:0.25rem">Errors</div>
        </div>
        <div class="card" style="text-align:center;padding:1rem">
          <div style="font-size:1rem;font-weight:600;color:var(--text)">${lastSync ? fmtDate(lastSync) : '—'}</div>
          <div class="muted" style="font-size:0.8rem;margin-top:0.25rem">Last Sync</div>
        </div>`;

      if (!connectors.length) {
        panel.querySelector('#ds-area').innerHTML = `
          <div class="card" style="text-align:center;padding:3rem 2rem">
            <div style="font-size:3rem;margin-bottom:1rem">🔌</div>
            <h2 style="margin:0 0 0.5rem">No directory sources configured</h2>
            <p class="muted" style="margin-bottom:1.5rem">Connect Active Directory, Google Workspace, Azure AD or any SCIM-compatible directory to start syncing identities.</p>
            <button class="btn btn-primary" id="ds-empty-add">+ Add Your First Directory Source</button>
          </div>`;
        panel.querySelector('#ds-empty-add').addEventListener('click', openAddWizard);
        return;
      }

      // connector cards
      const cards = connectors.map(c => {
        const meta = CONNECTOR_TYPES[c.connector_type] || { label: c.connector_type, icon: '⚙️', badge: 'badge-neutral' };
        return `<div class="card" style="margin-bottom:1rem" data-cid="${esc(String(c.id))}">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem">
            <div style="display:flex;align-items:center;gap:0.75rem">
              <div style="font-size:2rem;line-height:1">${meta.icon}</div>
              <div>
                <div style="font-weight:700;font-size:1.05rem">${esc(c.name)}</div>
                <div class="muted" style="font-size:0.8rem;margin-top:0.15rem">${esc(meta.label)} · ${esc(c.direction||'—')} · ${esc(c.sync_mode||'—')}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
              ${connectorStatusBadge(c.status)}
              ${c.sync_schedule ? `<span class="badge badge-neutral" title="Cron schedule">${esc(c.sync_schedule)}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:1.5rem;margin-top:0.75rem;flex-wrap:wrap;font-size:0.82rem;color:var(--text-dim)">
            <span>Last sync: ${c.last_sync_at ? fmtDate(c.last_sync_at) : 'Never'}</span>
            ${c.last_error ? `<span style="color:var(--danger)" title="${esc(c.last_error)}">⚠ ${esc(c.last_error.slice(0,60))}${c.last_error.length>60?'…':''}</span>` : ''}
          </div>
          <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary ds-sync"   data-id="${esc(String(c.id))}">▶ Sync Now</button>
            <button class="btn btn-sm btn-secondary ds-test" data-id="${esc(String(c.id))}">✓ Test Connection</button>
            <button class="btn btn-sm btn-secondary ds-edit" data-id="${esc(String(c.id))}" data-type="${esc(c.connector_type)}" data-name="${esc(c.name)}" data-mode="${esc(c.sync_mode||'')}" data-sched="${esc(c.sync_schedule||'')}">✏ Edit</button>
            <button class="btn btn-sm btn-secondary ds-logs" data-id="${esc(String(c.id))}" data-name="${esc(c.name)}">📋 Sync History</button>
            <button class="btn btn-sm btn-danger ds-del"     data-id="${esc(String(c.id))}">Delete</button>
          </div>
        </div>`;
      }).join('');
      panel.querySelector('#ds-area').innerHTML = cards;
      bindCardActions();
    } catch(e) { panel.querySelector('#ds-area').innerHTML = errHtml(e.message); }
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
        } catch(e) { showToast('✗ ' + e.message, true); }
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
    const meta = CONNECTOR_TYPES[connectorType] || { label: connectorType, fields: [] };
    const isEdit = !!existingId;

    const configFields = (meta.fields || []).map(f => {
      const label = FIELD_LABELS[f] || f;
      const val = esc(String(defaults[f] || ''));
      if (f === 'useSsl') {
        return `<div class="form-group" style="display:flex;align-items:center;gap:0.5rem">
          <input type="checkbox" id="cfg-${f}" class="form-check" ${defaults[f] ? 'checked' : ''}>
          <label class="form-label" style="margin:0" for="cfg-${f}">${esc(label)}</label>
        </div>`;
      }
      if (f === 'serviceAccountKey') {
        return `<div class="form-group">
          <label class="form-label">${esc(label)}</label>
          <textarea class="form-textarea" id="cfg-${f}" rows="4" placeholder='{"type":"service_account","project_id":"..."}'>${val}</textarea>
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
        baseDn:'DC=company,DC=com', customerDomain:'company.com', tenantId:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        clientId:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', domain:'company.okta.com',
        baseUrl:'https://scim.app.com/v2', apiKey:'sk_...', orgId:'12345' }[f] || '';
      return `<div class="form-group">
        <label class="form-label">${esc(label)}${['bindPassword','clientSecret','apiToken','bearerToken','oauthToken','serviceAccountKey'].includes(f)?` <span class="muted" style="font-size:0.75rem">(stored encrypted)</span>`:''}${['bindPassword','clientSecret','apiToken','bearerToken','oauthToken'].includes(f)&&isEdit?` <span class="muted" style="font-size:0.75rem">— leave blank to keep existing</span>`:''}</label>
        <input type="${type}" class="form-input" id="cfg-${f}" value="${val}" placeholder="${esc(ph)}">
      </div>`;
    }).join('');

    const bd = openModal(`<div class="modal" style="width:640px;max-width:96vw">
      <div class="modal-header">
        <h2>${isEdit ? 'Edit' : 'Configure'} — ${esc(meta.icon||'')} ${esc(meta.label||connectorType)}</h2>
      </div>
      <div class="modal-body">
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
        <hr style="border:none;border-top:1px solid var(--border);margin:0.5rem 0 1rem">
        <h3 style="font-size:0.9rem;font-weight:600;margin-bottom:0.75rem;color:var(--text-dim)">CONNECTION SETTINGS</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 1rem">
          ${configFields}
        </div>
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
          const r = await api.testConnector(existingId);
          bd.querySelector('#cfg-err').innerHTML = `<div class="alert ${r.success?'alert-success':'alert-error'}">${esc(r.message||'')}</div>`;
        } else {
          bd.querySelector('#cfg-err').innerHTML = `<div class="alert alert-info">Save the connector first, then use "Test Connection" from the directory list.</div>`;
        }
      } catch(e) { bd.querySelector('#cfg-err').innerHTML = errHtml(e.message); }
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
        } else {
          await api.createConnector(data);
        }
        bd.remove();
        await load();
        showToast(isEdit ? 'Connector updated.' : '✓ Directory source added! Use "Test Connection" to verify.');
      } catch(e) { bd.querySelector('#cfg-err').innerHTML = errHtml(e.message); saveBtn.disabled=false; saveBtn.textContent=isEdit?'Save Changes':'Add Source'; }
    });
  }

  // ── collect form values from config modal ───────────────────────────────────
  function collectFormData(bd, connectorType) {
    const meta = CONNECTOR_TYPES[connectorType] || { fields: [] };
    const configJson = {};
    for (const f of (meta.fields || [])) {
      const el2 = bd.querySelector(`#cfg-${f}`);
      if (!el2) continue;
      if (el2.type === 'checkbox') configJson[f] = el2.checked;
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

  panel.querySelector('#ds-add-btn').addEventListener('click', openAddWizard);
  load();
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  TAB 2: Universal Directory — Hybrid Identity Users         ║
// ╚══════════════════════════════════════════════════════════════╝
function initUsersTab(panel) {
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
    <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:1rem">
      <input class="form-input" id="ud-search" placeholder="Search name, email, ID…" style="flex:1;min-width:200px;max-width:340px">
      <select class="form-select" id="ud-src-filter" style="min-width:140px">
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
      <select class="form-select" id="ud-state-filter" style="min-width:130px">
        <option value="">All States</option>
        <option value="ACTIVE">Active</option>
        <option value="SUSPENDED">Suspended</option>
        <option value="TERMINATED">Terminated</option>
        <option value="INACTIVE">Inactive</option>
      </select>
      <button class="btn btn-secondary" id="ud-refresh-btn">⟳ Refresh</button>
      <button class="btn btn-primary"   id="ud-create-btn">+ Create Local User</button>
    </div>
    <div id="ud-stats" style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.75rem;margin-bottom:1.25rem"></div>
    <div id="ud-table-area">${loading()}</div>`;

  let allUsers = [];
  let searchTimer = null;

  // ── Load & render user list ──────────────────────────────────────────────────
  async function loadUsers(q = '', state = '', source = '') {
    panel.querySelector('#ud-table-area').innerHTML = loading();
    try {
      const r = await api.listUsersUnified(q, state, source, 200, 0);
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
    panel.querySelector('#ud-stats').innerHTML = [
      [total,  'Total Users',       'var(--accent)'],
      [withAD, 'With AD',           '#0078D4'],
      [withG,  'With Google',       '#34a853'],
      [local,  'Local / No Source', 'var(--text-dim)'],
    ].map(([n, lbl, clr]) => `
      <div class="card" style="text-align:center;padding:0.75rem">
        <div style="font-size:1.6rem;font-weight:700;color:${clr}">${n}</div>
        <div class="muted" style="font-size:0.78rem;margin-top:0.2rem">${lbl}</div>
      </div>`).join('');
  }

  function renderTable(users) {
    if (!users.length) {
      panel.querySelector('#ud-table-area').innerHTML = `
        <div class="card" style="text-align:center;padding:3rem 2rem">
          <div style="font-size:3rem;margin-bottom:1rem">👤</div>
          <p class="muted">No users match your filter.</p>
        </div>`;
      return;
    }

    const rows = users.map(u => {
      const sources = (u.identity_sources || '').split(',').filter(Boolean);
      const badges  = sources.length ? sources.map(srcBadge).join('') : srcBadge('LOCAL');
      const initials = (u.full_name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      return `<tr style="cursor:pointer" class="ud-row" data-empid="${esc(u.emp_id)}">
        <td>
          <div style="display:flex;align-items:center;gap:0.6rem">
            <div style="width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;
              display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;flex-shrink:0">${esc(initials)}</div>
            <div>
              <div style="font-weight:600;font-size:0.9rem">${esc(u.full_name||'—')}</div>
              <div class="muted" style="font-size:0.78rem">${esc(u.emp_id)}</div>
            </div>
          </div>
        </td>
        <td class="muted" style="font-size:0.85rem">${esc(u.email_corp||'—')}</td>
        <td class="muted" style="font-size:0.85rem">${esc(u.dept_id||'—')}</td>
        <td>${stateBadge(u.ilg_state)}</td>
        <td>${badges}</td>
        <td>
          <button class="btn btn-sm btn-secondary ud-profile-btn" data-empid="${esc(u.emp_id)}">View Profile</button>
        </td>
      </tr>`;
    }).join('');

    panel.querySelector('#ud-table-area').innerHTML = `
      <div class="table-wrap">
        <table>
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

    // ── Render header ───────────────────────────────────────────────────────────
    function renderHeader() {
      const emp   = profileData.employee      || {};
      const links = profileData.identityLinks || [];
      const sessions = profileData.recentLogins || [];

      const initial = (emp.full_name || empId).charAt(0).toUpperCase();
      overlay.querySelector('#pp-avatar').textContent = initial;
      overlay.querySelector('#pp-name').textContent   = emp.full_name || empId;
      overlay.querySelector('#pp-sub').textContent    =
        [emp.emp_id, emp.email_corp, emp.dept_id].filter(Boolean).join('  ·  ');

      const activeSources = links.filter(l => l.status === 'ACTIVE').map(l => l.system);
      overlay.querySelector('#pp-badges').innerHTML =
        stateBadge(emp.ilg_state) +
        (activeSources.length ? activeSources.map(srcBadge).join('') : srcBadge('LOCAL'));

      // Tab counters
      const idCount = links.filter(l => l.status === 'ACTIVE').length;
      const sessCount = sessions.length;
      const idBadge   = overlay.querySelector('#pp-tab-id-count');
      const sessBadge = overlay.querySelector('#pp-tab-sess-count');
      if (idCount)   { idBadge.textContent   = idCount;   idBadge.style.display   = ''; }
      if (sessCount) { sessBadge.textContent = sessCount; sessBadge.style.display = ''; }

      // Lifecycle buttons
      const state        = (emp.ilg_state || '').toUpperCase();
      const canSuspend   = state === 'ACTIVE';
      const canUnsuspend = state === 'SUSPENDED';
      const canTerminate = state !== 'TERMINATED';

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
      const links        = profileData.identityLinks || [];
      const recentLogins = profileData.recentLogins  || [];
      const writebackLog = profileData.writebackLog  || [];
      const body         = overlay.querySelector('#pp-body');

      // ── Overview tab ─────────────────────────────────────────────────────────
      if (tab === 'overview') {
        const attrs = [
          ['Employee ID',      esc(emp.emp_id     || '—')],
          ['Corporate Email',  esc(emp.email_corp || '—')],
          ['Department',       esc(emp.dept_id    || '—')],
          ['Employment Type',  esc(emp.employment_type || '—')],
          ['State',            stateBadge(emp.ilg_state)],
          ['Admin Role',       emp.admin_role ? `<span class="badge badge-primary">${esc(emp.admin_role)}</span>` : '<span class="muted">None</span>'],
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
              <td><span class="badge ${l.status==='ACTIVE'?'badge-success':'badge-neutral'}">${esc(l.status)}</span></td>
              <td style="font-size:0.75rem">${esc(l.auth_kind||'—')}</td>
              <td style="font-size:0.75rem;white-space:nowrap">${l.last_synced_at ? fmtDate(l.last_synced_at) : '—'}</td>
              <td>${l.drift_flag ? '<span class="badge badge-warning" title="Attribute drift detected">⚠ Drift</span>' : ''}</td>
              <td>
                ${l.status === 'ACTIVE'
                  ? `<button class="btn btn-sm btn-danger pp-unlink-btn" data-linkid="${esc(String(l.id))}" data-sys="${esc(l.system)}">Unlink</button>`
                  : ''}
              </td>
            </tr>`).join('')
          : `<tr><td colspan="7"><div class="pp-empty"><div class="pp-empty-icon">🔗</div>No identity links — this user authenticates locally only.</div></td></tr>`;

        body.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <p class="pp-section-title" style="margin:0">Linked Identity Sources</p>
            <button class="btn btn-sm btn-secondary" id="pp-link-btn">+ Link Identity</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Source</th><th>External ID</th><th>Status</th><th>Auth</th><th>Last Synced</th><th>Drift</th><th></th></tr></thead>
              <tbody>${linkRows}</tbody>
            </table>
          </div>`;

        body.querySelector('#pp-link-btn').addEventListener('click', () =>
          openLinkModal(empId, reloadProfile));

        body.querySelectorAll('.pp-unlink-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm(`Remove ${btn.dataset.sys} identity link?\nThe user will no longer be able to authenticate via this source.`)) return;
            btn.disabled = true; btn.textContent = 'Removing…';
            try {
              await api.unlinkIdentity(empId, btn.dataset.linkid);
              reloadProfile();
            } catch(e) {
              btn.disabled = false; btn.textContent = 'Unlink';
              alert('Failed to remove link: ' + e.message);
            }
          });
        });
      }

      // ── Sessions tab ─────────────────────────────────────────────────────────
      else if (tab === 'sessions') {
        const sessRows = recentLogins.length
          ? recentLogins.map(s => `<tr>
              <td style="font-size:0.8rem;white-space:nowrap">${s.started_at ? fmtDate(s.started_at) : '—'}</td>
              <td style="font-size:0.8rem">${esc(s.iss||'—')}</td>
              <td style="font-size:0.78rem;font-family:var(--mono,'JetBrains Mono',monospace)">${esc(s.ip||'—')}</td>
              <td style="font-size:0.75rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.user_agent||'')}">
                ${esc((s.user_agent||'').replace(/\(.*?\)/g,'').trim().slice(0,50))}
              </td>
              <td style="font-size:0.78rem;white-space:nowrap">${s.last_active_at ? fmtDate(s.last_active_at) : '—'}</td>
            </tr>`).join('')
          : '';

        body.innerHTML = recentLogins.length
          ? `
            <p class="pp-section-title">Active & Recent Sessions (last 10)</p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Started</th><th>Provider</th><th>IP Address</th><th>User Agent</th><th>Last Active</th></tr></thead>
                <tbody>${sessRows}</tbody>
              </table>
            </div>`
          : `<div class="pp-empty"><div class="pp-empty-icon">🖥️</div>No recent sessions found.</div>`;
      }

      // ── Password Reset tab ───────────────────────────────────────────────────
      else if (tab === 'password') {
        const activeSystems = links.filter(l => l.status === 'ACTIVE').map(l => l.system);
        const systemsList   = ['LOCAL', ...activeSystems];

        body.innerHTML = `
          <p class="pp-section-title">Reset Password</p>
          <p style="font-size:0.875rem;color:var(--text-muted);margin-bottom:1.25rem;line-height:1.6">
            The new password will be pushed to <strong>all linked systems simultaneously</strong>:
            ${systemsList.map(s => srcBadge(s)).join('')}
          </p>

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
          <div id="pp-reset-results" style="margin-top:1rem"></div>

          <div style="margin-top:2rem;padding:1rem;background:var(--surface-raised,#f8fafc);border-radius:8px;border:1px solid var(--border)">
            <p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim,#9ca3af);margin:0 0 0.5rem">Password Policy</p>
            <ul style="margin:0;padding-left:1.25rem;font-size:0.82rem;color:var(--text-muted);line-height:1.8">
              <li>Minimum 10 characters</li>
              <li>Writeback applies to: Active Directory, Google Workspace, and any active identity link</li>
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
            const r       = await api.adminResetPassword(empId, pwd, notify);
            const results = r.results || [];

            const rows = results.map(res => `
              <div class="pp-reset-result ${res.status === 'SUCCESS' ? 'success' : 'fail'}">
                ${srcBadge(res.system)}
                <span style="flex:1">${res.status === 'SUCCESS'
                  ? '✓ Updated successfully'
                  : `✗ ${esc(res.error || 'Failed')}`}</span>
              </div>`).join('');

            const banner = r.success
              ? `<div class="pp-alert success" style="margin-bottom:0.75rem">✓ ${esc(r.summary)}</div>`
              : `<div class="pp-alert error"   style="margin-bottom:0.75rem">⚠ ${esc(r.summary)}</div>`;

            resultsEl.innerHTML = banner + rows;
            pwdInput.value = '';
            // Refresh writeback log in overview
            reloadProfile(/* keepTab */ true);
          } catch(e) {
            resultsEl.innerHTML = `<div class="pp-alert error">Reset failed: ${esc(e.message)}</div>`;
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
  loadUsers();
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
            ${ents.map(e => `<tr><td>${esc(e.name||e.id||JSON.stringify(e))}</td><td><button class="btn btn-sm btn-danger rem-ent" data-id="${esc(String(e.id||e))}">Remove</button></td></tr>`).join('')}
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
        wrap.querySelector('#br-msg').innerHTML = `<div class="alert alert-success">Dry run complete: <strong>${result.affected_count ?? result.count ?? JSON.stringify(result)}</strong> users would be affected.</div>`;
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
            <button class="btn btn-sm btn-secondary edit-pam" data-p='${JSON.stringify({id:r.id,name:r.name,type:r.type||r.resource_type,hostname:r.hostname,port:r.port,description:r.description||""})}'>Edit</button>
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
          <td class="cell-strong">${esc(e.label)}</td>
          <td class="muted">${esc(e.system||'—')}</td>
          <td class="muted">${esc(e.username||'—')}</td>
          <td class="muted">${e.last_rotated_at ? fmtDate(e.last_rotated_at) : '—'}</td>
          <td class="muted">${e.last_accessed_at ? fmtDate(e.last_accessed_at) : '—'}</td>
          <td>
            <button class="btn btn-sm btn-secondary checkout-vault" data-id="${esc(String(e.id))}" data-label="${esc(e.label)}">Checkout</button>
            <button class="btn btn-sm btn-danger del-vault" data-id="${esc(String(e.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No vault entries.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Label</th><th>System</th><th>Username</th><th>Last Rotated</th><th>Last Accessed</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
      <div class="form-group"><label class="form-label">Label</label><input class="form-input" id="v-label" placeholder="prod-db-admin"></div>
      <div class="form-group"><label class="form-label">System</label><input class="form-input" id="v-system" placeholder="db.prod.example.com"></div>
      <div class="form-group"><label class="form-label">Username</label><input class="form-input" id="v-user" placeholder="admin"></div>
      <div class="form-group"><label class="form-label">Secret Type</label><select class="form-select" id="v-stype"><option>PASSWORD</option><option>SSH_KEY</option><option>TOKEN</option><option>CERT</option></select></div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="v-notes" rows="2"></textarea></div>
      <div id="v-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="v-save">Add</button><button class="btn btn-secondary" id="v-cancel">Cancel</button></div></div>`);
    bd.querySelector('#v-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#v-save').addEventListener('click', async () => {
      const data = { label: bd.querySelector('#v-label').value, system: bd.querySelector('#v-system').value, username: bd.querySelector('#v-user').value, secret_type: bd.querySelector('#v-stype').value, notes: bd.querySelector('#v-notes').value };
      if (!data.label) { bd.querySelector('#v-err').innerHTML = errHtml('Label required'); return; }
      try { await api.createVaultEntry(data); bd.remove(); await load(); } catch(e) { bd.querySelector('#v-err').innerHTML = errHtml(e.message); }
    });
  });

  await load();
}

// ─── 16. Workflow Library ─────────────────────────────────────────────────────
export async function viewWorkflowLibrary(content) {
  content.replaceChildren(el(`<div>${header('Workflow Library', 'Automated provisioning and access workflows', `<button class="btn btn-primary" id="new-wf-btn">+ New Workflow</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const workflows = norm(await api.listWorkflows());
      const rows = workflows.length ? workflows.map(w => `
        <tr>
          <td class="cell-strong">${esc(w.name)}</td>
          <td><span class="badge badge-info">${esc(w.trigger_event||'—')}</span></td>
          <td>${w.steps_count ?? (Array.isArray(w.steps) ? w.steps.length : '—')}</td>
          <td>${w.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-wf" data-id="${esc(String(w.id))}" data-name="${esc(w.name)}" data-desc="${esc(w.description||'')}" data-event="${esc(w.trigger_event||'')}" data-steps="${esc(JSON.stringify(w.steps||[]))}">Edit</button>
            <button class="btn btn-sm btn-danger del-wf" data-id="${esc(String(w.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No workflows defined.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Trigger</th><th>Steps</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-wf').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this workflow?')) return;
          try { await api.deleteWorkflow(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-wf').forEach(btn => {
        btn.addEventListener('click', () => openWfModal(btn.dataset.id, { name: btn.dataset.name, description: btn.dataset.desc, trigger_event: btn.dataset.event, steps_json: btn.dataset.steps }));
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openWfModal(id, d = {}) {
    const isEdit = !!id;
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Workflow</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="wf-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="wf-desc" value="${esc(d.description||'')}"></div>
      <div class="form-group"><label class="form-label">Trigger Event</label><input class="form-input" id="wf-event" value="${esc(d.trigger_event||'')}" placeholder="JOINER / LEAVER / ROLE_CHANGE"></div>
      <div class="form-group"><label class="form-label">Steps JSON</label><textarea class="form-textarea" id="wf-steps" rows="5">${esc(d.steps_json||'[]')}</textarea></div>
      <div id="wf-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="wf-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="wf-cancel">Cancel</button></div></div>`);
    bd.querySelector('#wf-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#wf-save').addEventListener('click', async () => {
      let steps;
      try { steps = JSON.parse(bd.querySelector('#wf-steps').value || '[]'); } catch { bd.querySelector('#wf-err').innerHTML = errHtml('Steps JSON is invalid'); return; }
      const data = { name: bd.querySelector('#wf-name').value, description: bd.querySelector('#wf-desc').value, trigger_event: bd.querySelector('#wf-event').value, steps };
      if (!data.name) { bd.querySelector('#wf-err').innerHTML = errHtml('Name required'); return; }
      try {
        if (isEdit) await api.updateWorkflow(id, data); else await api.createWorkflow(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#wf-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#new-wf-btn').addEventListener('click', () => openWfModal(null));
  await load();
}

// ─── 17. Event Triggers ───────────────────────────────────────────────────────
export async function viewEventTriggers(content) {
  content.replaceChildren(el(`<div>${header('Event Triggers', 'Webhooks and notifications fired on system events', `<button class="btn btn-primary" id="new-et-btn">+ New Trigger</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
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
            <button class="btn btn-sm btn-secondary edit-et" data-p='${JSON.stringify({id:t.id,name:t.name,event_type:t.event_type,channel:t.channel,target_url:t.target_url||t.target||"",secret:t.secret||""})}'>Edit</button>
            <button class="btn btn-sm btn-danger del-et" data-id="${esc(String(t.id))}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No event triggers.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Event</th><th>Channel</th><th>Target</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.del-et').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this trigger?')) return;
          try { await api.deleteEventTrigger(btn.dataset.id); await load(); } catch(e) { alert(e.message); }
        });
      });
      wrap.querySelectorAll('.edit-et').forEach(btn => {
        btn.addEventListener('click', () => { let p; try { p = JSON.parse(btn.dataset.p); } catch { p = {}; } openEtModal(p.id, p); });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openEtModal(id, d = {}) {
    const isEdit = !!id;
    const events = ['JOINER','LEAVER','MFA_ENROLLED','SUSPICIOUS_LOGIN','ROLE_CHANGE','ACCESS_REQUEST'];
    const channels = ['WEBHOOK','SLACK','TEAMS','EMAIL'];
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Event Trigger</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="et-name" value="${esc(d.name||'')}"></div>
      <div class="form-group"><label class="form-label">Event Type</label><select class="form-select" id="et-event">${events.map(e => `<option ${d.event_type===e?'selected':''}>${e}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Channel</label><select class="form-select" id="et-ch">${channels.map(c => `<option ${d.channel===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Target URL</label><input class="form-input" id="et-url" value="${esc(d.target_url||'')}" placeholder="https://hooks.example.com/..."></div>
      <div class="form-group"><label class="form-label">Signing Secret</label><input class="form-input" id="et-secret" value="${esc(d.secret||'')}" placeholder="Optional HMAC secret"></div>
      <div id="et-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="et-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="et-cancel">Cancel</button></div></div>`);
    bd.querySelector('#et-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#et-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#et-name').value, event_type: bd.querySelector('#et-event').value, channel: bd.querySelector('#et-ch').value, target_url: bd.querySelector('#et-url').value, secret: bd.querySelector('#et-secret').value };
      if (!data.name || !data.target_url) { bd.querySelector('#et-err').innerHTML = errHtml('Name and target URL required'); return; }
      try {
        if (isEdit) await api.updateEventTrigger(id, data); else await api.createEventTrigger(data);
        bd.remove(); await load();
      } catch(e) { bd.querySelector('#et-err').innerHTML = errHtml(e.message); }
    });
  }

  wrap.querySelector('#new-et-btn').addEventListener('click', () => openEtModal(null));
  await load();
}

// ─── 18. Notifications ────────────────────────────────────────────────────────
export async function viewNotifications(content) {
  content.replaceChildren(el(`<div>${header('Notifications', 'Notification delivery stats and recent messages')}<div id="notif-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const [stats, _rawNotifs] = await Promise.all([api.notificationStats(), api.listNotifications()]);
      const notifs = norm(_rawNotifs);
      const statusBadge = s => ({ SENT: 'badge-success', FAILED: 'badge-danger', PENDING: 'badge-warning', PROCESSING: 'badge-info' }[s] || 'badge-neutral');
      const rows = notifs.length ? notifs.map(n => `
        <tr>
          <td class="cell-strong">${esc(n.subject||'—')}</td>
          <td><span class="badge badge-info">${esc(n.channel||'—')}</span></td>
          <td class="muted">${esc(n.recipient||'—')}</td>
          <td><span class="badge ${statusBadge(n.status)}">${esc(n.status||'—')}</span></td>
          <td class="muted">${n.created_at ? fmtDate(n.created_at) : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">◎</div><p>No notifications found.</p></div></td></tr>`;
      wrap.querySelector('#notif-area').innerHTML = `
        <div class="stat-grid" style="margin-bottom:1.5rem">
          <div class="stat-card"><div class="stat-value">${stats?.total ?? '—'}</div><div class="stat-label">Total</div></div>
          <div class="stat-card"><div class="stat-value">${stats?.sent ?? '—'}</div><div class="stat-label">Sent</div></div>
          <div class="stat-card"><div class="stat-value">${stats?.failed ?? '—'}</div><div class="stat-label">Failed</div></div>
          <div class="stat-card"><div class="stat-value">${stats?.pending ?? '—'}</div><div class="stat-label">Pending</div></div>
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
          <div class="form-group"><label class="form-label">Recipient</label><input class="form-input" id="tn-to" placeholder="user@example.com"></div>
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

export async function viewSsoReports(content) {
  content.replaceChildren(el(`<div>${header('SSO Reports', 'Login analytics, adoption and dormancy reports')}<div id="sso-area">${loading()}</div></div>`));
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
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
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
    const s = await api.getGeneralSettings();
    const chk = v => v ? 'checked' : '';
    wrap.querySelector('#gs-area').innerHTML = `
      <div class="card" style="max-width:640px">
        <h2>Organisation</h2>
        <div class="form-group"><label class="form-label">Org Name</label><input class="form-input" id="gs-org" value="${esc(s.org_name||'')}"></div>
        <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" id="gs-email" value="${esc(s.support_email||'')}"></div>
        <h2 style="margin-top:1.5rem">Session</h2>
        <div class="form-group"><label class="form-label">Session TTL (hours)</label><input class="form-input" id="gs-ttl" type="number" value="${s.session_ttl_hours??8}"></div>
        <div class="form-group"><label class="form-label">Cookie Domain</label><input class="form-input" id="gs-domain" value="${esc(s.cookie_domain||'')}"></div>
        <h2 style="margin-top:1.5rem">Authentication</h2>
        <div class="form-group">
          <label class="form-check"><input type="checkbox" id="gs-mfa" ${chk(s.mfa_required)}> MFA Required</label>
          <label class="form-check"><input type="checkbox" id="gs-local" ${chk(s.allow_local_login)}> Allow Local Login</label>
        </div>
        <div class="form-group"><label class="form-label">Max Failed Attempts</label><input class="form-input" id="gs-maxfail" type="number" value="${s.max_failed_attempts??5}"></div>
        <div class="form-group"><label class="form-label">Lockout Duration (min)</label><input class="form-input" id="gs-lockdur" type="number" value="${s.lockout_duration_minutes??15}"></div>
        <h2 style="margin-top:1.5rem">SMTP</h2>
        <div class="form-group"><label class="form-label">SMTP Host</label><input class="form-input" id="gs-shost" value="${esc(s.smtp_host||'')}"></div>
        <div class="form-group"><label class="form-label">SMTP Port</label><input class="form-input" id="gs-sport" type="number" value="${s.smtp_port||587}"></div>
        <div class="form-group"><label class="form-label">SMTP User</label><input class="form-input" id="gs-suser" value="${esc(s.smtp_user||'')}"></div>
        <div id="gs-msg" style="margin-top:1rem"></div>
        <button class="btn btn-primary" id="gs-save" style="margin-top:0.5rem">Save Settings</button>
      </div>`;
    wrap.querySelector('#gs-save').addEventListener('click', async () => {
      const data = {
        org_name: wrap.querySelector('#gs-org').value,
        support_email: wrap.querySelector('#gs-email').value,
        session_ttl_hours: parseInt(wrap.querySelector('#gs-ttl').value)||8,
        cookie_domain: wrap.querySelector('#gs-domain').value,
        mfa_required: wrap.querySelector('#gs-mfa').checked,
        allow_local_login: wrap.querySelector('#gs-local').checked,
        max_failed_attempts: parseInt(wrap.querySelector('#gs-maxfail').value)||5,
        lockout_duration_minutes: parseInt(wrap.querySelector('#gs-lockdur').value)||15,
        smtp_host: wrap.querySelector('#gs-shost').value,
        smtp_port: parseInt(wrap.querySelector('#gs-sport').value)||587,
        smtp_user: wrap.querySelector('#gs-suser').value,
      };
      try {
        await api.saveGeneralSettings(data);
        wrap.querySelector('#gs-msg').innerHTML = `<div class="alert alert-success">Settings saved.</div>`;
        setTimeout(() => { if (wrap.querySelector('#gs-msg')) wrap.querySelector('#gs-msg').innerHTML = ''; }, 3000);
      } catch(e) { wrap.querySelector('#gs-msg').innerHTML = errHtml(e.message); }
    });
  } catch(e) { wrap.querySelector('#gs-area').innerHTML = errHtml(e.message); }
}

// ─── 21. Branding ─────────────────────────────────────────────────────────────
export async function viewBranding(content) {
  content.replaceChildren(el(`<div>${header('Branding', 'Portal look and feel — colors, logos, and custom CSS')}<div id="br-area">${loading()}</div></div>`));
  const wrap = content.firstChild;
  try {
    const b = await api.getBranding();
    wrap.querySelector('#br-area').innerHTML = `
      <div class="grid-3">
        <div class="card" style="grid-column:span 2">
          <h2>Branding Settings</h2>
          <div class="form-group"><label class="form-label">App Name</label><input class="form-input" id="br-appname" value="${esc(b.app_name||'Lenskart IdP')}"></div>
          <div class="form-group"><label class="form-label">Logo URL</label><input class="form-input" id="br-logo" value="${esc(b.logo_url||'')}"></div>
          <div class="form-group"><label class="form-label">Favicon URL</label><input class="form-input" id="br-fav" value="${esc(b.favicon_url||'')}"></div>
          <div class="form-group"><label class="form-label">Accent Color</label><input type="color" class="form-input" id="br-color" value="${esc(b.accent_color||'#4f46e5')}" style="height:2.5rem;padding:0.25rem"></div>
          <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" id="br-email" value="${esc(b.support_email||'')}"></div>
          <div class="form-group"><label class="form-label">Footer Text</label><input class="form-input" id="br-footer" value="${esc(b.footer_text||'')}"></div>
          <div class="form-group"><label class="form-label">Login Hero Heading</label><input class="form-input" id="br-hero" value="${esc(b.login_hero_heading||'')}"></div>
          <div class="form-group"><label class="form-label">Login Hero Subtext</label><input class="form-input" id="br-sub" value="${esc(b.login_hero_subtext||'')}"></div>
          <div class="form-group"><label class="form-label">Custom CSS</label><textarea class="form-textarea" id="br-css" rows="5" placeholder="/* Custom CSS overrides */">${esc(b.custom_css||'')}</textarea></div>
          <div id="br-msg"></div>
          <button class="btn btn-primary" id="br-save">Save Branding</button>
        </div>
        <div class="card">
          <h2>Preview</h2>
          <div id="br-preview" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:0.5rem">
            <div id="br-prev-header" style="background:${esc(b.accent_color||'#4f46e5')};padding:2rem 1.5rem;text-align:center">
              <div style="font-size:1.25rem;font-weight:700;color:#fff" id="br-prev-title">${esc(b.app_name||'Lenskart IdP')}</div>
            </div>
            <div style="padding:1rem;background:#f9f9f9">
              <div style="font-size:0.8rem;font-weight:600;color:#333;text-align:center" id="br-prev-hero">${esc(b.login_hero_heading||'Sign in to continue')}</div>
              <div style="margin-top:0.4rem;font-size:0.7rem;color:#888;text-align:center" id="br-prev-sub">${esc(b.login_hero_subtext||'')}</div>
              <div style="margin-top:1rem;background:#fff;border-radius:4px;padding:0.75rem;border:1px solid #e2e8f0">
                <div style="height:0.5rem;background:#e2e8f0;border-radius:2px;margin-bottom:0.5rem"></div>
                <div style="height:0.5rem;background:#e2e8f0;border-radius:2px;width:70%"></div>
                <div id="br-prev-btn" style="margin-top:0.75rem;height:1.5rem;border-radius:4px;background:${esc(b.accent_color||'#4f46e5')}"></div>
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
        app_name: wrap.querySelector('#br-appname').value,
        logo_url: wrap.querySelector('#br-logo').value,
        favicon_url: wrap.querySelector('#br-fav').value,
        accent_color: wrap.querySelector('#br-color').value,
        support_email: wrap.querySelector('#br-email').value,
        footer_text: wrap.querySelector('#br-footer').value,
        login_hero_heading: wrap.querySelector('#br-hero').value,
        login_hero_subtext: wrap.querySelector('#br-sub').value,
        custom_css: wrap.querySelector('#br-css').value,
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
      { name: 'Multi-Factor Auth', status: 'live' },
      { name: 'IGA / Access Reviews', status: 'live' },
      { name: 'OIDC / OAuth 2.0', status: 'live' },
      { name: 'User Provisioning', status: 'live' },
      { name: 'Directory Sync', status: 'live' },
      { name: 'PAM / Vault', status: 'progress' },
      { name: 'Birthright Rules', status: 'progress' },
      { name: 'Risk Engine', status: 'planned' },
      { name: 'UEBA Analytics', status: 'planned' },
      { name: 'Behavioral Biometrics', status: 'planned' },
      { name: 'App Discovery', status: 'planned' },
    ];
    const featureHtml = features.map(f => {
      const icon = f.status === 'live' ? '✓' : f.status === 'progress' ? '◑' : '○';
      const color = f.status === 'live' ? 'var(--success, #22c55e)' : f.status === 'progress' ? '#f59e0b' : '#94a3b8';
      return `<div style="display:flex;gap:0.5rem;align-items:center"><span style="color:${color};font-weight:700">${icon}</span><span>${esc(f.name)}</span></div>`;
    }).join('');
    wrap.querySelector('#lic-area').innerHTML = `
      <div class="grid-3">
        <div class="card" style="grid-column:span 2">
          <h2>Edition Details</h2>
          <div class="kv" style="margin-top:1rem">
            <div class="kv"><span class="k">Organisation</span><span class="v">${esc(s.org_name||'—')}</span></div>
            <div class="kv"><span class="k">Edition</span><span class="v"><span class="badge badge-success">Enterprise Self-Hosted</span></span></div>
            <div class="kv"><span class="k">Version</span><span class="v">1.0.0</span></div>
            <div class="kv"><span class="k">Build</span><span class="v">lilg-idp-2026</span></div>
            <div class="kv"><span class="k">License Type</span><span class="v">Perpetual + SaaS Option</span></div>
          </div>
          <h2 style="margin-top:1.5rem">Feature Matrix</h2>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-top:0.75rem">${featureHtml}</div>
          <div style="margin-top:1.5rem;display:flex;gap:0.5rem">
            <a class="btn btn-secondary" href="mailto:support@lenskart.com">Contact Support</a>
            <a class="btn btn-secondary" href="/healthz" target="_blank">Health Check</a>
          </div>
        </div>
        <div class="card">
          <h2>Legend</h2>
          <div style="display:grid;gap:0.5rem;margin-top:0.75rem">
            <div style="display:flex;gap:0.5rem;align-items:center"><span style="color:var(--success,#22c55e);font-weight:700">✓</span> <span class="muted">Live in production</span></div>
            <div style="display:flex;gap:0.5rem;align-items:center"><span style="color:#f59e0b;font-weight:700">◑</span> <span class="muted">In progress</span></div>
            <div style="display:flex;gap:0.5rem;align-items:center"><span style="color:#94a3b8;font-weight:700">○</span> <span class="muted">Planned / roadmap</span></div>
          </div>
          <h2 style="margin-top:1.5rem">System Links</h2>
          <div style="display:grid;gap:0.4rem;margin-top:0.5rem">
            ${['/healthz','/readyz','/diagz','/metrics'].map(p => `<a href="${p}" target="_blank" class="btn btn-sm btn-secondary">${p}</a>`).join('')}
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
    <select class="form-select" id="tk-cat" style="width:auto"><option value="">ALL</option><option>ACCESS</option><option>PASSWORD</option><option>MFA</option><option>ACCOUNT</option><option>OTHER</option></select>
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
        <tr class="tk-row" data-p='${JSON.stringify({id:t.id,title:t.title,category:t.category,status:t.status,priority:t.priority,description:t.description||"",created_by:t.created_by||"",created_at:t.created_at||""})}' style="cursor:pointer">
          <td class="cell-strong">${esc(t.title)}</td>
          <td><span class="badge badge-info">${esc(t.category||'—')}</span></td>
          <td><span class="badge ${stColor(t.status)}">${esc(t.status||'—')}</span></td>
          <td><span class="badge ${priColor(t.priority)}">${esc(t.priority||'—')}</span></td>
          <td class="muted">${esc(t.created_by||'—')}</td>
          <td class="muted">${t.created_at ? fmtDate(t.created_at) : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No tickets found.</p></div></td></tr>`;
      wrap.querySelector('#list-area').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Priority</th><th>Created By</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      wrap.querySelectorAll('.tk-row').forEach(row => {
        row.addEventListener('click', () => { let p; try { p = JSON.parse(row.dataset.p); } catch { p = {}; } openTkDetail(p); });
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openTkDetail(t) {
    const statuses = ['OPEN','IN_PROGRESS','RESOLVED','CLOSED'];
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${esc(t.title)}</h2></div><div class="modal-body">
      <div class="kv">
        <div><span class="k">Category</span><span class="v">${esc(t.category||'—')}</span></div>
        <div><span class="k">Priority</span><span class="v">${esc(t.priority||'—')}</span></div>
        <div><span class="k">Created By</span><span class="v">${esc(t.created_by||'—')}</span></div>
        <div><span class="k">Created</span><span class="v">${t.created_at ? fmtDate(t.created_at) : '—'}</span></div>
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
      <div class="form-group"><label class="form-label">Title</label><input class="form-input" id="tk-title"></div>
      <div class="form-group"><label class="form-label">Category</label><select class="form-select" id="tk-cat-new"><option>ACCESS</option><option>PASSWORD</option><option>MFA</option><option>ACCOUNT</option><option>OTHER</option></select></div>
      <div class="form-group"><label class="form-label">Priority</label><select class="form-select" id="tk-pri"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="tk-desc" rows="4"></textarea></div>
      <div id="tk-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="tk-save">Submit</button><button class="btn btn-secondary" id="tk-cancel">Cancel</button></div></div>`);
    bd.querySelector('#tk-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#tk-save').addEventListener('click', async () => {
      const data = { title: bd.querySelector('#tk-title').value, category: bd.querySelector('#tk-cat-new').value, priority: bd.querySelector('#tk-pri').value, description: bd.querySelector('#tk-desc').value };
      if (!data.title) { bd.querySelector('#tk-err').innerHTML = errHtml('Title required'); return; }
      try { await api.createTicket(data); bd.remove(); await load(); } catch(e) { bd.querySelector('#tk-err').innerHTML = errHtml(e.message); }
    });
  });

  await load();
}

// ─── 24. System Health ────────────────────────────────────────────────────────
export async function viewSystemHealth(content) {
  content.replaceChildren(el(`<div>${header('System Health', 'Infrastructure status and diagnostics', `<button class="btn btn-secondary" id="health-refresh">↺ Refresh</button>`)}<div id="health-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    wrap.querySelector('#health-area').innerHTML = loading();
    try {
      const h = await api.systemHealth();
      const statusBadge = (ok, label) => ok ? `<span class="badge badge-success">${label || 'OK'}</span>` : `<span class="badge badge-danger">${label || 'ERROR'}</span>`;
      const dbOk = h.db?.status === 'ok' || h.db?.connected === true || h.database === 'ok';
      const redisOk = h.redis?.status === 'ok' || h.redis?.connected === true || h.redis === 'ok';
      const outbox = h.outbox || {};
      const connectors = h.connectors || [];

      wrap.querySelector('#health-area').innerHTML = `
        <div class="stat-grid" style="margin-bottom:1.5rem">
          <div class="stat-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div class="stat-label">Database</div>${statusBadge(dbOk)}
            </div>
            <div class="stat-value" style="font-size:1rem;margin-top:0.5rem">${esc(h.db?.latency_ms != null ? h.db.latency_ms + 'ms' : '—')}</div>
          </div>
          <div class="stat-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div class="stat-label">Redis</div>${statusBadge(redisOk)}
            </div>
            <div class="stat-value" style="font-size:1rem;margin-top:0.5rem">${esc(h.redis?.latency_ms != null ? h.redis.latency_ms + 'ms' : '—')}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">API Uptime</div>
            <div class="stat-value" style="font-size:1rem;margin-top:0.5rem">${esc(h.uptime || h.uptime_seconds != null ? Math.round((h.uptime||h.uptime_seconds)/3600)+'h' : '—')}</div>
          </div>
        </div>
        <div class="grid-3">
          <div class="card">
            <h2>Outbox Depth</h2>
            <div style="display:grid;gap:0.5rem;margin-top:0.75rem">
              ${['PENDING','PROCESSING','DONE','DEAD'].map(k => `<div style="display:flex;justify-content:space-between"><span class="muted">${k}</span><strong>${outbox[k.toLowerCase()] ?? outbox[k] ?? 0}</strong></div>`).join('')}
            </div>
          </div>
          <div class="card" style="grid-column:span 2">
            <h2>Connectors</h2>
            ${connectors.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th></tr></thead><tbody>
              ${connectors.map(c => `<tr><td>${esc(c.name||'—')}</td><td class="muted">${esc(c.type||c.connector_type||'—')}</td><td>${(c.status==='ok'||c.status==='ACTIVE')?'<span class="badge badge-success">OK</span>':'<span class="badge badge-neutral">'+esc(c.status||'Unknown')+'</span>'}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No connectors configured.</p>'}
          </div>
        </div>`;
      wrap.querySelector('#sys-body').innerHTML = html;
    } catch(e) {
      wrap.querySelector('#sys-body').innerHTML = errHtml(e.message);
    }
  }
  load();
}
