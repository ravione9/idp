import { z } from 'zod';
import { ensureSamlKeys } from './services/saml-auto-keys.js';

// Auto-generate SAML keys if not configured — must run before env is parsed
ensureSamlKeys();

// ---------------------------------------------------------------------------
// Helper coercions
// ---------------------------------------------------------------------------
const envInt = z.string().transform((v) => parseInt(v, 10)).pipe(z.number().int().positive());
const envFloat = z.string().transform((v) => parseFloat(v)).pipe(z.number());
const envBool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Treat blank env vars as unset (common in .env files). */
function emptyToUndefined(val: unknown): unknown {
  if (typeof val === 'string' && val.trim() === '') return undefined;
  return val;
}

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

  // AWS / SQS — accept http URLs for LocalStack in dev
  AWS_REGION: z.string().min(1),
  SQS_HRMS_EVENTS_URL: z.string().min(1),
  SQS_CELERY_BROKER_URL: z.string().min(1),

  // Google
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_HOSTED_DOMAIN: z.string().min(1),
  GOOGLE_SA_KEY_JSON: z.string().min(1),

  // Zoho — only used by the outbound IGA adapter (zoho-adapter.ts) for
  // SCIM-style provisioning into Zoho. NOT used for portal login anymore.
  ZOHO_CLIENT_ID:     z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  ZOHO_CLIENT_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  ZOHO_SCIM_BASE_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional()),

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
  /** Set 'false' for plain-HTTP dev (192.168.24.254). Defaults to true in production. */
  COOKIE_SECURE: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    envBool.optional(),
  ),

  // Application
  PORT: envInt.default('8080'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  IDP_DETERMINISTIC: envBool.default('false'),
  /** When "true", API skips runMigrations() on boot (K8s Job owns schema). Unset/false = current behavior. */
  SKIP_MIGRATIONS_ON_BOOT: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // Outbox worker
  OUTBOX_LEADER_TTL_MS: envInt.default('30000'),
  OUTBOX_POLL_INTERVAL_MS: envInt.default('5000'),

  // Circuit breaker
  CIRCUIT_BREAKER_ERROR_THRESHOLD: envFloat.default('50'),

  // Internal token
  INTERNAL_TOKEN: z.string().min(16),

  // RADIUS / VPN AAA (optional UDP listener; REST always available via /api/internal/radius)
  RADIUS_UDP_ENABLED: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    envBool.optional(),
  ),
  RADIUS_UDP_PORT: z.preprocess(emptyToUndefined, envInt.optional()),
  RADIUS_UDP_BIND: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

  // One-time bootstrap token for first local super admin (dev only — unset in prod after bootstrap)
  LOCAL_BOOTSTRAP_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),

  // Master administrator — always provisioned from env on startup (SSO/IGA portal admin)
  MASTER_ADMIN_EMAIL: z.preprocess(
    emptyToUndefined,
    z.string().email().optional(),
  ),
  MASTER_ADMIN_PASSWORD: z.preprocess(
    emptyToUndefined,
    z.string().min(10).max(128).optional(),
  ),
  MASTER_ADMIN_FULL_NAME: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).max(255).default('Master Administrator'),
  ),

  // Public URL — relaxed for dev IPs (e.g. http://192.168.24.254:8080)
  PUBLIC_BASE_URL: z.string().min(1).optional(),

  /**
   * Express trust proxy setting — required behind Cloudflare / ALB / NGINX.
   * Use `true` for Cloudflare orange-cloud (proxied). Default: true when PUBLIC_BASE_URL is https.
   */
  TRUST_PROXY: z.preprocess(
    (v) => {
      if (v === undefined || (typeof v === 'string' && v.trim() === '')) return undefined;
      if (v === 'true' || v === true) return true;
      if (v === 'false' || v === false) return false;
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? true : n;
    },
    z.union([z.boolean(), z.number().int().nonnegative()]).optional(),
  ),

  // SAML IdP (optional — production host: https://idp.lenskart.com)
  SAML_IDP_BASE_URL: z.string().min(1).optional(),
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
  const hasMasterEmail = Boolean(parsed.MASTER_ADMIN_EMAIL);
  const hasMasterPass  = Boolean(parsed.MASTER_ADMIN_PASSWORD);
  if (hasMasterEmail !== hasMasterPass) {
    throw new Error(
      'MASTER_ADMIN_EMAIL and MASTER_ADMIN_PASSWORD must both be set or both omitted',
    );
  }
} catch (err) {
  if (err instanceof z.ZodError) {
    console.error('[IDP] Configuration validation failed:');
    for (const issue of err.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    console.error('[IDP] Unknown configuration error:', err);
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
    /** Only set when ZOHO_* env vars exist; used by outbound provisioning adapter. */
    clientId:     parsed.ZOHO_CLIENT_ID ?? '',
    clientSecret: parsed.ZOHO_CLIENT_SECRET ?? '',
    scimBaseUrl:  parsed.ZOHO_SCIM_BASE_URL ?? '',
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
    cookieSecure:
      parsed.COOKIE_SECURE ?? (parsed.NODE_ENV === 'production'),
  },
  app: {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    deterministic: parsed.IDP_DETERMINISTIC,
    skipMigrationsOnBoot: parsed.SKIP_MIGRATIONS_ON_BOOT ?? false,
    outboxLeaderTtlMs: parsed.OUTBOX_LEADER_TTL_MS,
    outboxPollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
    circuitBreakerErrorThreshold: parsed.CIRCUIT_BREAKER_ERROR_THRESHOLD,
    internalToken: parsed.INTERNAL_TOKEN,
    localBootstrapToken: parsed.LOCAL_BOOTSTRAP_TOKEN,
    masterAdmin:
      parsed.MASTER_ADMIN_EMAIL && parsed.MASTER_ADMIN_PASSWORD
        ? {
            email:    parsed.MASTER_ADMIN_EMAIL.toLowerCase().trim(),
            password: parsed.MASTER_ADMIN_PASSWORD,
            fullName: parsed.MASTER_ADMIN_FULL_NAME,
          }
        : undefined,
    /** Canonical public origin (e.g. https://idp.lenskart.com). Falls back to request Host when unset. */
    publicBaseUrl: (parsed.PUBLIC_BASE_URL ?? parsed.SAML_IDP_BASE_URL)?.replace(/\/$/, ''),
    /** Express `trust proxy` — true/number for Cloudflare WAF and other reverse proxies. */
    trustProxy: (() => {
      if (parsed.TRUST_PROXY !== undefined) return parsed.TRUST_PROXY;
      const pub = (parsed.PUBLIC_BASE_URL ?? parsed.SAML_IDP_BASE_URL ?? '').toLowerCase();
      if (pub.startsWith('https://')) return true;
      return parsed.NODE_ENV === 'production' ? 1 : false;
    })(),
  },
  radius: {
    udpEnabled: parsed.RADIUS_UDP_ENABLED ?? false,
    udpPort: parsed.RADIUS_UDP_PORT ?? 1812,
    udpBind: parsed.RADIUS_UDP_BIND ?? '0.0.0.0',
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
