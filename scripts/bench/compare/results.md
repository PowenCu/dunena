# Benchmark Comparison Results

> Record of performance benchmarks comparing Dunena against Redis.

## Setup

| Parameter       | Value              |
|-----------------|--------------------|
| Hardware        | _describe system_  |
| OS              | _OS version_       |
| CPU             | _model, cores_     |
| Memory          | _GB RAM_           |
| Dunena version  | 0.4.0              |
| Redis version   | _X.X.X_            |
| k6 version      | _X.X.X_            |
| Redis bridge    | webdis (HTTP)      |
| Date            | _YYYY-MM-DD_       |

## Cache CRUD Operations

| Operation | Dunena p50 | Dunena p95 | Dunena p99 | Redis p50 | Redis p95 | Redis p99 | Ratio (p95) |
|-----------|-----------|-----------|-----------|----------|----------|----------|-------------|
| GET       |           |           |           |          |          |          |             |
| SET       |           |           |           |          |          |          |             |
| DEL       |           |           |           |          |          |          |             |

## Batch Operations (batch size = 20)

| Operation | Dunena p50 | Dunena p95 | Dunena p99 | Redis p50 | Redis p95 | Redis p99 | Ratio (p95) |
|-----------|-----------|-----------|-----------|----------|----------|----------|-------------|
| MGET (20) |           |           |           |          |          |          |             |
| MSET (20) |           |           |           |          |          |          |             |

## SQLite Durable Storage

| Operation   | Dunena p50 | Dunena p95 | Dunena p99 | Notes             |
|-------------|-----------|-----------|-----------|-------------------|
| DB GET      |           |           |           | SQLite read       |
| DB SET      |           |           |           | SQLite write      |
| DB DEL      |           |           |           | SQLite delete     |
| DB MGET (20)|           |           |           | Batch read        |
| DB MSET (20)|           |           |           | Batch write       |

## WebSocket Operations

| Metric                 | Value      | Notes                    |
|------------------------|------------|--------------------------|
| WS Roundtrip p50       |            | set/get/del via WS       |
| WS Roundtrip p95       |            |                          |
| WS Roundtrip p99       |            |                          |
| Messages/sec (total)   |            | Across all VUs           |
| Concurrent connections |            | Max tested               |
| Error count            |            |                          |

## Mixed Workload (80% read / 20% write)

| Metric          | Dunena   | Redis    | Ratio |
|-----------------|----------|----------|-------|
| Throughput (rps)|          |          |       |
| Latency p50     |          |          |       |
| Latency p95     |          |          |       |
| Latency p99     |          |          |       |
| Error rate      |          |          |       |

## Observations

_Add qualitative observations here:_

- Dunena vs Redis on cold-start performance
- Memory usage comparison
- CPU utilization
- Tail latency behavior under load
- SQLite durability vs Redis AOF/RDB

## How to Run

```bash
# Start Dunena
bun run start

# Run all Dunena benchmarks
k6 run scripts/bench/k6/cache-crud.js
k6 run scripts/bench/k6/cache-batch.js
k6 run scripts/bench/k6/db-operations.js
k6 run scripts/bench/k6/websocket-events.js
k6 run scripts/bench/k6/mixed-workload.js

# Start Redis + webdis for comparison
docker run -d --name redis -p 6379:6379 redis
docker run -d --name webdis -p 7379:7379 --link redis nicolas/webdis

# Run Redis baseline
REDIS_URL=http://localhost:7379 k6 run scripts/bench/compare/redis-baseline.js
```
