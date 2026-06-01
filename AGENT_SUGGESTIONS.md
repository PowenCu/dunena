# Agent Suggestions & Project Roadmap

This document serves as the central repository for planned features, addons, tooling, scripts, and agent skill definitions for the Dunena project. Other agents can use this file to pick up tasks and understand the project's trajectory.

> **Last updated:** 2026-06-01 — Updated status for all completed implementations.

---

## 📋 Priority Matrix

| Priority | Item | Complexity | Status |
|----------|------|------------|--------|
| **P0 — Ship Next** | Load Testing Suite | Low | ✅ Done |
| **P0 — Ship Next** | Python SDK | Medium | ✅ Done |
| **P0 — Ship Next** | Health Check Enhancements | Low | ✅ Done |
| **P0 — Ship Next** | Snapshot Export/Import CLI | Low | ✅ Done |
| **P1 — High** | Expanded DB Proxy Connectors | Low–Medium | ✅ Done |
| **P1 — High** | Cloud Storage Persistence | Medium | ✅ Done |
| **P1 — High** | Cloud Deployment Scripts | Medium | ✅ Done |
| **P1 — High** | ARC Eviction Policy (Zig) | Medium | ✅ Done |
| **P1 — High** | Write-Behind DB Proxy Caching | Medium | ✅ Done |
| **P1 — High** | Automated API Documentation | Low–Medium | ✅ Done |
| **P2 — Medium** | Redis Protocol Translation Layer | High | ✅ Done |
| **P2 — Medium** | GraphQL API Endpoint | Medium | ✅ Done |
| **P2 — Medium** | OpenTelemetry Integration | Medium | ✅ Done |
| **P2 — Medium** | SIMD Hashing & Bloom Filter (Zig) | Medium | ✅ Done |
| **P2 — Medium** | Namespace-level RBAC & API Keys | Medium | ✅ Done |
| **P2 — Medium** | Testing Gap Coverage | Medium | ✅ Done |
| **P2 — Medium** | Glassmorphic UI Admin Dashboard | Medium | ⚪ Backlog |
| **P3 — Future** | High Availability / Clustering | Very High | ✅ Done |

---

## 🚀 Proposed Features & Addons

### 1. Redis Protocol Translation Layer (Addon) — P2

- **Description**: Build a bridge/adapter layer allowing Dunena to accept standard Redis TCP connections and commands (RESP protocol).
- **Benefit**: Enables Dunena to act as a drop-in replacement for existing applications using Redis clients without any codebase changes.
- **Complexity**: High

#### Implementation Spec

- **New package**: `packages/redis-adapter/` — standalone package, depends on `@dunena/platform`.
- **Protocol**: Implement RESP2 parsing (bulk strings, arrays, simple strings, errors, integers).
- **Supported commands (MVP)**:
  - `GET`, `SET`, `DEL`, `MGET`, `MSET`, `EXISTS`, `KEYS`, `TTL`, `PTTL`, `EXPIRE`, `PEXPIRE`
  - `INCR`, `DECR`, `INCRBY`, `DECRBY`
  - `PING`, `INFO`, `DBSIZE`, `FLUSHDB`, `SELECT` (namespace mapping)
- **Mapping**: Use Bun's `Bun.listen()` TCP API. Map Redis commands → CacheService methods.
- **Config**: `DUNENA_REDIS_PORT=6379`, `DUNENA_REDIS_ENABLED=false`.
- **Tests**: Add `packages/redis-adapter/tests/` with `redis` npm client integration tests.

---

### 2. Cloud Storage Persistence (Feature) — P1

- **Description**: Extend the current JSON snapshot persistence layer to support automatic backup syncs to cloud storage providers (AWS S3, Google Cloud Storage, Azure Blob Storage).
- **Benefit**: Provides offsite durable backups and easier state restoration in cloud-native environments.
- **Complexity**: Medium

#### Implementation Spec

- **Target file**: New `packages/platform/src/services/cloud-persistence-service.ts`
- **Interface**: Implement a `CloudStorageBackend` interface:
  ```typescript
  interface CloudStorageBackend {
    upload(key: string, data: Buffer): Promise<void>;
    download(key: string): Promise<Buffer | null>;
    list(prefix?: string): Promise<string[]>;
    delete(key: string): Promise<void>;
  }
  ```
- **Backends**: Start with S3 (using `@aws-sdk/client-s3`) — most broadly compatible (also works with R2, MinIO, DigitalOcean Spaces).
- **Integration**: Hook into existing `PersistenceService` (`packages/platform/src/services/persistence-service.ts`). After each local snapshot write, optionally upload to cloud.
- **Config variables**:
  - `DUNENA_CLOUD_BACKUP=false`
  - `DUNENA_CLOUD_PROVIDER=s3`
  - `DUNENA_CLOUD_BUCKET=dunena-backups`
  - `DUNENA_CLOUD_REGION=us-east-1`
  - `DUNENA_CLOUD_PREFIX=snapshots/`
- **Types**: Extend `PersistenceConfig` in `packages/platform/src/types/index.ts` with cloud backup fields.

---

### 3. High Availability / Clustering (Feature) — P3

- **Description**: Implement a Raft-based consensus mechanism or a gossip protocol to cluster multiple Dunena instances.
- **Benefit**: Mitigates the single-writer limitation of SQLite by allowing distributed state sharing and failover.
- **Complexity**: Very High

#### Implementation Notes

- **Prerequisite**: Cloud Storage Persistence (item #2) should be completed first for state transfer during leader elections.
- **Existing foundation**: `ReplicationService` (`packages/platform/src/services/replication-service.ts`) already supports write-through replication to secondary instances via HTTP. This can serve as the basis for a cluster data plane.
- **Approach**: Recommended to use an existing Raft library rather than building from scratch. Consider `dragonboat` (Go, via sidecar) or implement a minimal Raft in TypeScript for metadata consensus, keeping SQLite writes on a single leader.
- **Phase 1**: Leader election only (automatic failover).
- **Phase 2**: Read replicas with consistent routing.

---

### 4. GraphQL API Endpoint (Feature) — P2

- **Description**: Introduce a GraphQL API alongside the existing REST and WebSocket layers.
- **Benefit**: Enables highly specific, batched data querying which is especially useful for the Database Proxy layer.
- **Complexity**: Medium

#### Implementation Spec

- **Library**: Use `graphql-yoga` (lightweight, works with Bun natively).
- **Target file**: New `packages/platform/src/server/graphql.ts`
- **Integration point**: Mount at `/graphql` in `packages/platform/src/server/app.ts` (currently 45KB — be surgical).
- **Schema (MVP)**:
  ```graphql
  type Query {
    cache(key: String!, ns: String): CacheEntry
    cacheMulti(keys: [String!]!, ns: String): [CacheEntry]
    keys(pattern: String, ns: String, cursor: Int, count: Int): KeyScanResult
    stats: CacheStats
    dbEntry(key: String!, ns: String): StorageEntry
    dbQuery(pattern: String, tags: [String], limit: Int): [StorageEntry]
    queryCache(key: String!): QueryCacheEntry
    connectors: [Connector]
  }

  type Mutation {
    cacheSet(key: String!, value: String!, ttl: Int, ns: String): Boolean
    cacheDelete(key: String!, ns: String): Boolean
    flush: Boolean
    dbSet(key: String!, value: String!, ttl: Int, ns: String, tags: [String]): Boolean
    dbDelete(key: String!, ns: String): Boolean
    proxyQuery(connector: String!, query: String!, params: [String], tags: [String]): ProxyResult
  }

  type Subscription {
    cacheEvents(channel: String): CacheEvent
  }
  ```
- **Auth/Rate limiting**: Reuse existing middleware from `packages/platform/src/server/middleware.ts`.

---

### 5. Expanded DB Proxy Connectors (Addon) — P1

- **Description**: Add native connectors for MongoDB, Redis, and Elasticsearch to the Database Proxy.
- **Benefit**: Makes Dunena a unified caching and proxy layer for a wider variety of datastores.
- **Complexity**: Low to Medium

#### Implementation Spec

- **Target file**: Extend `packages/platform/src/db/proxy.ts`.
- **Current state**: `DatabaseType` is `"postgresql" | "mysql" | "http"`. The `SqlDatabaseConnector` and `HttpDatabaseConnector` classes both use HTTP fetch under the hood (no native drivers).
- **New types**: Add `"mongodb" | "redis" | "elasticsearch"` to `DatabaseType`.
- **New connector classes**:
  - `MongoDBConnector` — uses `mongodb` npm driver (optional peer dependency)
  - `RedisConnector` — uses `ioredis` (optional peer dependency)  
  - `ElasticsearchConnector` — uses fetch against ES REST API (zero dependencies)
- **Pattern**: Follow the existing `execute(query, params)` → `Promise<unknown>` contract.
- **Update `createConnector()`** factory function at line ~121 in `proxy.ts`.
- **Note**: For MongoDB and Redis, consider using dynamic `import()` so they don't break the build if not installed.

---

### 6. ARC Eviction Policy (Feature) — P1

- **Description**: Add Adaptive Replacement Cache (ARC) eviction policy to the Zig core alongside existing LRU and LFU.
- **Benefit**: ARC automatically balances between recency and frequency without manual tuning — ideal for mixed workloads.
- **Complexity**: Medium

#### Implementation Spec

- **Zig core**: Add `arc = 2` to `EvictionPolicy` enum in `zig/src/cache.zig` (line 15).
- **ARC structure**: Maintain four lists (T1, T2, B1, B2) and a target size `p` that adapts on cache misses.
- **C-ABI**: No new exports needed — `dunena_cache_create_with_policy(max, 2)` will work.
- **Bridge**: Add `"arc"` to `EvictionPolicy` type in `packages/platform/src/types/index.ts` (line 3).
- **Bridge mapping**: Update `NativeCache` constructor in `cache-bridge.ts` (line 29) to map `"arc" → 2`.
- **Config**: `DUNENA_EVICTION_POLICY=lru|lfu|arc`.

---

### 7. Health Check Enhancements (Feature) — P0

- **Description**: Expand the `/health` endpoint to return structured diagnostics.
- **Benefit**: Required for production readiness — enables proper k8s liveness/readiness probes and monitoring dashboards.
- **Complexity**: Low

#### Implementation Spec

- **Target file**: `packages/platform/src/server/app.ts` — find the `/health` handler.
- **Response schema**:
  ```json
  {
    "status": "healthy",
    "version": "0.3.1",
    "uptime": 123456,
    "checks": {
      "zigCore": { "status": "up", "latencyMs": 0.2 },
      "sqlite": { "status": "up", "latencyMs": 1.1 },
      "memory": { "status": "ok", "heapUsedMB": 45, "heapTotalMB": 128, "rss": 180 },
      "cache": { "status": "ok", "entries": 5421, "hitRate": 0.87 }
    },
    "timestamp": "2026-05-10T01:45:00Z"
  }
  ```
- **k8s probes**: Add `GET /health/live` (liveness — just returns 200) and `GET /health/ready` (readiness — checks SQLite is writable).
- **Update k8s manifests**: `deploy/k8s/deployment.yaml` should use the new probe paths.

---

### 8. OpenTelemetry Integration (Feature) — P2

- **Description**: Add OpenTelemetry (OTLP) tracing and metrics export alongside the existing Prometheus endpoint.
- **Benefit**: Enables distributed tracing across services that use Dunena, compatible with Jaeger/Zipkin/Datadog/Grafana Tempo.
- **Complexity**: Medium

#### Implementation Spec

- **Library**: `@opentelemetry/api` + `@opentelemetry/sdk-node` + OTLP exporters.
- **New file**: `packages/platform/src/services/telemetry-service.ts`
- **Instrumentation points**:
  - HTTP request spans (auto-instrumented via `@opentelemetry/instrumentation-http`)
  - Cache get/set/delete spans (manual instrumentation in `CacheService`)
  - DB proxy query spans (manual in `DatabaseProxy.query()`)
- **Config**:
  - `DUNENA_OTEL_ENABLED=false`
  - `DUNENA_OTEL_ENDPOINT=http://localhost:4318` (OTLP HTTP)
  - `DUNENA_OTEL_SERVICE_NAME=dunena`

---

### 9. SIMD Hashing & Bloom Filter (Zig Feature) — P2

- **Description**: Upgrade the native hashing algorithm in the Bloom filter to a SIMD-accelerated FarmHash or xxHash utilizing Zig's `@Vector` capabilities.
- **Benefit**: Significantly increases throughput for key validation operations under high request volumes.
- **Complexity**: Medium

---

### 10. Write-Behind (Write-Back) DB Proxy Caching (Feature) — P1

- **Description**: Add an asynchronous write path to the Database Proxy. Write operations are temporarily buffered in memory or a fast local transaction log, and flushed down to target databases asynchronously.
- **Benefit**: Protects backend relational databases from heavy write spikes and returns instant responses to clients.
- **Complexity**: Medium

---

### 11. Namespace-level RBAC & API Keys (Security Feature) — P2

- **Description**: Expose token validation inside the middleware layer. Assign specific permissions per key (e.g. read, write, admin) mapped to targeted namespaces.
- **Benefit**: Prevents tenants or distinct microservices from cross-contaminating cache spaces.
- **Complexity**: Medium

---

### 12. Glassmorphic UI Admin Dashboard (Addon) — P2

- **Description**: Bundle a sleek, responsive Single Page Application dashboard served from Dunena's HTTP API (e.g. `/dashboard`).
- **Benefit**: Offers real-time graphical insight into cache memory usages, hit/miss ratios, connected WebSocket channels, and active namespaces.
- **Complexity**: Medium

---

## 🛠 Tooling & Scripts

### 1. Official SDKs — P0 (Python first)

- **Description**: Create official client SDK libraries. Start with Python, then Go and Rust.
- **Benefit**: Lowers the barrier to entry for developers using other backend ecosystems.

#### Implementation Spec — Python SDK

- **Location**: New top-level `sdks/python/` directory.
- **Package name**: `dunena` (PyPI).
- **Structure**:
  ```
  sdks/python/
  ├── pyproject.toml
  ├── dunena/
  │   ├── __init__.py
  │   ├── client.py        # sync client (httpx)
  │   ├── async_client.py  # async client (httpx.AsyncClient)
  │   ├── types.py          # typed dataclasses
  │   └── exceptions.py
  └── tests/
      └── test_client.py
  ```
- **API surface** (mirrors the REST API):
  ```python
  client = Dunena("http://localhost:3000", token="optional")
  client.get("key", ns="optional")
  client.set("key", "value", ttl=60000, ns="optional")
  client.delete("key")
  client.mget(["a", "b", "c"])
  client.mset({"a": "1", "b": "2"})
  client.keys(pattern="user-*")
  client.stats()
  client.flush()
  client.health()
  # Database operations
  client.db.get("key")
  client.db.set("key", "value", tags=["users"], ttl=3600000)
  client.db.query(pattern="user:", tags=["active"])
  ```
- **Dependencies**: `httpx` only (minimal).
- **CI**: Add a GitHub Actions workflow `.github/workflows/sdk-python.yml` that runs `pytest`.

---

### 2. Standardized Load Testing Suite — P0

- **Description**: Integrate a performance testing suite using `k6` under a new `scripts/bench/` directory.
- **Benefit**: Provides standardized benchmarking against Redis/Memcached to validate performance regressions during PRs.

#### Implementation Spec

- **Location**: `scripts/bench/`
- **Structure**:
  ```
  scripts/bench/
  ├── README.md
  ├── k6/
  │   ├── cache-crud.js          # Basic GET/SET/DEL throughput
  │   ├── cache-batch.js         # MGET/MSET throughput
  │   ├── mixed-workload.js      # 80% read / 20% write
  │   ├── db-operations.js       # SQLite durable storage ops
  │   ├── websocket-events.js    # WebSocket message throughput
  │   └── config.js              # Shared configuration
  ├── compare/
  │   ├── redis-baseline.js      # Redis comparison benchmark
  │   └── results.md             # Historical comparison results
  └── run.sh                     # Convenience wrapper
  ```
- **Package.json scripts**: Add to root `package.json`:
  ```json
  "bench:cache": "k6 run scripts/bench/k6/cache-crud.js",
  "bench:mixed": "k6 run scripts/bench/k6/mixed-workload.js",
  "bench:all": "k6 run scripts/bench/k6/cache-crud.js && k6 run scripts/bench/k6/cache-batch.js && k6 run scripts/bench/k6/mixed-workload.js"
  ```
- **Thresholds**: HTTP p95 < 10ms for cache GET, p95 < 15ms for SET, 0% error rate.
- **CI integration**: Run `bench:cache` on PR to detect regressions (compare against saved baseline).

---

### 3. Cloud Deployment Scripts — P1

- **Description**: Provide Terraform modules and AWS CloudFormation templates in the `deploy/` directory.
- **Benefit**: Eases production deployments beyond the current Docker and raw Kubernetes manifests.

#### Implementation Spec

- **Location**: Extend `deploy/` directory.
- **Structure**:
  ```
  deploy/
  ├── docker-compose.yml        # (existing)
  ├── k8s/                      # (existing)
  ├── terraform/
  │   ├── aws/
  │   │   ├── main.tf           # ECS Fargate or EC2 deployment
  │   │   ├── variables.tf
  │   │   ├── outputs.tf
  │   │   └── README.md
  │   └── gcp/
  │       ├── main.tf           # Cloud Run deployment
  │       ├── variables.tf
  │       └── outputs.tf
  ├── cloudformation/
  │   └── dunena-stack.yaml     # Single-stack ECS + ALB + EFS
  └── helm/
      └── dunena/
          ├── Chart.yaml
          ├── values.yaml
          └── templates/
              ├── deployment.yaml
              ├── service.yaml
              ├── configmap.yaml
              ├── ingress.yaml
              └── pvc.yaml
  ```
- **Helm chart**: Migrate existing raw k8s manifests into a proper Helm chart with parameterizable values.
- **Terraform AWS module**: Deploy on ECS Fargate with EFS for persistent storage (sidesteps the SQLite single-writer issue cleanly).

---

### 4. Snapshot Export/Import CLI Commands (Tooling) — P0

- **Description**: Add CLI commands for exporting and importing cache/database snapshots as portable files.
- **Benefit**: Enables data migration, backup/restore workflows, and debugging.
- **Complexity**: Low

#### Implementation Spec

- **Target file**: `packages/dunena/src/cli.ts` — add new commands.
- **New commands**:
  ```
  snapshot save [path]      # Trigger snapshot save, download to local file
  snapshot restore <path>   # Upload and restore from local snapshot file
  snapshot list             # List available snapshots (if cloud backup enabled)
  export --format=json|csv  # Export all cache entries as JSON or CSV
  import <file>             # Import entries from a JSON file
  ```
- **REST endpoints needed**: May require new `/snapshot/download` and `/snapshot/upload` endpoints in `app.ts`.

---

### 5. Automated API Documentation Generation (Tooling) — P1

- **Description**: Auto-generate OpenAPI/Swagger spec from the existing route definitions.
- **Benefit**: Keeps API docs always in sync with code; enables client SDK generation.
- **Complexity**: Low–Medium

#### Implementation Spec

- **Approach**: Since the routes are defined procedurally in `app.ts`, create a `scripts/generate-openapi.ts` that parses the route table and outputs `openapi.yaml`.
- **Alternative**: Add JSDoc-style annotations to each route handler in `app.ts` and use a lightweight extractor.
- **Output**: `packages/platform/docs/public/openapi.yaml` — served at `/docs/openapi.yaml`.
- **Integration**: Add Swagger UI or Redoc viewer at `/docs/api` (can be a simple HTML page that loads the spec).

---

## 🤖 Agent Skills & Classifications

To efficiently distribute work, agents should adopt the following specific skills/personas when contributing to Dunena:

### `zig-core-engineering`
- **Scope**: `zig/src/*`
- **Responsibilities**: Optimizing the core LRU cache logic, implementing new caching algorithms (e.g., LFU, ARC), managing the Bloom filter, improving RLE compression, and safely exposing new capabilities via the C-ABI exports.
- **Prerequisites**: Deep knowledge of Zig memory management and Bun FFI bridging.
- **Key files**:
  - `zig/src/cache.zig` — LRU/LFU cache implementation (316 lines)
  - `zig/src/exports.zig` — C-ABI export layer (440 lines)
  - `zig/src/bloom_filter.zig` — Bloom filter
  - `zig/src/compression.zig` — RLE compression
  - `zig/src/stats.zig` — Statistical computations
- **Current backlog**:
  - [x] Implement ARC eviction policy (see Feature #6 above)
  - [ ] Add `dunena_cache_iterate()` export for efficient bulk key scanning
  - [x] Investigate SIMD-accelerated hash functions for bloom filter
  - [ ] Add memory pool/arena allocator option for reduced fragmentation

### `bun-platform-development`
- **Scope**: `packages/platform/src/server/*`, `apps/server/*`
- **Responsibilities**: Expanding the REST API, building WebSocket channels, implementing new authentication/rate-limiting middleware, and managing the core app lifecycle.
- **Prerequisites**: Expertise in Bun, TypeScript, and high-performance asynchronous networking.
- **Key files**:
  - `packages/platform/src/server/app.ts` — Main HTTP server (45KB, ~1200 lines)
  - `packages/platform/src/server/middleware.ts` — Auth, rate limiting, CORS
  - `packages/platform/src/server/websocket.ts` — WebSocket handler
  - `packages/platform/src/server/router.ts` — Route matching
- **Current backlog**:
  - [x] GraphQL endpoint (see Feature #4 above)
  - [x] Health check enhancements (see Feature #7 above)
  - [x] Redis RESP adapter integration point
  - [x] OpenTelemetry instrumentation
  - [ ] Refactor `app.ts` — consider splitting into route modules (it's getting large)

### `sqlite-durable-storage`
- **Scope**: `packages/platform/src/db/*`
- **Responsibilities**: Optimizing `bun:sqlite` operations, building out the query cache and proxy mechanisms, managing tag-based invalidation logic, and handling snapshot persistence.
- **Prerequisites**: Strong understanding of SQLite performance characteristics, WAL mode, and caching strategies.
- **Key files**:
  - `packages/platform/src/db/sqlite-adapter.ts` — SQLite storage adapter (14KB)
  - `packages/platform/src/db/query-cache.ts` — Query result caching
  - `packages/platform/src/db/proxy.ts` — Database proxy service
  - `packages/platform/src/db/adapter.ts` — `StorageAdapter` interface
- **Current backlog**:
  - [x] Add MongoDB, Redis, Elasticsearch connectors to proxy (see Feature #5)
  - [x] Cloud storage backup integration (see Feature #2)
  - [ ] Implement write-ahead log for crash recovery
  - [ ] Add query plan caching for repeated proxy queries

### `sdk-development`
- **Scope**: `sdks/*`, `packages/dunena/*`
- **Responsibilities**: Building and maintaining official client SDKs for Python, Go, and Rust. Ensuring API parity with the REST endpoints and maintaining comprehensive test coverage.
- **Prerequisites**: Polyglot programming skills, familiarity with language-specific packaging ecosystems (PyPI, crates.io, Go modules).
- **Key files**:
  - `packages/dunena/src/cli.ts` — Existing TypeScript CLI/SDK (454 lines)
  - `packages/dunena/package.json` — npm package config
- **Current backlog**:
  - [x] Python SDK (see Tooling #1 — **P0**)
  - [ ] Go SDK
  - [ ] Rust SDK
  - [ ] TypeScript SDK improvements (WebSocket client, connection pooling)

### `devops-infrastructure`
- **Scope**: `deploy/*`, `scripts/*`, `.github/workflows/*`
- **Responsibilities**: Deployment automation, CI/CD pipeline enhancements, Terraform/Helm chart authoring, and performance benchmarking infrastructure.
- **Prerequisites**: Experience with Docker, Kubernetes, Terraform, GitHub Actions, and load testing tools (k6).
- **Key files**:
  - `deploy/docker-compose.yml` — Docker Compose config
  - `deploy/k8s/*.yaml` — Kubernetes manifests (7 files)
  - `scripts/release.ts` — Release automation
  - `scripts/bump-version.ts` — Version management
  - `.github/workflows/` — CI/CD pipelines
- **Current backlog**:
  - [x] Helm chart (see Tooling #3)
  - [x] Terraform modules — AWS (ECS Fargate + EFS) and GCP (Cloud Run + GCS)
  - [x] k6 benchmark suite (see Tooling #2 — **P0**)
  - [x] CloudFormation template (ECS + ALB + EFS)
  - [ ] Add staging deployment workflow
  - [ ] Container image multi-arch builds (arm64 + amd64)

### `documentation-engineering` (Currently Active)
- **Scope**: `packages/platform/docs/*`
- **Responsibilities**: Migrating the documentation to Next.js, maintaining UI/UX consistency, handling MDX compilation, and setting up static site generation.
- **Status**: Currently owned by the active Claude agent. Do not disturb this directory.

### `testing-quality`
- **Scope**: `packages/platform/tests/*`, `zig/src/exports.zig` (test section)
- **Responsibilities**: Expanding test coverage, adding integration tests, property-based tests, and performance regression tests.
- **Prerequisites**: Testing methodology, Bun test runner, Zig test framework.
- **Key files**:
  - `packages/platform/tests/api.test.ts` — API integration tests (21KB)
  - `packages/platform/tests/cache.test.ts` — Cache unit tests
  - `packages/platform/tests/db.test.ts` — Database tests (19KB)
  - `packages/platform/tests/ffi-boundary.test.ts` — FFI boundary tests
- **Current backlog**:
  - [x] WebSocket integration tests
  - [x] GraphQL integration tests
  - [x] Lock service tests
  - [x] Persistence service snapshot roundtrip tests
  - [x] RBAC service tests (18 tests)
  - [x] Redis adapter RESP parser tests (19 tests)
  - [ ] Replication service tests
  - [ ] Stress tests for concurrent cache access
  - [ ] Add code coverage reporting to CI

---

## 📐 Architecture Decision Records

### ADR-001: Zero-dependency DB Proxy connectors use HTTP bridges

The current `SqlDatabaseConnector` and `HttpDatabaseConnector` in `proxy.ts` both use `fetch()` under the hood. This was a deliberate choice to keep the platform package zero-dependency beyond Bun built-ins. New connectors that require native drivers (MongoDB, Redis) should use **dynamic imports** (`await import("mongodb")`) and document the peer dependency. The connector should throw a clear error if the driver is not installed.

### ADR-002: Zig FFI handles as opaque usize

All Zig objects are passed to TypeScript as `usize` (pointer cast to integer). TypeScript stores these as `Pointer` (Bun FFI type). The bridge layer in `cache-bridge.ts` wraps each handle in a class with a `destroyed` guard. **New Zig structures** (e.g., ARC cache internals) must follow the same pattern: `create → handle → ops → destroy`.

### ADR-003: Namespace separator is `\0`

Cache keys use the null byte (`\0`) as a namespace separator (`${namespace}\0${key}`). This is safe because keys are restricted to printable ASCII. Any new feature that creates composite keys must use this same convention.

---

## 🔗 Cross-References

- **Documentation migration status**: See `CLAUDE.md` and `packages/platform/docs/`.
- **Gemini agent config**: See `GEMINI.md`.
- **Changelog**: See `CHANGELOG.md` for release history.
- **Contributing guide**: See `CONTRIBUTING.md` for code standards.
- **Deployment guide**: See `deploy/README.md`.
