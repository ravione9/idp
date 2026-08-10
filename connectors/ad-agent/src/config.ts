import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AdConfig {
  host: string;
  port: number;
  useSsl: boolean;
  startTls: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  targetOu?: string;
  upnDomain?: string;
  disabledOu?: string;
}

export interface AgentConfig {
  idpUrl: string;
  connectorId: string;
  agentToken: string;
  pollIntervalSeconds: number;
  heartbeatIntervalSeconds: number;
  ad: AdConfig;
}

/** Strip line and block comments before JSON.parse. */
function stripJsonComments(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function configCandidates(): string[] {
  const candidates: string[] = [];
  // Packaged EXE: config.json must sit next to lilg-ad-connector.exe
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    candidates.push(path.join(path.dirname(process.execPath), 'config.json'));
  }
  // node dist/index.js from install folder (e.g. C:\LILG\ad-connector)
  candidates.push(path.join(process.cwd(), 'config.json'));
  // npm run dev / dist next to source tree
  candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'));
  // Fallback when cwd differs but EXE dir has config
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) {
    candidates.push(path.join(path.dirname(process.execPath), 'config.json'));
  }
  return [...new Set(candidates.map((p) => path.resolve(p)))];
}

function resolveConfigPath(): string {
  for (const p of configCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  const hint = configCandidates()[0] ?? path.join(process.cwd(), 'config.json');
  throw new Error(
    `Missing config.json — copy config.example.json to ${hint} and edit AD + IdP settings`,
  );
}

function readConfigJson(p: string): Partial<AgentConfig> {
  const text = stripJsonComments(fs.readFileSync(p, 'utf8'));
  try {
    return JSON.parse(text) as Partial<AgentConfig>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid JSON in ${p}: ${detail}. ` +
        'Use config.example.json only — valid JSON, no README text or shell comments after the closing brace.',
    );
  }
}

export function loadConfig(): { config: AgentConfig; configPath: string } {
  const p = resolveConfigPath();
  const raw = readConfigJson(p);

  const ad = raw.ad ?? {} as Partial<AdConfig>;
  const cfg: AgentConfig = {
    idpUrl: String(raw.idpUrl ?? '').replace(/\/+$/, ''),
    connectorId: String(raw.connectorId ?? '').trim(),
    agentToken: String(raw.agentToken ?? '').trim(),
    pollIntervalSeconds: Number(raw.pollIntervalSeconds ?? 30),
    heartbeatIntervalSeconds: Number(raw.heartbeatIntervalSeconds ?? 60),
    ad: {
      host: String(ad.host ?? '').trim(),
      port: Number(ad.port ?? (ad.useSsl ? 636 : 389)),
      useSsl: ad.useSsl === true || String(ad.useSsl) === 'true',
      startTls: ad.startTls === true || String(ad.startTls) === 'true',
      bindDn: String(ad.bindDn ?? '').trim(),
      bindPassword: String(ad.bindPassword ?? ''),
      baseDn: String(ad.baseDn ?? '').trim(),
      targetOu: ad.targetOu ? String(ad.targetOu).trim() : undefined,
      upnDomain: ad.upnDomain ? String(ad.upnDomain).trim() : undefined,
      disabledOu: ad.disabledOu ? String(ad.disabledOu).trim() : 'OU=Disabled,',
    },
  };

  const missing: string[] = [];
  if (!cfg.idpUrl) missing.push('idpUrl');
  if (!cfg.connectorId) missing.push('connectorId');
  if (!cfg.agentToken) missing.push('agentToken');
  if (!cfg.ad.host) missing.push('ad.host');
  if (!cfg.ad.bindDn) missing.push('ad.bindDn');
  if (!cfg.ad.bindPassword) missing.push('ad.bindPassword');
  if (!cfg.ad.baseDn) missing.push('ad.baseDn');
  if (missing.length) {
    throw new Error(`config.json missing required field(s): ${missing.join(', ')}`);
  }

  return { config: cfg, configPath: p };
}

export const AGENT_VERSION = '1.1.0';
