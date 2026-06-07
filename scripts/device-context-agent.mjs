#!/usr/bin/env node
/**
 * Local device-context agent for IdP login attribution.
 * Serves hostname, local LAN IP, and MAC on http://127.0.0.1:17891/device-context
 *
 * Run on each workstation (or via GPO/login script):
 *   node scripts/device-context-agent.mjs
 */
import http from 'node:http';
import os from 'node:os';

const PORT = parseInt(process.env['DEVICE_CONTEXT_PORT'] || '17891', 10);

function formatMac(raw) {
  const hex = String(raw || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

function pickInterface() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const lower = name.toLowerCase();
    if (lower.includes('loopback') || lower === 'lo') continue;

    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push({
        name,
        address: addr.address,
        mac: formatMac(addr.mac),
        priority: lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('ethernet') || lower.includes('eth') ? 0 : 1,
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return candidates[0] || null;
}

function buildPayload() {
  const hostname = os.hostname().trim() || null;
  const iface = pickInterface();
  let mac = iface?.mac || null;

  if (!mac && hostname) {
    const m = hostname.match(/^LOC-([0-9A-F]{12})$/i);
    if (m) mac = formatMac(m[1]);
  }

  return {
    hostname,
    localIp: iface?.address || null,
    macAddress: mac,
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildPayload()));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`device-context-agent listening on http://127.0.0.1:${PORT}/device-context\n`);
});
