import { z } from 'zod';

const deviceContextSchema = z.object({
  hostname: z.string().max(255).regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/,
    'Invalid hostname',
  ).optional(),
  localIp: z.string().max(45).regex(
    /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/,
    'Invalid IP address',
  ).optional(),
}).partial();

export type SanitizedDeviceContext = {
  hostname: string | null;
  localIp:  string | null;
};

export function sanitizeDeviceContext(
  raw: unknown,
): SanitizedDeviceContext | null {
  const parsed = deviceContextSchema.safeParse(raw);
  if (!parsed.success) return null;

  const hostname = parsed.data.hostname?.trim() || null;
  const localIp  = parsed.data.localIp?.trim() || null;
  if (!hostname && !localIp) return null;

  return { hostname, localIp };
}
