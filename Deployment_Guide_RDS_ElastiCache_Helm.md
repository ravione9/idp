# Lenskart IdP — Production Deployment Guide

## RDS MySQL + ElastiCache Redis + Helm (final architecture)

The authoritative runbook for deploying `idp.lenskart.com` on EKS with the **managed data tier** and the **Helm chart at `charts/lilg/`** (in this repo). Supersedes the raw-manifest instructions in `K8s_Deployment_Guide.md` §5 — infrastructure sections there still apply and are referenced, not repeated.

**Decision record:** data tier = RDS MySQL Multi-AZ + ElastiCache Redis Multi-AZ. The in-cluster option (Percona/Bitnami) remains documented in `K8s_Deployment_Guide.md` §1.2-ALT for non-AWS client installs only.

---

## 1. One-time infrastructure setup

Run once per environment. Full commands in `K8s_Deployment_Guide.md`; summary with the decisions baked in:

| Step | What | Reference |
|---|---|---|
| 1.1 | EKS cluster, 3 AZs, IRSA enabled, KMS secret encryption | Guide §1.1 |
| 1.2 | **RDS MySQL 8, Multi-AZ**, gp3, 7-day backups, private subnets; create `lilg_app` user | Guide §1.2 |
| 1.3 | **ElastiCache Redis 7, Multi-AZ**, auto-failover, at-rest + transit encryption (→ `rediss://` URL) | Guide §1.3 |
| 1.4 | SQS queues `hrms-events`, `celery-broker` | Guide §1.4 |
| 1.5 | Add-ons: AWS Load Balancer Controller, metrics-server, kube-prometheus-stack, **External Secrets Operator** | Guide §2 |
| 1.6 | ECR repo + image build/push | Guide §3 |
| 1.7 | IAM role `lilg-prod` for IRSA: SQS send/receive/delete on both queues | Guide §4 |

Security groups: RDS 3306 and ElastiCache 6379 accept traffic **only** from the EKS node/pod security group.

## 2. One-time secrets setup (AWS Secrets Manager)

Two JSON secrets per environment:

```bash
# 2.1 App secrets — everything sensitive that used to live in .env
aws secretsmanager create-secret --name lilg/prod/app --secret-string '{
  "DB_USER": "lilg_app",
  "DB_PASSWORD": "<strong-password>",
  "SESSION_SECRET": "<openssl rand -base64 48>",
  "MASTER_ADMIN_EMAIL": "…", "MASTER_ADMIN_PASSWORD": "<break-glass, vaulted>",
  "INTERNAL_TOKEN": "<openssl rand -hex 32>",
  "SMTP_HOST": "…", "SMTP_USER": "…", "SMTP_PASS": "…",
  "GOOGLE_SA_KEY_JSON": "…", "ZOHO_CLIENT_ID": "…", "ZOHO_CLIENT_SECRET": "…",
  "AD_BIND_DN": "…", "AD_BIND_PASSWORD": "…"
}'

# 2.2 SAML signing keys — EXTRACT the existing cert from pam-2 (SPs pin its fingerprint!)
docker cp idp-api:/app/data/saml/.saml-auto-keys.key ./saml.key
docker cp idp-api:/app/data/saml/.saml-auto-keys.crt ./saml.crt
aws secretsmanager create-secret --name lilg/prod/saml-signing \
  --secret-string "$(jq -n --rawfile key saml.key --rawfile crt saml.crt \
      '{privateKeyPem: $key, certPem: $crt}')"
shred -u saml.key
```

Create the ESO `ClusterSecretStore` named `aws-secrets-manager` (IRSA-authenticated) once per cluster.

## 3. The Helm chart (`charts/lilg/`)

```
charts/lilg/
├── Chart.yaml
├── values.yaml                      # defaults — README of every knob
└── templates/
    ├── _helpers.tpl                 # labels + image helper
    ├── configmap.yaml               # non-sensitive env (incl. SKIP_MIGRATIONS_ON_BOOT)
    ├── serviceaccount.yaml          # IRSA-annotated
    ├── externalsecrets.yaml         # Secrets Manager → lilg-app-secrets + lilg-saml-keys
    ├── job-migrate.yaml             # pre-install/pre-upgrade hook — runs migrations, gates rollout
    ├── deployment-api.yaml          # 3 replicas, probes, zone spread, maxUnavailable: 0
    ├── deployment-worker.yaml       # 2 replicas, leader-elected outbox drainer
    ├── service.yaml
    ├── pdb.yaml                     # minAvailable: 2
    ├── hpa.yaml                     # CPU 65%, 3→6
    ├── ingress.yaml                 # ALB, ACM TLS, ssl-redirect
    └── servicemonitor.yaml          # Prometheus scrape of /metrics
```

Design notes:

- **Migrations gate the rollout.** The Job runs as a Helm `pre-upgrade` hook; if a migration fails, the release aborts *before* any pod changes. Pods boot with `SKIP_MIGRATIONS_ON_BOOT=true` (from the ConfigMap); the Job overrides it to `false` via an explicit `env` entry (explicit `env` beats `envFrom` in Kubernetes).
- **SAML keys arrive as env vars** from `lilg-saml-keys` — the app's auto-generate path is unreachable, so every pod signs with the same cert.
- **No session affinity anywhere** — sessions live in RDS + ElastiCache.
- **ServiceMonitor caveat:** Prometheus sends `Authorization: Bearer <token>`; `requireDiagToken()` in `src/api/health.ts` currently reads only `x-internal-token`. Add one line to also accept the Bearer header before enabling `monitoring.serviceMonitor.enabled`.

## 4. Per-environment values

```yaml
# values-prod.yaml (do NOT put secrets here — this file is committed)
image:
  repository: "123456789012.dkr.ecr.ap-south-1.amazonaws.com/lilg"
  tag: "a1b2c3d"                               # git SHA, set by CI
idpHostname: idp.lenskart.com
db:
  host: "lilg-prod.xxxxxx.ap-south-1.rds.amazonaws.com"
redis:
  url: "rediss://master.lilg-prod.xxxxxx.aps1.cache.amazonaws.com:6379/0"
sqs:
  hrmsEventsUrl: "https://sqs.ap-south-1.amazonaws.com/123456789012/hrms-events"
  celeryBrokerUrl: "https://sqs.ap-south-1.amazonaws.com/123456789012/celery-broker"
serviceAccount:
  roleArn: "arn:aws:iam::123456789012:role/lilg-prod"
externalSecrets:
  appSecretKey: "lilg/prod/app"
  samlSecretKey: "lilg/prod/saml-signing"
ingress:
  certificateArn: "arn:aws:acm:ap-south-1:123456789012:certificate/abc-123"
  annotations:
    # restrict origin to Cloudflare (prefix-list or SG id maintained separately)
    alb.ingress.kubernetes.io/security-groups: "sg-0cloudflareonly"
```

Staging = same file with `idpHostname: idp-staging…`, smaller HPA bounds, `lilg/staging/*` secret keys.

## 5. Deploy

```bash
# Always lint + dry-run first
helm lint charts/lilg -f values-prod.yaml
helm template lilg charts/lilg -f values-prod.yaml | kubectl apply --dry-run=server -f -

# Pre-deploy DB snapshot when the release includes migrations
aws rds create-db-snapshot --db-instance-identifier lilg-prod \
  --db-snapshot-identifier pre-$(git rev-parse --short HEAD)

# Install / upgrade (identical command; hook ordering does the rest)
helm upgrade --install lilg charts/lilg \
  -n idp --create-namespace \
  -f values-prod.yaml \
  --set image.tag=$(git rev-parse --short HEAD) \
  --wait --timeout 15m
```

`--wait` + the migration hook means the command succeeds only if: migrations applied → API rolled with `maxUnavailable: 0` → all replicas Ready.

## 6. Verify (after every deploy)

```bash
helm status lilg -n idp
kubectl -n idp get pods -o wide                      # spread across 3 AZs

# Same SAML fingerprint from every pod — MUST be identical
for p in $(kubectl -n idp get pods -l app=lilg-api -o name); do
  kubectl -n idp exec $p -- wget -qO- http://localhost:8080/saml/metadata \
    | grep -o '<ds:X509Certificate>[^<]*' | md5sum; done

# Migrations ran in the Job only
kubectl -n idp logs job/lilg-migrate | tail -5
kubectl -n idp logs deploy/lilg-api | grep -i skip_migrations

# Readiness sees RDS + ElastiCache
kubectl -n idp exec deploy/lilg-api -- wget -qO- http://localhost:8080/readyz
```

Full 10-point checklist (rate limits, scheduler single-fire, worker failover, live SP login): `K8s_Deployment_Guide.md` §7.

## 7. Rollback

```bash
helm history lilg -n idp
helm rollback lilg <REV> -n idp --wait
```

- App-only rollback: safe, previous ReplicaSet resumes.
- Release included a migration: migrations are forward-only — `helm rollback` restores old code but **not** old schema. Migrations must stay backward-compatible with the previous app version (additive first, destructive later releases). If a bad migration *applied*, restore the pre-deploy RDS snapshot.
- Platform emergency: DNS back to pam-2 (lossless while both point at RDS/ElastiCache — cut data over before DNS, per `K8s_Deployment_Guide.md` §8).

## 8. Day-2 quick reference

```bash
kubectl -n idp logs deploy/lilg-api -f                     # logs
helm upgrade lilg charts/lilg -n idp --reuse-values \
  --set image.tag=$NEWTAG --wait                           # new version
kubectl -n idp get pods,hpa,pdb                            # status
```

- **RDS**: monitor `max_connections` vs (pool size × replicas); Performance Insights on; minor-version auto-upgrade in a maintenance window.
- **ElastiCache**: alert on failover events and evictions; transit encryption already forces `rediss://`.
- **Prometheus alerts**: outbox `PENDING` depth rising >15 min; `lilg_db_pool_queued > 0` sustained; ALB 5xx; `up == 0`.
- **SAML cert rotation** (deliberate): update `lilg/prod/saml-signing` in Secrets Manager → ESO re-syncs within `refreshInterval` → `kubectl -n idp rollout restart deploy/lilg-api` → re-pin fingerprint at every SP.
