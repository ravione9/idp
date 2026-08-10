#!/usr/bin/env node
/**
 * LILG Active Directory Connector Agent
 *
 * Runs on a Windows server inside the AD domain. Connects outbound to the IdP
 * over HTTPS :443 for bidirectional directory sync. AD LDAP credentials are
 * configured locally in config.json only.
 */
import { loadConfig, AGENT_VERSION, type AgentConfig } from './config.js';
import { IdpClient } from './idp-client.js';
import { AdLdapClient } from './ad-ldap.js';
import { runSyncJob } from './sync-runner.js';

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function sendHeartbeat(idp: IdpClient, ldap: AdLdapClient): Promise<void> {
  const test = await ldap.testConnection();
  await idp.heartbeat(test.ok, test.message, AGENT_VERSION);
  log(test.ok ? 'info' : 'warn', 'heartbeat', { adReachable: test.ok, message: test.message });
}

async function pollJobs(cfg: AgentConfig, idp: IdpClient, ldap: AdLdapClient): Promise<void> {
  const job = await idp.fetchNextJob();
  if (!job) return;
  log('info', 'sync job received', { runId: job.runId, inbound: job.runInbound, outbound: job.runOutbound });
  await runSyncJob(cfg, idp, job);
  log('info', 'sync job completed', { runId: job.runId });
}

async function main(): Promise<void> {
  const { config: cfg, configPath } = loadConfig();
  const idp = new IdpClient(cfg);
  const ldap = new AdLdapClient(cfg.ad);

  log('info', 'LILG AD connector agent starting', {
    version: AGENT_VERSION,
    idpUrl: cfg.idpUrl,
    connectorId: cfg.connectorId,
    adHost: cfg.ad.host,
    configPath,
  });

  await sendHeartbeat(idp, ldap);

  setInterval(() => {
    sendHeartbeat(idp, ldap).catch((err) => {
      log('error', 'heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, cfg.heartbeatIntervalSeconds * 1000).unref();

  const poll = async () => {
    try {
      await pollJobs(cfg, idp, ldap);
    } catch (err) {
      log('error', 'job poll failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  await poll();
  setInterval(poll, cfg.pollIntervalSeconds * 1000).unref();
}

main().catch((err) => {
  log('error', 'fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
