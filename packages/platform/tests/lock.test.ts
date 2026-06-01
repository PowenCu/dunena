// ── Lock Service Integration Tests ─────────────────────────
// Tests the distributed lock HTTP API at /locks.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/types";

const TEST_PORT = 19879;

const testConfig: AppConfig = {
  cache: {
    maxEntries: 1000,
    enableBloomFilter: true,
    bloomFilterSize: 10_000,
    bloomFilterHashes: 5,
  },
  server: {
    port: TEST_PORT,
    host: "127.0.0.1",
    enableWebSocket: false,
    enableDashboard: false,
    rateLimit: { windowMs: 60_000, maxRequests: 10_000 },
    cors: { origins: ["*"], methods: ["GET", "POST", "PUT", "DELETE"] },
  },
  persistence: {
    enabled: false,
    filePath: "./data/test-lock-snapshot.json",
    intervalMs: 0,
    saveOnShutdown: false,
  },
  database: {
    enabled: false,
    sqlitePath: ":memory:",
    queryCacheTTL: 5_000,
    purgeIntervalMs: 0,
  },
  log: { level: "error", format: "text" },
  telemetry: {
    enabled: false,
    endpoint: "",
    serviceName: "test",
    serviceVersion: "1",
  },
  cluster: {
    enabled: false,
    nodeId: "test-node",
    seeds: [],
    heartbeatIntervalMs: 2000,
    suspectTimeoutMs: 6000,
    deadTimeoutMs: 15000,
    electionTimeoutMs: 5000,
    priority: 100,
    localReads: true,
  },
};

const BASE = `http://127.0.0.1:${TEST_PORT}`;
const headers = { "Content-Type": "application/json" };
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp(testConfig);
});

afterAll(() => {
  app.cacheService.destroy();
  app.server.stop();
});

// ── Lock Acquisition & Release ────────────────────────────

describe("Lock Lifecycle", () => {
  it("acquires a lock successfully", async () => {
    const res = await fetch(`${BASE}/locks/resource-1/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "worker-1", ttl: 30000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { acquired: boolean; lock: { key: string; owner: string; ttl: number } };
    expect(body.acquired).toBe(true);
    expect(body.lock.key).toBe("resource-1");
    expect(body.lock.owner).toBe("worker-1");
  });

  it("checks lock status via GET", async () => {
    const res = await fetch(`${BASE}/locks/resource-1`);
    const body = await res.json() as { locked: boolean; lock: { key: string; owner: string } };
    expect(res.status).toBe(200);
    expect(body.locked).toBe(true);
    expect(body.lock.owner).toBe("worker-1");
  });

  it("releases a lock with correct owner", async () => {
    const res = await fetch(`${BASE}/locks/resource-1/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "worker-1" }),
    });
    const body = await res.json() as { released: boolean };
    expect(res.status).toBe(200);
    expect(body.released).toBe(true);

    // Verify released
    const check = await fetch(`${BASE}/locks/resource-1`);
    const checkBody = await check.json() as { locked: boolean };
    expect(checkBody.locked).toBe(false);
  });

  it("lists active locks via GET /locks", async () => {
    // Acquire two locks
    await fetch(`${BASE}/locks/list-a/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "worker-a" }),
    });
    await fetch(`${BASE}/locks/list-b/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "worker-b" }),
    });

    const res = await fetch(`${BASE}/locks`);
    const body = await res.json() as { locks: Array<{ key: string }>; count: number };
    expect(res.status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(2);

    // Clean up
    await fetch(`${BASE}/locks/list-a`, { method: "DELETE" });
    await fetch(`${BASE}/locks/list-b`, { method: "DELETE" });
  });
});

// ── Lock Contention ───────────────────────────────────────

describe("Lock Contention", () => {
  it("rejects acquisition when lock is already held", async () => {
    // Acquire the lock first
    const first = await fetch(`${BASE}/locks/contested/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "holder-1" }),
    });
    expect(first.status).toBe(201);

    // Try to acquire the same lock with a different owner
    const second = await fetch(`${BASE}/locks/contested/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "holder-2" }),
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { acquired: boolean; error: string };
    expect(body.acquired).toBe(false);

    // Clean up
    await fetch(`${BASE}/locks/contested`, { method: "DELETE" });
  });

  it("prevents release by wrong owner", async () => {
    await fetch(`${BASE}/locks/owner-check/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "real-owner" }),
    });

    const res = await fetch(`${BASE}/locks/owner-check/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "imposter" }),
    });
    const body = await res.json() as { released: boolean };
    expect(body.released).toBe(false);

    // Lock should still be held
    const check = await fetch(`${BASE}/locks/owner-check`);
    const checkBody = await check.json() as { locked: boolean };
    expect(checkBody.locked).toBe(true);

    // Clean up
    await fetch(`${BASE}/locks/owner-check`, { method: "DELETE" });
  });
});

// ── Lock Expiration ───────────────────────────────────────

describe("Lock Expiration", () => {
  it("lock expires after short TTL", async () => {
    const res = await fetch(`${BASE}/locks/ttl-lock/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "temp-worker", ttl: 200 }),
    });
    expect(res.status).toBe(201);

    // Wait for expiration
    await Bun.sleep(350);

    // Should be able to acquire again (previous expired)
    const retry = await fetch(`${BASE}/locks/ttl-lock/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "new-worker" }),
    });
    expect(retry.status).toBe(201);

    // Clean up
    await fetch(`${BASE}/locks/ttl-lock`, { method: "DELETE" });
  });
});

// ── Lock Extension ────────────────────────────────────────

describe("Lock Extension", () => {
  it("extends a held lock", async () => {
    await fetch(`${BASE}/locks/ext-lock/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "worker-ext", ttl: 5000 }),
    });

    const res = await fetch(`${BASE}/locks/ext-lock/extend`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "worker-ext", ttl: 30000 }),
    });
    const body = await res.json() as { extended: boolean; lock: { ttl: number } };
    expect(res.status).toBe(200);
    expect(body.extended).toBe(true);
    expect(body.lock.ttl).toBeGreaterThanOrEqual(5000);

    // Clean up
    await fetch(`${BASE}/locks/ext-lock`, { method: "DELETE" });
  });

  it("rejects extend from wrong owner", async () => {
    await fetch(`${BASE}/locks/ext-wrong/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "real-worker" }),
    });

    const res = await fetch(`${BASE}/locks/ext-wrong/extend`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "imposter", ttl: 30000 }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { extended: boolean };
    expect(body.extended).toBe(false);

    // Clean up
    await fetch(`${BASE}/locks/ext-wrong`, { method: "DELETE" });
  });

  it("rejects extend for non-existent lock", async () => {
    const res = await fetch(`${BASE}/locks/no-such-lock/extend`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "anyone", ttl: 5000 }),
    });
    expect(res.status).toBe(404);
  });
});

// ── Force Release ─────────────────────────────────────────

describe("Force Release", () => {
  it("force releases a lock via DELETE", async () => {
    await fetch(`${BASE}/locks/force-lock/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "holder" }),
    });

    const res = await fetch(`${BASE}/locks/force-lock`, { method: "DELETE" });
    const body = await res.json() as { forceReleased: boolean };
    expect(res.status).toBe(200);
    expect(body.forceReleased).toBe(true);

    // Verify released
    const check = await fetch(`${BASE}/locks/force-lock`);
    const checkBody = await check.json() as { locked: boolean };
    expect(checkBody.locked).toBe(false);
  });

  it("force release non-existent lock returns false", async () => {
    const res = await fetch(`${BASE}/locks/ghost-lock`, { method: "DELETE" });
    const body = await res.json() as { forceReleased: boolean };
    expect(body.forceReleased).toBe(false);
  });
});

// ── Error Handling ────────────────────────────────────────

describe("Lock Error Handling", () => {
  it("rejects acquire without owner", async () => {
    const res = await fetch(`${BASE}/locks/bad-lock/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects release without owner", async () => {
    const res = await fetch(`${BASE}/locks/bad-lock/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects extend without ttl", async () => {
    await fetch(`${BASE}/locks/ext-no-ttl/acquire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "w" }),
    });

    const res = await fetch(`${BASE}/locks/ext-no-ttl/extend`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "w" }),
    });
    expect(res.status).toBe(400);

    // Clean up
    await fetch(`${BASE}/locks/ext-no-ttl`, { method: "DELETE" });
  });

  it("release non-existent lock returns false", async () => {
    const res = await fetch(`${BASE}/locks/never-locked/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "anyone" }),
    });
    const body = await res.json() as { released: boolean };
    expect(body.released).toBe(false);
  });

  it("check status of non-existent lock", async () => {
    const res = await fetch(`${BASE}/locks/nonexistent-status`);
    const body = await res.json() as { locked: boolean };
    expect(res.status).toBe(200);
    expect(body.locked).toBe(false);
  });
});
