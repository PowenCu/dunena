// ── GraphQL Integration Tests ──────────────────────────────
// Tests the GraphQL endpoint at /graphql for all queries and
// mutations defined in the schema.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/types";

const TEST_PORT = 19878;

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
    filePath: "./data/test-graphql-snapshot.json",
    intervalMs: 0,
    saveOnShutdown: false,
  },
  database: {
    enabled: true,
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
let app: Awaited<ReturnType<typeof createApp>>;

// Flag: skip all if graphql-yoga is not installed
let graphqlAvailable = true;

async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

beforeAll(async () => {
  app = await createApp(testConfig);

  // Probe the endpoint — if graphql-yoga isn't installed, /graphql will 404
  const probe = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ __typename }" }),
  });
  if (probe.status === 404) {
    graphqlAvailable = false;
  }
});

afterAll(async () => {
  if (app.sqliteAdapter) await app.sqliteAdapter.close();
  app.cacheService.destroy();
  app.server.stop();
});

// ── Helper: seed data via REST ──────────────────────────────

async function seedCache(key: string, value: string, opts?: { ns?: string; ttl?: number }) {
  const qs = opts?.ns ? `?ns=${opts.ns}` : "";
  await fetch(`${BASE}/cache/${key}${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, ttl: opts?.ttl }),
  });
}

// ── Query: cache ────────────────────────────────────────────

describe("GraphQL Queries", () => {
  it("cache — returns entry set via REST", async () => {
    if (!graphqlAvailable) return;
    await seedCache("gql-hello", "world");

    const body = await gql(`{ cache(key: "gql-hello") { key value namespace } }`);
    expect(body.data.cache.key).toBe("gql-hello");
    expect(body.data.cache.value).toBe("world");
  });

  it("cache — returns null for missing key", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ cache(key: "gql-missing") { key value } }`);
    expect(body.data.cache).toBeNull();
  });

  it("cache — namespace isolation", async () => {
    if (!graphqlAvailable) return;
    await seedCache("gql-ns-key", "alpha-val", { ns: "alpha" });
    await seedCache("gql-ns-key", "beta-val", { ns: "beta" });

    const alpha = await gql(`{ cache(key: "gql-ns-key", ns: "alpha") { value } }`);
    expect(alpha.data.cache.value).toBe("alpha-val");

    const beta = await gql(`{ cache(key: "gql-ns-key", ns: "beta") { value } }`);
    expect(beta.data.cache.value).toBe("beta-val");
  });

  // ── Query: cacheMulti ───────────────────────────────────

  it("cacheMulti — batch retrieval", async () => {
    if (!graphqlAvailable) return;
    await seedCache("gql-m1", "a");
    await seedCache("gql-m2", "b");

    const body = await gql(`{
      cacheMulti(keys: ["gql-m1", "gql-m2", "gql-m-missing"]) {
        key value
      }
    }`);
    expect(body.data.cacheMulti).toHaveLength(3);
    expect(body.data.cacheMulti[0].value).toBe("a");
    expect(body.data.cacheMulti[1].value).toBe("b");
    expect(body.data.cacheMulti[2].value).toBeNull();
  });

  // ── Query: keys ─────────────────────────────────────────

  it("keys — scans keys with pattern", async () => {
    if (!graphqlAvailable) return;
    await seedCache("gql-scan-x", "1");
    await seedCache("gql-scan-y", "2");

    const body = await gql(`{ keys(pattern: "gql-scan-*") { cursor keys } }`);
    expect(body.data.keys.keys).toContain("gql-scan-x");
    expect(body.data.keys.keys).toContain("gql-scan-y");
  });

  // ── Query: stats ────────────────────────────────────────

  it("stats — returns cache statistics", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ stats { hits misses hitRate entries evictions maxEntries } }`);
    expect(typeof body.data.stats.hits).toBe("number");
    expect(typeof body.data.stats.hitRate).toBe("number");
    expect(typeof body.data.stats.maxEntries).toBe("number");
  });

  // ── Query: exists ───────────────────────────────────────

  it("exists — true for existing key", async () => {
    if (!graphqlAvailable) return;
    await seedCache("gql-exists-key", "here");

    const body = await gql(`{ exists(key: "gql-exists-key") }`);
    expect(body.data.exists).toBe(true);
  });

  it("exists — false for missing key", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ exists(key: "gql-no-such-key") }`);
    expect(body.data.exists).toBe(false);
  });

  // ── Query: ttl ──────────────────────────────────────────

  it("ttl — returns -2 for missing key", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ ttl(key: "gql-ttl-gone") }`);
    expect(body.data.ttl).toBe(-2);
  });

  it("ttl — returns remaining TTL for key with expiry", async () => {
    if (!graphqlAvailable) return;
    await seedCache("gql-ttl-key", "temp", { ttl: 60000 });

    const body = await gql(`{ ttl(key: "gql-ttl-key") }`);
    expect(body.data.ttl).toBeGreaterThan(0);
    expect(body.data.ttl).toBeLessThanOrEqual(60000);
  });

  // ── Query: dbEntry ──────────────────────────────────────

  it("dbEntry — retrieves stored DB entry", async () => {
    if (!graphqlAvailable) return;

    // Seed via REST DB endpoint
    await fetch(`${BASE}/db/gql-db-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "db-val", tags: ["gql-tag"] }),
    });

    const body = await gql(`{ dbEntry(key: "gql-db-key") { key value tags } }`);
    expect(body.data.dbEntry).not.toBeNull();
    expect(body.data.dbEntry.key).toBe("gql-db-key");
    expect(body.data.dbEntry.value).toBe("db-val");
  });

  it("dbEntry — returns null for missing DB entry", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ dbEntry(key: "gql-db-nope") { key value } }`);
    expect(body.data.dbEntry).toBeNull();
  });

  // ── Query: connectors ───────────────────────────────────

  it("connectors — returns list (may be empty)", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ connectors { name type } }`);
    expect(Array.isArray(body.data.connectors)).toBe(true);
  });
});

// ── Mutations ─────────────────────────────────────────────

describe("GraphQL Mutations", () => {
  it("cacheSet — sets a cache entry", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`
      mutation { cacheSet(key: "gql-mut-key", value: "mut-val", ttl: 30000) }
    `);
    expect(body.data.cacheSet).toBe(true);

    // Verify via query
    const check = await gql(`{ cache(key: "gql-mut-key") { value } }`);
    expect(check.data.cache.value).toBe("mut-val");
  });

  it("cacheSet — with namespace", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`
      mutation { cacheSet(key: "gql-mut-ns", value: "ns-val", ns: "myns") }
    `);
    expect(body.data.cacheSet).toBe(true);

    const check = await gql(`{ cache(key: "gql-mut-ns", ns: "myns") { value } }`);
    expect(check.data.cache.value).toBe("ns-val");
  });

  it("cacheDelete — deletes a cache entry", async () => {
    if (!graphqlAvailable) return;
    await gql(`mutation { cacheSet(key: "gql-to-del", value: "tmp") }`);

    const body = await gql(`mutation { cacheDelete(key: "gql-to-del") }`);
    expect(body.data.cacheDelete).toBe(true);

    const check = await gql(`{ cache(key: "gql-to-del") { value } }`);
    expect(check.data.cache).toBeNull();
  });

  it("cacheDelete — returns false for missing key", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`mutation { cacheDelete(key: "gql-never-existed") }`);
    expect(body.data.cacheDelete).toBe(false);
  });

  it("flush — clears all cache entries", async () => {
    if (!graphqlAvailable) return;
    await gql(`mutation { cacheSet(key: "gql-flush-a", value: "a") }`);
    await gql(`mutation { cacheSet(key: "gql-flush-b", value: "b") }`);

    const body = await gql(`mutation { flush }`);
    expect(body.data.flush).toBe(true);

    const check = await gql(`{ cache(key: "gql-flush-a") { value } }`);
    expect(check.data.cache).toBeNull();
  });

  it("dbSet — sets a database entry", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`
      mutation { dbSet(key: "gql-db-set", value: "db-set-val") }
    `);
    expect(body.data.dbSet).toBe(true);
  });

  it("dbDelete — deletes a database entry", async () => {
    if (!graphqlAvailable) return;
    await gql(`mutation { dbSet(key: "gql-db-del", value: "temp") }`);

    const body = await gql(`mutation { dbDelete(key: "gql-db-del") }`);
    expect(body.data.dbDelete).toBe(true);
  });
});

// ── Error Handling ────────────────────────────────────────

describe("GraphQL Error Handling", () => {
  it("returns errors for invalid query syntax", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ invalidSyntax {{{ }`);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("returns errors for unknown field", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ nonExistentField }`);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("handles introspection query", async () => {
    if (!graphqlAvailable) return;
    const body = await gql(`{ __schema { types { name } } }`);
    expect(body.data.__schema.types.length).toBeGreaterThan(0);
  });
});
