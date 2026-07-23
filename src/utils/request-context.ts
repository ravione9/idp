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

/** Debug snapshot of IP-related headers (for /api/me/client-ip and deny logs). */
export function getClientIpDebug(req: Request): Record<string, string | null> {
  return {
    resolved: getClientIp(req),
    cfConnectingIp: req.get('cf-connecting-ip')?.trim() || null,
    trueClientIp: req.get('true-client-ip')?.trim() || null,
    xRealIp: req.get('x-real-ip')?.trim() || null,
    xForwardedFor: req.get('x-forwarded-for')?.trim() || null,
    reqIp: req.ip ?? null,
    remoteAddress: req.socket?.remoteAddress ?? null,
    serverPublicIp: getCachedServerPublicIp(),
  };
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

/**
 * Client public IP for the browser / endpoint.
 * Order: CF-Connecting-IP → True-Client-IP → X-Real-IP → Forwarded →
 * X-Forwarded-For hops → Express req.ips/req.ip → socket.
 * Skips private/loopback and known server public IPs when a better candidate exists.
 */
export function getClientIp(req: Request): string {
  const candidates: string[] = [];
  const seen = new Set<string>();

  pushCandidate(candidates, seen, req.get('cf-connecting-ip'));
  pushCandidate(candidates, seen, req.get('true-client-ip'));
  pushCandidate(candidates, seen, req.get('x-real-ip'));

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
  const isUsableClient = (ip: string) =>
    !isPrivateOrLocalIp(ip) && !serverIps.has(ip);

  const publicClient = candidates.find(isUsableClient);
  if (publicClient) return publicClient;

  // No clear public client IP — avoid returning the origin/server EIP.
  const nonServer = candidates.find((ip) => !serverIps.has(ip));
  if (nonServer) return nonServer;

  return candidates[0] ?? 'unknown';
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
