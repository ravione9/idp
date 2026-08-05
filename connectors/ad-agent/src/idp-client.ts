import axios, { type AxiosInstance } from 'axios';
import type { AgentConfig } from './config.js';

export interface AgentJob {
  runId: string;
  runType: string;
  direction: string;
  runInbound: boolean;
  runOutbound: boolean;
  dirConfig: {
    searchBaseDn: string;
    domainRoot: string;
    provisionOuRdn: string;
    provisionOuDn: string;
  };
  upnDomain?: string;
  syncGroups?: string;
}

export interface OutboundAction {
  action: 'PROVISION' | 'DISABLE' | 'ENABLE' | 'NOOP';
  empId: string;
  fullName: string;
  emailCorp: string;
  deptId: string | null;
  role: string | null;
  externalId?: string;
  suggestedSam?: string;
  provisionOuRdn?: string;
  upnDomain?: string;
}

export interface OutboundResult {
  empId: string;
  action: string;
  success: boolean;
  externalId?: string;
  error?: string;
}

export interface GroupPayload {
  dn: string;
  name: string;
  sam?: string;
  members: Array<{ sam: string; mail?: string; upn?: string; employeeId?: string }>;
}

export class IdpClient {
  private readonly http: AxiosInstance;

  constructor(private readonly cfg: AgentConfig) {
    this.http = axios.create({
      baseURL: `${cfg.idpUrl.replace(/\/+$/, '')}/api/internal/ad-connector`,
      timeout: 120_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Connector-Id': cfg.connectorId,
        'X-Agent-Token': cfg.agentToken,
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });
  }

  async heartbeat(adReachable: boolean, adMessage: string, agentVersion: string): Promise<void> {
    const res = await this.http.post('/heartbeat', { adReachable, adMessage, agentVersion });
    if (res.status >= 400) {
      throw new Error(`Heartbeat failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
  }

  async fetchNextJob(): Promise<AgentJob | null> {
    const res = await this.http.get('/jobs/next');
    if (res.status === 204) return null;
    if (res.status >= 400) {
      throw new Error(`Job poll failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data as AgentJob;
  }

  async claimJob(runId: string): Promise<void> {
    const res = await this.http.post(`/jobs/${runId}/claim`);
    if (res.status >= 400) {
      throw new Error(`Claim failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
  }

  async postInbound(runId: string, users: Record<string, unknown>[]): Promise<{ summary?: string; inbound?: Record<string, unknown> }> {
    const res = await this.http.post(`/jobs/${runId}/inbound`, { users });
    if (res.status >= 400) {
      throw new Error(`Inbound post failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data as { summary?: string; inbound?: Record<string, unknown> };
  }

  async fetchOutboundPlan(runId: string): Promise<OutboundAction[]> {
    const res = await this.http.get(`/jobs/${runId}/outbound-plan`);
    if (res.status >= 400) {
      throw new Error(`Outbound plan failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return (res.data as { actions: OutboundAction[] }).actions ?? [];
  }

  async postOutboundResults(runId: string, results: OutboundResult[]): Promise<void> {
    const res = await this.http.post(`/jobs/${runId}/outbound`, { results });
    if (res.status >= 400) {
      throw new Error(`Outbound results failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
  }

  async postGroups(runId: string, groups: GroupPayload[]): Promise<{ summary?: string; groupsSynced?: number; membersSynced?: number; errors?: string[] }> {
    const res = await this.http.post(`/jobs/${runId}/groups`, { groups });
    if (res.status >= 400) {
      throw new Error(`Groups post failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data as { summary?: string; groupsSynced?: number; membersSynced?: number; errors?: string[] };
  }

  async completeJob(
    runId: string,
    summary: { itemsProcessed: number; itemsSucceeded: number; itemsFailed: number; errorSummary?: string | null; inboundSummary?: string },
  ): Promise<void> {
    const res = await this.http.post(`/jobs/${runId}/complete`, summary);
    if (res.status >= 400) {
      throw new Error(`Complete failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
  }

  async failJob(runId: string, message: string): Promise<void> {
    await this.http.post(`/jobs/${runId}/fail`, { message });
  }
}
