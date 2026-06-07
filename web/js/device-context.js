/* Collect client hostname and local IP for session attribution (supplementary).
 *
 * Primary attribution is server-side via X-Forwarded-For + reverse DNS.
 * This module sends any extra data the browser can provide (local agent only).
 */

const STORAGE_KEY = 'idp_device_ctx';

async function probeLocalAgent() {
  // Loopback fetch is allowed from HTTPS pages per the Secure Contexts spec.
  const endpoints = [
    'http://127.0.0.1:17891/device-context',
    'http://localhost:17891/device-context',
  ];
  for (const url of endpoints) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      const res   = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const hostname = typeof data.hostname === 'string' ? data.hostname.trim() : null;
      const localIp  = typeof data.localIp  === 'string' ? data.localIp.trim()  : null;
      if (hostname || localIp) return { hostname, localIp };
    } catch {
      /* agent not running */
    }
  }
  return null;
}

export function readStoredDeviceContext() {
  try {
    const raw    = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const hostname = typeof parsed.hostname === 'string' ? parsed.hostname : null;
    const localIp  = typeof parsed.localIp  === 'string' ? parsed.localIp  : null;
    if (!hostname && !localIp) return null;
    return { hostname, localIp };
  } catch {
    return null;
  }
}

export async function ensureDeviceContext() {
  const cached = readStoredDeviceContext();
  if (cached) return cached;

  const agent = await probeLocalAgent();
  if (agent) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(agent));
  return agent;
}

export function clearStoredDeviceContext() {
  sessionStorage.removeItem(STORAGE_KEY);
}
