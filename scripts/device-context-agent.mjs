#!/usr/bin/env node
/**
 * Lenskart IdP — Local device-context agent
 *
 * Serves the workstation hostname and local LAN IP on:
 *   http://127.0.0.1:17891/device-context
 *
 * The browser login page reads this so sessions show the actual machine name
 * (e.g. L-PG049BBQ) — impossible to get from a web page any other way.
 *
 * ─── QUICK START (no admin, Windows) ────────────────────────────────────────
 *   node scripts\device-context-agent.mjs
 *
 * ─── AUTO-START AT LOGON (no admin) ─────────────────────────────────────────
 *   Copy  scripts\start-device-agent.bat  and  scripts\device-context-agent.mjs
 *   to:   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
 *   (or open shell: explorer shell:startup)
 *
 * ─── AUTO-START AS SCHEDULED TASK (admin) ────────────────────────────────────
 *   powershell -ExecutionPolicy Bypass -File scripts\install-device-agent.ps1
 *
 * ─── VERIFY ──────────────────────────────────────────────────────────────────
 *   PowerShell:  Invoke-RestMethod http://127.0.0.1:17891/device-context
 *   CMD:         curl http://127.0.0.1:17891/device-context
 */
import http from 'node:http';
import os from 'node:os';

const PORT = parseInt(process.env['DEVICE_CONTEXT_PORT'] || '17891', 10);

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

      let score = 2;
      if (/^(ethernet|eth|en\d|局域网|이더넷)/.test(lower)) score = 0;
      else if (/^(wi-?fi|wlan|wl\d|airport|무선)/.test(lower)) score = 1;

      candidates.push({ name, address: addr.address, score });
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return candidates[0] || null;
}

function buildPayload() {
  const hostname = os.hostname().trim() || null;
  const iface    = pickBestInterface();
  return {
    hostname,
    localIp: iface?.address || null,
  };
}

const ALLOWED_ORIGINS = [
  'https://idp.lenskart.com',
  'http://192.168.24.254:8080',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const server = http.createServer((req, res) => {
  const origin     = req.headers['origin'] || '';
  const corsOrigin = ALLOWED_ORIGINS.find((o) => origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
  const p = buildPayload();
  process.stdout.write([
    'Lenskart IdP — device-context agent',
    `  Listening : http://127.0.0.1:${PORT}/device-context`,
    `  Hostname  : ${p.hostname  || '—'}`,
    `  Local IP  : ${p.localIp   || '—'}`,
    '',
  ].join('\n'));
});
