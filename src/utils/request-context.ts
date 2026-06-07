/**
 * Request context helpers for deployments behind reverse proxies
 * (Cloudflare WAF, ALB, NGINX). Uses X-Forwarded-* when trust proxy is enabled.
 *
 * Device attribution without a local agent — same approach as email servers:
 *   1. Walk the full X-Forwarded-For / X-Real-IP chain
 *   2. Identify any private (RFC-1918) IP — that is the workstation's LAN IP
 *   3. Async reverse-DNS PTR lookup on that private IP → hostname
 */
import dns from 'node:dns/promises';
import type { Request } from 'express';
import { config } from '../config.js';
import logger from './logger.js';

/** Client IP — prefers Cloudflare CF-Connecting-IP, then first X-Forwarded-For hop. */
export function getClientIp(req: Request): string {
  const cf = req.get('cf-connecting-ip');
  if (cf?.trim()) return cf.trim();

  const xff = req.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** True if an IPv4 address belongs to a private (RFC-1918 / loopback) range. */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.replace(/^::ffff:/, '').split('.').map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n))) return false;
  return (p[0] === 10)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 127);
}

/**
 * Walk all forwarding headers (X-Forwarded-For, X-Real-IP, X-Originating-IP)
 * and return the first private/LAN IP found.
 *
 * When a corporate proxy or VPN gateway adds the client's internal IP to the
 * forwarding chain (e.g. X-Forwarded-For: 192.168.1.42, 10.0.0.1, 203.x.x.x),
 * this returns 192.168.1.42 — the actual workstation IP.
 */
export function findClientLocalIp(req: Request): string | null {
  const headerNames = ['x-forwarded-for', 'x-real-ip', 'x-originating-ip', 'forwarded'];
  const allIps: string[] = [];

  for (const h of headerNames) {
    const val = req.get(h);
    if (!val) continue;
    // "Forwarded" RFC-7239 can be "for=192.0.2.60;proto=http" — extract bare IPs
    const extracted = val
      .replace(/for=/gi, '')
      .replace(/by=[^,]+/gi, '')
      .replace(/proto=[^,]+/gi, '')
      .replace(/host=[^,]+/gi, '');
    extracted.split(',').forEach((raw) => {
      const ip = raw.replace(/["\[\]]/g, '').trim().split(':')[0]; // strip IPv6 brackets and port
      if (ip) allIps.push(ip);
    });
  }

  // Also check the direct socket connection
  const direct = req.socket?.remoteAddress;
  if (direct) allIps.push(direct);

  return allIps.find(isPrivateIpv4) ?? null;
}

/**
 * Reverse-DNS PTR lookup on an IP address.
 * Returns just the first label of the FQDN (e.g. "LOC-9D358FEE60EC"
 * from "LOC-9D358FEE60EC.lenskart.in") or null on any failure.
 *
 * Non-blocking — always resolves (never rejects).
 */
export async function reverseDnsLookup(ip: string): Promise<string | null> {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  try {
    const names = await dns.reverse(ip);
    if (!names?.length) return null;
    const label = names[0].split('.')[0];
    return label ? label.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Derive the machine hostname from a LOC-{12hexchars} style emp_id.
 *
 * In Lenskart's AD setup each domain-joined machine has an account whose
 * emp_id encodes the machine identity (e.g. LOC-9D358FEE60EC).  We can use
 * that directly as the session hostname — zero network calls required.
 *
 * Returns null for normal person accounts (EMP001, AD-xxxxx, GW-xxxxx, etc.)
 */
export function hostnameFromEmpId(empId: string): string | null {
  return /^LOC-[0-9A-F]{12}$/i.test(empId) ? empId.toUpperCase() : null;
}

/**
 * Forward DNS A-record lookup: hostname → IPv4.
 * Best-effort: tries bare hostname, then hostname + each suffix in order.
 * Never throws.
 */
export async function forwardDnsLookup(
  hostname: string,
  suffixes: string[] = [],
): Promise<string | null> {
  const candidates = [hostname, ...suffixes.map((s) => `${hostname}.${s}`)];
  for (const name of candidates) {
    try {
      const addrs = await dns.resolve4(name);
      if (addrs?.length) return addrs[0];
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/**
 * After a session is created, attempt a background reverse-DNS lookup on the
 * client's internal IP and fill in client_hostname if not already set.
 * Fire-and-forget — never throws.
 */
export function enrichSessionHostname(
  sessionId: string,
  localIp:   string | null,
  updateFn:  (sessionId: string, hostname: string) => Promise<unknown>,
): void {
  if (!localIp) return;
  reverseDnsLookup(localIp)
    .then((hostname) => {
      if (!hostname) return;
      return updateFn(sessionId, hostname);
    })
    .catch((err) => logger.debug({ err, localIp }, 'DNS enrichment failed'));
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
