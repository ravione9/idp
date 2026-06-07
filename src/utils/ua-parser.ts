/**
 * Lightweight User-Agent parser — no external dependencies.
 * Returns a human-readable "Browser · OS" string, same as Gmail device info.
 */

function parseOs(ua: string): string {
  if (/Windows NT 11\.0|Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/Windows/.test(ua)) return 'Windows';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const v = ua.match(/Android\s([\d.]+)/)?.[1];
    return v ? `Android ${v.split('.')[0]}` : 'Android';
  }
  if (/Mac OS X/.test(ua)) {
    const v = ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.');
    return v ? `macOS ${v}` : 'macOS';
  }
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function parseBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera\//.test(ua)) return 'Opera';
  if (/YaBrowser\//.test(ua)) return 'Yandex';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  if (/MSIE|Trident\//.test(ua)) return 'IE';
  return 'Browser';
}

/** Returns e.g. "Chrome · Windows 10/11" or "Safari · iPhone" */
export function parseUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown';
  const browser = parseBrowser(ua);
  const os      = parseOs(ua);
  return `${browser} · ${os}`;
}
