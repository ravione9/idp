/* Collect client machine hostname, local IP, and MAC for session attribution.
 *
 * Collection strategy (in order):
 *   1. Local device agent on http://127.0.0.1:17891/device-context  (most reliable)
 *   2. WebRTC ICE candidates — captures local IP on Firefox/older Chrome;
 *      Chrome 92+ uses mDNS UUIDs instead of real IPs so WebRTC alone is insufficient.
 *
 * Run scripts/install-device-agent.ps1 (Windows) or start
 * scripts/device-context-agent.mjs manually to enable full attribution.
 */

const STORAGE_KEY = 'idp_device_ctx';

function formatMac(raw) {
  const hex = String(raw || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

function macFromHostname(hostname) {
  if (!hostname) return null;
  const m = hostname.match(/^LOC-([0-9A-F]{12})$/i);
  return m ? formatMac(m[1]) : null;
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  return (parts[0] === 10)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 127);
}

function parseIceCandidate(candidate) {
  const out = { localIp: null, hostname: null };
  if (!candidate) return out;

  // Real local IPv4 (Firefox, older Chrome, some Safari)
  const ipMatch = candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (ipMatch && isPrivateIpv4(ipMatch[1])) {
    out.localIp = ipMatch[1];
  }

  // mDNS hostname (.local) — Chrome 92+ uses UUID.local; capture it anyway
  const mdnsMatch = candidate.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.local\b/i);
  if (mdnsMatch) {
    // UUID-based mDNS from Chrome — not the real hostname, skip as hostname
    // but note that the UUID is stable per browser profile
  } else {
    const plainMdns = candidate.match(/\b([A-Za-z0-9][A-Za-z0-9-]{1,62})\.local\b/);
    if (plainMdns) {
      const token = plainMdns[1].toUpperCase();
      out.hostname = token.length === 12 && /^[0-9A-F]+$/.test(token)
        ? `LOC-${token}`
        : token;
    }
  }

  return out;
}

async function probeLocalAgent() {
  // Chrome allows fetch from HTTPS to http://127.0.0.1 (secure-context exception for loopback)
  const endpoints = [
    'http://127.0.0.1:17891/device-context',
    'http://localhost:17891/device-context',
  ];
  for (const url of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const hostname = typeof data.hostname === 'string' ? data.hostname.trim() : null;
      const localIp = typeof data.localIp === 'string' ? data.localIp.trim() : null;
      const macAddress = typeof data.macAddress === 'string'
        ? formatMac(data.macAddress)
        : macFromHostname(hostname);
      if (hostname || localIp || macAddress) {
        return { hostname, localIp, macAddress };
      }
    } catch {
      /* agent not running or blocked */
    }
  }
  return null;
}

async function discoverViaWebRtc() {
  const out = { hostname: null, localIp: null, macAddress: null };
  if (typeof RTCPeerConnection !== 'function') return out;

  const pc = new RTCPeerConnection({ iceServers: [] });
  try {
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const parsed = parseIceCandidate(ev.candidate.candidate);
        if (!out.localIp && parsed.localIp) out.localIp = parsed.localIp;
        if (!out.hostname && parsed.hostname) out.hostname = parsed.hostname;
      };
    });
  } catch {
    /* WebRTC unavailable */
  } finally {
    pc.close();
  }

  if (!out.macAddress) out.macAddress = macFromHostname(out.hostname);
  return out;
}

/** Try agent first (fast, accurate), fall back to WebRTC. */
export async function collectDeviceContext() {
  const agent = await probeLocalAgent();
  if (agent) return agent;

  const rtc = await discoverViaWebRtc();
  if (!rtc.macAddress) rtc.macAddress = macFromHostname(rtc.hostname);
  return rtc;
}

export function readStoredDeviceContext() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const hostname = typeof parsed.hostname === 'string' ? parsed.hostname : null;
    const localIp = typeof parsed.localIp === 'string' ? parsed.localIp : null;
    const macAddress = typeof parsed.macAddress === 'string'
      ? formatMac(parsed.macAddress)
      : macFromHostname(hostname);
    if (!hostname && !localIp && !macAddress) return null;
    return { hostname, localIp, macAddress };
  } catch {
    return null;
  }
}

export async function ensureDeviceContext() {
  const cached = readStoredDeviceContext();
  if (cached) return cached;  // cached only if has real data (readStoredDeviceContext returns null for all-empty)

  const collected = await collectDeviceContext();
  // Only persist to sessionStorage if we found something — so next login always retries the agent
  if (collected.hostname || collected.localIp || collected.macAddress) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(collected));
  }
  return collected;
}

export function clearStoredDeviceContext() {
  sessionStorage.removeItem(STORAGE_KEY);
}
