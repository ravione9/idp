import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helper coercions
// ---------------------------------------------------------------------------
const envInt = z.string().transform((v) => parseInt(v, 10)).pipe(z.number().int().positive());
const envFloat = z.string().transform((v) => parseFloat(v)).pipe(z.number());
const envBool = z.enum(['true', 'false']).transform((v) => v === 'true');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const ConfigSchema = z.object({
  // Database
  DB_HOST: z.string().min(1),
  DB_PORT: envInt.default('3306'),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),

  // Redis
  REDIS_URL: z.string().url(),

  // AWS
  AWS_REGION: z.string().min(1),
  SQS_HRMS_EVENTS_URL: z.string().url(),
  SQS_CELERY_BROKER_URL: z.string().url(),

  // Google
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_HOSTED_DOMAIN: z.string().min(1),
  GOOGLE_SA_KEY_JSON: z.string().min(1),

  // Zoho
  ZOHO_CLIENT_ID: z.string().min(1),
  ZOHO_CLIENT_SECRET: z.string().min(1),
  ZOHO_SCIM_BASE_URL: z.string().url(),

  // Active Directory
  AD_URL: z.string().min(1),
  AD_BIND_DN: z.string().min(1),
  AD_BIND_PASSWORD: z.string().min(1),
  AD_BASE_DN: z.string().min(1),

  // HRMS
  HRMS_API_BASE_URL: z.string().url(),
  HRMS_API_KEY: z.string().min(1),

  // Session
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_CORPORATE_HOURS: envInt.default('8'),
  SESSION_TTL_STORE_HOURS: envInt.default('12'),

  // Application
  PORT: envInt.default('8080'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LILG_DETERMINISTIC: envBool.default('false'),

  // Outbox worker
  OUTBOX_LEADER_TTL_MS: envInt.default('30000'),
  OUTBOX_POLL_INTERVAL_MS: envInt.default('5000'),

  // Circuit breaker
  CIRCUIT_BREAKER_ERROR_THRESHOLD: envFloat.default('50'),

  // Internal token
  INTERNAL_TOKEN: z.string().min(16),

  // One-time bootstrap token for first local super admin (dev only — unset in prod after bootstrap)
  LOCAL_BOOTSTRAP_TOKEN: z.string().min(16).optional(),

  // Public URL (production: https://idp.lenskart.com) — used for OAuth redirect URIs
  PUBLIC_BASE_URL: z.string().url().optional(),

  // SAML IdP (optional — production host: https://idp.lenskart.com)
  SAML_IDP_BASE_URL: z.string().url().optional(),
  SAML_IDP_ENTITY_ID: z.string().min(1).optional(),
  SAML_IDP_PRIVATE_KEY_PEM: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\\n/g, '\n') : undefined)),
  SAML_IDP_CERT_PEM: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\\n/g, '\n') : undefined)),
});

type RawConfig = z.input<typeof ConfigSchema>;
type ParsedConfig = z.output<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------
let parsed: ParsedConfig;
try {
  parsed = ConfigSchema.parse(process.env as unknown as RawConfig);
} catch (err) {
  if (err instanceof z.ZodError) {
    console.error('[LILG] Configuration validation failed:');
    for (const issue of err.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    console.error('[LILG] Unknown configuration error:', err);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Structured config export
// ---------------------------------------------------------------------------
export const config = {
  db: {
    host: parsed.DB_HOST,
    port: parsed.DB_PORT,
    user: parsed.DB_USER,
    password: parsed.DB_PASSWORD,
    database: parsed.DB_NAME,
  },
  redis: {
    url: parsed.REDIS_URL,
  },
  aws: {
    region: parsed.AWS_REGION,
    sqsHrmsEventsUrl: parsed.SQS_HRMS_EVENTS_URL,
    sqsCeleryBrokerUrl: parsed.SQS_CELERY_BROKER_URL,
  },
  google: {
    clientId: parsed.GOOGLE_CLIENT_ID,
    clientSecret: parsed.GOOGLE_CLIENT_SECRET,
    hostedDomain: parsed.GOOGLE_HOSTED_DOMAIN,
    saKeyJson: parsed.GOOGLE_SA_KEY_JSON,
  },
  zoho: {
    clientId: parsed.ZOHO_CLIENT_ID,
    clientSecret: parsed.ZOHO_CLIENT_SECRET,
    scimBaseUrl: parsed.ZOHO_SCIM_BASE_URL,
  },
  ad: {
    url: parsed.AD_URL,
    bindDn: parsed.AD_BIND_DN,
    bindPassword: parsed.AD_BIND_PASSWORD,
    baseDn: parsed.AD_BASE_DN,
  },
  hrms: {
    apiBaseUrl: parsed.HRMS_API_BASE_URL,
    apiKey: parsed.HRMS_API_KEY,
  },
  session: {
    secret: parsed.SESSION_SECRET,
    ttlCorporateHours: parsed.SESSION_TTL_CORPORATE_HOURS,
    ttlStoreHours: parsed.SESSION_TTL_STORE_HOURS,
  },
  app: {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    deterministic: parsed.LILG_DETERMINISTIC,
    outboxLeaderTtlMs: parsed.OUTBOX_LEADER_TTL_MS,
    outboxPollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
    circuitBreakerErrorThreshold: parsed.CIRCUIT_BREAKER_ERROR_THRESHOLD,
    internalToken: parsed.INTERNAL_TOKEN,
    localBootstrapToken: parsed.LOCAL_BOOTSTRAP_TOKEN,
    /** Canonical public origin (e.g. https://idp.lenskart.com). Falls back to request Host when unset. */
    publicBaseUrl: (parsed.PUBLIC_BASE_URL ?? parsed.SAML_IDP_BASE_URL)?.replace(/\/$/, ''),
  },
  saml:
    parsed.SAML_IDP_BASE_URL &&
    parsed.SAML_IDP_PRIVATE_KEY_PEM &&
    parsed.SAML_IDP_CERT_PEM
      ? {
          baseUrl:      parsed.SAML_IDP_BASE_URL.replace(/\/$/, ''),
          entityId:     parsed.SAML_IDP_ENTITY_ID ?? `${parsed.SAML_IDP_BASE_URL.replace(/\/$/, '')}/saml/metadata`,
          privateKeyPem: parsed.SAML_IDP_PRIVATE_KEY_PEM,
          certPem:       parsed.SAML_IDP_CERT_PEM,
        }
      : undefined,
} as const;

export type Config = typeof config;

/** True when SAML IdP signing keys and base URL are configured. */
export function isSamlEnabled(): boolean {
  return config.saml !== undefined;
}
