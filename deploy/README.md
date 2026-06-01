# Deployment Guide

This repository includes production deployment assets for local Docker, Kubernetes, Terraform, and Helm.

## Environment Profiles

Environment files are in `deploy/env/`:

- `.env.dev`
- `.env.staging`
- `.env.prod`

Select one when running docker-compose:

```bash
# dev profile
DUNENA_ENV=dev docker compose -f deploy/docker-compose.yml up -d

# staging profile
DUNENA_ENV=staging docker compose -f deploy/docker-compose.yml up -d

# prod profile
DUNENA_ENV=prod docker compose -f deploy/docker-compose.yml up -d
```

## Docker

Build and run via root scripts:

```bash
bun run docker:build
bun run docker:up
bun run docker:down
```

### Enabling Features in Docker

Pass additional environment variables to enable optional features:

```bash
# Enable Redis protocol + OpenTelemetry
DUNENA_REDIS_ENABLED=true \
DUNENA_OTEL_ENABLED=true \
DUNENA_OTEL_ENDPOINT=http://otel-collector:4318 \
docker compose -f deploy/docker-compose.yml up -d
```

## Kubernetes

Apply manifests in order:

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.example.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
```

Optional ingress:

```bash
kubectl apply -f deploy/k8s/ingress.example.yaml
```

## Helm Chart

Deploy using the Helm chart in `deploy/helm/dunena/`:

```bash
# Install with defaults
helm install dunena deploy/helm/dunena/

# Install with custom values
helm install dunena deploy/helm/dunena/ \
  --set image.tag=v0.4.0 \
  --set persistence.size=10Gi \
  --set config.maxEntries=500000 \
  --set config.authToken=my-secret-token

# Upgrade
helm upgrade dunena deploy/helm/dunena/ --set image.tag=v0.5.0
```

See `deploy/helm/dunena/values.yaml` for all configurable values.

## Terraform

### AWS (ECS Fargate + EFS)

```bash
cd deploy/terraform/aws
terraform init
terraform plan -var="region=us-east-1"
terraform apply
```

See `deploy/terraform/aws/README.md` for details.

### GCP (Cloud Run + GCS)

```bash
cd deploy/terraform/gcp
terraform init
terraform plan -var="project_id=my-project"
terraform apply -var="project_id=my-project"
```

See `deploy/terraform/gcp/README.md` for details.

## AWS CloudFormation

Deploy a single stack with ECS Fargate, ALB, and EFS:

```bash
aws cloudformation deploy \
  --template-file deploy/cloudformation/dunena-stack.yaml \
  --stack-name dunena \
  --parameter-overrides \
    VpcId=vpc-12345 \
    SubnetIds=subnet-a,subnet-b \
  --capabilities CAPABILITY_NAMED_IAM
```

## Supported Deployment Modes

| Mode | SQLite Safe? | Notes |
|------|-------------|-------|
| Local development | ✅ | Single process, no durability concerns |
| Single-node / VPS | ✅ | One server process with persistent disk |
| Docker single-instance | ✅ | Mount a volume for `/var/lib/dunena` |
| Kubernetes (1 replica) | ✅ | Use `ReadWriteOnce` PVC, `Recreate` strategy |
| Kubernetes (>1 replica) | ⚠️ | Enable clustering — each pod needs its own PVC |
| Multi-node cluster | ✅ | Use `DUNENA_CLUSTER_ENABLED=true` with per-node storage |

## Clustering / High Availability

Dunena supports leader-follower clustering for high availability. When enabled:

- A **leader** node handles all SQLite writes and replicates to followers
- **Follower** nodes serve reads from their local in-memory cache
- If the leader dies, the highest-priority follower is automatically elected as the new leader
- Followers forward writes to the leader transparently

### Cluster Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DUNENA_CLUSTER_ENABLED` | `false` | Enable clustering |
| `DUNENA_CLUSTER_NODE_ID` | `node-{pid}` | Unique node identifier |
| `DUNENA_CLUSTER_SEEDS` | — | Comma-separated seed addresses |
| `DUNENA_CLUSTER_PRIORITY` | `100` | Election priority (higher = preferred leader) |
| `DUNENA_CLUSTER_HEARTBEAT_MS` | `2000` | Heartbeat interval |
| `DUNENA_CLUSTER_SUSPECT_TIMEOUT_MS` | `6000` | Time before marking a node suspect |
| `DUNENA_CLUSTER_DEAD_TIMEOUT_MS` | `15000` | Time before declaring a node dead |
| `DUNENA_CLUSTER_ELECTION_TIMEOUT_MS` | `5000` | Election response timeout |
| `DUNENA_CLUSTER_LOCAL_READS` | `true` | Serve reads from local cache on followers |

### Kubernetes Clustered Deployment

For Kubernetes, use a **StatefulSet** instead of a Deployment:

1. Each pod gets its own PVC for the SQLite database
2. Set `DUNENA_CLUSTER_NODE_ID` to the pod name (e.g., `$(POD_NAME)`)
3. Set `DUNENA_CLUSTER_SEEDS` to the headless service DNS names
4. Set different `DUNENA_CLUSTER_PRIORITY` values for stable leader preference

### Cluster Monitoring

```bash
# Check cluster health
curl http://localhost:3000/_cluster/stats

# List all cluster members
curl http://localhost:3000/_cluster/members
```

## ⚠️ SQLite Constraints (Non-Clustered Mode)

Dunena uses SQLite for durable storage. SQLite is a **single-writer** database:

- **Only one process may write to a given SQLite file at a time.** Running multiple replicas against the same database file **will corrupt data**.
- The Kubernetes deployment manifest ships with `replicas: 1` and the `Recreate` update strategy to prevent two pods from running simultaneously during rollouts.
- The PVC uses `ReadWriteOnce` access mode, which prevents the volume from being mounted by multiple nodes, but does **not** prevent multiple pods on the same node from accessing it.
- **Do not increase `replicas`** without enabling clustering.
- If you need horizontal scaling without clustering, consider disabling the SQLite database layer (`DUNENA_DB=false`) and using only the in-memory Zig cache, which is per-instance.

## Production Notes

- Replace the image in `deploy/k8s/deployment.yaml` with your published image.
- Replace values in `deploy/k8s/secret.example.yaml` before applying.
- Keep `DUNENA_AUTH_TOKEN` set in staging/prod.
- Keep JSON logs in staging/prod (`DUNENA_LOG_FORMAT=json`).
- Persist database state by keeping `DUNENA_DB_PATH` on mounted storage.
- Enable `DUNENA_OTEL_ENABLED=true` in production for observability.

## Health, Readiness & Metrics

The server exposes the following operational endpoints:

| Endpoint | Purpose | Auth Required |
|----------|---------|----|
| `GET /health` | Detailed health diagnostics (Zig core, SQLite, memory, cache) | No |
| `GET /health/live` | Liveness probe — returns 200 if process is alive | No |
| `GET /health/ready` | Readiness probe — checks SQLite is writable | No |
| `GET /metrics` | Prometheus-format metrics (cache counters, latency quantiles, uptime) | Yes |
| `GET /stats` | JSON cache stats + latency breakdown | Yes |
| `GET /db-stats` | SQLite storage statistics | Yes |
| `GET /_cluster/stats` | Cluster health (role, term, members) | No |

**Kubernetes probes:** Use `/health/live` for `livenessProbe` and `/health/ready` for `readinessProbe`.

**Metrics:** Scrape `/metrics` with Prometheus. All counter metrics are cumulative from server start. Latency quantiles (p50, p95, p99) reflect the current measurement window.

**Tracing:** Enable OpenTelemetry (`DUNENA_OTEL_ENABLED=true`) to export traces and metrics to Jaeger, Grafana Tempo, Datadog, or any OTLP-compatible backend.

## Optional Features

| Feature | Enable With | Port/Path |
|---------|-------------|-----------|
| Redis protocol | `DUNENA_REDIS_ENABLED=true` | TCP `:6379` |
| GraphQL API | Always available | `GET/POST /graphql` |
| OpenTelemetry | `DUNENA_OTEL_ENABLED=true` | Outbound to OTLP endpoint |
| Clustering | `DUNENA_CLUSTER_ENABLED=true` | `/_cluster/*` endpoints |
| WebSocket | `DUNENA_WS=true` (default) | `ws://host:port/ws` |
| Dashboard | `DUNENA_DASHBOARD=true` (default) | `/dashboard` |
| Persistence | `DUNENA_PERSIST=true` | Writes to `DUNENA_PERSIST_PATH` |

## Operational Expectations

| Parameter | Value |
|-----------|-------|
| Max key size | 512 bytes (validated by server) |
| Max value size | 4 MB (`MAX_VALUE_SIZE` in cache-bridge) |
| Default TTL | Configurable, `0` = no expiry |
| Eviction policies | LRU, LFU, ARC (configurable via `DUNENA_EVICTION_POLICY`) |
| Persistence | Periodic JSON snapshots + on-demand save; not WAL-replicated |
| In-memory cache | Not persisted across restarts unless snapshot persistence is enabled |
| SQLite durability | Standard SQLite durability; no replication (unless clustered) |
| Startup | Restores snapshot from disk if available, then starts HTTP server |
| Shutdown | Leaves cluster gracefully, saves snapshot if enabled, closes SQLite, stops server |
