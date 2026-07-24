/**
 * History-based App Discovery scanner.
 *
 * Chrome/Edge do not expose HTTP disk cache contents to websites or extensions.
 * chrome.history is the supported API for "what sites this browser used".
 */

const DEFAULT_IDP = 'https://idp.lenskart.com';
const NOISE = [
  'gstatic.com', 'googleapis.com', 'google-analytics.com', 'googletagmanager.com',
  'cloudflare.com', 'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'doubleclick.net', 'facebook.net', 'fbcdn.net', 'twitter.com', 'twimg.com',
  'linkedin.com', 'licdn.com', 'gravatar.com', 'localhost', '127.0.0.1',
];

function normalizeHost(raw) {
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return (u.hostname || '').toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isNoise(host) {
  if (!host || !host.includes('.')) return true;
  return NOISE.some((n) => host === n || host.endsWith(`.${n}`));
}

async function getIdpBase() {
  const { idpBaseUrl } = await chrome.storage.sync.get({ idpBaseUrl: DEFAULT_IDP });
  return String(idpBaseUrl || DEFAULT_IDP).replace(/\/$/, '');
}

/** Scan last N days of browser history → [{ domain, hitCount, signalType }] */
async function scanHistory(days = 90) {
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const items = await chrome.history.search({
    text: '',
    startTime: start,
    maxResults: 8000,
  });

  const counts = new Map();
  for (const item of items) {
    const host = normalizeHost(item.url || '');
    if (!host || isNoise(host)) continue;
    const prev = counts.get(host) || 0;
    counts.set(host, prev + Math.max(1, item.visitCount || 1));
  }

  return [...counts.entries()]
    .map(([domain, hitCount]) => ({ domain, hitCount, signalType: 'history' }))
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, 200);
}

/** Inject reporter into an IdP tab so the portal session cookie is used. */
async function reportViaIdpTab(idpBase, domains) {
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => t.url && t.url.startsWith(idpBase));
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: `${idpBase}/?v=home`, active: false });
    created = true;
    await new Promise((r) => setTimeout(r, 2800));
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (payload) => {
        const res = await fetch('/api/me/browser-app-signals', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error('Not signed in to the IdP. Open the portal, sign in, then scan again.');
        }
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`${res.status} ${t.slice(0, 160)}`);
        }
        return res.json();
      },
      args: [{ domains, source: 'extension-history' }],
    });
    return { ok: true, ...result };
  } finally {
    if (created && tab?.id) {
      // leave tab open so user can finish login if needed
    }
  }
}

async function runScanAndReport() {
  const idpBase = await getIdpBase();
  const domains = await scanHistory(90);
  await chrome.storage.local.set({
    lastScanAt: Date.now(),
    lastDomainCount: domains.length,
  });

  if (!domains.length) {
    const empty = { ok: true, accepted: 0, skipped: 0, empty: true };
    await chrome.storage.local.set({ lastResult: empty });
    return { domains: 0, result: empty };
  }

  let result;
  try {
    result = await reportViaIdpTab(idpBase, domains);
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
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
    scanHistory(90)
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
