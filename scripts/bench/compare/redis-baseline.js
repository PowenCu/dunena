// ── Redis Baseline Benchmark ───────────────────────────────
// k6 script for benchmarking Redis to establish a comparison
// baseline against Dunena's performance.
//
// Prerequisites:
//   - Redis server running (default: localhost:6379)
//   - k6 with experimental Redis module OR Redis HTTP bridge
//
// Since k6 does not have a native Redis module, this benchmark
// uses an HTTP bridge approach:
//   - Option A: Run a small HTTP-to-Redis proxy (e.g., webdis)
//   - Option B: Use a Redis REST API (e.g., Upstash REST)
//
// For local comparison, we recommend webdis:
//   docker run -d -p 7379:7379 nicolas/webdis
//
// Usage:
//   REDIS_URL=http://localhost:7379 k6 run scripts/bench/compare/redis-baseline.js

import http from "k6/http";
import { check, sleep } from "k6";

const REDIS_URL = __ENV.REDIS_URL || "http://localhost:7379";

export const options = {
  scenarios: {
    redis_set: {
      executor: "constant-vus",
      vus: 20,
      duration: "15s",
      exec: "redisSet",
      tags: { op: "redis_set" },
    },
    redis_get: {
      executor: "constant-vus",
      vus: 20,
      duration: "15s",
      exec: "redisGet",
      startTime: "15s",
      tags: { op: "redis_get" },
    },
    redis_del: {
      executor: "constant-vus",
      vus: 10,
      duration: "10s",
      exec: "redisDel",
      startTime: "30s",
      tags: { op: "redis_del" },
    },
    redis_mset: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "redisMset",
      startTime: "40s",
      tags: { op: "redis_mset" },
    },
    redis_mget: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "redisMget",
      startTime: "55s",
      tags: { op: "redis_mget" },
    },
  },
  thresholds: {
    "http_req_duration{op:redis_get}": ["p(95)<10", "p(99)<25"],
    "http_req_duration{op:redis_set}": ["p(95)<15", "p(99)<30"],
    "http_req_duration{op:redis_del}": ["p(95)<10", "p(99)<25"],
    "http_req_duration{op:redis_mset}": ["p(95)<50", "p(99)<100"],
    "http_req_duration{op:redis_mget}": ["p(95)<30", "p(99)<60"],
    http_req_failed: ["rate<0.01"],
  },
};

// ── Webdis HTTP API ───────────────────────────────────────
// Webdis exposes Redis commands as HTTP endpoints:
//   GET  /GET/<key>           → { "GET": "value" }
//   GET  /SET/<key>/<value>   → { "SET": [true, "OK"] }
//   GET  /DEL/<key>           → { "DEL": 1 }
//   GET  /MSET/<k1>/<v1>/... → { "MSET": "OK" }
//   GET  /MGET/<k1>/<k2>/... → { "MGET": ["v1", "v2"] }

export function redisSet() {
  const key = `bench-${__VU}-${__ITER}`;
  const value = `value-${key}-${"x".repeat(64)}`;

  const res = http.get(`${REDIS_URL}/SET/${key}/${encodeURIComponent(value)}`);
  check(res, {
    "Redis SET status 200": (r) => r.status === 200,
  });
}

export function redisGet() {
  const key = `bench-${__VU}-${__ITER % 100}`;
  const res = http.get(`${REDIS_URL}/GET/${key}`);
  check(res, {
    "Redis GET status 200": (r) => r.status === 200,
  });
}

export function redisDel() {
  const key = `bench-${__VU}-${__ITER}`;
  const res = http.get(`${REDIS_URL}/DEL/${key}`);
  check(res, {
    "Redis DEL status 200": (r) => r.status === 200,
  });
}

export function redisMset() {
  const batchSize = 20;
  const parts = [];
  for (let i = 0; i < batchSize; i++) {
    const key = `batch-${__VU}-${__ITER}-${i}`;
    const value = `bval-${i}-${"y".repeat(32)}`;
    parts.push(`${key}/${encodeURIComponent(value)}`);
  }

  const res = http.get(`${REDIS_URL}/MSET/${parts.join("/")}`);
  check(res, {
    "Redis MSET status 200": (r) => r.status === 200,
  });
}

export function redisMget() {
  const batchSize = 20;
  const keys = [];
  for (let i = 0; i < batchSize; i++) {
    keys.push(`batch-${__VU}-${__ITER % 50}-${i}`);
  }

  const res = http.get(`${REDIS_URL}/MGET/${keys.join("/")}`);
  check(res, {
    "Redis MGET status 200": (r) => r.status === 200,
  });
}
