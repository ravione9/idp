/* Shared UI helpers: DOM, escape, formatters, badges, charts. */

const PORTAL_ADMIN_ROLES = new Set([
  'ADMIN', 'SUPER_ADMIN', 'APP_CONTRIBUTOR', 'USER_GROUP_MANAGER', 'CUSTOM',
]);

/** Portal console access role (separate from employees.role job designation). */
export function portalRoleOf(me) {
  return me?.session?.portalRole ?? 'EMPLOYEE';
}

export function isPortalAdmin(me) {
  if (me?.capabilities?.canAdmin) return true;
  return PORTAL_ADMIN_ROLES.has(portalRoleOf(me));
}

export function isPortalSuperAdmin(me) {
  return portalRoleOf(me) === 'SUPER_ADMIN';
}

/** Module permission from /api/me portalModules. */
export function hasPortalModule(me, moduleKey, level = 'read') {
  if (!moduleKey) return isPortalAdmin(me);
  const role = portalRoleOf(me);
  if (role === 'SUPER_ADMIN') return true;
  const perm = me?.portalModules?.[moduleKey];
  if (perm) return level === 'write' ? !!perm.write : !!(perm.read || perm.write);
  // Legacy ADMIN without modules payload: full console except Administrators/License
  if (role === 'ADMIN') {
    if (moduleKey === 'administrators' || moduleKey === 'pam') return false;
    return true;
  }
  return false;
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe embedding of a JSON object into a single-quoted HTML attribute. */
export function escAttrJson(obj) {
  return esc(JSON.stringify(obj ?? null));
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return esc(s);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtShortDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return esc(s);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
}

/* Persist a search input's value across page refreshes.
   Call after wiring the input listener so a restored value re-applies filters. */
export function persistSearch(input, key) {
  if (!input || !key) return '';
  const storageKey = `idp_search_${key}`;
  const saved = sessionStorage.getItem(storageKey) || '';
  input.addEventListener('input', () => {
    if (input.value) sessionStorage.setItem(storageKey, input.value);
    else sessionStorage.removeItem(storageKey);
  });
  if (saved) {
    input.value = saved;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return saved;
}

/** Read the current sub-tab from the URL (?tab=). */
export function getAppTab(fallback = null) {
  return new URLSearchParams(location.search).get('tab') || fallback;
}

/** Keep the browser URL in sync with the SPA route and optional sub-tab. */
export function syncAppUrl(routeKey, tab = null, defaultTab = null) {
  const qs = new URLSearchParams();
  const showTab = tab && tab !== defaultTab;
  if (routeKey && routeKey !== 'home') {
    qs.set('v', routeKey);
    if (showTab) qs.set('tab', tab);
  } else if (routeKey === 'home' && showTab) {
    qs.set('v', 'home');
    qs.set('tab', tab);
  }
  history.replaceState(null, '', qs.toString() ? `/?${qs}` : '/');
}

export function ilgBadge(state) {
  const s = (state || '').toUpperCase();
  if (s === 'ACTIVE' || s === 'REACTIVATED') return `<span class="badge badge-success">${esc(s)}</span>`;
  if (s.startsWith('SUSPENDED') || s === 'PENDING_MGR' || s === 'ESCALATED_HRBP')
    return `<span class="badge badge-warning">${esc(s)}</span>`;
  if (s === 'DEPARTED' || s === 'DEPROVISIONED')
    return `<span class="badge badge-neutral">${esc(s)}</span>`;
  return `<span class="badge badge-neutral">${esc(s || '—')}</span>`;
}

/* Build a 30-day series indexed by date. Fills missing days with zero. */
export function build30DaySeries(rows = []) {
  const map = new Map();
  for (const r of rows) {
    const k = (r.d || r.date || '').slice(0, 10);
    if (k) map.set(k, Number(r.n) || 0);
  }
  const out = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    out.push({ d: k, n: map.get(k) ?? 0 });
  }
  return out;
}

/* Render a small SVG line chart with one or two series. */
export function renderLineChart({ width = 760, height = 220, series = [], labels = [], colors = ['primary', 'accent'] }) {
  const padding = { top: 16, right: 12, bottom: 28, left: 32 };
  const w = width;
  const h = height;
  const innerW = w - padding.left - padding.right;
  const innerH = h - padding.top - padding.bottom;

  const all = series.flat();
  const maxY = Math.max(1, ...all);
  const stepY = innerH / (maxY || 1);

  const len = (series[0] || []).length || 1;
  const stepX = len > 1 ? innerW / (len - 1) : 0;

  const xy = (i, v) => {
    const x = padding.left + i * stepX;
    const y = padding.top + innerH - v * stepY;
    return [x, y];
  };

  const grid = [];
  for (let g = 0; g <= 4; g++) {
    const y = padding.top + (innerH * g) / 4;
    grid.push(`<line class="grid-line" x1="${padding.left}" y1="${y}" x2="${w - padding.right}" y2="${y}" />`);
    grid.push(`<text class="axis-label" x="${padding.left - 6}" y="${y + 3}" text-anchor="end">${Math.round(maxY - (maxY * g) / 4)}</text>`);
  }

  const tickIdxs = [0, Math.floor(len / 4), Math.floor(len / 2), Math.floor((3 * len) / 4), len - 1];
  for (const i of tickIdxs) {
    if (!labels[i]) continue;
    const x = padding.left + i * stepX;
    grid.push(`<text class="axis-label" x="${x}" y="${h - 8}" text-anchor="middle">${esc(labels[i])}</text>`);
  }

  let paths = '';
  series.forEach((s, idx) => {
    if (!s.length) return;
    const lineColor = colors[idx] === 'accent' ? 'line-stroke-2' : 'line-stroke';
    const areaColor = colors[idx] === 'accent' ? 'area-fill-2' : 'area-fill';
    const points = s.map((v, i) => xy(i, v).join(',')).join(' ');
    const areaPoints = `${padding.left},${padding.top + innerH} ${points} ${padding.left + (s.length - 1) * stepX},${padding.top + innerH}`;
    paths += `<polygon class="${areaColor}" points="${areaPoints}" />`;
    paths += `<polyline class="${lineColor}" points="${points}" />`;
    s.forEach((v, i) => {
      const [x, y] = xy(i, v);
      paths += `<circle class="${colors[idx] === 'accent' ? 'data-point-2' : 'data-point'}" cx="${x}" cy="${y}" r="2.5" />`;
    });
  });

  return `
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      ${grid.join('')}
      ${paths}
    </svg>
  `;
}

/* Render a donut chart from { label, value, color } slices. */
export function renderDonut(slices, centerLabel = '') {
  const total = slices.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const r = 65;
  const cx = 90, cy = 90;
  const stroke = 24;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  const arcs = slices.map((s) => {
    const value = s.value || 0;
    const portion = value / total;
    const dash = circumference * portion;
    const offset = circumference * (1 - acc);
    const segment = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${s.color}" stroke-width="${stroke}"
        stroke-dasharray="${dash} ${circumference - dash}"
        stroke-dashoffset="${offset}"
        transform="rotate(-90 ${cx} ${cy})" />`;
    acc += portion;
    return segment;
  }).join('');

  const totalLabel = total === 0 ? '0' : total.toLocaleString();

  return `
    <div class="donut-relative">
      <svg viewBox="0 0 180 180">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="${stroke}" />
        ${arcs}
      </svg>
      <div class="donut-center">
        <div class="v">${totalLabel}</div>
        <div class="l">${esc(centerLabel)}</div>
      </div>
    </div>
    <div class="legend" style="flex-wrap:wrap;justify-content:center">
      ${slices.map((s) => `<span><span class="swatch" style="background:${s.color}"></span>${esc(s.label)} (${s.value || 0})</span>`).join('')}
    </div>`;
}

export function b64urlToBuf(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const str = atob(b64);
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
  return buf;
}

export function bufToB64url(buf) {
  let str = '';
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function prepareWebAuthnRegOptions(options) {
  const o = structuredClone(options);
  o.challenge = b64urlToBuf(o.challenge);
  o.user.id = b64urlToBuf(o.user.id);
  if (Array.isArray(o.excludeCredentials)) {
    o.excludeCredentials = o.excludeCredentials.map((c) => ({
      ...c,
      id: b64urlToBuf(c.id),
    }));
  }
  return o;
}

export function webAuthnRegResponseToJson(cred) {
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: bufToB64url(cred.response.attestationObject),
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      transports: cred.response.getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}

export function prepareWebAuthnAuthOptions(options) {
  const o = structuredClone(options);
  o.challenge = b64urlToBuf(o.challenge);
  if (Array.isArray(o.allowCredentials)) {
    o.allowCredentials = o.allowCredentials.map((c) => ({
      ...c,
      id: b64urlToBuf(c.id),
    }));
  }
  return o;
}

export function webAuthnAuthResponseToJson(cred) {
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: bufToB64url(cred.response.authenticatorData),
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      signature: bufToB64url(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}
