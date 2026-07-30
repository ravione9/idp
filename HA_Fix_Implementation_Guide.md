# Lenskart IdP — HA Fix Implementation Guide

Companion to `HA_Kubernetes_Architecture.md`. That doc explains *why*; this one is the exact *how* — code diffs against the current repo and copy-paste-ready Kubernetes/Helm YAML. Section numbers reference the architecture doc.

Assumptions: EKS with AWS Load Balancer Controller and External Secrets Operator installed, namespace `idp`, image pushed to ECR as `<ECR_REPO>/lilg:<TAG>`.

---

## Fix 1 — SAML + OIDC signing keys via Secrets Manager (§6, §7b.1)

**Code changes: none.** `ensureSamlKeys()` short-circuits when both env vars are set, and `ensureOidcKeys()` reuses the SAML key when SAML is enabled.

### 1.1 Generate the keypair once

If prod already ran on pam-2 and SPs have pinned the auto-generated cert, **extract the existing one** instead of generating new (avoids re-registering every SP):

```bash
# On pam-2 — pull the current auto-generated key/cert out of the container volume
docker cp idp-api:/app/data/saml/.saml-auto-keys.key ./saml.key
docker cp idp-api:/app/data/saml/.saml-auto-keys.crt ./saml.crt
```

Fresh install only:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
  -keyout saml.key -out saml.crt -days 1095 \
  -subj "/CN=idp.lenskart.com/O=Lenskart IdP/OU=Identity/C=IN"
```

### 1.2 Store in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name lilg/prod/saml-signing \
  --region ap-south-1 \
  --secret-string "$(jq -n \
      --rawfile key saml.key \
      --rawfile crt saml.crt \
      '{privateKeyPem: $key, certPem: $crt}')"

# Then shred local copies
shred -u saml.key
```

### 1.3 Sync into the cluster (External Secrets Operator)

```yaml
# k8s/externalsecret-saml.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: lilg-saml-keys
  namespace: idp
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager        # your ClusterSecretStore/SecretStore
    kind: ClusterSecretStore
  target:
    name: lilg-saml-keys             # resulting K8s Secret
    creationPolicy: Owner
  data:
    - secretKey: SAML_IDP_PRIVATE_KEY_PEM
      remoteRef:
        key: lilg/prod/saml-signing
        property: privateKeyPem
    - secretKey: SAML_IDP_CERT_PEM
      remoteRef:
        key: lilg/prod/saml-signing
        property: certPem
```

### 1.4 Inject into the Deployment

```yaml
# In the lilg-api container spec (full Deployment in Fix 5)
envFrom:
  - secretRef:
      name: lilg-saml-keys
```

### 1.5 Verify

```bash
kubectl -n idp scale deploy/lilg-api --replicas=3
# Fingerprint must be identical from every pod:
for p in $(kubectl -n idp get pods -l app=lilg-api -o name); do
  kubectl -n idp exec $p -- wget -qO- http://localhost:8080/saml/metadata \
    | grep -o '<ds:X509Certificate>[^<]*' | md5sum
done
```

Also check logs: no pod should print `SAML auto-cert generated` — if one does, the env vars didn’t reach it.

---

## Fix 1-ALT — Multi-client deployments WITHOUT Secrets Manager

When the same IdP is deployed for many different clients (each on their own cluster/namespace, possibly not on AWS), an external secret store per client is overhead you don't need. The best method: **an in-cluster bootstrap Job, shipped in your Helm chart, that generates the SAML keypair once per client and stores it as a plain Kubernetes Secret.** No external dependency, every client automatically gets a unique cert, fully idempotent, works on any Kubernetes (EKS, AKS, GKE, on-prem).

### How it works

- Helm `pre-install` hook Job runs before anything else.
- If the Secret `lilg-saml-keys` already exists in the namespace → exit 0 (no-op on every upgrade — the cert never silently changes, which is exactly what SP fingerprint pinning requires).
- If not → generate the keypair with `openssl`, create the Secret, exit.
- The `lilg-api` Deployment consumes the Secret via `envFrom` exactly as in Fix 1.4 — the app's `ensureSamlKeys()` short-circuit works identically. Still zero app code changes.

### 1A.1 RBAC for the bootstrap Job

```yaml
# k8s/keygen-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: lilg-keygen
  namespace: idp
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "-10"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: lilg-keygen
  namespace: idp
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "-10"
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create"]        # deliberately no update/delete — cert is immutable once made
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: lilg-keygen
  namespace: idp
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "-10"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: lilg-keygen
subjects:
  - kind: ServiceAccount
    name: lilg-keygen
    namespace: idp
```

### 1A.2 The keygen Job

```yaml
# k8s/job-keygen.yaml  (Helm template — {{ .Values.idpHostname }} per client)
apiVersion: batch/v1
kind: Job
metadata:
  name: lilg-saml-keygen
  namespace: idp
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "-5"          # after RBAC, before migrate Job & Deployments
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: lilg-keygen
      containers:
        - name: keygen
          image: bitnami/kubectl:1.30    # has kubectl; openssl via the shell below
          command: ["/bin/bash", "-c"]
          args:
            - |
              set -euo pipefail
              NS=idp
              SECRET=lilg-saml-keys
              CN="{{ .Values.idpHostname }}"     # e.g. idp.clientname.com

              if kubectl -n "$NS" get secret "$SECRET" >/dev/null 2>&1; then
                echo "Secret $SECRET already exists — keeping existing cert (SP fingerprints stay valid)"
                exit 0
              fi

              openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
                -keyout /tmp/saml.key -out /tmp/saml.crt -days 1095 \
                -subj "/CN=${CN}/O=Lenskart IdP/OU=Identity/C=IN"

              kubectl -n "$NS" create secret generic "$SECRET" \
                --from-literal=SAML_IDP_PRIVATE_KEY_PEM="$(cat /tmp/saml.key)" \
                --from-literal=SAML_IDP_CERT_PEM="$(cat /tmp/saml.crt)"

              rm -f /tmp/saml.key /tmp/saml.crt
              echo "Generated new SAML cert for ${CN}:"
              openssl x509 -in <(kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data.SAML_IDP_CERT_PEM}' | base64 -d) -noout -fingerprint -sha256 -enddate
```

The Deployment consumes it exactly as before (`envFrom: secretRef: lilg-saml-keys`) — nothing else changes from Fix 1.

### 1A.3 Hardening plain K8s Secrets (do these since there's no external vault)

- **Enable encryption at rest for Secrets in etcd.** On EKS: associate a KMS key with the cluster (one checkbox / one eksctl flag). On kubeadm: an `EncryptionConfiguration` with `aescbc` or KMS provider. Without this, Secrets are base64-plaintext in etcd.
- **Restrict RBAC** on the `idp` namespace: only the CI/CD deployer and the keygen ServiceAccount should read/write Secrets there. No cluster-wide `get secrets` for humans.
- **Back up the Secret per client** (e.g. `kubectl get secret lilg-saml-keys -o yaml` into the client's encrypted backup store, or rely on etcd/Velero backups). If the namespace is deleted and recreated, a *new* cert gets generated and every SP for that client must re-pin — the backup is what saves you from that.
- Rotation: delete the Secret, re-run the Job (or `helm upgrade` after delete), then update fingerprints at that client's SPs. Deliberate and per-client.

### If you keep per-client config in git (GitOps)

Then a generated-in-cluster Secret is invisible to git, which some teams dislike. Two well-trodden options, in order of simplicity:

- **Sealed Secrets** (Bitnami): generate the keypair once per client, `kubeseal` it against that client's cluster, commit the SealedSecret to the client's repo. Only that cluster can decrypt it. One controller to install per cluster.
- **SOPS + age**: encrypt the Secret YAML in git with a per-client age key; decrypt in the CI pipeline at deploy time. No in-cluster controller, but the CI runner holds decryption keys.

Both stay cloud-agnostic. The bootstrap-Job approach remains the recommendation when you don't need the cert visible in git — fewer moving parts and nothing sensitive ever leaves the cluster.

### Same pattern for the app secrets

`SESSION_SECRET` can be bootstrap-generated per client the same way (add `--from-literal=SESSION_SECRET="$(openssl rand -base64 48)"` to a similar Job). Truly external credentials (DB password, SMTP, Google/Zoho/AD adapter creds) can't be generated — deliver those per client as a plain Secret created by your deploy pipeline (`kubectl create secret ... --from-env-file=client.env`), or via Sealed Secrets/SOPS as above.

---

## Fix 2 — Migrations as a one-shot Job + skip flag (§7, Option A)

### 2.1 Code change 1 — CLI entrypoint

New file `src/db/migrate-cli.ts`:

```ts
/**
 * Standalone migration runner — executed by the K8s migration Job.
 *   node dist/db/migrate-cli.js
 */
import { runMigrations } from './migrate.js';
import logger from '../utils/logger.js';

runMigrations()
  .then(() => {
    logger.info('Migrations complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.fatal({ err }, 'Migrations failed');
    process.exit(1);
  });
```

### 2.2 Code change 2 — gate the boot-time call

In `src/config.ts`, add to the zod schema (near the other app-level flags):

```ts
SKIP_MIGRATIONS_ON_BOOT: z
  .string()
  .optional()
  .transform((v) => v === 'true'),
```

…and expose it on the returned config object (in the `app` block):

```ts
skipMigrationsOnBoot: parsed.SKIP_MIGRATIONS_ON_BOOT ?? false,
```

In `src/index.ts` (currently line ~308–314), wrap the existing call:

```ts
if (config.app.skipMigrationsOnBoot) {
  logger.info('SKIP_MIGRATIONS_ON_BOOT=true — migrations handled externally (K8s Job)');
} else {
  try {
    await runMigrations();
  } catch (err) {
    logger.fatal({ err }, 'Database migrations failed — refusing to start');
    process.exit(1);
  }
}
```

Nothing changes for pam-2 / docker-compose: the flag is unset there, behavior identical.

### 2.3 Code change 3 (defense-in-depth, §7 Option B) — `GET_LOCK` in `migrate.ts`

In `runMigrations()`, right after the connection retry loop succeeds (after `if (!conn) throw …`), replace the existing `try { … } finally { await conn.end(); }` body wrapper:

```ts
const LOCK_NAME = 'lilg_migrations';
const LOCK_TIMEOUT_S = 120;

const [lockRows] = await conn.query<mysql.RowDataPacket[]>(
  'SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, LOCK_TIMEOUT_S],
);
if (lockRows[0]?.['got'] !== 1) {
  throw new Error(`Could not acquire migration lock '${LOCK_NAME}' within ${LOCK_TIMEOUT_S}s`);
}

try {
  // ── existing body unchanged: ensureTrackingTable → load → apply loop ──
} finally {
  await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
  await conn.end();
}
```

### 2.4 The migration Job (Helm pre-upgrade hook)

```yaml
# k8s/job-migrate.yaml  (Helm template — for raw kubectl, drop the annotations
# and apply this before the Deployment manifests)
apiVersion: batch/v1
kind: Job
metadata:
  name: lilg-migrate
  namespace: idp
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: <ECR_REPO>/lilg:<TAG>          # same image as the app
          command: ["node", "dist/db/migrate-cli.js"]
          envFrom:
            - configMapRef: { name: lilg-config }
            - secretRef:    { name: lilg-app-secrets }   # DB creds etc.
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { memory: 512Mi }
```

Argo CD equivalent: replace the Helm annotations with `argocd.argoproj.io/hook: PreSync` and `argocd.argoproj.io/hook-delete-policy: BeforeHookCreation`.

---

## Fix 3 — Redis-backed rate limiting (§7b.2)

Replace the in-memory `Map` in `src/auth/rate-limit.ts` with an atomic Redis fixed-window counter (`INCR` + `PEXPIRE`). The function signature is unchanged, so **no caller changes anywhere**. Reuses the shared client from `session-store.ts`.

```ts
/**
 * Redis-backed rate limiter for /auth endpoints — cluster-safe across pods.
 * Falls open (allows the request) if Redis is unreachable: an IdP hard-down
 * because the rate limiter can't reach Redis is worse than one unthrottled window.
 */
import { Request, Response, NextFunction } from 'express';
import { redis } from './session-store.js';
import logger from '../utils/logger.js';

// Atomic INCR + set-expiry-on-first-hit
const LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('PTTL', KEYS[1])
  return {c, ttl}
`;

export function rateLimit(opts: { max: number; windowMs: number; keyFn?: (req: Request) => string }) {
  const { max, windowMs } = opts;
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? 'unknown');

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const key = `idp:rl:${keyFn(req)}`;
      try {
        const [count, pttl] = (await redis.eval(LUA, 1, key, String(windowMs))) as [number, number];
        if (count > max) {
          const retry = Math.max(1, Math.ceil(pttl / 1000));
          res.set('Retry-After', String(retry));
          res.status(429).json({ error: 'Too many requests', retryAfter: retry });
          return;
        }
        next();
      } catch (err) {
        logger.warn({ err }, 'Rate limiter Redis error — failing open');
        next();
      }
    })();
  };
}
```

Notes:
- Fixed-window (matches current semantics closely enough for login throttling). If you later want sliding-window, swap the Lua for a ZSET version — callers still don’t change.
- Existing per-pod limits were effectively `max × N`; after this change the configured `max` is global again. Review the configured values in the `/auth` routes — they may have been tuned (implicitly) to single-instance behavior.

---

## Fix 4 — Distributed locks for the three in-API schedulers (§7b.3)

One small shared helper, then a 2-line change per scheduler. Pattern is identical to the outbox worker’s existing leader election.

### 4.1 New file `src/utils/sched-lock.ts`

```ts
/**
 * Best-effort distributed mutex for scheduler ticks (Redis SET NX PX).
 * Lock auto-expires; we deliberately do NOT release early, so a tick
 * runs at most once per TTL window across all pods.
 */
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';

export async function withSchedLock(
  name: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<void> {
  const key = `idp:sched:${name}:lock`;
  try {
    const ok = await redis.set(key, `${process.env['HOSTNAME'] ?? 'pod'}:${Date.now()}`, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return;              // another pod owns this tick
  } catch (err) {
    logger.warn({ err, name }, 'Sched lock: Redis unavailable — running tick locally (may duplicate)');
  }
  await fn();
}
```

### 4.2 Apply to each scheduler

`src/services/attendance-iga/scheduler.ts` — wrap the tick body (TTL = 55s, just under the 60s interval):

```ts
import { withSchedLock } from '../../utils/sched-lock.js';

timer = setInterval(() => {
  void withSchedLock('attendance-iga', 55_000, tickAll);
}, 60_000);
```

`src/services/access-request-expiry.ts` (interval 5 min → TTL 4.5 min):

```ts
import { withSchedLock } from '../utils/sched-lock.js';

timer = setInterval(() => {
  void withSchedLock('access-request-expiry', 270_000, sweep);
}, INTERVAL_MS);
```

`src/services/connector-health.ts` (TTL = interval − 10%):

```ts
import { withSchedLock } from '../utils/sched-lock.js';

healthTimer = setInterval(() => {
  void withSchedLock('connector-health', Math.floor(HEALTH_INTERVAL_MS * 0.9), tick);
}, HEALTH_INTERVAL_MS);
```

Also wrap the immediate boot-time invocations (`void tickAll()` at scheduler start, the 15s-delayed first sweep) the same way, otherwise every pod still runs once at startup.

---

## Fix 5 — Kubernetes manifests (compute tier, §3)

### 5.1 ConfigMap + app Secret

```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: lilg-config, namespace: idp }
data:
  NODE_ENV: "production"
  PORT: "8080"
  PUBLIC_BASE_URL: "https://idp.lenskart.com"
  SAML_IDP_BASE_URL: "https://idp.lenskart.com"
  SAML_IDP_ENTITY_ID: "https://idp.lenskart.com/saml/metadata"
  COOKIE_SECURE: "true"
  TRUST_PROXY: "true"
  SKIP_MIGRATIONS_ON_BOOT: "true"          # Fix 2 — Job owns migrations
  DB_HOST: "<rds-endpoint>.ap-south-1.rds.amazonaws.com"
  REDIS_URL: "rediss://<elasticache-endpoint>:6379/0"
  SQS_HRMS_EVENTS_URL: "https://sqs.ap-south-1.amazonaws.com/<acct>/hrms-events"
  SQS_CELERY_BROKER_URL: "https://sqs.ap-south-1.amazonaws.com/<acct>/celery-broker"
```

```yaml
# k8s/externalsecret-app.yaml — everything else from .env that is sensitive
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: lilg-app-secrets, namespace: idp }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secrets-manager, kind: ClusterSecretStore }
  target: { name: lilg-app-secrets, creationPolicy: Owner }
  dataFrom:
    - extract:
        key: lilg/prod/app        # JSON secret: DB_USER, DB_PASSWORD, SESSION_SECRET,
                                  # MASTER_ADMIN_*, INTERNAL_TOKEN, adapter creds, SMTP, …
```

### 5.2 ServiceAccount with IRSA (SQS + Secrets Manager)

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: lilg
  namespace: idp
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<acct>:role/lilg-prod
    # IAM role policy: sqs:SendMessage/ReceiveMessage/DeleteMessage on the two queues,
    # secretsmanager:GetSecretValue on lilg/prod/* (app-level reads, if used at runtime)
```

### 5.3 `lilg-api` Deployment + Service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lilg-api
  namespace: idp
spec:
  replicas: 3
  strategy:
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  selector:
    matchLabels: { app: lilg-api }
  template:
    metadata:
      labels: { app: lilg-api }
    spec:
      serviceAccountName: lilg
      terminationGracePeriodSeconds: 35     # index.ts forces exit at 30s
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app: lilg-api }
      containers:
        - name: api
          image: <ECR_REPO>/lilg:<TAG>
          ports:
            - { containerPort: 8080, name: http }
          envFrom:
            - configMapRef: { name: lilg-config }
            - secretRef:    { name: lilg-app-secrets }
            - secretRef:    { name: lilg-saml-keys }     # Fix 1
          startupProbe:                                   # covers slow first boot
            httpGet: { path: /readyz, port: 8080 }
            periodSeconds: 5
            failureThreshold: 36          # up to 3 min
          readinessProbe:
            httpGet: { path: /readyz, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 15
            failureThreshold: 3
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { memory: 1Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: lilg-api
  namespace: idp
spec:
  selector: { app: lilg-api }
  ports:
    - { port: 80, targetPort: 8080, protocol: TCP }
```

### 5.4 PDB + HPA

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: lilg-api, namespace: idp }
spec:
  minAvailable: 2
  selector:
    matchLabels: { app: lilg-api }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: lilg-api, namespace: idp }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: lilg-api }
  minReplicas: 3
  maxReplicas: 6            # keep (pool size × maxReplicas) < RDS max_connections
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 65 }
```

### 5.5 `lilg-worker` Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lilg-worker
  namespace: idp
spec:
  replicas: 2                     # leader-elected; 2nd is warm standby
  selector:
    matchLabels: { app: lilg-worker }
  template:
    metadata:
      labels: { app: lilg-worker }
    spec:
      serviceAccountName: lilg
      terminationGracePeriodSeconds: 35
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app: lilg-worker }
      containers:
        - name: worker
          image: <ECR_REPO>/lilg:<TAG>
          command: ["node", "dist/services/outbox-worker.js"]
          envFrom:
            - configMapRef: { name: lilg-config }
            - secretRef:    { name: lilg-app-secrets }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { memory: 512Mi }
```

### 5.6 Ingress (ALB, TLS at the edge — §8)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: lilg
  namespace: idp
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443},{"HTTP":80}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:ap-south-1:<acct>:certificate/<id>
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    # Cloudflare stays in front: set Full (strict) mode, restrict ALB SG to Cloudflare IPs
spec:
  ingressClassName: alb
  rules:
    - host: idp.lenskart.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: lilg-api, port: { number: 80 } }
```

No session-affinity annotations — sessions live in MySQL/Redis (§5); affinity would only add overhead.

### 5.7 ServiceMonitor (§11)

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: lilg-api
  namespace: idp
  labels: { release: kube-prometheus-stack }
spec:
  selector:
    matchLabels: { app: lilg-api }
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      headers:                       # /metrics requires the internal token
        x-internal-token: <INTERNAL_TOKEN>   # or inject via secret + relabeling
```

---

## Rollout order

1. **Code PR** — Fixes 2 (CLI + flag + `GET_LOCK`), 3 (rate limit), 4 (scheduler locks). All backward-compatible: with no new env vars set, behavior on pam-2 is unchanged except rate limiting moves to Redis (verify Redis reachability there) and scheduler ticks take a Redis lock (single instance → always wins the lock).
2. **AWS** — RDS Multi-AZ + ElastiCache provisioned; secrets created (1.2); IRSA role.
3. **Cluster** — ESO secret stores, ConfigMap/ExternalSecrets, migration Job, Deployments, PDB/HPA, Ingress, ServiceMonitor — in that order.
4. **Verify** at 3 replicas: identical SAML fingerprint from every pod (1.5); one `Applying migration` log line total per migration (Job only); 429s enforced globally (hit `/auth/login` >max times split across pods); exactly one `Attendance IGA scheduled run` per due window across all pods.
5. **Cutover** — point Cloudflare at the ALB; keep pam-2 warm until soak completes.
