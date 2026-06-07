/* Collect client machine hostname, local IP, and MAC for session attribution. */

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
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  return false;
}

function parseIceCandidate(candidate) {
  const out = { localIp: null, hostname: null };
  if (!candidate) return out;

  const ipMatch = candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (ipMatch && isPrivateIpv4(ipMatch[1])) {
    out.localIp = ipMatch[1];
  }

  const mdnsMatch = candidate.match(/\b([0-9a-f-]+)\.local\b/i);
  if (mdnsMatch) {
    const token = mdnsMatch[1].toUpperCase();
    out.hostname = token.length === 12 && /^[0-9A-F]+$/.test(token)
      ? `LOC-${token}`
      : token;
  }

  return out;
}

async function probeLocalAgent() {
  const endpoints = [
    'http://127.0.0.1:17891/device-context',
    'http://localhost:17891/device-context',
  ];
  for (const url of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const hostname = typeof data.hostname === 'string' ? data.hostname.trim() : null;
      const localIp = typeof data.localIp === 'string' ? data.localIp.trim() : null;
      const macAddress = typeof data.macAddress === 'string'
        ? formatMac(data.macAddress.trim())
        : macFromHostname(hostname);
      return { hostname, localIp, macAddress };
    } catch {
      /* no local agent */
    }
  }
  return { hostname: null, localIp: null, macAddress: null };
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
      const timer = setTimeout(resolve, 3000);
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
    /* WebRTC blocked or unavailable */
  } finally {
    pc.close();
  }

  if (!out.macAddress) out.macAddress = macFromHostname(out.hostname);
  return out;
}

function mergeContext(...parts) {
  const out = { hostname: null, localIp: null, macAddress: null };
  for (const p of parts) {
    if (!p) continue;
    if (!out.hostname && p.hostname) out.hostname = p.hostname;
    if (!out.localIp && p.localIp) out.localIp = p.localIp;
    if (!out.macAddress && p.macAddress) out.macAddress = p.macAddress;
  }
  if (!out.macAddress) out.macAddress = macFromHostname(out.hostname);
  return out;
}

export async function collectDeviceContext() {
  const agent = await probeLocalAgent();
  const rtc = await discoverViaWebRtc();
  return mergeContext(agent, rtc);
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
    return { hostname, localIp, macAddress };
  } catch {
    return null;
  }
}

export async function ensureDeviceContext() {
  const cached = readStoredDeviceContext();
  if (cached && (cached.hostname || cached.localIp || cached.macAddress)) return cached;
  const collected = await collectDeviceContext();
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(collected));
  return collected;
}

export function clearStoredDeviceContext() {
  sessionStorage.removeItem(STORAGE_KEY);
}
