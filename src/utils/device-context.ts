import { z } from 'zod';

const hostnameSchema = z.string().max(255).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/,
  'Invalid hostname',
).optional();

const localIpSchema = z.string().max(45).regex(
  /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/,
  'Invalid IP address',
).optional();

const macSchema = z.string().max(17).regex(
  /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^[0-9A-Fa-f]{12}$/,
  'Invalid MAC address',
).optional();

const deviceContextSchema = z.object({
  hostname:   hostnameSchema,
  localIp:    localIpSchema,
  macAddress: macSchema,
}).partial();

export type SanitizedDeviceContext = {
  hostname:   string | null;
  localIp:    string | null;
  macAddress: string | null;
};

function formatMac(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)?.join(':') ?? null;
}

function macFromHostname(hostname: string | null): string | null {
  if (!hostname) return null;
  const loc = hostname.match(/^LOC-([0-9A-F]{12})$/i);
  if (loc) return formatMac(loc[1]);
  return null;
}

export function sanitizeDeviceContext(
  raw: unknown,
): SanitizedDeviceContext | null {
  const parsed = deviceContextSchema.safeParse(raw);
  if (!parsed.success) return null;

  const hostname = parsed.data.hostname?.trim() || null;
  const localIp  = parsed.data.localIp?.trim() || null;
  let macAddress = parsed.data.macAddress?.trim()
    ? formatMac(parsed.data.macAddress.trim())
    : null;

  if (!macAddress) macAddress = macFromHostname(hostname);
  if (!hostname && !localIp && !macAddress) return null;

  return { hostname, localIp, macAddress };
}
