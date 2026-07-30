# Lenskart IdP — Kubernetes Deployment Guide (End-to-End)

Step-by-step runbook: from empty AWS account to `idp.lenskart.com` serving from EKS, plus day-2 operations and rollback. Uses the manifests from `HA_Fix_Implementation_Guide.md` (Fix 1/1-ALT and Fix 5). Single-tier docker-compose deployments remain fully supported — nothing here changes pam-2.

---

## 0. Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| `aws` CLI | v2 | AWS resources |
| `eksctl` | latest | EKS cluster provisioning |
| `kubectl` | matches cluster minor | cluster operations |
| `helm` | v3 | add-ons + app chart |
| `docker` | any recent | image build |

Also required before starting: the code changes from the implementation guide merged to `main` (migration CLI + `SKIP_MIGRATIONS_ON_BOOT`, Redis rate limiter, scheduler locks), and an AWS account with permissions for EKS/RDS/ElastiCache/ECR/IAM.

Set once per shell:

```bash
export AWS_REGION=ap-south-1
export ACCT=$(aws sts get-caller-identity --query Account --output text)
export CLUSTER=lilg-prod
```

---

## 1. Provision infrastructure

### 1.1 EKS cluster (3 AZs)

```bash
eksctl create cluster \
  --name $CLUSTER --region $AWS_REGION --version 1.30 \
  --zones ${AWS_REGION}a,${AWS_REGION}b,${AWS_REGION}c \
  --nodegroup-name app --node-type m6i.large \
  --nodes 3 --nodes-min 3 --nodes-max 6 \
  --with-oidc \
  --secrets-encryption-key-arn arn:aws:kms:$AWS_REGION:$ACCT:key/<kms-key-id>
```

`--with-oidc` enables IRSA; `--secrets-encryption-key-arn` gives etcd encryption at rest for Secrets (mandatory when using plain K8s Secrets — see Fix 1-ALT hardening).

### 1.2 RDS MySQL (Multi-AZ)

```bash
aws rds create-db-instance \
  --db-instance-identifier lilg-prod \
  --engine mysql --engine-version 8.0 \
  --db-instance-class db.m6g.large \
  --allocated-storage 100 --storage-type gp3 \
  --multi-az \
  --db-name lilg \
  --master-username lilg_admin --manage-master-user-password \
  --vpc-security-group-ids <sg-allowing-3306-from-eks-nodes> \
  --db-subnet-group-name <private-subnet-group> \
  --backup-retention-period 7 --no-publicly-accessible
```

Create the app user after boot: `CREATE USER 'lilg_app'@'%' IDENTIFIED BY '<pw>'; GRANT ALL ON lilg.* TO 'lilg_app'@'%';`

### 1.3 ElastiCache Redis (Multi-AZ)

```bash
aws elasticache create-replication-group \
  --replication-group-id lilg-prod \
  --replication-group-description "LILG sessions + locks" \
  --engine redis --engine-version 7.1 \
  --cache-node-type cache.m6g.large \
  --num-cache-clusters 2 \
  --multi-az-enabled --automatic-failover-enabled \
  --at-rest-encryption-enabled --transit-encryption-enabled \
  --cache-subnet-group-name <private-subnet-group> \
  --security-group-ids <sg-allowing-6379-from-eks-nodes>
```

Transit encryption on → use `rediss://` in `REDIS_URL`.

### 1.2-ALT / 1.3-ALT — In-cluster MySQL & Redis (no RDS/ElastiCache)

Use these instead of §1.2/§1.3 when the data tier must live inside the cluster (multi-client installs, non-AWS clients, or cost). **Never raw StatefulSets** — a hand-rolled MySQL StatefulSet has no failover logic; use operators.

#### MySQL — Percona XtraDB Cluster Operator (3-node synchronous cluster)

No app changes: `DB_HOST` just points at the HAProxy Service the operator creates.

```bash
helm repo add percona https://percona.github.io/percona-helm-charts
helm install pxc-operator percona/pxc-operator -n idp
```

```yaml
# k8s/mysql-cluster.yaml
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBCluster
metadata:
  name: lilg-db
  namespace: idp
spec:
  crVersion: "1.15.0"
  secretsName: lilg-db-secrets          # operator generates users incl. root if absent
  pxc:
    size: 3                             # one per AZ — quorum survives any single node/AZ loss
    image: percona/percona-xtradb-cluster:8.0.36
    affinity:
      antiAffinityTopologyKey: topology.kubernetes.io/zone
    resources:
      requests: { cpu: "1", memory: 4Gi }
      limits:   { memory: 6Gi }
    volumeSpec:
      persistentVolumeClaim:
        storageClassName: gp3           # any SSD class on other clouds/on-prem
        resources: { requests: { storage: 100Gi } }
  haproxy:
    enabled: true                       # single stable write endpoint for the app
    size: 2
    affinity:
      antiAffinityTopologyKey: topology.kubernetes.io/zone
  backup:
    image: percona/percona-xtradb-cluster-operator:1.15.0-pxc8.0-backup
    schedule:
      - name: nightly
        schedule: "0 21 * * *"          # 02:30 IST
        keep: 7
        storageName: s3-backup
    storages:
      s3-backup:                        # any S3-compatible target (AWS S3, MinIO on-prem)
        type: s3
        s3:
          bucket: lilg-db-backups
          region: ap-south-1
          credentialsSecret: lilg-backup-s3
  pmm:
    enabled: false                      # optional: Percona monitoring
```

App config change (only values, not code):

```yaml
# lilg-config ConfigMap
DB_HOST: "lilg-db-haproxy.idp.svc.cluster.local"
```

Create the app user via the operator's root secret:

```bash
kubectl -n idp exec lilg-db-pxc-0 -c pxc -- mysql -uroot -p"$(kubectl -n idp get secret lilg-db-secrets -o jsonpath='{.data.root}' | base64 -d)" \
  -e "CREATE USER 'lilg_app'@'%' IDENTIFIED BY '<pw>'; GRANT ALL ON lilg.* TO 'lilg_app'@'%'; CREATE DATABASE IF NOT EXISTS lilg;"
```

Failover behavior: synchronous (Galera) replication, so any node can fail with zero data loss; HAProxy re-routes in seconds. This is *better* RPO than RDS Multi-AZ, at the cost of you owning upgrades and backup verification.

#### Redis — Bitnami chart with persistence (pragmatic default)

Redis in this app is cache + locks + MFA challenges — sessions are also in MySQL, and the rate limiter/scheduler locks **fail open** by design. So a ~30–60 s Redis blip on pod rescheduling is tolerable, which permits the simple topology:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install lilg-redis bitnami/redis -n idp \
  --set architecture=replication \
  --set auth.enabled=true --set auth.password=<pw> \
  --set master.persistence.enabled=true --set master.persistence.size=8Gi \
  --set master.persistence.storageClass=gp3 \
  --set replica.replicaCount=2 \
  --set master.podAntiAffinityPreset=hard
```

```yaml
# lilg-config ConfigMap
REDIS_URL: "redis://:<pw>@lilg-redis-master.idp.svc.cluster.local:6379/0"
```

If the master pod dies, Kubernetes reschedules it and replays the AOF from its PVC — MTTR comparable to an ElastiCache failover. **True sub-second failover (Sentinel)** is possible but requires a small code change: `config.ts` validates `REDIS_URL` as a URL, while ioredis Sentinel needs a `{ sentinels: [...], name: ... }` options object — add an optional `REDIS_SENTINEL_HOSTS`/`REDIS_MASTER_NAME` config path if a client contract demands it. Don't start there; the simple topology is operationally proportionate to how this app uses Redis.

#### Ops you now own (vs managed)

- **Backup restore drills** — test the PXC S3 restore quarterly; an untested backup is a hope, not a backup.
- **Version upgrades** — operator handles rolling PXC upgrades, but you schedule/supervise them.
- **Disk monitoring** — alert at 70% PVC usage; expand via PVC resize (gp3/most CSI drivers support online expansion).
- **Quorum awareness** — never run PXC with 2 nodes (split-brain); scale 3 → 5, never 3 → 2.
- **Node group sizing** — DB pods need dedicated headroom; consider a separate node group with taints so API autoscaling never evicts DB pods.

### 1.4 SQS queues

```bash
aws sqs create-queue --queue-name hrms-events
aws sqs create-queue --queue-name celery-broker
```

---

## 2. Cluster add-ons

```bash
# AWS Load Balancer Controller (ALB Ingress)
helm repo add eks https://aws.github.io/eks-charts
eksctl create iamserviceaccount --cluster $CLUSTER \
  --namespace kube-system --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::$ACCT:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=$CLUSTER \
  --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller

# metrics-server (required by HPA)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Monitoring (ServiceMonitor CRD + Prometheus + Grafana)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack -n monitoring --create-namespace

# External Secrets Operator — ONLY for the Secrets Manager path (Fix 1).
# Skip entirely for the multi-client bootstrap-Job path (Fix 1-ALT).
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace
```

---

## 3. Build & push the image

```bash
aws ecr create-repository --repository-name lilg
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCT.dkr.ecr.$AWS_REGION.amazonaws.com

TAG=$(git rev-parse --short HEAD)
docker build -t $ACCT.dkr.ecr.$AWS_REGION.amazonaws.com/lilg:$TAG --target runner .
docker push $ACCT.dkr.ecr.$AWS_REGION.amazonaws.com/lilg:$TAG
```

The existing multi-stage `Dockerfile` needs no changes — `runner` stage is already non-root with dumb-init.

---

## 4. Namespace, identity, and secrets

```bash
kubectl create namespace idp

# IRSA for the app (SQS access)
eksctl create iamserviceaccount --cluster $CLUSTER \
  --namespace idp --name lilg \
  --attach-policy-arn arn:aws:iam::$ACCT:policy/lilg-sqs-policy \
  --approve
```

Then choose ONE key-management path:

- **Path A — Secrets Manager + ESO** (single deployment, AWS-native): apply `externalsecret-saml.yaml` and `externalsecret-app.yaml` from Fix 1/5.1 after creating the secrets in Secrets Manager (Fix 1.2). If migrating from pam-2, extract the existing cert first (Fix 1.1) so SPs keep their pinned fingerprint.
- **Path B — In-cluster bootstrap Job** (multi-client / cloud-agnostic): apply `keygen-rbac.yaml` + `job-keygen.yaml` from Fix 1-ALT. App secrets (DB password, SMTP, adapter creds) are created by the pipeline: `kubectl -n idp create secret generic lilg-app-secrets --from-env-file=client.env`.

---

## 5. Deploy the application

Apply in this order (or template the whole set as a Helm chart — see §6):

```bash
kubectl apply -f k8s/configmap.yaml            # lilg-config (Fix 5.1) — includes SKIP_MIGRATIONS_ON_BOOT=true
# Path A: externalsecrets; Path B: keygen RBAC + Job (waits to completion)
kubectl apply -f k8s/job-migrate.yaml          # migration Job (Fix 2.4)
kubectl -n idp wait --for=condition=complete job/lilg-migrate --timeout=600s
kubectl apply -f k8s/deployment-api.yaml       # lilg-api Deployment + Service (Fix 5.3)
kubectl apply -f k8s/deployment-worker.yaml    # lilg-worker (Fix 5.5)
kubectl apply -f k8s/pdb-hpa.yaml              # PDB + HPA (Fix 5.4)
kubectl apply -f k8s/ingress.yaml              # ALB Ingress (Fix 5.6)
kubectl apply -f k8s/servicemonitor.yaml       # Prometheus scrape (Fix 5.7)
```

Wait for rollout:

```bash
kubectl -n idp rollout status deploy/lilg-api
kubectl -n idp get ingress lilg -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

---

## 6. Helm chart layout (recommended for multi-client)

```
charts/lilg/
├── Chart.yaml
├── values.yaml                  # defaults
├── values-<client>.yaml         # per-client: idpHostname, image tag, sizes
└── templates/
    ├── keygen-rbac.yaml         # hook-weight -10 (Path B only)
    ├── job-keygen.yaml          # hook-weight -5  (Path B only)
    ├── job-migrate.yaml         # pre-install,pre-upgrade hook, weight 0
    ├── configmap.yaml
    ├── deployment-api.yaml
    ├── deployment-worker.yaml
    ├── service.yaml
    ├── pdb.yaml
    ├── hpa.yaml
    ├── ingress.yaml
    └── servicemonitor.yaml
```

Hook weights guarantee ordering: RBAC → keygen → migrations → app. Per client:

```bash
helm upgrade --install lilg charts/lilg -n idp --create-namespace \
  -f charts/lilg/values-<client>.yaml \
  --set image.tag=$TAG
```

Upgrades re-run the migration Job automatically (pre-upgrade hook) and never regenerate the SAML cert (keygen Job no-ops when the Secret exists).

---

## 7. Verification (run all before cutover)

```bash
# 1. All pods ready, spread across zones
kubectl -n idp get pods -o wide

# 2. Identical SAML cert fingerprint from EVERY api pod (the §6 killer)
for p in $(kubectl -n idp get pods -l app=lilg-api -o name); do
  kubectl -n idp exec $p -- wget -qO- http://localhost:8080/saml/metadata \
    | grep -o '<ds:X509Certificate>[^<]*' | md5sum
done

# 3. Migrations ran exactly once (Job logs only; api pods must log the skip message)
kubectl -n idp logs job/lilg-migrate | grep 'Applying migration'
kubectl -n idp logs deploy/lilg-api | grep 'SKIP_MIGRATIONS_ON_BOOT'

# 4. Readiness gates traffic on DB+Redis
kubectl -n idp exec deploy/lilg-api -- wget -qO- http://localhost:8080/readyz

# 5. Rate limit is global: hammer /auth/login > max times through the ALB —
#    must get 429 even though requests spread across pods

# 6. Exactly one scheduler tick per window across all pods
kubectl -n idp logs -l app=lilg-api --since=5m | grep 'Attendance IGA scheduled run' | wc -l

# 7. Worker leader election: exactly one 'leader election won' among worker pods
kubectl -n idp logs -l app=lilg-worker --since=5m | grep -c 'leader election won'

# 8. Kill the leader worker pod — standby must take over within the lock TTL
kubectl -n idp delete pod <leader-pod>; kubectl -n idp logs -l app=lilg-worker -f

# 9. Rolling deploy under load: run a login loop while
kubectl -n idp rollout restart deploy/lilg-api   # zero failed logins expected

# 10. End-to-end SP login (Google/Zoho SAML) through the ALB hostname
#     using a hosts-file override for idp.lenskart.com before DNS moves
```

---

## 8. DNS cutover (Cloudflare)

1. Lower the `idp.lenskart.com` record TTL ahead of time.
2. Point the record (orange-cloud) at the ALB hostname; set SSL mode **Full (strict)** with the ACM cert on the ALB.
3. Restrict the ALB security group to [Cloudflare IP ranges](https://www.cloudflare.com/ips/) so origin can't be hit directly.
4. Keep pam-2 running warm for the soak period (1–2 weeks). Its stack is untouched by all of this.
5. Rollback = point DNS back at pam-2. Sessions survive either direction only if both point at the same DB/Redis — during soak, **cut over data first** (pam-2 `.env` → RDS/ElastiCache endpoints) so both environments share state, then move DNS. This makes rollback instant and lossless.

---

## 9. Rollback procedures

| Scenario | Action |
|---|---|
| Bad app rollout | `kubectl -n idp rollout undo deploy/lilg-api` (or `helm rollback lilg <rev>`) — old ReplicaSet still present |
| Failed migration Job | Rollout never started (hook blocks it). Fix the SQL, re-run. Migrations are forward-only — restore the RDS snapshot taken before deploy if a bad migration *applied* |
| Whole-platform emergency | DNS back to pam-2 (see §8.5 — shared data tier makes this lossless) |
| Bad SAML cert (Path B namespace recreated) | Restore the backed-up `lilg-saml-keys` Secret — do NOT let the keygen Job mint a new one unless you intend to re-pin every SP |

Take an RDS snapshot before every deploy that includes a migration: `aws rds create-db-snapshot --db-instance-identifier lilg-prod --db-snapshot-identifier pre-$TAG`.

---

## 10. Day-2 operations

```bash
# Logs
kubectl -n idp logs deploy/lilg-api -f
kubectl -n idp logs deploy/lilg-worker -f

# Scale (HPA handles api automatically; manual override:)
kubectl -n idp scale deploy/lilg-api --replicas=4

# Deploy a new version
docker build/push … :$NEWTAG
helm upgrade lilg charts/lilg -n idp --set image.tag=$NEWTAG --reuse-values

# Status / metrics
kubectl -n idp get pods,hpa,pdb
# Grafana: lilg_outbox_queue_depth, lilg_db_pool_queued, lilg_active_sessions

# SAML cert rotation (deliberate, coordinated with SPs)
kubectl -n idp delete secret lilg-saml-keys   # Path B; then helm upgrade → keygen re-runs
kubectl -n idp rollout restart deploy/lilg-api
# → update fingerprint at every SP for that client
```

Alerts to configure in Prometheus: `lilg_outbox_queue_depth{status="PENDING"}` growing for >15 min (stalled worker), `lilg_db_pool_queued > 0` sustained (pool exhaustion → check HPA max vs RDS max_connections), `up == 0` on the ServiceMonitor, ALB 5xx rate.

---

## 11. Single-tier compatibility statement

All code changes are gated so docker-compose deployments behave identically: `SKIP_MIGRATIONS_ON_BOOT` unset → migrations still run at boot (now under `GET_LOCK`, harmless with one instance); the rate limiter uses the Redis that compose already ships; scheduler locks are always won by the only instance; SAML auto-keygen still works when the PEM env vars are absent. `docker-compose.dev.yml` / `docker-compose.prod.yml` need no edits.
