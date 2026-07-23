/**
 * Request context helpers for deployments behind reverse proxies
 * (Cloudflare WAF, ALB, NGINX). Uses X-Forwarded-* when trust proxy is enabled.
 */
import type { Request } from 'express';
import { config } from '../config.js';
import { getCachedServerPublicIp } from './server-public-ip.js';

function normalizeIp(ip: string): string {
  const trimmed = (ip || '').trim();
  if (!trimmed) return '';
  // IPv4-mapped IPv6 (:ffff:1.2.3.4)
  if (trimmed.toLowerCase().startsWith('::ffff:')) return trimmed.slice(7);
  // Strip brackets from IPv6 literals
  if (trimmed.startsWith('[') && trimmed.includes(']')) {
    return trimmed.slice(1, trimmed.indexOf(']'));
  }
  return trimmed;
}

/** RFC1918 / loopback / link-local — never treat as the end-user public IP. */
export function isPrivateOrLocalIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (!n || n === 'unknown') return true;
  if (n === '127.0.0.1' || n === '::1') return true;
  if (n.startsWith('10.')) return true;
  if (n.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(n)) return true;
  if (n.startsWith('169.254.')) return true;
  if (n.toLowerCase().startsWith('fc') || n.toLowerCase().startsWith('fd')) return true;
  if (n.toLowerCase().startsWith('fe80:')) return true;
  return false;
}

/**
 * Cloudflare edge / proxy address ranges (not visitor IPs).
 * See https://www.cloudflare.com/ips/ — subset covering common IPv4 edges.
 */
export function isCloudflareProxyIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (!n) return false;
  const parts = n.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  // 172.64.0.0/13
  if (a === 172 && b >= 64 && b <= 71) return true;
  // 104.16.0.0/13
  if (a === 104 && b >= 16 && b <= 23) return true;
  // 104.24.0.0/14
  if (a === 104 && b >= 24 && b <= 27) return true;
  // 162.158.0.0/15
  if (a === 162 && (b === 158 || b === 159)) return true;
  // 108.162.192.0/18
  if (a === 108 && b === 162 && parts[2]! >= 192) return true;
  // 141.101.64.0/18
  if (a === 141 && b === 101 && parts[2]! >= 64 && parts[2]! <= 127) return true;
  // 190.93.240.0/20
  if (a === 190 && b === 93 && parts[2]! >= 240) return true;
  // 188.114.96.0/20
  if (a === 188 && b === 114 && parts[2]! >= 96 && parts[2]! <= 111) return true;
  // 197.234.240.0/22
  if (a === 197 && b === 234 && parts[2]! >= 240 && parts[2]! <= 243) return true;
  // 198.41.128.0/17
  if (a === 198 && b === 41 && parts[2]! >= 128) return true;
  // 103.21.244.0/22
  if (a === 103 && b === 21 && parts[2]! >= 244 && parts[2]! <= 247) return true;
  // 103.22.200.0/22
  if (a === 103 && b === 22 && parts[2]! >= 200 && parts[2]! <= 203) return true;
  // 103.31.4.0/22
  if (a === 103 && b === 31 && parts[2]! >= 4 && parts[2]! <= 7) return true;
  // 173.245.48.0/20
  if (a === 173 && b === 245 && parts[2]! >= 48 && parts[2]! <= 63) return true;
  return false;
}

/** Extra header names (comma-separated) that carry the visitor IP — e.g. from a CF Transform Rule. */
function extraClientIpHeaders(): string[] {
  const raw = process.env['CLIENT_IP_HEADERS'] ?? 'x-idp-client-ip,x-lenskart-client-ip';
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Origin / host public IPs that must never be used as the client IP. */
function knownServerPublicIps(): Set<string> {
  const out = new Set<string>();
  for (const key of ['SERVER_PUBLIC_IP', 'ORIGIN_PUBLIC_IP', 'EC2_PUBLIC_IPV4']) {
    const v = process.env[key];
    if (v?.trim()) out.add(normalizeIp(v));
  }
  const detected = getCachedServerPublicIp();
  if (detected) out.add(detected);
  return out;
}

function pushCandidate(list: string[], seen: Set<string>, raw?: string | null): void {
  if (!raw) return;
  const n = normalizeIp(raw);
  if (!n || n === 'unknown' || seen.has(n)) return;
  seen.add(n);
  list.push(n);
}

function parseForwardedForHeader(forwarded: string): string[] {
  const ips: string[] = [];
  for (const part of forwarded.split(',')) {
    const m = /for=(?:"?\[?)([^;"\]]+)/i.exec(part.trim());
    if (m?.[1]) ips.push(m[1]);
  }
  return ips;
}

function isUsableEndpointIp(ip: string, serverIps: Set<string>): boolean {
  return (
    !isPrivateOrLocalIp(ip)
    && !isCloudflareProxyIp(ip)
    && !serverIps.has(ip)
  );
}

/**
 * Client public IP for the browser / endpoint.
 * Prefers custom Transform-Rule headers, then Cloudflare visitor headers,
 * then public XFF hops. Never returns Cloudflare edge or the IdP host EIP
 * when a better candidate exists.
 */
export function getClientIp(req: Request): string {
  const candidates: string[] = [];
  const seen = new Set<string>();

  // 1) Explicit visitor headers (Cloudflare Transform Rule → ip.src)
  for (const h of extraClientIpHeaders()) {
    pushCandidate(candidates, seen, req.get(h));
  }

  // 2) Standard Cloudflare / proxy visitor headers
  pushCandidate(candidates, seen, req.get('cf-connecting-ip'));
  pushCandidate(candidates, seen, req.get('true-client-ip'));
  pushCandidate(candidates, seen, req.get('x-real-ip'));
  pushCandidate(candidates, seen, req.get('x-client-ip'));

  const forwarded = req.get('forwarded');
  if (forwarded) {
    for (const ip of parseForwardedForHeader(forwarded)) {
      pushCandidate(candidates, seen, ip);
    }
  }

  const xff = req.get('x-forwarded-for');
  if (xff) {
    for (const hop of xff.split(',')) {
      pushCandidate(candidates, seen, hop);
    }
  }

  if (Array.isArray(req.ips)) {
    for (const ip of req.ips) pushCandidate(candidates, seen, ip);
  }
  pushCandidate(candidates, seen, req.ip);
  pushCandidate(candidates, seen, req.socket?.remoteAddress);

  const serverIps = knownServerPublicIps();
  const publicClient = candidates.find((ip) => isUsableEndpointIp(ip, serverIps));
  if (publicClient) return publicClient;

  const nonServer = candidates.find(
    (ip) => !serverIps.has(ip) && !isCloudflareProxyIp(ip),
  );
  if (nonServer) return nonServer;

  return candidates[0] ?? 'unknown';
}

/** Debug snapshot of IP-related headers (for /api/me/client-ip and deny logs). */
export function getClientIpDebug(req: Request): Record<string, unknown> {
  const resolved = getClientIp(req);
  const remote = normalizeIp(req.socket?.remoteAddress ?? '');
  const cfConnecting = req.get('cf-connecting-ip')?.trim() || null;
  const serverPublicIp = getCachedServerPublicIp();

  const ipLikeHeaders: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (!/ip|forward|client|cf-|true-client|real-ip|forwarded/i.test(key)) continue;
    const s = Array.isArray(val) ? val.join(', ') : String(val ?? '');
    if (s) ipLikeHeaders[key] = s;
  }

  const fromCloudflare = isCloudflareProxyIp(remote);
  let diagnosis: string;
  if (fromCloudflare && cfConnecting && cfConnecting === resolved) {
    diagnosis =
      'Cloudflare edge reached this origin, but CF-Connecting-IP is '
      + `${cfConnecting}. That is the IP Cloudflare saw connecting to its edge — `
      + 'not necessarily your browser. Open https://idp.lenskart.com/cdn-cgi/trace '
      + 'and check the ip= line. If it matches CF-Connecting-IP, traffic is proxied '
      + 'through that address before Cloudflare (old reverse-proxy, corporate SWG, '
      + 'or a Transform Rule). Your true endpoint IP will not appear until that path is fixed, '
      + 'or you add a CF Transform Rule header X-IdP-Client-IP = ip.src (only helps if ip.src is correct).';
  } else if (fromCloudflare && !cfConnecting) {
    diagnosis =
      'Request arrived from Cloudflare but CF-Connecting-IP is missing '
      + '(check Managed Transforms → Remove visitor IP headers).';
  } else {
    diagnosis = 'Resolved from available proxy headers / socket.';
  }

  return {
    resolved,
    expectedHint: 'Compare resolved to https://ifconfig.me and to /cdn-cgi/trace ip=',
    cfConnectingIp: cfConnecting,
    trueClientIp: req.get('true-client-ip')?.trim() || null,
    xRealIp: req.get('x-real-ip')?.trim() || null,
    xForwardedFor: req.get('x-forwarded-for')?.trim() || null,
    xIdpClientIp: req.get('x-idp-client-ip')?.trim() || null,
    reqIp: req.ip ?? null,
    remoteAddress: req.socket?.remoteAddress ?? null,
    serverPublicIp,
    fromCloudflareEdge: fromCloudflare,
    ipLikeHeaders,
    diagnosis,
  };
}

/** True when the client reached the app over HTTPS (via proxy headers or TLS). */
export function isRequestSecure(req: Request): boolean {
  const proto = (req.get('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase();
  if (proto === 'https') return true;
  if (proto === 'http') return false;
  return req.secure;
}

/**
 * Canonical public origin for redirects, SAML, and OAuth callbacks.
 * Always prefers PUBLIC_BASE_URL / SAML_IDP_BASE_URL (e.g. https://idp.lenskart.com).
 */
export function getPublicOrigin(req: Request): string {
  if (config.app.publicBaseUrl) {
    return config.app.publicBaseUrl;
  }
  const proto = isRequestSecure(req) ? 'https' : (req.get('x-forwarded-proto') ?? req.protocol);
  const host  = req.get('x-forwarded-host') ?? req.get('host') ?? 'localhost:8080';
  return `${proto}://${host}`.replace(/\/$/, '');
}
