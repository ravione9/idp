#!/usr/bin/env node
/**
 * Lenskart IdP — Local device-context agent
 *
 * Serves hostname, local LAN IP, and MAC on http://127.0.0.1:17891/device-context
 * so the IdP login page can attribute sessions to the correct workstation.
 *
 * INSTALLATION (Windows — run once per machine, no admin required):
 *   node scripts/device-context-agent.mjs
 *
 * AUTO-START (Windows, admin required):
 *   powershell -ExecutionPolicy Bypass -File scripts/install-device-agent.ps1
 *
 * QUICK TEST (PowerShell):
 *   Invoke-RestMethod http://127.0.0.1:17891/device-context
 */
import http from 'node:http';
import os from 'node:os';

const PORT = parseInt(process.env['DEVICE_CONTEXT_PORT'] || '17891', 10);

function formatMac(raw) {
  const hex = String(raw || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

function pickBestInterface() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const lower = name.toLowerCase();
    if (lower.includes('loopback') || lower === 'lo') continue;
    if (lower.includes('virtual') || lower.includes('vmware') || lower.includes('vbox')) continue;

    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;

      // Score: prefer Ethernet > Wi-Fi > other
      let score = 2;
      if (/^(ethernet|eth|en\d|局域网)/.test(lower)) score = 0;
      else if (/^(wi-?fi|wlan|wl\d|airport)/.test(lower)) score = 1;

      candidates.push({
        name,
        address: addr.address,
        mac: formatMac(addr.mac),
        score,
      });
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return candidates[0] || null;
}

function buildPayload() {
  const hostname = os.hostname().trim() || null;
  const iface = pickBestInterface();

  let mac = iface?.mac || null;
  // Fall back: parse MAC from LOC-{12hexchars} style AD hostnames
  if (!mac && hostname) {
    const m = hostname.match(/^LOC-([0-9A-F]{12})$/i);
    if (m) mac = formatMac(m[1]);
  }

  return {
    hostname,
    localIp:    iface?.address || null,
    macAddress: mac,
  };
}

const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'https://idp.lenskart.com',
  'http://192.168.24.254:8080',
];

const server = http.createServer((req, res) => {
  const origin = req.headers['origin'] || '';
  const corsOrigin = ALLOWED_ORIGINS.find((o) => origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[2];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url !== '/device-context') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const payload = buildPayload();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${PORT} already in use — agent may already be running.\n`);
    process.exit(0);
  }
  process.stderr.write(`Agent error: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const payload = buildPayload();
  process.stdout.write([
    `Lenskart IdP device-context agent`,
    `  Listening : http://127.0.0.1:${PORT}/device-context`,
    `  Hostname  : ${payload.hostname || '—'}`,
    `  Local IP  : ${payload.localIp  || '—'}`,
    `  MAC       : ${payload.macAddress || '—'}`,
    '',
  ].join('\n'));
});
