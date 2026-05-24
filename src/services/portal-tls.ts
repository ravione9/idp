/**
 * Portal TLS Manager
 * ------------------
 * Holds a reference to the HTTPS server so the portal-ssl API can hot-reload
 * the TLS certificate via server.setSecureContext() without a restart.
 * Also tracks the runtime HTTP/HTTPS connection flags.
 */

import type https from 'node:https';
import logger from '../utils/logger.js';

interface PortalTlsState {
  httpsServer:  https.Server | null;
  httpsEnabled: boolean;
  allowHttp:    boolean;
  httpsPort:    number;
}

const state: PortalTlsState = {
  httpsServer:  null,
  httpsEnabled: false,
  allowHttp:    true,
  httpsPort:    8443,
};

/** Called from index.ts once the HTTPS server is created. */
export function registerHttpsServer(server: https.Server, port: number): void {
  state.httpsServer  = server;
  state.httpsEnabled = true;
  state.httpsPort    = port;
}

/** Called from the portal-ssl API after a new cert is saved. */
export function reloadTlsContext(cert: string, key: string, ca?: string | null): void {
  if (!state.httpsServer) {
    logger.warn('reloadTlsContext called but no HTTPS server is running — restart required to activate HTTPS');
    return;
  }
  state.httpsServer.setSecureContext({ cert, key, ca: ca ?? undefined });
  logger.info('Portal HTTPS TLS context hot-reloaded — no restart required');
}

/** Called from portal-ssl API when connection settings change. */
export function updateConnectionFlags(httpsEnabled: boolean, allowHttp: boolean): void {
  state.httpsEnabled = httpsEnabled;
  state.allowHttp    = allowHttp;
}

export function getPortalTlsState(): Readonly<PortalTlsState> {
  return state;
}
