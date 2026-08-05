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

function configPath(): string {
  const exeDir = path.dirname(process.execPath);
  const nearExe = path.join(exeDir, 'config.json');
  if (fs.existsSync(nearExe)) return nearExe;
  const dev = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
  if (fs.existsSync(dev)) return dev;
  return nearExe;
}

export function loadConfig(): AgentConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Missing config.json — copy config.example.json to ${p} and edit AD + IdP settings`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<AgentConfig>;

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

  return cfg;
}

export const AGENT_VERSION = '1.1.0';
