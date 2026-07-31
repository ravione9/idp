import fs from 'node:fs/promises';

type VaultLoginResponse = {
  auth?: { client_token?: string };
};

type VaultKvV1Response = {
  data?: Record<string, unknown>;
  errors?: string[];
};

function vaultEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/** Load KV v1 secrets from Vault into process.env (CCMS-style VAULT_* config). */
export async function loadVaultSecretsIntoEnv(): Promise<void> {
  if (vaultEnv('VAULT_ENABLED') !== 'true') return;

  const vaultUri = vaultEnv('VAULT_URI');
  const role = vaultEnv('VAULT_ROLE');
  const context = vaultEnv('VAULT_DEFAULT_CONTEXT');
  const backend = vaultEnv('VAULT_BACKEND') ?? 'multiverse/config';
  const k8sAuthPath = vaultEnv('VAULT_KUBERNETES-PATH') ?? 'kubernetes';
  const tokenFile =
    vaultEnv('VAULT_SERVICE-ACCOUNT-TOKEN-FILE') ??
    '/var/run/secrets/kubernetes.io/serviceaccount/token';

  if (!vaultUri || !role || !context) {
    throw new Error(
      '[IDP] VAULT_ENABLED=true but VAULT_URI, VAULT_ROLE, or VAULT_DEFAULT_CONTEXT is missing',
    );
  }

  const jwt = (await fs.readFile(tokenFile, 'utf8')).trim();
  const loginResp = await fetch(`${vaultUri}/v1/auth/${k8sAuthPath}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, jwt }),
  });

  if (!loginResp.ok) {
    const body = await loginResp.text();
    throw new Error(
      `[IDP] Vault Kubernetes login failed (${loginResp.status}): ${body}`,
    );
  }

  const loginJson = (await loginResp.json()) as VaultLoginResponse;
  const token = loginJson.auth?.client_token;
  if (!token) {
    throw new Error('[IDP] Vault login succeeded but no client_token returned');
  }

  const secretPath = `${backend.replace(/\/$/, '')}/${context}`;
  const secretResp = await fetch(`${vaultUri}/v1/${secretPath}`, {
    headers: { 'X-Vault-Token': token },
  });

  if (!secretResp.ok) {
    const body = await secretResp.text();
    throw new Error(
      `[IDP] Vault read ${secretPath} failed (${secretResp.status}): ${body}`,
    );
  }

  const secretJson = (await secretResp.json()) as VaultKvV1Response;
  if (secretJson.errors?.length) {
    throw new Error(`[IDP] Vault read ${secretPath}: ${secretJson.errors.join(', ')}`);
  }

  const data = secretJson.data ?? {};
  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error(
      `[IDP] Vault path ${secretPath} is empty — write secrets with: vault write ${secretPath} KEY=value ...`,
    );
  }

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = String(value);
    }
  }

  console.info(`[IDP] Loaded ${keys.length} keys from Vault path ${secretPath}`);
}
