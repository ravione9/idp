/**
 * IP geolocation — same technique as Gmail security alerts.
 * Uses ip-api.com (free, no API key, up to 45 req/min from a server).
 * Runs asynchronously after session creation — never blocks login.
 *
 * Returns a compact string like "Mumbai · India" or null on failure.
 */
import logger from './logger.js';
import { execute } from '../db/connection.js';

const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^::1$/,
  /^fc00:/i,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

interface IpApiResponse {
  status:      string;
  city?:       string;
  regionName?: string;
  country?:    string;
}

async function fetchGeo(ip: string): Promise<string | null> {
  if (!ip || isPrivateIp(ip)) return null;

  try {
    // ip-api.com free tier: HTTP only, 45 req/min, no key required
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;

    const data = await res.json() as IpApiResponse;
    if (data.status !== 'success') return null;

    const parts = [data.city, data.country].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  } catch {
    return null;
  }
}

/**
 * After session creation, look up geo for the client IP and store it.
 * Fire-and-forget — never throws, never blocks the login response.
 */
export function enrichSessionGeo(sessionId: string, ip: string): void {
  if (!ip || isPrivateIp(ip)) return;

  fetchGeo(ip)
    .then((geo) => {
      if (!geo) return;
      return execute(
        'UPDATE idp_sessions SET geo_location = ? WHERE session_id = ? AND geo_location IS NULL',
        [geo, sessionId],
      );
    })
    .catch((err) => logger.debug({ err, sessionId }, 'Geo enrichment failed'));
}
