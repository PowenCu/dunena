// ── Dunena k6 Benchmark: SQLite Database Operations ────────
// Measures throughput and latency for durable storage operations.
//
// Usage:
//   k6 run scripts/bench/k6/db-operations.js
//   k6 run scripts/bench/k6/db-operations.js --vus 20 --duration 30s

import http from "k6/http";
import { check, sleep } from "k6";
import { config } from "./config.js";

export const options = {
  scenarios: {
    db_set: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 10 },   // ramp up
        { duration: "15s", target: 20 },   // sustain
        { duration: "5s", target: 0 },     // ramp down
      ],
      exec: "dbSetOperation",
      tags: { op: "db_set" },
    },
    db_get: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 10 },
        { duration: "15s", target: 20 },
        { duration: "5s", target: 0 },
      ],
      exec: "dbGetOperation",
      startTime: "25s", // Start after SET phase
      tags: { op: "db_get" },
    },
    db_delete: {
      executor: "constant-vus",
      vus: 10,
      duration: "10s",
      exec: "dbDeleteOperation",
      startTime: "50s", // Start after GET phase
      tags: { op: "db_delete" },
    },
    db_mset: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "dbMsetOperation",
      startTime: "60s",
      tags: { op: "db_mset" },
    },
    db_mget: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "dbMgetOperation",
      startTime: "75s",
      tags: { op: "db_mget" },
    },
  },
  thresholds: {
    "http_req_duration{op:db_get}": ["p(95)<25", "p(99)<50"],
    "http_req_duration{op:db_set}": ["p(95)<50", "p(99)<100"],
    "http_req_duration{op:db_delete}": ["p(95)<25", "p(99)<50"],
    "http_req_duration{op:db_mset}": ["p(95)<100", "p(99)<200"],
    "http_req_duration{op:db_mget}": ["p(95)<50", "p(99)<100"],
    http_req_failed: ["rate<0.01"], // <1% error rate
  },
};

const headers = { "Content-Type": "application/json", ...config.authHeaders };

export function dbSetOperation() {
  const key = `db-bench-${__VU}-${__ITER}`;
  const payload = JSON.stringify({
    value: `db-value-${key}-${"d".repeat(64)}`,
    tags: ["benchmark", `vu-${__VU}`],
  });

  const res = http.post(`${config.baseUrl}/db/${key}`, payload, { headers });
  check(res, {
    "DB SET status is 201": (r) => r.status === 201,
    "DB SET response has ok": (r) => JSON.parse(r.body).ok === true,
  });
}

export function dbGetOperation() {
  const key = `db-bench-${__VU}-${__ITER % 100}`;
  const res = http.get(`${config.baseUrl}/db/${key}`, { headers });
  check(res, {
    "DB GET status is 200 or 404": (r) => r.status === 200 || r.status === 404,
  });
}

export function dbDeleteOperation() {
  const key = `db-bench-${__VU}-${__ITER}`;
  const res = http.del(`${config.baseUrl}/db/${key}`, null, { headers });
  check(res, {
    "DB DEL status is 200": (r) => r.status === 200,
  });
}

export function dbMsetOperation() {
  const batchSize = 20;
  const entries = [];
  for (let i = 0; i < batchSize; i++) {
    entries.push({
      key: `db-batch-${__VU}-${__ITER}-${i}`,
      value: `batch-val-${i}-${"e".repeat(32)}`,
      tags: ["batch-bench"],
    });
  }

  const payload = JSON.stringify({ action: "mset", entries });
  const res = http.post(`${config.baseUrl}/db`, payload, { headers });
  check(res, {
    "DB MSET status is 200": (r) => r.status === 200,
    "DB MSET stored count matches": (r) => JSON.parse(r.body).stored === batchSize,
  });
}

export function dbMgetOperation() {
  const batchSize = 20;
  const keys = [];
  for (let i = 0; i < batchSize; i++) {
    keys.push(`db-batch-${__VU}-${__ITER % 50}-${i}`);
  }

  const payload = JSON.stringify({ action: "mget", keys });
  const res = http.post(`${config.baseUrl}/db`, payload, { headers });
  check(res, {
    "DB MGET status is 200": (r) => r.status === 200,
    "DB MGET has result": (r) => JSON.parse(r.body).result !== undefined,
  });
}
