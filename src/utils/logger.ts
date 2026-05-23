/**
 * LILG — Structured logger (Pino)
 * --------------------------------
 * - JSON in production
 * - Pretty-printed in development
 * - request_id propagation via child logger
 */

import pino from 'pino';

const isDev = process.env['NODE_ENV'] === 'development' || process.env['NODE_ENV'] === 'test';

const transport = isDev
  ? pino.transport({
      target:  'pino-pretty',
      options: {
        colorize:        true,
        translateTime:   'SYS:standard',
        ignore:          'pid,hostname',
        singleLine:      false,
        messageFormat:   '{msg}',
      },
    })
  : undefined;

const logger = pino(
  {
    level:     process.env['LOG_LEVEL'] ?? 'info',
    base:      { service: 'lilg' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    redact: {
      paths:  ['password', 'DB_PASSWORD', 'AD_BIND_PASSWORD', 'SESSION_SECRET', 'INTERNAL_TOKEN', '*.token', '*.access_token', '*.id_token'],
      censor: '[REDACTED]',
    },
  },
  transport,
);

/**
 * Create a child logger that includes the request_id field.
 * Use this inside Express handlers: const log = logger.child({ request_id });
 */
export function createRequestLogger(requestId: string): pino.Logger {
  return logger.child({ request_id: requestId });
}

export default logger;
