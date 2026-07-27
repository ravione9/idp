/**
 * History-based App Discovery scanner (MV3).
 * Collects history + open tabs, uploads with the IdP session cookie,
 * and asks the API to ingest into discovered_apps immediately.
 */

const DEFAULT_IDP = 'https://idp.lenskart.com';
const NOISE = [
  'gstatic.com', 'googleapis.com', 'google-analytics.com', 'googletagmanager.com',
  'googleadservices.com', 'googlesyndication.com', 'doubleclick.net',
  'cloudflare.com', 'cloudflareinsights.com', 'jsdelivr.net', 'unpkg.com',
  'cdnjs.cloudflare.com', 'bootstrapcdn.com', 'fontawesome.com',
  'hotjar.com', 'segment.com', 'sentry.io', 'newrelic.com', 'nr-data.net',
  'facebook.net', 'fbcdn.net', 'twitter.com', 'twimg.com',
  'linkedin.com', 'licdn.com', 'gravatar.com', 'localhost', '127.0.0.1',
  'chrome.google.com', 'chromewebstore.google.com', 'microsoftedge.microsoft.com',
];

function normalizeHost(raw) {
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return (u.hostname || '').toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function registrable(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function isNoise(host) {
  if (!host || !host.includes('.')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return NOISE.some((n) => host === n || host.endsWith(`.${n}`));
}

async function getIdpBase() {
  const { idpBaseUrl } = await chrome.storage.sync.get({ idpBaseUrl: DEFAULT_IDP });
  return String(idpBaseUrl || DEFAULT_IDP).replace(/\/$/, '');
}

function addDomain(counts, host, n = 1) {
  if (!host || isNoise(host)) return;
  const key = registrable(host);
  if (!key || isNoise(key)) return;
  counts.set(key, (counts.get(key) || 0) + Math.max(1, n));
}

/** Scan history + open tabs → [{ domain, hitCount, signalType }] */
async function collectDomains(days = 90) {
  const counts = new Map();
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;

  // Prefer omitting empty text — some Chrome builds return nothing for text:''
  let items = [];
  try {
    items = await chrome.history.search({ startTime: start, maxResults: 10000 });
  } catch {
    items = [];
  }
  if (!items.length) {
    try {
      items = await chrome.history.search({ text: 'https', startTime: start, maxResults: 5000 });
    } catch {
      items = [];
    }
  }
  for (const item of items) {
    addDomain(counts, normalizeHost(item.url || ''), item.visitCount || 1);
  }

  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url) addDomain(counts, normalizeHost(t.url), 1);
    }
  } catch { /* ignore */ }

  return [...counts.entries()]
    .map(([domain, hitCount]) => ({ domain, hitCount, signalType: 'history' }))
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, 200);
}

async function reportDirect(idpBase, domains) {
  const res = await fetch(`${idpBase}/api/me/browser-app-signals`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domains,
      source: 'extension-history',
      ingest: true,
    }),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, needTab: true, error: 'Not signed in to the IdP in this browser.' };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `IdP returned ${res.status}: ${t.slice(0, 180)}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, ...data };
}

async function waitTabComplete(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) return tab;
    await new Promise((r) => setTimeout(r, 400));
  }
  return chrome.tabs.get(tabId);
}

/** Fallback: inject fetch into an IdP tab (uses first-party cookies reliably). */
async function reportViaIdpTab(idpBase, domains) {
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => t.url && t.url.startsWith(idpBase));
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: `${idpBase}/?v=home`, active: true });
    created = true;
  }
  await waitTabComplete(tab.id);

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (payload) => {
      const res = await fetch('/api/me/browser-app-signals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Not signed in to the IdP. Sign in on this tab, then scan again.');
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`${res.status} ${t.slice(0, 160)}`);
      }
      return res.json();
    },
    args: [{ domains, source: 'extension-history', ingest: true }],
  });

  if (!result) {
    return {
      ok: false,
      error: created
        ? 'Opened IdP tab — sign in there, then click Scan again.'
        : 'Could not talk to the IdP tab. Sign in and retry.',
    };
  }
  return { ok: true, ...result };
}

async function runScanAndReport() {
  const idpBase = await getIdpBase();
  const domains = await collectDomains(90);
  await chrome.storage.local.set({
    lastScanAt: Date.now(),
    lastDomainCount: domains.length,
  });

  if (!domains.length) {
    const empty = {
      ok: true,
      accepted: 0,
      skipped: 0,
      inventoryCreated: 0,
      inventoryUpdated: 0,
      empty: true,
      error: 'No browsable history/tabs found. Visit some SaaS sites, then scan again.',
    };
    await chrome.storage.local.set({ lastResult: empty });
    return { domains: 0, result: empty };
  }

  let result = await reportDirect(idpBase, domains);
  if (!result.ok && result.needTab) {
    try {
      result = await reportViaIdpTab(idpBase, domains);
    } catch (err) {
      result = { ok: false, error: String(err?.message || err) };
    }
  } else if (!result.ok) {
    // Retry via tab once for other failures too
    try {
      const viaTab = await reportViaIdpTab(idpBase, domains);
      if (viaTab.ok) result = viaTab;
    } catch { /* keep original error */ }
  }

  await chrome.storage.local.set({ lastResult: result });
  return { domains: domains.length, result };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'RUN_SCAN') {
    runScanAndReport()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ domains: 0, result: { ok: false, error: String(err) } }));
    return true;
  }
  if (msg?.type === 'PREVIEW_HISTORY') {
    collectDomains(90)
      .then((domains) => sendResponse({ domains }))
      .catch((err) => sendResponse({ domains: [], error: String(err) }));
    return true;
  }
  return false;
});

chrome.alarms.create('lilg-discovery-daily', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'lilg-discovery-daily') {
    runScanAndReport().catch(() => {});
  }
});
