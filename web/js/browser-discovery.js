/**
 * Collect portal-visible browser signals for App Discovery.
 *
 * Browsers do NOT allow reading HTTP disk cache or full history from a website.
 * We capture what is allowed: document.referrer, Performance resource hosts,
 * and destinations remembered around SSO / app launches.
 */
import { api } from './api.js';

const STORE_KEY = 'lilg_browser_domains';
const REF_KEY = 'lilg_pending_referrer';
const LAST_SEND_KEY = 'lilg_browser_signals_sent_at';

function hostFromUrl(raw) {
  try {
    const u = new URL(raw, location.origin);
    return (u.hostname || '').toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function rememberDomain(domain, signalType = 'launch') {
  const d = (domain || '').toLowerCase().replace(/^www\./, '');
  if (!d || !d.includes('.') || d === location.hostname) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list.push({ domain: d, signalType, at: Date.now() });
  list = list.slice(-80);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* ignore quota */ }
}

/** Call on /login so SP-initiated SSO referrer survives the auth redirect. */
export function captureLoginReferrer() {
  try {
    if (document.referrer) {
      const h = hostFromUrl(document.referrer);
      if (h && h !== location.hostname) {
        sessionStorage.setItem(REF_KEY, JSON.stringify({ domain: h, signalType: 'referrer' }));
      }
    }
  } catch { /* ignore */ }
}

function collectDomains() {
  const out = [];
  const seen = new Set();
  const add = (domain, signalType) => {
    const d = (domain || '').toLowerCase().replace(/^www\./, '');
    if (!d || !d.includes('.') || d === location.hostname || seen.has(d)) return;
    seen.add(d);
    out.push({ domain: d, signalType });
  };

  try {
    const pending = sessionStorage.getItem(REF_KEY);
    if (pending) {
      const p = JSON.parse(pending);
      add(p.domain, p.signalType || 'referrer');
      sessionStorage.removeItem(REF_KEY);
    }
  } catch { /* ignore */ }

  try {
    if (document.referrer) add(hostFromUrl(document.referrer), 'referrer');
  } catch { /* ignore */ }

  try {
    for (const e of performance.getEntriesByType('resource')) {
      const h = hostFromUrl(e.name);
      if (h) add(h, 'resource');
    }
  } catch { /* ignore */ }

  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (Array.isArray(stored)) {
      for (const row of stored) add(row.domain, row.signalType || 'launch');
    }
  } catch { /* ignore */ }

  // Cache Storage API only exposes this origin's Cache API entries (not disk cache of other sites)
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      // fire-and-forget enrichment happens in reportBrowserAppSignals async path
    }
  } catch { /* ignore */ }

  return out;
}

export async function reportBrowserAppSignals() {
  try {
    const last = Number(sessionStorage.getItem(LAST_SEND_KEY) || 0);
    if (Date.now() - last < 60_000) return; // rate limit client-side
  } catch { /* ignore */ }

  let domains = collectDomains();

  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      const keys = await caches.keys();
      for (const k of keys) {
        // keys are opaque; skip unless they look like hostnames
        if (k.includes('.') && !k.includes(' ')) {
          domains.push({ domain: k.toLowerCase(), signalType: 'cache_api' });
        }
      }
    }
  } catch { /* ignore */ }

  // Deduplicate
  const map = new Map();
  for (const d of domains) {
    if (!d?.domain) continue;
    map.set(d.domain, d);
  }
  domains = [...map.values()].slice(0, 40);
  if (!domains.length) return;

  try {
    await api.reportBrowserAppSignals(domains);
    sessionStorage.setItem(LAST_SEND_KEY, String(Date.now()));
    localStorage.removeItem(STORE_KEY);
  } catch {
    // non-fatal — discovery is best-effort
  }
}

/** Remember entity / ACS host when user launches a tile (sanctioned apps filtered on scan). */
export function rememberAppLaunch(app) {
  if (!app) return;
  if (app.entityId) {
    const h = hostFromUrl(app.entityId.startsWith('http') ? app.entityId : `https://${app.entityId}`);
    if (h) rememberDomain(h, 'launch');
  }
}

export function wireAppLaunchTracking(root) {
  root?.querySelectorAll?.('a.app-tile[href]')?.forEach((a) => {
    a.addEventListener('click', () => {
      try {
        const href = a.getAttribute('href') || '';
        // SAML launch paths are same-origin; entity host stored separately via rememberAppLaunch
        if (href.startsWith('http')) {
          const h = hostFromUrl(href);
          if (h) rememberDomain(h, 'launch');
        }
      } catch { /* ignore */ }
    });
  });
}
