import { api } from './api.js';
import { el, esc, fmtDate } from './ui.js';

function header(title, subtitle, action = '') {
  return `<div class="page-header"><div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${action}</div>`;
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

// ─── 1. Groups ────────────────────────────────────────────────────────────────
export async function viewGroups(content) {
  content.replaceChildren(el(`<div>${header('Groups', 'Manage static and dynamic groups', `<button class="btn btn-primary" id="new-group-btn">+ New Group</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const groups = await api.listGroups();
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
      const users = await api.listSystemUsers();
      const rows = users.length ? users.map(u => `
        <tr>
          <td class="cell-strong">${esc(u.username)}</td>
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
      const data = { username: bd.querySelector('#su-user').value, type: bd.querySelector('#su-type').value, resource_id: bd.querySelector('#su-res').value };
      if (!data.username) { bd.querySelector('#su-err').innerHTML = errHtml('Username required'); return; }
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
      const profiles = await api.listIdentityProfiles();
      const rows = profiles.length ? profiles.map(p => `
        <tr>
          <td class="cell-strong">${esc(p.name)}</td>
          <td><span class="badge badge-info">${esc(p.source_type || '—')}</span></td>
          <td>${p.priority ?? '—'}</td>
          <td>${p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-ip" data-id="${esc(String(p.id))}" data-name="${esc(p.name)}" data-desc="${esc(p.description||'')}" data-src="${esc(p.source_type||'')}" data-pri="${esc(String(p.priority||0))}">Edit</button>
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
        btn.addEventListener('click', () => openIpModal(btn.dataset.id, { name: btn.dataset.name, description: btn.dataset.desc, source_type: btn.dataset.src, priority: btn.dataset.pri }));
      });
    } catch(e) { wrap.querySelector('#list-area').innerHTML = errHtml(e.message); }
  }

  function openIpModal(id, defaults = {}) {
    const isEdit = !!id;
    const bd = openModal(`<div class="modal"><div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Identity Profile</h2></div><div class="modal-body">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ip-name" value="${esc(defaults.name||'')}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="ip-desc" value="${esc(defaults.description||'')}"></div>
      <div class="form-group"><label class="form-label">Source Type</label><select class="form-select" id="ip-src">
        <option ${defaults.source_type==='LDAP'?'selected':''}>LDAP</option>
        <option ${defaults.source_type==='SCIM'?'selected':''}>SCIM</option>
        <option ${defaults.source_type==='CSV'?'selected':''}>CSV</option>
        <option ${defaults.source_type==='MANUAL'?'selected':''}>MANUAL</option>
      </select></div>
      <div class="form-group"><label class="form-label">Priority</label><input class="form-input" id="ip-pri" type="number" value="${esc(String(defaults.priority||1))}"></div>
      <div id="ip-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="ip-save">${isEdit ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="ip-cancel">Cancel</button></div></div>`);
    bd.querySelector('#ip-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#ip-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#ip-name').value, description: bd.querySelector('#ip-desc').value, source_type: bd.querySelector('#ip-src').value, priority: parseInt(bd.querySelector('#ip-pri').value) || 1 };
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
    wrap.querySelector('#mfa-area').innerHTML = `
      <div class="stat-grid" style="margin-bottom:1.5rem">
        <div class="stat-card"><div class="stat-value">${status?.enrolled ?? 0}</div><div class="stat-label">Methods Enrolled</div></div>
        <div class="stat-card"><div class="stat-value">${methods.filter(m=>['badge-success','badge-info'].includes(m.badge)).length}</div><div class="stat-label">Live / Schema</div></div>
        <div class="stat-card"><div class="stat-value">2</div><div class="stat-label">Planned</div></div>
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
      const policies = await api.listAdaptivePolicies();
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
      const policies = await api.listPasswordPolicies();
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
// ─── Pre-built SSO Integration Catalog ───────────────────────────────────────
const SSO_CATALOG = [
  // Productivity & Collaboration
  { id:'slack',      name:'Slack',              icon:'https://cdn.brandfetch.io/idmFGMCpgF/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Collaboration',   protocol:'OIDC', scopes:['openid','email','profile'], grants:['authorization_code'], setupUrl:'https://api.slack.com/authentication/sign-in-with-slack', hint:'Use Slack\'s OIDC integration for workspace SSO.' },
  { id:'teams',      name:'Microsoft Teams',    icon:'https://cdn.brandfetch.io/idchmboHEZ/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Collaboration',   protocol:'SAML', hint:'Configure via Microsoft Entra ID (Azure AD) app gallery.' },
  { id:'zoom',       name:'Zoom',               icon:'https://cdn.brandfetch.io/idPJzRyTFr/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Collaboration',   protocol:'SAML', hint:'Zoom supports SAML 2.0 SSO via the SSO tab in Zoom Admin.' },
  { id:'notion',     name:'Notion',             icon:'https://cdn.brandfetch.io/idoHnTEJFz/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Collaboration',   protocol:'SAML', hint:'Notion Enterprise supports SAML 2.0. Configure in Settings → Identity & Provisioning.' },
  { id:'miro',       name:'Miro',               icon:'https://cdn.brandfetch.io/idAnDmwDVl/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Collaboration',   protocol:'SAML', hint:'Miro supports SAML 2.0 SSO for Enterprise plans.' },
  // Dev Tools
  { id:'github',     name:'GitHub Enterprise',  icon:'https://cdn.brandfetch.io/idZAyF9zcg/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Development',    protocol:'SAML', hint:'GitHub Enterprise Cloud supports SAML 2.0 SSO at the organisation level.' },
  { id:'gitlab',     name:'GitLab',             icon:'https://cdn.brandfetch.io/idgPFp_k7R/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Development',    protocol:'SAML', hint:'GitLab supports SAML 2.0 for self-managed and GitLab.com groups.' },
  { id:'jira',       name:'Jira / Confluence',  icon:'https://cdn.brandfetch.io/idg6A4H3BO/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Development',    protocol:'SAML', hint:'Atlassian Access enables SAML 2.0 SSO for Jira and Confluence Cloud.' },
  { id:'jenkins',    name:'Jenkins',            icon:'https://cdn.brandfetch.io/idFCMjIcFj/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Development',    protocol:'OIDC', scopes:['openid','email','profile'], grants:['authorization_code'], hint:'Use the OpenID Connect Authentication Plugin for Jenkins SSO.' },
  { id:'sonarqube',  name:'SonarQube',          icon:'https://cdn.brandfetch.io/idE1RNF9Fg/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Development',    protocol:'OIDC', scopes:['openid','email','profile'], grants:['authorization_code'], hint:'SonarQube supports SAML 2.0 and OIDC. Configure in Administration → Security → Authentication.' },
  { id:'argocd',     name:'Argo CD',            icon:'https://cdn.brandfetch.io/idqxjS-Lgf/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Development',    protocol:'OIDC', scopes:['openid','email','groups'], grants:['authorization_code'], hint:'Argo CD supports OIDC via dex or direct OIDC provider config in argocd-cm.' },
  // Cloud & Infrastructure
  { id:'aws',        name:'AWS (IAM Identity)',  icon:'https://cdn.brandfetch.io/idHpBVQh7T/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Cloud',          protocol:'SAML', hint:'AWS IAM Identity Center (SSO) accepts SAML 2.0 from external IdPs. ACS URL: https://signin.aws.amazon.com/saml.' },
  { id:'gcp',        name:'Google Cloud',        icon:'https://cdn.brandfetch.io/idoHnTEJFz/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Cloud',          protocol:'SAML', hint:'Google Workspace / Cloud Identity supports SAML 2.0 external IdP federation.' },
  { id:'azure',      name:'Azure / Entra ID',    icon:'https://cdn.brandfetch.io/idchmboHEZ/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Cloud',          protocol:'SAML', hint:'Azure federated identity supports SAML 2.0 and OIDC from external IdPs.' },
  { id:'datadog',    name:'Datadog',             icon:'https://cdn.brandfetch.io/idWnZ2IOXT/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Cloud',          protocol:'SAML', hint:'Datadog supports SAML 2.0 in Organisation Settings → SAML.' },
  { id:'pagerduty',  name:'PagerDuty',           icon:'https://cdn.brandfetch.io/idoJiE2gqt/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Cloud',          protocol:'SAML', hint:'PagerDuty supports SAML 2.0 SSO in Account Settings → SSO.' },
  // Business Apps
  { id:'salesforce', name:'Salesforce',          icon:'https://cdn.brandfetch.io/id6H4MeNHm/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'CRM',            protocol:'SAML', hint:'Salesforce supports SAML 2.0 and can be configured as SP in Setup → Single Sign-On Settings.' },
  { id:'hubspot',    name:'HubSpot',             icon:'https://cdn.brandfetch.io/idVfY5YB3d/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'CRM',            protocol:'SAML', hint:'HubSpot Enterprise supports SAML 2.0 SSO via Security → Single Sign-On.' },
  { id:'zendesk',    name:'Zendesk',             icon:'https://cdn.brandfetch.io/idXJeVJAz2/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Support',        protocol:'SAML', hint:'Zendesk supports SAML 2.0 in Admin → Security → Single Sign-On.' },
  { id:'freshdesk',  name:'Freshdesk',           icon:'https://cdn.brandfetch.io/idpw09B7q5/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Support',        protocol:'SAML', hint:'Freshdesk supports SAML 2.0 via Admin → Security → Single Sign-On.' },
  { id:'servicenow', name:'ServiceNow',          icon:'https://cdn.brandfetch.io/idPjDwVY0z/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'ITSM',           protocol:'SAML', hint:'ServiceNow supports SAML 2.0 via System Security → SSO Properties.' },
  { id:'workday',    name:'Workday',             icon:'https://cdn.brandfetch.io/id6nDjnGVK/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'HR',             protocol:'SAML', hint:'Workday supports SAML 2.0 SSO. Workday acts as SP; configure in Edit Tenant Setup → Security.' },
  { id:'bamboohr',   name:'BambooHR',            icon:'https://cdn.brandfetch.io/idV79BaEsJ/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'HR',             protocol:'SAML', hint:'BambooHR supports SAML 2.0 SSO. Configure under Settings → SSO.' },
  { id:'gusto',      name:'Gusto',               icon:'https://cdn.brandfetch.io/idkiTADKT9/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'HR',             protocol:'OIDC', scopes:['openid','email','profile'], grants:['authorization_code'], hint:'Gusto supports OAuth 2.0 / OIDC for partner integrations.' },
  // Storage & Docs
  { id:'gsuite',     name:'Google Workspace',    icon:'https://cdn.brandfetch.io/idoHnTEJFz/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Productivity',   protocol:'SAML', hint:'Google Workspace supports SAML 2.0. Configure in Admin Console → Security → SSO with third-party IdP.' },
  { id:'office365',  name:'Microsoft 365',       icon:'https://cdn.brandfetch.io/idchmboHEZ/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Productivity',   protocol:'SAML', hint:'Microsoft 365 federated authentication with SAML 2.0 via Azure AD federation.' },
  { id:'box',        name:'Box',                 icon:'https://cdn.brandfetch.io/idEnXxBhPr/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Storage',        protocol:'SAML', hint:'Box supports SAML 2.0 SSO. Configure in Admin Console → Enterprise Settings → User Settings.' },
  { id:'dropbox',    name:'Dropbox Business',    icon:'https://cdn.brandfetch.io/idl-wKFkJt/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Storage',        protocol:'SAML', hint:'Dropbox Business supports SAML 2.0 in Admin Console → Settings → Single Sign-On.' },
  // Design & Media
  { id:'figma',      name:'Figma',               icon:'https://cdn.brandfetch.io/idZfZEO_0x/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Design',         protocol:'SAML', hint:'Figma Organization supports SAML 2.0 SSO via Organization Settings → Security.' },
  { id:'canva',      name:'Canva',               icon:'https://cdn.brandfetch.io/idJERK4uq6/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Design',         protocol:'SAML', hint:'Canva for Enterprise supports SAML 2.0 SSO.' },
  // Finance
  { id:'quickbooks', name:'QuickBooks',          icon:'https://cdn.brandfetch.io/idqmVyUheS/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Finance',        protocol:'OIDC', scopes:['openid','email','profile'], grants:['authorization_code'], hint:'QuickBooks Online supports OpenID Connect for accounting integrations.' },
  // Security & IAM
  { id:'okta',       name:'Okta (SP-initiated)', icon:'https://cdn.brandfetch.io/idpPMCJaSN/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'IAM',            protocol:'SAML', hint:'Use when Lenskart IdP federates INTO an Okta org. Okta acts as SP.' },
  { id:'cyberark',   name:'CyberArk',            icon:'https://cdn.brandfetch.io/idPJBtxYOh/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'PAM',            protocol:'SAML', hint:'CyberArk Privileged Access Manager supports SAML 2.0 SSO for web access.' },
  // Analytics
  { id:'tableau',    name:'Tableau',             icon:'https://cdn.brandfetch.io/idnRpjVP9q/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Analytics',      protocol:'SAML', hint:'Tableau Online and Server support SAML 2.0 SSO.' },
  { id:'looker',     name:'Looker / Looker Studio',icon:'https://cdn.brandfetch.io/idoHnTEJFz/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Analytics',    protocol:'SAML', hint:'Looker supports SAML 2.0 for enterprise SSO.' },
  { id:'metabase',   name:'Metabase',            icon:'https://cdn.brandfetch.io/id3vLq9Qiv/w/400/h/400/theme/dark/icon.png?k=bfHSJFAPEG', cat:'Analytics',      protocol:'SAML', hint:'Metabase Enterprise supports SAML 2.0 SSO.' },
  // Custom
  { id:'custom',     name:'Custom OIDC App',     icon:null, cat:'Custom',        protocol:'OIDC', scopes:['openid','email','profile'], grants:['authorization_code','refresh_token'], hint:'Register any application that supports OpenID Connect / OAuth 2.0.' },
];

const CATALOG_CATS = ['All', ...new Set(SSO_CATALOG.map(a => a.cat))];

// ─── 8. OIDC / OAuth Applications ────────────────────────────────────────────
export async function viewOidcApps(content) {
  content.replaceChildren(el(`<div>
    ${header('OIDC / OAuth Applications', 'OAuth 2.0 and OpenID Connect client registrations')}
    <div class="inline-tabs" id="oidc-tabs">
      <button class="inline-tab active" data-tab="my-apps">My Applications</button>
      <button class="inline-tab" data-tab="catalog">Pre-built Integrations</button>
    </div>
    <div id="tab-my-apps"><div id="list-area">${loading()}</div></div>
    <div id="tab-catalog" style="display:none"></div>
  </div>`));
  const wrap = content.firstChild;

  // ── tab switching ──────────────────────────────────────────────────────────
  wrap.querySelectorAll('.inline-tab').forEach(t => {
    t.addEventListener('click', () => {
      wrap.querySelectorAll('.inline-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      wrap.querySelector('#tab-my-apps').style.display  = t.dataset.tab === 'my-apps'  ? '' : 'none';
      wrap.querySelector('#tab-catalog').style.display  = t.dataset.tab === 'catalog'  ? '' : 'none';
      if (t.dataset.tab === 'catalog') renderCatalog();
    });
  });

  // ── My Applications tab ────────────────────────────────────────────────────
  async function load() {
    try {
      const r = await api.listOidcClients();
      // Backend returns { data: [...] } — normalise
      const clients = Array.isArray(r) ? r : (r && r.data ? r.data : []);
      const rows = clients.length ? clients.map(c => `
        <tr>
          <td class="cell-strong">${esc(c.name || c.client_name || '—')}</td>
          <td><code style="font-size:0.78rem;user-select:all">${esc(c.client_id)}</code></td>
          <td class="muted" style="font-size:0.8rem">${esc(parseJsonArr(c.grant_types).join(', ') || '—')}</td>
          <td class="muted" style="font-size:0.75rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(parseJsonArr(c.redirect_uris).join(', '))}">${esc(parseJsonArr(c.redirect_uris).join(', ') || '—')}</td>
          <td>${c.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary rotate-oidc" data-id="${esc(String(c.id))}" data-name="${esc(c.name||c.client_name||'')}">↻ Rotate Secret</button>
            <button class="btn btn-sm btn-danger del-oidc" data-id="${esc(String(c.id))}">Delete</button>
          </td>
        </tr>`).join('')
        : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>No OIDC applications yet. Register one above or pick a pre-built integration.</p></div></td></tr>`;

      wrap.querySelector('#list-area').innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">
          <button class="btn btn-primary" id="new-oidc-btn">+ Register Custom App</button>
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

  // ── Pre-built Integrations catalog ─────────────────────────────────────────
  let activeCat = 'All';
  let searchQ   = '';

  function renderCatalog() {
    const area = wrap.querySelector('#tab-catalog');
    area.innerHTML = `
      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:1.25rem">
        <input class="form-input" id="cat-search" placeholder="Search integrations…" style="max-width:260px;flex:1" value="${esc(searchQ)}">
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap" id="cat-filters">
          ${CATALOG_CATS.map(cat => `<button class="btn btn-sm ${activeCat===cat?'btn-primary':'btn-secondary'} cat-filter" data-cat="${esc(cat)}">${esc(cat)}</button>`).join('')}
        </div>
      </div>
      <div id="cat-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem"></div>`;

    function renderGrid() {
      const q = searchQ.toLowerCase();
      const visible = SSO_CATALOG.filter(a =>
        (activeCat === 'All' || a.cat === activeCat) &&
        (!q || a.name.toLowerCase().includes(q) || a.cat.toLowerCase().includes(q))
      );
      area.querySelector('#cat-grid').innerHTML = visible.map(app => `
        <div class="card" style="padding:1.25rem;cursor:default;position:relative">
          <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem">
            ${app.icon
              ? `<img src="${esc(app.icon)}" width="36" height="36" style="border-radius:8px;object-fit:contain;background:var(--surface-3);padding:4px" onerror="this.style.display='none';this.nextSibling.style.display='flex'">`
              : ''
            }
            <div class="app-icon-fallback" style="width:36px;height:36px;border-radius:8px;font-size:1.1rem;${app.icon?'display:none':'display:flex'}">${esc(app.name[0])}</div>
            <div>
              <div style="font-weight:600;font-size:0.9rem">${esc(app.name)}</div>
              <div><span class="badge ${app.protocol==='OIDC'?'badge-info':'badge-warning'}" style="font-size:0.65rem">${esc(app.protocol)}</span></div>
            </div>
          </div>
          <div class="muted" style="font-size:0.75rem;margin-bottom:0.75rem;line-height:1.5">${esc(app.hint || '')}</div>
          <button class="btn btn-primary btn-sm" style="width:100%" data-app="${esc(app.id)}">+ Add Integration</button>
        </div>`).join('') || `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><p>No integrations match "${esc(q)}"</p></div>`;

      area.querySelectorAll('[data-app]').forEach(btn => {
        btn.addEventListener('click', () => {
          const app = SSO_CATALOG.find(a => a.id === btn.dataset.app);
          if (!app) return;
          if (app.protocol === 'SAML') {
            // Redirect to SAML apps page with pre-fill info
            openModal(`<div class="modal"><div class="modal-header"><h2>${esc(app.name)} — SAML 2.0 Integration</h2></div>
              <div class="modal-body">
                <div class="info-box">ℹ️ ${esc(app.name)} uses <strong>SAML 2.0</strong>. Configure it as a SAML SP in the <strong>SAML Applications</strong> section, then paste the IdP metadata URL into ${esc(app.name)}'s SSO settings.<br><br>${esc(app.hint)}</div>
                <div class="form-group"><label class="form-label">IdP Metadata URL (paste into ${esc(app.name)})</label>
                  <input class="form-input" value="${esc(window.location.origin)}/auth/saml/metadata" readonly onclick="this.select()"></div>
                <div class="form-group"><label class="form-label">IdP SSO URL</label>
                  <input class="form-input" value="${esc(window.location.origin)}/auth/saml/sso" readonly onclick="this.select()"></div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-primary" onclick="window.location.hash=''; document.querySelector('[data-v=samlApps]')?.click(); this.closest('.modal-backdrop').remove();">Go to SAML Apps →</button>
                <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Close</button>
              </div>
            </div>`);
          } else {
            wrap.querySelectorAll('.inline-tab')[0].click();
            openRegisterModal({ name: app.name, scopes: app.scopes, grants: app.grants, hint: app.hint });
          }
        });
      });
    }

    area.querySelector('#cat-search').addEventListener('input', e => { searchQ = e.target.value; renderGrid(); });
    area.querySelectorAll('.cat-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCat = btn.dataset.cat;
        area.querySelectorAll('.cat-filter').forEach(b => b.classList.toggle('btn-primary', b.dataset.cat === activeCat));
        area.querySelectorAll('.cat-filter').forEach(b => b.classList.toggle('btn-secondary', b.dataset.cat !== activeCat));
        renderGrid();
      });
    });

    renderGrid();
  }

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
  content.replaceChildren(el(`<div>
    ${header('Universal Directory', 'Connect and manage identity sources — Active Directory, Google Workspace, Azure AD and more',
      `<button class="btn btn-primary" id="ds-add-btn">+ Add Directory Source</button>`)}
    <div id="ds-stats" style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1.5rem"></div>
    <div id="ds-area">${loading()}</div>
  </div>`));
  const wrap = content.firstChild;

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
      wrap.querySelector('#ds-stats').innerHTML = `
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
        wrap.querySelector('#ds-area').innerHTML = `
          <div class="card" style="text-align:center;padding:3rem 2rem">
            <div style="font-size:3rem;margin-bottom:1rem">🔌</div>
            <h2 style="margin:0 0 0.5rem">No directory sources configured</h2>
            <p class="muted" style="margin-bottom:1.5rem">Connect Active Directory, Google Workspace, Azure AD or any SCIM-compatible directory to start syncing identities.</p>
            <button class="btn btn-primary" id="ds-empty-add">+ Add Your First Directory Source</button>
          </div>`;
        wrap.querySelector('#ds-empty-add').addEventListener('click', openAddWizard);
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
      wrap.querySelector('#ds-area').innerHTML = cards;
      bindCardActions();
    } catch(e) { wrap.querySelector('#ds-area').innerHTML = errHtml(e.message); }
  }

  // ── bind all card button actions ────────────────────────────────────────────
  function bindCardActions() {
    // Sync Now
    wrap.querySelectorAll('.ds-sync').forEach(btn => {
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
    wrap.querySelectorAll('.ds-test').forEach(btn => {
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
    wrap.querySelectorAll('.ds-edit').forEach(btn => {
      btn.addEventListener('click', () => openEditModal(btn.dataset.id, btn.dataset));
    });

    // Sync History
    wrap.querySelectorAll('.ds-logs').forEach(btn => {
      btn.addEventListener('click', () => openLogsModal(btn.dataset.id, btn.dataset.name));
    });

    // Delete
    wrap.querySelectorAll('.ds-del').forEach(btn => {
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

  wrap.querySelector('#ds-add-btn').addEventListener('click', openAddWizard);
  await load();
}

// ─── 11. Business Roles ───────────────────────────────────────────────────────
export async function viewRoles(content) {
  content.replaceChildren(el(`<div>${header('Business Roles', 'Manage roles and their entitlements', `<button class="btn btn-primary" id="new-role-btn">+ New Role</button>`)}<div id="list-area">${loading()}</div></div>`));
  const wrap = content.firstChild;

  async function load() {
    try {
      const roles = await api.listBusinessRoles();
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
        const ents = await api.getRoleEntitlements(roleId);
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
    const rules = await api.listBirthrightRules();
    const list = (rules || []);
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
      const resources = await api.listPamResources();
      const typeBadge = t => ({ SSH: 'badge-success', RDP: 'badge-info', DB: 'badge-warning', WEB: 'badge-neutral' }[t] || 'badge-neutral');
      const rows = resources.length ? resources.map(r => `
        <tr>
          <td class="cell-strong">${esc(r.name)}</td>
          <td><span class="badge ${typeBadge(r.resource_type)}">${esc(r.resource_type||'—')}</span></td>
          <td class="muted">${esc(r.hostname||'—')}</td>
          <td class="muted">${r.port ?? '—'}</td>
          <td>${r.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
          <td>
            <button class="btn btn-sm btn-secondary edit-pam" data-p='${JSON.stringify({id:r.id,name:r.name,resource_type:r.resource_type,hostname:r.hostname,port:r.port,description:r.description||""})}'>Edit</button>
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
        <option ${d.resource_type==='SSH'?'selected':''}>SSH</option>
        <option ${d.resource_type==='RDP'?'selected':''}>RDP</option>
        <option ${d.resource_type==='DB'?'selected':''}>DB</option>
        <option ${d.resource_type==='WEB'?'selected':''}>WEB</option>
      </select></div>
      <div class="form-group"><label class="form-label">Hostname</label><input class="form-input" id="pam-host" value="${esc(d.hostname||'')}"></div>
      <div class="form-group"><label class="form-label">Port</label><input class="form-input" id="pam-port" type="number" value="${esc(String(d.port||22))}"></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="pam-desc" value="${esc(d.description||'')}"></div>
      <div id="pam-err"></div>
    </div><div class="modal-footer"><button class="btn btn-primary" id="pam-save">${isEdit ? 'Update' : 'Add'}</button><button class="btn btn-secondary" id="pam-cancel">Cancel</button></div></div>`);
    bd.querySelector('#pam-cancel').addEventListener('click', () => bd.remove());
    bd.querySelector('#pam-save').addEventListener('click', async () => {
      const data = { name: bd.querySelector('#pam-name').value, resource_type: bd.querySelector('#pam-type').value, hostname: bd.querySelector('#pam-host').value, port: parseInt(bd.querySelector('#pam-port').value)||22, description: bd.querySelector('#pam-desc').value };
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
      const sessions = await api.listPamSessions();
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
      const entries = await api.listVaultEntries();
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
      const workflows = await api.listWorkflows();
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
      const triggers = await api.listEventTriggers();
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
      const [stats, notifs] = await Promise.all([api.notificationStats(), api.listNotifications()]);
      const statusBadge = s => ({ SENT: 'badge-success', FAILED: 'badge-danger', PENDING: 'badge-warning', PROCESSING: 'badge-info' }[s] || 'badge-neutral');
      const rows = (notifs||[]).length ? notifs.map(n => `
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
    const [summary, failed, adoption, dormant] = await Promise.all([
      api.ssoLoginSummary(), api.ssoFailedLogins(), api.ssoAppAdoption(), api.ssoDormantUsers()
    ]);

    const summaryRows = (summary||[]).map(r => `<tr><td>${esc(r.app||r.application||'—')}</td><td>${r.count ?? 0}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">No data</td></tr>`;
    const failedRows = (failed||[]).map(r => `<tr><td>${esc(r.email||'—')}</td><td>${r.count ?? 0}</td><td class="muted">${r.last_attempt ? fmtDate(r.last_attempt) : '—'}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">No data</td></tr>`;
    const adoptionRows = (adoption||[]).map(r => `<tr><td>${esc(r.app||r.application||'—')}</td><td>${r.entitled ?? 0}</td><td>${r.signed_in ?? 0}</td><td>${r.adoption_pct != null ? r.adoption_pct+'%' : '—'}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">No data</td></tr>`;
    const dormantRows = (dormant||[]).map(r => `<tr><td>${esc(r.email||'—')}</td><td class="muted">${r.last_login ? fmtDate(r.last_login) : 'Never'}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">No data</td></tr>`;

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

    wrap.querySelector('#exp-summary').addEventListener('click', () => csvDownload('login-summary.csv', [['App','Logins'], ...(summary||[]).map(r => [r.app||r.application||'', r.count||0])]));
    wrap.querySelector('#exp-failed').addEventListener('click', () => csvDownload('failed-logins.csv', [['Email','Count','Last Attempt'], ...(failed||[]).map(r => [r.email||'', r.count||0, r.last_attempt||''])]));
    wrap.querySelector('#exp-adoption').addEventListener('click', () => csvDownload('app-adoption.csv', [['App','Entitled','Signed In','Adoption %'], ...(adoption||[]).map(r => [r.app||r.application||'', r.entitled||0, r.signed_in||0, r.adoption_pct||''])]));
    wrap.querySelector('#exp-dormant').addEventListener('click', () => csvDownload('dormant-users.csv', [['Email','Last Login'], ...(dormant||[]).map(r => [r.email||'', r.last_login||'Never'])]));
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
      const tickets = await api.listTickets(status || undefined, cat || undefined);
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
              ${connectors.map(c => `<tr><td>${esc(c.name||'—')}</td><td class="muted">${esc(c.type||'—')}</td><td>${c.status==='ok'||c.status==='ACTIVE'?'<span class="badge badge-success">OK</span>':'<span class="badge badge-danger">'+esc(c.status||'?')+'</span>'}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No connector health data.</p>'}
          </div>
        </div>
        <div class="card" style="margin-top:1rem">
          <h2>Diagnostic Links</h2>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem">
            ${['/healthz','/readyz','/diagz','/metrics'].map(p => `<a href="${p}" target="_blank" class="btn btn-sm btn-secondary">${p}</a>`).join('')}
          </div>
        </div>`;
    } catch(e) { wrap.querySelector('#health-area').innerHTML = errHtml(e.message); }
  }

  wrap.querySelector('#health-refresh').addEventListener('click', load);
  await load();
}
