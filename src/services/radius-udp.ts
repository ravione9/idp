/**
 * Optional UDP RADIUS authentication server (PAP Access-Request).
 * Enabled via RADIUS_UDP_ENABLED=true. Pair with FreeRADIUS when NAS needs proxying.
 */
import dgram from 'node:dgram';
import radius from 'radius';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import {
  authenticateRadius,
  findRadiusClient,
} from './radius-auth.js';
import { openSecret } from '../utils/secret-box.js';

let server: dgram.Socket | null = null;

function attrString(attrs: Record<string, unknown>, key: string): string {
  const v = attrs[key];
  if (Array.isArray(v)) return String(v[0] ?? '');
  return v == null ? '' : String(v);
}

export function startRadiusUdpServer(): void {
  if (!config.radius.udpEnabled) {
    logger.info('RADIUS UDP listener disabled (set RADIUS_UDP_ENABLED=true to enable)');
    return;
  }
  if (server) return;

  const sock = dgram.createSocket('udp4');
  server = sock;

  sock.on('message', (msg, rinfo) => {
    void (async () => {
      try {
        const client = await findRadiusClient(null, rinfo.address);
        if (!client) {
          logger.warn({ from: rinfo.address }, 'RADIUS UDP: unknown client IP');
          return;
        }
        let secret: string;
        try {
          secret = openSecret(client.shared_secret);
        } catch {
          logger.error({ clientId: client.id }, 'RADIUS UDP: bad shared secret seal');
          return;
        }

        let decoded: {
          code: string;
          identifier: number;
          attributes: Record<string, unknown>;
        };
        try {
          decoded = radius.decode({ packet: msg, secret }) as typeof decoded;
        } catch (err) {
          logger.warn({ err, from: rinfo.address }, 'RADIUS UDP: decode failed');
          return;
        }

        if (decoded.code !== 'Access-Request') {
          return;
        }

        const username = attrString(decoded.attributes, 'User-Name');
        const password = attrString(decoded.attributes, 'User-Password');
        const nasIp = attrString(decoded.attributes, 'NAS-IP-Address')
          || attrString(decoded.attributes, 'NAS-Identifier')
          || rinfo.address;
        const calling = attrString(decoded.attributes, 'Calling-Station-Id');

        const result = await authenticateRadius({
          username,
          password,
          nasIp,
          callingStationId: calling || null,
          clientSourceIp: rinfo.address,
          protocol: 'UDP',
        });

        const replyAttrs: Array<[string, string | number]> = [];
        if (result.result === 'ACCEPT' && result.reply) {
          for (const [k, v] of Object.entries(result.reply)) {
            if (/^\d+$/.test(v)) replyAttrs.push([k, Number(v)]);
            else replyAttrs.push([k, v]);
          }
        }

        const code = result.result === 'ACCEPT' ? 'Access-Accept' : 'Access-Reject';
        const response = radius.encode_response({
          packet: decoded,
          code,
          secret,
          attributes: replyAttrs,
        }) as Buffer;

        sock.send(response, 0, response.length, rinfo.port, rinfo.address);
        logger.info(
          { from: rinfo.address, username, result: result.result, reason: result.reason },
          'RADIUS UDP auth',
        );
      } catch (err) {
        logger.error({ err, from: rinfo.address }, 'RADIUS UDP handler error');
      }
    })();
  });

  sock.on('error', (err) => {
    logger.error({ err }, 'RADIUS UDP socket error');
  });

  sock.bind(config.radius.udpPort, config.radius.udpBind, () => {
    logger.info(
      { port: config.radius.udpPort, bind: config.radius.udpBind },
      'RADIUS UDP authentication listener ready (PAP)',
    );
  });
}

export function stopRadiusUdpServer(): void {
  if (!server) return;
  try { server.close(); } catch { /* ignore */ }
  server = null;
}
