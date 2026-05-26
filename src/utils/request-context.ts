/**
 * Request context helpers for deployments behind reverse proxies
 * (Cloudflare WAF, ALB, NGINX). Uses X-Forwarded-* when trust proxy is enabled.
 */
import type { Request } from 'express';
import { config } from '../config.js';

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
