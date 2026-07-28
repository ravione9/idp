# Lenskart IdP — HA Architecture on Kubernetes (AWS EKS)

Target: `idp.lenskart.com` — enterprise SAML/OIDC identity provider, SSO, and identity lifecycle governance.

This document is written against the current codebase (`@lenskart/lilg`), not a generic reference architecture. Every recommendation below ties back to something observed in `docker-compose.prod.yml`, `src/config.ts`, `src/index.ts`, `src/api/health.ts`, `src/services/outbox-worker.ts`, `src/services/saml-auto-keys.ts`, and `src/db/migrate.ts`.

---

## 1. Current state (single point of failure inventory)

Today: one host (`pam-2`), one `docker-compose` stack, no orchestration.

| Component | Today | Failure mode |
|---|---|---|
| `lilg-api` | 1 container | Host reboot/crash = full IdP outage — every SP login and admin console goes down |
| `lilg-worker` | 1 container | Outbox stalls silently; HRMS/Google/Zoho/AD provisioning backs up |
| MySQL | 1 container, local volume | Data loss risk on disk failure; no failover |
| Redis | 1 container, local volume | Sessions and MFA challenge state lost on restart |
| SAML signing keys | Written to local disk (`SAML_KEY_DIR`) | Tied to host; not replicated |
| TLS | Cloudflare orange-cloud → host `:80`/`:443`, optional ACME webroot | Single origin, single cert store |
| Deploy | `ssh pam-2` + `git reset --hard` + `docker-compose` | Manual, no rolling update, no rollback automation |

Everything below addresses each row.

---

## 2. Target topology (AWS EKS, multi-AZ)

```
Cloudflare (DNS/WAF) → AWS ALB (Multi-AZ, ACM/Cloudflare TLS)
        → EKS cluster, node groups spread across 3 AZs
              → Deployment: lilg-api   (N replicas, HPA, PDB, topology spread)
              → Deployment: lilg-worker (2–3 replicas, Redis leader-elected)
        → RDS MySQL 8 (Multi-AZ)  |  ElastiCache Redis (Multi-AZ)  |  AWS SQS  |  Secrets Manager
```

See the diagram above for the visual. The rest of this doc fills in the reasoning per tier.

---

## 3. Compute tier — `lilg-api` and `lilg-worker` as Deployments

**Why these two stay separate Deployments:** they already run as separate processes/containers in `docker-compose.yml` (`lilg-api` vs. `node dist/services/outbox-worker.js`), and they scale differently — `lilg-api` scales with login traffic, `lilg-worker` scales with outbox queue depth.

`lilg-api`:
- `replicas: 3` minimum (one per AZ), `HorizontalPodAutoscaler` on CPU (60–70%) or a custom metric off `lilg_db_pool_queued` / request rate from the existing `/metrics` endpoint.
- `PodDisruptionBudget minAvailable: 2` so cluster upgrades/node drains never take the IdP fully down.
- `topologySpreadConstraints` (or pod anti-affinity) keyed on `topology.kubernetes.io/zone` so replicas don't collapse onto one AZ.
- Probes map directly onto endpoints that already exist in `src/api/health.ts` — no app changes needed:
  - `livenessProbe` → `GET /healthz` (always 200 if process is up)
  - `readinessProbe` → `GET /readyz` (checks DB + Redis, returns 503 if either is down — exactly what you want gating traffic)
  - `startupProbe` → also `/readyz`, with a longer `failureThreshold` to cover first-boot migration time
- Rolling update: `maxUnavailable: 0`, `maxSurge: 1` (or 25%). Safe because sessions aren't in-process (see §5) — no connection draining choreography needed beyond the graceful shutdown already implemented in `src/index.ts` (`SIGTERM`/`SIGINT` → `server.close()` → 30s forced-exit timeout). That code is already container/K8s-ready; just set `terminationGracePeriodSeconds: 35` to give it room.

`lilg-worker`:
- `replicas: 2–3`. This is safe *today* without any code change: `src/services/outbox-worker.ts` already implements Redis `SET NX PX` leader election (`idp:outbox:leader`) plus a per-system concurrency semaphore. Only one replica actively drains the outbox at a time; if it dies, the lock TTL expires and another replica takes over. Deploy multiple replicas purely for failover speed, not throughput.
- No externally-facing Service needed — internal only.
- Same liveness probe pattern isn't available out of the box (no HTTP server in the worker process) — add a simple TCP or exec probe (e.g., a lockfile/heartbeat write) if you want K8s to restart a wedged worker; not blocking for initial HA rollout.

---

## 4. Data tier — managed AWS vs. in-cluster HA

You asked to cover both. Trade-offs:

| | **Managed (RDS + ElastiCache)** | **In-cluster (Percona Operator + Redis Sentinel/Operator)** |
|---|---|---|
| MySQL HA | RDS Multi-AZ — automatic failover (~60–120s), synchronous standby, automated backups + PITR | Percona XtraDB Cluster or MySQL InnoDB ClusterSet operator — Galera/group replication inside EKS; you own backup automation, failover tuning, storage class (EBS gp3, `ReadWriteOnce` per replica) |
| Redis HA | ElastiCache replication group, Multi-AZ auto-failover, encryption at rest/in transit built in | Redis Operator (e.g. Bitnami/Spotahome) running Sentinel or Redis Cluster mode as StatefulSets; you manage quorum, persistence (AOF/RDB on PVs), upgrades |
| Ops burden | Low — AWS handles patching, failover, backups | High — you run the operator, monitor quorum health, handle split-brain scenarios |
| Cost | AWS service pricing, no extra compute for DB pods | Cheaper at scale if you already over-provision EKS nodes, but real ops time cost |
| Latency | Cross-service (RDS/ElastiCache endpoints), typically same-VPC, negligible | In-cluster, marginally lower latency |
| Fit for an IdP | **Recommended.** This is the identity provider for the whole company — MySQL and Redis outages here mean company-wide login outage. Minimizing operational surface area matters more than the cost delta. | Reasonable if there's an existing platform team already running these operators for other workloads and wants one operational model everywhere. |

**Recommendation:** RDS MySQL Multi-AZ + ElastiCache Redis Multi-AZ as the default. If there's an existing in-cluster data platform (Percona/Redis operators already run for other services), reusing it is defensible — just budget real SRE time for quorum/failover testing before cutover, since this is higher blast-radius than a typical stateless service outage.

Either way: `DB_HOST` / `REDIS_URL` in `src/config.ts` are already just connection strings — no code change required to point at RDS/ElastiCache endpoints vs. in-cluster Services.

**One sizing note:** `mysql2` pool size × `lilg-api` replica count must stay under RDS `max_connections` (and leave headroom for `lilg-worker` and admin tooling). Check the current pool config in `src/db/connection.ts` before setting `HPA maxReplicas`.

---

## 5. Sessions — already stateless-friendly

`ARCHITECTURE.md` §5.2: sessions are stored in MySQL (`lilg_sessions`) and cached in Redis (`idp:session:<id>`), not in-process. This is the single biggest thing already working in your favor for K8s: **no session affinity / sticky sessions needed at the ALB or Ingress.** Any pod can serve any request. Don't add `IngressAffinity`/cookie-based routing — it would be pure overhead here.

---

## 6. SAML signing keys — the one thing that will break silently at N>1 replicas

### 6.1 Exact code path

`src/services/saml-auto-keys.ts`, `ensureSamlKeys()`:

1. **Line 70–72**: if both `SAML_IDP_PRIVATE_KEY_PEM` and `SAML_IDP_CERT_PEM` are already set in the environment, return immediately — nothing else in this function runs.
2. **Line 75–98**: otherwise, look for persisted key/cert files on local disk at `SAML_KEY_DIR` (default `/app/data/saml`). If found and the cert has >30 days validity left, load them into `process.env` and return.
3. **Line 101+**: otherwise, **generate a brand-new RSA-2048 self-signed cert** (3-year validity), write it to those two files on local disk, and inject it into `process.env`.

This is designed for exactly one long-lived container on one host with a persistent volume — which is what `pam-2` is today. It was never designed for N interchangeable, ephemeral pods.

### 6.2 Why it breaks with multiple replicas

Kubernetes pods have ephemeral root filesystems by default (no volume = nothing survives a restart, and nothing is shared between pods regardless). Walk through a 3-replica rollout with no `SAML_IDP_PRIVATE_KEY_PEM`/`CERT_PEM` env vars set:

- Pod A boots, finds no persisted files, generates **cert A**, starts serving.
- Pod B boots (no shared disk), finds no persisted files either, generates **cert B** — a completely different keypair and fingerprint.
- Pod C generates **cert C**.

Now `/saml/metadata` returns a different certificate depending which pod the ALB happens to route a given request to. Every relying party (Google Workspace, Zoho, any SAML SP registered against this IdP) pins the certificate fingerprint it saw when the SP was configured. Whichever pod's fingerprint got registered, the *other two pods'* signed assertions will fail signature validation at the SP. Because routing is round-robin/least-connections, this doesn't look like a clean outage — it looks like **SSO working for some logins and silently failing for others**, correlated with nothing obvious from the user's side. That's a much harder incident to diagnose than a hard failure.

Note that a shared `ReadWriteMany` volume (EFS) only half-fixes this: on a *cold* start where the file doesn't exist yet, two pods booting at the same instant can still both hit the "no file found" branch simultaneously and both write competing cert files, with whichever write lands last silently winning on disk while the other pod keeps running with the cert it already loaded into memory. It's the same class of race as the migration issue in §7 — a shared volume removes the steady-state divergence but not the cold-start race.

### 6.3 The fix

**Generate the cert once, store it centrally, inject it as configuration — never let the app generate it per pod in this environment.**

1. Generate a keypair/cert once — either let `ensureSamlKeys()` create one locally and pull the two PEM files out, or use `openssl req -x509 -newkey rsa:2048 -nodes -keyout saml.key -out saml.crt -days 1095 -subj "/CN=idp.lenskart.com/O=Lenskart IdP/OU=Identity/C=IN"` if you want explicit control over validity/subject.
2. Store both PEM strings in **AWS Secrets Manager** (e.g. one secret `lilg/saml-signing-cert` with `privateKeyPem` / `certPem` fields). You already depend on `@aws-sdk/client-secrets-manager` in `package.json`, so this isn't a new tool in the stack — it's already assumed to be there.
3. Sync that secret into a Kubernetes `Secret` (`lilg-saml-keys`) via **External Secrets Operator**, then mount its keys as `SAML_IDP_PRIVATE_KEY_PEM` / `SAML_IDP_CERT_PEM` env vars on the `lilg-api` Deployment (`envFrom.secretRef` or explicit `valueFrom.secretKeyRef`).
4. Because of the short-circuit at line 70–72, every pod that boots with those two env vars set skips key generation entirely and loads the identical cert — **zero code changes required**.
5. Keep `saml-auto-keys.ts` as-is for local dev / `docker-compose.dev.yml`, where single-container auto-generation is fine. Just make sure the K8s manifests for every real environment always set both env vars so the auto-gen branch is unreachable there.
6. Rotation is now a deliberate, out-of-band operation instead of a silent per-pod side effect: when the cert nears expiry, generate a new one, update the Secrets Manager entry, roll the Deployment — but budget time to update the fingerprint at every SP (Google Workspace, Zoho, etc.), since that's an external coordination step, not just a Kubernetes one.

---

## 7. Migrations — no distributed lock today

### 7.1 Exact mechanics

`src/index.ts` line 310 calls `await runMigrations()` inside `main()`, **before the HTTP server starts listening** — every pod runs this on every boot. Inside `src/db/migrate.ts`, `runMigrations()`:

1. Opens its own dedicated `mysql.createConnection()` (retrying up to `DB_CONNECT_RETRIES` times if MySQL isn't reachable yet).
2. `ensureTrackingTable()` — `CREATE TABLE IF NOT EXISTS lilg_schema_migrations`.
3. `SELECT name, checksum FROM lilg_schema_migrations` — builds an in-memory map of what's already applied.
4. Loops over every `.sql` file in `migrations/` in sorted order; for each one **not** in that map, calls `applyMigrationSql()` (runs the file's SQL as a batch, with a compatibility fallback that replays it statement-by-statement for older MySQL variants that reject `ADD COLUMN IF NOT EXISTS`), then `INSERT`s a tracking row.

There is no `GET_LOCK`, no advisory lock, and no transaction wrapping steps 3–4 (a transaction wouldn't fully help anyway — MySQL DDL statements like `ALTER TABLE`/`CREATE TABLE` auto-commit implicitly regardless of any surrounding transaction). This is a textbook check-then-act race: step 3 (read "what's applied") and step 4 (apply + record) are two separate round-trips with no lock holding them together.

### 7.2 Why it's fine today and won't be at N replicas

With exactly one `lilg-api` container (today's `docker-compose` reality), there's only ever one caller, so the race never has a second participant. In Kubernetes, any of the following put two or more pods through `runMigrations()` within milliseconds of each other, all reading the same "nothing applied yet" snapshot: a rolling deploy with `maxSurge` > 0 bringing up new pods before old ones terminate, a `kubectl apply`/Helm install bringing all replicas up cold at once, an HPA scale-up event, or — worst case — a full cluster/disaster-recovery restart where all pods start simultaneously during an actual incident.

Concretely, if two pods both see a given migration as pending and both call `applyMigrationSql()` on it concurrently:

- MySQL 8 serializes conflicting DDL via metadata locks, so the second pod's statement blocks behind the first's, then typically surfaces as something like "Duplicate column name" or a lock-wait timeout once it's unblocked.
- That error propagates out of `applyMigrationSql()`, is logged as `'Migration failed — aborting startup'`, and rethrown.
- Back in `index.ts`, that becomes `logger.fatal(...)` + `process.exit(1)` — the pod crash-loops, even though the migration may have already succeeded via the *other* pod.
- With `maxUnavailable: 0`, this is contained (old pods keep serving while the bad new pod loops and eventually alerts) — annoying but not an outage. In a full simultaneous restart during an incident, though, you can end up with multiple pods crash-looping against each other until they happen to serialize by luck, which delays the whole IdP coming back up at exactly the moment you can least afford it.
- There's also a subtler risk: the statement-by-statement compatibility retry path (added specifically because some MySQL variants reject `ADD COLUMN IF NOT EXISTS`) interleaving with another connection's single-batch attempt on the *same* `ALTER TABLE` is a genuinely messier failure mode than a clean duplicate-key error, since it's operating statement-by-statement rather than atomically.

### 7.3 Fix options

**Option A — recommended: move migrations out of the pod boot path entirely.**

- Add a small CLI entrypoint that just calls `runMigrations()` and exits (e.g. `node dist/db/migrate-cli.js`, or reuse the existing compiled `migrate.js` with a thin wrapper).
- Run it as a Kubernetes `Job` (or a Helm `pre-upgrade`/`pre-install` hook, which Helm natively sequences before the Deployment's new ReplicaSet rolls out) using the same container image, with a sane `backoffLimit` and `activeDeadlineSeconds`.
- Add one new boolean env var (zod-validated in `config.ts`, e.g. `SKIP_MIGRATIONS_ON_BOOT`) and gate the `await runMigrations()` call at `index.ts:310` behind it — set `true` on the `lilg-api`/`lilg-worker` Deployments, leave it unset (`false`) only on the Job. This is the one code change this option needs.
- For Argo CD instead of Helm, the equivalent is a `PreSync` hook / sync-wave ordering the migration Job before the Deployment sync.

**Option B — smaller diff, keeps "runs on every boot" model: add a real distributed lock.**

- Right after opening the connection in `runMigrations()` (after the retry loop, before `ensureTrackingTable`), call `SELECT GET_LOCK('lilg_migrations', <timeout_seconds>)`. Wrap the existing body in `try { ... } finally { await conn.query("SELECT RELEASE_LOCK('lilg_migrations')"); await conn.end(); }` — or rely on `conn.end()` closing the session, which implicitly releases the lock, since `GET_LOCK` is already scoped to `runMigrations()`'s dedicated connection.
- Every pod still attempts migrations on every boot, but now they serialize: the first pod to acquire the lock runs the check-and-apply cycle to completion; every other pod blocks on `GET_LOCK` until it's released, then re-runs its own check and finds everything already applied (a harmless no-op).
- This is a same-file, ~5 line change and doesn't require any new Job/Helm-hook plumbing — a reasonable stopgap if you want to scale to multiple replicas sooner and add the Job-based approach later.

**Recommendation: do both — they're not mutually exclusive, and B is nearly free once you're touching this file.**

- Ship **Option A** (Job/Helm pre-upgrade hook + `SKIP_MIGRATIONS_ON_BOOT`) as the primary mechanism. It gives you a single, visible, blocking step per deploy — if the migration fails, the rollout stops before any new pod with a mismatched schema expectation goes live. That property (fail the deploy, not the running fleet) is what you actually want for an IdP, and it's the standard pattern for a reason.
- Add **Option B**'s `GET_LOCK` in `migrate.ts` anyway, as defense-in-depth, not as the primary mechanism. It's a ~5 line change and it protects you from the scenarios Option A alone doesn't fully cover: someone forgets to set `SKIP_MIGRATIONS_ON_BOOT` on a new pod template, an old Job and a new Job overlap during a fast-follow deploy, or a local/staging environment still runs multiple `docker-compose` instances against the same DB by mistake. Belt-and-suspenders costs almost nothing here and removes an entire class of "someone misconfigured one flag" incidents.

If you only have bandwidth for one right now: do the Job first (§7.3 Option A) — it's the one that actually prevents a bad migration from reaching production traffic, not just the one that prevents pods from racing each other.

---

## 7b. Second-pass audit — other things that change at N>1 replicas

A re-review of the codebase surfaced four more findings beyond §6/§7. None block the first HA deploy the way §6/§7 do, but two are security-relevant for an IdP.

### 7b.1 OIDC signing keys — same disease as SAML keys, mostly cured by the same fix

`src/oidc/keys.ts` (`ensureOidcKeys()`, called at `index.ts:323`) mirrors the SAML auto-key pattern: prefer configured key → fall back to disk (`OIDC_KEY_DIR`/`SAML_KEY_DIR`) → **auto-generate RSA-2048 per process and persist to local disk**. Per-pod generation would mean each pod publishes a different JWKS (`kid` + key), so ID tokens signed by pod A fail verification against the JWKS fetched from pod B.

The saving grace: when SAML is enabled and configured, **OIDC reuses the SAML IdP signing key** (lines 65–68). So the §6 fix — injecting `SAML_IDP_PRIVATE_KEY_PEM` via Secret — automatically fixes OIDC too. Just verify `isSamlEnabled()` is true in prod config; if you ever run OIDC without SAML, inject a dedicated OIDC key the same way instead of relying on the disk-persist path.

### 7b.2 Login rate limiting is per-pod in-memory — weakens brute-force protection ×N

`src/auth/rate-limit.ts` keeps its token buckets in an in-process `Map` (line 14) with a `setInterval` evictor. With 3 replicas behind round-robin, an attacker's attempts spread across pods, so the effective brute-force budget is ~3× the configured limit — and retries that should be blocked succeed when they land on a fresh pod. For an IdP this is worth fixing near-term: back the buckets with Redis (`INCR` + `PEXPIRE`, or a Lua token bucket — the ioredis client and the semaphore pattern already exist in `outbox-worker.ts`). Until then, treat configured limits as "per pod" and set them accordingly.

### 7b.3 In-process schedulers in the API will run N times concurrently

`index.ts:335–337` starts three background schedulers **inside every API pod**:

| Scheduler | Interval | N-replica effect |
|---|---|---|
| `startAttendanceIgaScheduler` (`attendance-iga/scheduler.ts`) | 60s tick | Duplicate pipeline runs — the `runningByConfig` guard is an in-process `Set`, invisible to other pods. `configIsDue()` re-reads DB state, which narrows but doesn't close the race: two pods ticking in the same minute both see "due" and both run. |
| `startAccessRequestExpiryScheduler` (`access-request-expiry.ts`) | 5 min sweep | Concurrent sweeps of the same stale rows — likely idempotent-ish but racy, and duplicate log/audit noise. |
| `startConnectorHealthScheduler` (`connector-health.ts`) | periodic tick | N× redundant health probes against Google/Zoho/AD — wasteful API-quota burn, no lock found in the file. |

Fix: wrap each tick in the same Redis `SET NX PX` lock pattern the outbox worker already uses (e.g. `idp:sched:<name>:lock` with TTL ≈ interval) — small, mechanical change, one key per scheduler. Alternatively move all three into the `lilg-worker` process behind its existing leader election, which centralizes "singleton background work" in one place at the cost of a slightly larger refactor.

### 7b.4 RADIUS UDP listener — needs special handling if enabled in prod

`startRadiusUdpServer()` (`radius-udp.ts`) is optional (`RADIUS_UDP_ENABLED=true`). If used in prod: UDP doesn't go through the ALB — it needs an **NLB with a UDP listener** via a separate `Service`. And since clients are identified by **source IP** (`findRadiusClient(null, rinfo.address)`), the Service must preserve it (`externalTrafficPolicy: Local` on the NLB). If RADIUS stays disabled in prod, just note it and move on.

### 7b.5 Minor notes

- `/metrics` counts sessions via `redis.keys('idp:session:*')` — `KEYS` is O(N) and blocks Redis; on a busy shared ElastiCache node switch to `SCAN` (or a counter). Low priority at current scale.
- The portal-HTTPS path (`index.ts:344–379`, cert loaded from `general_settings` at boot) should be left disabled on K8s — TLS terminates at the ALB (§8), and a DB-loaded cert read once per pod boot adds a second, divergence-prone cert store for no benefit.

---

## 8. Networking / TLS

Current setup: Cloudflare orange-cloud → single origin on host `:80`/`:443`, with an optional ACME webroot (`/app/acme-webroot`) for cert issuance directly on the app.

For K8s: terminate TLS **before** the app, at the AWS ALB (via the AWS Load Balancer Controller + ACM certificate) or by keeping Cloudflare in Full (strict) mode pointed at the ALB. Either way, drop the app's ACME-webroot code path in this environment — it assumes a single, disk-persistent origin, which doesn't hold across replicas without shared storage, and you don't need it once ALB/Cloudflare handles TLS. Keep `TRUST_PROXY=true` and `COOKIE_SECURE=true` (already the correct prod values per `docker-compose.prod.yml`) so the app trusts the `X-Forwarded-*` headers from the ALB/Cloudflare chain — this also feeds `getClientIp()` for session IP attribution (`ARCHITECTURE.md` §5.2), so don't skip it.

---

## 9. Secrets & config

Move `.env` (currently gitignored, hand-maintained on `pam-2`) to:

- **K8s `Secret`** (or **External Secrets Operator + AWS Secrets Manager**, reusing the existing `@aws-sdk/client-secrets-manager` dependency) for: `SESSION_SECRET`, `MASTER_ADMIN_EMAIL`/`MASTER_ADMIN_PASSWORD`, DB credentials, `SAML_IDP_PRIVATE_KEY_PEM`/`CERT_PEM`, Google/Zoho/AD adapter credentials.
- **`ConfigMap`** for non-sensitive values: `PUBLIC_BASE_URL`, `SAML_IDP_BASE_URL`, `SAML_IDP_ENTITY_ID`, feature-level env vars.

`src/config.ts` already zod-validates all of this at startup — misconfigured Secrets/ConfigMaps will fail fast and loudly (pod stuck in `CrashLoopBackOff` with a clear validation error), which is the behavior you want.

---

## 10. Messaging (SQS) — already cloud-native, no change needed

`SQS_HRMS_EVENTS_URL` / `SQS_CELERY_BROKER_URL` already point at real AWS SQS in production (`docker-compose.prod.yml` doesn't override `AWS_ENDPOINT_URL`, so it only points at LocalStack in the dev compose file). SQS is multi-AZ by design — nothing to add here beyond making sure the EKS node/pod IAM role (via IRSA — IAM Roles for Service Accounts) has queue permissions, replacing whatever credential mechanism `pam-2` uses today.

---

## 11. Observability

`src/api/health.ts` already exposes a Prometheus-format `/metrics` endpoint (protected by `x-internal-token` header), covering:
- `lilg_outbox_queue_depth` by status — alert on this to catch a stalled worker before users notice provisioning delays.
- `lilg_active_sessions` — useful for anomaly detection (sudden spike/drop).
- `lilg_db_pool_total` / `_free` / `_queued` — direct signal for connection pool exhaustion, which is exactly the failure mode to watch when scaling `lilg-api` replicas against a fixed RDS `max_connections`.
- `lilg_employee_state_count` — business-metric side effect, not infra, but free.

Wire this into `kube-prometheus-stack` via a `ServiceMonitor` (with the internal token as a bearer/custom header in the scrape config) instead of building new instrumentation.

---

## 12. Pre-cutover checklist

In priority order (top two are correctness issues, not just hardening):

1. **SAML keys**: inject `SAML_IDP_PRIVATE_KEY_PEM`/`CERT_PEM` via Secret — do not rely on per-pod auto-generation (§6).
2. **Migrations**: move to a one-shot Job or add `GET_LOCK` (§7).
3. Confirm `mysql2` pool size × max `lilg-api` replicas stays under RDS `max_connections` (§4).
4. Decide managed vs. in-cluster data tier (§4) and provision accordingly.
5. Stand up External Secrets Operator (or plain K8s Secrets) for `.env` → Secret/ConfigMap migration (§9).
6. AWS Load Balancer Controller + ACM (or Cloudflare Full-strict) for TLS; retire the ACME-webroot path (§8).
7. IRSA for SQS + Secrets Manager access, replacing whatever AWS creds mechanism is used on `pam-2` today.
8. Move login rate limiting to Redis-backed buckets — per-pod in-memory limits weaken brute-force protection ×N (§7b.2).
9. Add Redis `SET NX` locks to the three in-API schedulers (attendance IGA, access-request expiry, connector health) or move them to the worker (§7b.3).
10. Verify OIDC uses the injected SAML key (`isSamlEnabled()` true in prod) so JWKS is identical across pods (§7b.1).
11. If RADIUS UDP is needed in prod: NLB UDP Service with `externalTrafficPolicy: Local`; otherwise keep disabled (§7b.4).
12. `ServiceMonitor` for `/metrics`; alerts on outbox queue depth and DB pool exhaustion (§11).
13. Load-test a rolling deploy (`maxUnavailable: 0`) end-to-end, including a live login flow, before pointing DNS at the new stack.
