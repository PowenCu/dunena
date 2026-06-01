# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-06-01

## [0.4.0] - 2026-06-01

## [0.4.0] - 2026-05-16

### Added

- **Redis Protocol Translation Layer (P2)**: Full RESP2 protocol adapter via `packages/redis-adapter`. Supports `GET`, `SET`, `DEL`, `MGET`, `MSET`, `EXISTS`, `KEYS`, `TTL`, `EXPIRE`, `INCR`, `DECR`, `PING`, `INFO`, `DBSIZE`, `FLUSHDB`, and more. Connect any standard Redis client to Dunena on port 6379. Enable with `DUNENA_REDIS_ENABLED=true`.
- **GraphQL API Endpoint (P2)**: Full GraphQL API at `/graphql` via `graphql-yoga`. Exposes queries for cache, database, analytics, and proxy operations. Includes mutations for cache set/delete, flush, DB operations, and proxy queries. Subscriptions for cache events.
- **OpenTelemetry Integration (P2)**: Dynamic-loading telemetry service with OTLP trace and metric export. Instruments HTTP requests, cache operations, and DB proxy queries. Zero overhead when disabled. Configure with `DUNENA_OTEL_ENABLED`, `DUNENA_OTEL_ENDPOINT`, and `DUNENA_OTEL_SERVICE_NAME`.
- **High Availability / Clustering (P3)**: Gossip-based membership protocol with automatic leader election (Bully algorithm). Features include:
  - Periodic heartbeat broadcasting with configurable intervals
  - Three-state failure detection: `alive → suspect → dead`
  - Automatic leader election when the leader node dies
  - Write-through replication from leader to all followers
  - Write forwarding from followers to the leader
  - Internal cluster API endpoints (`/_cluster/stats`, `/_cluster/members`, `/_cluster/join`, `/_cluster/message`)
  - Auto-configuration of `ReplicationService` when nodes join/leave
  - Configurable via `DUNENA_CLUSTER_*` environment variables
- **Cluster module**: New `packages/platform/src/cluster/` directory containing:
  - `types.ts` — Cluster type definitions (nodes, messages, config, stats)
  - `membership.ts` — Gossip membership service with failure detection
  - `election.ts` — Bully algorithm leader election service
  - `cluster-service.ts` — Top-level orchestrator
  - `index.ts` — Barrel exports
- Startup banner now shows OpenTelemetry, GraphQL, and Cluster feature flags

### Changed

- `AppConfig` interface now includes `telemetry` and `cluster` configuration sections
- `config.ts` parses 10 new `DUNENA_CLUSTER_*` environment variables and 3 `DUNENA_OTEL_*` variables
- `app.ts` fetch handler is now `async` to support cluster endpoint request body parsing
- Production caveat in README updated: clustering now supports horizontal scaling with leader-follower architecture
- `ReplicationService` is automatically managed by `ClusterService` when clustering is enabled
- Graceful shutdown now stops cluster service (broadcasts leave) before other teardown
- README, INSTALL.md, CHANGELOG.md, .env.example fully rewritten to document all P0–P3 features

### Fixed

- Module resolution error for `@dunena/platform/src/services/cache-service` in `redis-adapter` — now uses exported type from main package entry point

## [0.3.1] - 2026-03-28

### Added

- **Memory Usage Tracking**: Track actual memory usage (bytes) per cache entry in Zig core, exposed via `/stats` and `/metrics` endpoints
- **Atomic Increment/Decrement**: `INCR` and `DECR` operations for numeric counters via `/cache/:key/incr` and `/cache/:key/decr` endpoints
- **Compare-and-Swap (CAS)**: Optimistic locking with version tracking via `/cache/:key/version` and `/cache/:key/cas` endpoints
- **TTL Touch/Update API**: Update TTL without re-setting value via `/cache/:key/touch` endpoint, get remaining TTL via `/cache/:key/ttl`
- **LRU/LFU Switchable Eviction**: Support for both LRU (Least Recently Used) and LFU (Least Frequently Used) eviction policies, configurable at cache creation
- **Key Expiration Events**: WebSocket clients receive `expired` events when keys expire (via PubSub)
- **Cache Warmup API**: Bulk import endpoint `POST /cache/warmup` to pre-populate cache from JSON
- **Distributed Locking**: Lock service with acquire/release/extend operations via `/locks` endpoints
- **Cache Replication**: Write-through replication to secondary cache instances with async/sync modes via `/replication` endpoints
- **Cache Info Endpoint**: `GET /cache/info` returns eviction policy, memory usage, and CAS statistics
- CLI commands: `incr`, `decr`, `version`, `cas`, `ttl`, `touch`, `cache-info`, `warmup`, `lock-*`, `replication-*`
- New Prometheus metrics: `dunena_cache_memory_bytes`, `dunena_cache_cas_hits_total`, `dunena_cache_cas_misses_total`, `dunena_locks_active`

### Changed

- `CacheStats` now includes `memoryBytes`, `casHits`, and `casMisses` fields
- `CacheConfig` now accepts optional `evictionPolicy` field (`"lru"` or `"lfu"`)
- Zig `CacheEntry` struct now includes `version` and `access_count` fields
- FFI stats buffer increased from 7 to 10 u64 values

## [0.3.1] - 2026-03-17

## [0.3.0] - 2026-03-17

## [0.2.0] - 2026-03-16

### Added

- FFI boundary tests for edge cases (empty keys, oversized values, create/destroy cycles)
- ABI-safety docstrings in `exports.zig` and `ffi.ts`
- Zero-length input guards in Zig exports (bloom filter, stats)
- CI dependency caching for Zig build artifacts
- Separate lint job in CI for faster feedback
- `CHANGELOG.md` scaffold
- `CODEOWNERS` file
- Expanded `CONTRIBUTING.md` with developer quickstart and architecture overview

### Changed

- Unified Zig setup action across CI and release workflows (`mlugg/setup-zig@v2.2.1`)
- Improved `.gitignore` patterns
- Improved FFI bridge safety in `cache-bridge.ts` to handle zero-length strings gracefully (Bun FFI compatibility)

### Fixed

- Potential undefined behavior in stats exports when called with zero-length data
- TypeError in Bun FFI when passing empty ArrayBufferView to `ptr()`
