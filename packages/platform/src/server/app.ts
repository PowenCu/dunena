// ── HTTP Application ───────────────────────────────────────
import { Router } from "./router";
import {
  corsHeaders,
  handleCors,
  authenticate,
  rateLimit,
  logRequest,
  checkBodySize,
  namespaceRateLimit,
  configureNamespaceRateLimit,
  removeNamespaceRateLimit,
  getNamespaceRateLimits,
  getNamespaceRateLimitStats,
  setRBACService,
  checkPermission,
} from "./middleware";
import { RBACService } from "../services/rbac-service";
import { createWebSocketHandlers } from "./websocket";
import { CacheService } from "../services/cache-service";
import { AnalyticsService } from "../services/analytics-service";
import { PubSubService } from "../services/pubsub-service";
import { LockService } from "../services/lock-service";
import { ReplicationService } from "../services/replication-service";
import {
  validateKey,
  validateValue,
  validateTTL,
  validationError,
} from "../utils/validation";
import { logger } from "../utils/logger";
import type { AppConfig, WebSocketData, ReplicaConfig } from "../types";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { PersistenceService, type SnapshotData } from "../services/persistence-service";
import { SQLiteAdapter } from "../db/sqlite-adapter";
import { QueryCacheService } from "../db/query-cache";
import { DatabaseProxy } from "../db/proxy";
import type { DatabaseConnectorConfig, ProxyQueryRequest } from "../db/proxy";
import { initTelemetry, shutdownTelemetry, withSpan, recordCacheOp } from "../services/telemetry-service";
import { createGraphQLHandler } from "./graphql";
import { ClusterService } from "../cluster/cluster-service";

const log = logger.child("app");

export async function createApp(appConfig: AppConfig) {
  // ── Telemetry ──────────────────────────────────────────
  await initTelemetry(appConfig.telemetry);

  // ── Bootstrap services ─────────────────────────────────
  const pubsub = new PubSubService();
  const cacheService = new CacheService(appConfig.cache, pubsub);
  const analytics = new AnalyticsService();
  const persistence = new PersistenceService(appConfig.persistence);

  // Wire persistence and restore snapshot from disk
  persistence.attach(cacheService);
  const restored = persistence.load();
  if (restored > 0) log.info(`Restored ${restored} entries from snapshot`);
  persistence.start();

  // Snapshot analytics every 60 s
  const snapshotInterval = setInterval(() => {
    analytics.takeSnapshot(cacheService.stats());
  }, 60_000);
  snapshotInterval.unref();

  // ── Database layer ─────────────────────────────────────
  let sqliteAdapter: SQLiteAdapter | null = null;
  let queryCache: QueryCacheService | null = null;
  let dbProxy: DatabaseProxy | null = null;
  let purgeInterval: Timer | null = null;

  if (appConfig.database.enabled) {
    const dbDir = dirname(resolve(appConfig.database.sqlitePath));
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    sqliteAdapter = new SQLiteAdapter({ path: appConfig.database.sqlitePath });
    queryCache = new QueryCacheService(sqliteAdapter, cacheService, appConfig.database.queryCacheTTL);
    dbProxy = new DatabaseProxy(queryCache, appConfig.database.writeBehind);

    // Start the write-behind buffer if configured
    if (appConfig.database.writeBehind?.enabled) {
      dbProxy.startWriteBehind();
    }

    // Periodic expired-entry purge
    if (appConfig.database.purgeIntervalMs > 0) {
      purgeInterval = setInterval(() => {
        sqliteAdapter!.purgeExpired();
      }, appConfig.database.purgeIntervalMs);
      purgeInterval.unref();
    }
  }

  // ── Lock & Replication Services ────────────────────────
  const lockService = new LockService(cacheService, pubsub);
  const replicationService = new ReplicationService(pubsub);

  // ── Cluster ────────────────────────────────────────────
  const clusterService = new ClusterService(
    appConfig.cluster,
    cacheService,
    pubsub,
    replicationService,
  );

  // ── RBAC Service ───────────────────────────────────────
  let rbacService: RBACService | null = null;
  if (appConfig.rbac?.enabled) {
    const rbacDbDir = dirname(resolve(appConfig.rbac.dbPath));
    if (!existsSync(rbacDbDir)) mkdirSync(rbacDbDir, { recursive: true });
    rbacService = new RBACService(appConfig.rbac);
    setRBACService(rbacService);
    log.info("RBAC enabled", { dbPath: appConfig.rbac.dbPath });
  }

  // ── GraphQL ────────────────────────────────────────────
  const graphqlHandler = await createGraphQLHandler({
    cacheService,
    analyticsService: analytics,
    dbProxy,
    sqliteAdapter,
    queryCache,
  });

  // ── Routes ─────────────────────────────────────────────
  const router = new Router();

  // Health
  router.get("/health", () => {
    const stats = cacheService.stats();
    const memUsage = process.memoryUsage();

    // Measure Zig core latency with a no-op check
    const zigStart = performance.now();
    cacheService.has("__health_probe__");
    const zigLatencyMs = parseFloat((performance.now() - zigStart).toFixed(3));

    // Measure SQLite latency
    let sqliteStatus: { status: string; latencyMs?: number } = { status: "disabled" };
    if (sqliteAdapter) {
      try {
        const dbStart = performance.now();
        sqliteAdapter.count();
        const dbLatencyMs = parseFloat((performance.now() - dbStart).toFixed(3));
        sqliteStatus = { status: "up", latencyMs: dbLatencyMs };
      } catch {
        sqliteStatus = { status: "down" };
      }
    }

    return Response.json({
      status: "healthy",
      version: "0.4.0",
      uptime: parseFloat(process.uptime().toFixed(2)),
      checks: {
        zigCore: { status: "up", latencyMs: zigLatencyMs },
        sqlite: sqliteStatus,
        memory: {
          status: "ok",
          heapUsedMB: parseFloat((memUsage.heapUsed / 1024 / 1024).toFixed(2)),
          heapTotalMB: parseFloat((memUsage.heapTotal / 1024 / 1024).toFixed(2)),
          rssMB: parseFloat((memUsage.rss / 1024 / 1024).toFixed(2)),
        },
        cache: {
          status: "ok",
          entries: stats.currentSize,
          maxEntries: stats.maxSize,
          hitRate: parseFloat(stats.hitRate.toFixed(4)),
          memoryBytes: stats.memoryBytes,
        },
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Liveness probe — just confirms the process is alive
  router.get("/health/live", () =>
    Response.json({ status: "alive" })
  );

  // Readiness probe — verifies SQLite is writable
  router.get("/health/ready", async () => {
    if (sqliteAdapter) {
      try {
        // Verify SQLite is functional with a count operation
        await sqliteAdapter.count();
        return Response.json({ status: "ready" });
      } catch {
        return Response.json({ status: "not_ready", reason: "SQLite unavailable" }, { status: 503 });
      }
    }
    return Response.json({ status: "ready" });
  });

  // ── Cache CRUD ─────────────────────────────────────────

  router.get("/cache/:key", (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    const ns = new URL(req.url).searchParams.get("ns") ?? undefined;
    const value = cacheService.get(params.key, ns);
    if (value === null) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }
    return Response.json({ key: params.key, value });
  });

  router.post("/cache/:key", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { value?: unknown; ttl?: unknown; ns?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    const vv = validateValue(body.value);
    if (!vv.valid) return validationError(vv.error!);
    const tv = validateTTL(body.ttl);
    if (!tv.valid) return validationError(tv.error!);

    const ok = cacheService.set(
      params.key,
      body.value as string,
      body.ttl as number | undefined,
      body.ns ?? new URL(req.url).searchParams.get("ns") ?? undefined
    );
    return Response.json({ ok }, { status: ok ? 201 : 500 });
  });

  router.delete("/cache/:key", (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    const ns = new URL(req.url).searchParams.get("ns") ?? undefined;
    const deleted = cacheService.delete(params.key, ns);
    return Response.json({ deleted });
  });

  // ── Batch Operations ───────────────────────────────────

  router.post("/cache", async (req) => {
    let body: {
      action?: string;
      keys?: string[];
      entries?: Array<{ key: string; value: string; ttl?: number }>;
      ns?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (body.action === "mget" && Array.isArray(body.keys)) {
      const result = cacheService.mget(body.keys, body.ns);
      return Response.json({ result });
    }

    if (body.action === "mset" && Array.isArray(body.entries)) {
      for (const e of body.entries) {
        const ek = validateKey(e.key);
        if (!ek.valid) return validationError(`mset key error: ${ek.error}`);
        const ev = validateValue(e.value);
        if (!ev.valid) return validationError(`mset value error for "${e.key}": ${ev.error}`);
        if (e.ttl !== undefined) {
          const et = validateTTL(e.ttl);
          if (!et.valid) return validationError(`mset ttl error for "${e.key}": ${et.error}`);
        }
      }
      const count = cacheService.mset(body.entries, body.ns);
      return Response.json({ stored: count });
    }

    return validationError('Unknown action. Use "mget" or "mset".');
  });

  // ── Key Scanning ───────────────────────────────────────

  router.get("/keys", (req) => {
    const url = new URL(req.url);
    const pattern = url.searchParams.get("pattern") ?? "*";
    const ns = url.searchParams.get("ns") ?? undefined;
    const cursor = parseInt(url.searchParams.get("cursor") ?? "0", 10);
    const count = Math.min(
      parseInt(url.searchParams.get("count") ?? "100", 10),
      1000
    );
    const result = cacheService.keys(pattern, ns, cursor, count);
    return Response.json(result);
  });

  // ── Management ─────────────────────────────────────────

  router.get("/stats", () => {
    const stats = cacheService.stats();
    const latency = analytics.getLatencyStats();
    return Response.json({ cache: stats, latency });
  });

  router.get("/stats/history", () => {
    const count = 60;
    return Response.json({ snapshots: analytics.getHistory(count) });
  });

  router.post("/flush", () => {
    cacheService.clear();
    return Response.json({ flushed: true });
  });

  // On-demand snapshot save
  router.post("/snapshot", () => {
    const ok = persistence.save();
    return Response.json({ saved: ok });
  });

  // Download the latest snapshot file
  router.get("/snapshot/download", () => {
    const filePath = persistence.getFilePath();
    if (!existsSync(filePath)) {
      return Response.json({ error: "No snapshot file found" }, { status: 404 });
    }
    const data = readFileSync(filePath);
    return new Response(data, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=snapshot.json",
      },
    });
  });

  // Upload and restore a snapshot file
  router.post("/snapshot/upload", async (req) => {
    let snapshot: SnapshotData;
    try {
      snapshot = (await req.json()) as SnapshotData;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (
      typeof snapshot.version !== "number" ||
      typeof snapshot.timestamp !== "number" ||
      !Array.isArray(snapshot.entries)
    ) {
      return validationError("Invalid snapshot format: requires version, timestamp, and entries");
    }

    const restored = persistence.restoreFromSnapshot(snapshot);
    return Response.json({ restored: true, entriesCount: restored });
  });

  // Export all cache entries as JSON or CSV
  router.get("/export", (req) => {
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "json";
    const nsFilter = url.searchParams.get("ns") ?? undefined;

    const allEntries = cacheService.exportEntries();
    const NS_SEP = "\0";

    // Map raw entries to structured form, optionally filtering by namespace
    const mapped: Array<{ key: string; value: string; namespace: string }> = [];
    for (const e of allEntries) {
      const sepIdx = e.key.indexOf(NS_SEP);
      const entryNs = sepIdx >= 0 ? e.key.slice(0, sepIdx) : "";
      const entryKey = sepIdx >= 0 ? e.key.slice(sepIdx + 1) : e.key;

      if (nsFilter !== undefined && entryNs !== nsFilter) continue;
      mapped.push({ key: entryKey, value: e.value, namespace: entryNs });
    }

    if (format === "csv") {
      const csvEscape = (s: string) => '"' + s.replace(/"/g, '""') + '"';
      const lines = ["key,value,namespace"];
      for (const m of mapped) {
        lines.push(`${csvEscape(m.key)},${csvEscape(m.value)},${csvEscape(m.namespace)}`);
      }
      return new Response(lines.join("\n") + "\n", {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }

    return Response.json(mapped);
  });

  // Import cache entries from JSON
  router.post("/import", async (req) => {
    let body: { entries?: Array<{ key: string; value: string; ttl?: number; ns?: string }> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return validationError("entries (non-empty array) is required");
    }

    let imported = 0;
    for (const e of body.entries) {
      if (typeof e.key !== "string" || typeof e.value !== "string") continue;
      if (cacheService.set(e.key, e.value, e.ttl, e.ns)) imported++;
    }

    return Response.json({ imported });
  });

  router.get("/info", () =>
    Response.json({
      name: "dunena",
      version: "0.2.0",
      entries: cacheService.count(),
      uptime: process.uptime(),
      database: appConfig.database.enabled,
    })
  );

  // ── Database / Storage Endpoints ───────────────────────

  // SQLite direct key-value storage
  router.get("/db/:key", async (req, params) => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);
    const ns = new URL(req.url).searchParams.get("ns") ?? "";
    const entry = await sqliteAdapter.get(params.key, ns);
    if (!entry) return Response.json({ error: "Key not found" }, { status: 404 });
    return Response.json(entry);
  });

  router.post("/db/:key", async (req, params) => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);
    let body: { value?: unknown; ttl?: unknown; ns?: string; tags?: string[] };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }
    const vv = validateValue(body.value);
    if (!vv.valid) return validationError(vv.error!);
    const tv = validateTTL(body.ttl);
    if (!tv.valid) return validationError(tv.error!);
    const ns = body.ns ?? new URL(req.url).searchParams.get("ns") ?? "";
    const ok = await sqliteAdapter.set(params.key, body.value as string, {
      namespace: ns,
      ttl: body.ttl as number | undefined,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined,
    });
    return Response.json({ ok }, { status: ok ? 201 : 500 });
  });

  router.delete("/db/:key", async (req, params) => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);
    const ns = new URL(req.url).searchParams.get("ns") ?? "";
    const deleted = await sqliteAdapter.delete(params.key, ns);
    return Response.json({ deleted });
  });

  // SQLite batch operations
  router.post("/db", async (req) => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: {
      action?: string;
      keys?: string[];
      entries?: Array<{ key: string; value: string; ttl?: number; tags?: string[] }>;
      ns?: string;
      tags?: string[];
      pattern?: string;
      limit?: number;
      offset?: number;
      orderBy?: string;
      order?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    switch (body.action) {
      case "mget": {
        if (!Array.isArray(body.keys)) return validationError("keys must be an array");
        const result = await sqliteAdapter.mget(body.keys, body.ns ?? "");
        return Response.json({ result });
      }
      case "mset": {
        if (!Array.isArray(body.entries)) return validationError("entries must be an array");
        for (const e of body.entries) {
          const ek = validateKey(e.key);
          if (!ek.valid) return validationError(`mset key error: ${ek.error}`);
          const ev = validateValue(e.value);
          if (!ev.valid) return validationError(`mset value error for "${e.key}": ${ev.error}`);
        }
        const count = await sqliteAdapter.mset(body.entries, body.ns ?? "");
        return Response.json({ stored: count });
      }
      case "mdelete": {
        if (!Array.isArray(body.keys)) return validationError("keys must be an array");
        const deleted = await sqliteAdapter.mdelete(body.keys, body.ns ?? "");
        return Response.json({ deleted });
      }
      case "query": {
        const entries = await sqliteAdapter.query({
          namespace: body.ns,
          prefix: body.pattern,
          tags: body.tags,
          limit: body.limit,
          offset: body.offset,
          orderBy: body.orderBy as "key" | "createdAt" | "updatedAt" | undefined,
          order: body.order as "asc" | "desc" | undefined,
        });
        return Response.json({ entries, count: entries.length });
      }
      case "deleteByTags": {
        if (!Array.isArray(body.tags)) return validationError("tags must be an array");
        const deleted = await sqliteAdapter.deleteByTags(body.tags, body.ns);
        return Response.json({ deleted });
      }
      default:
        return validationError('Unknown action. Use "mget", "mset", "mdelete", "query", or "deleteByTags".');
    }
  });

  // Database stats
  router.get("/db-stats", async () => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const stats = await sqliteAdapter.stats();
    return Response.json(stats);
  });

  // Database keys listing
  router.get("/db-keys", async (req) => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const url = new URL(req.url);
    const pattern = url.searchParams.get("pattern") ?? "*";
    const ns = url.searchParams.get("ns") ?? undefined;
    const keys = await sqliteAdapter.keys(pattern, ns);
    return Response.json({ keys, count: keys.length });
  });

  // Database clear
  router.post("/db-clear", async (req) => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const url = new URL(req.url);
    const ns = url.searchParams.get("ns") ?? undefined;
    await sqliteAdapter.clear(ns);
    return Response.json({ cleared: true });
  });

  // Purge expired entries
  router.post("/db-purge", async () => {
    if (!sqliteAdapter) return Response.json({ error: "Database disabled" }, { status: 503 });
    const purged = await sqliteAdapter.purgeExpired();
    return Response.json({ purged });
  });

  // ── Query Cache Endpoints ──────────────────────────────

  // Specific routes must come before parameterized /:key
  router.get("/query-cache/stats", async () => {
    if (!queryCache) return Response.json({ error: "Database disabled" }, { status: 503 });
    const stats = await queryCache.fullStats();
    return Response.json(stats);
  });

  router.get("/query-cache/:key", async (_req, params) => {
    if (!queryCache) return Response.json({ error: "Database disabled" }, { status: 503 });
    const result = await queryCache.get(params.key);
    if (!result) return Response.json({ error: "Cache miss" }, { status: 404 });
    return Response.json(result);
  });

  router.post("/query-cache", async (req) => {
    if (!queryCache) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: { key?: string; data?: unknown; ttl?: number; tags?: string[] };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }
    if (!body.key || typeof body.key !== "string") return validationError("key is required");
    if (body.data === undefined) return validationError("data is required");
    await queryCache.set(body.key, body.data, { ttl: body.ttl, tags: body.tags });
    return Response.json({ cached: true, key: body.key }, { status: 201 });
  });

  router.post("/query-cache/invalidate", async (req) => {
    if (!queryCache) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: { tags?: string[]; key?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }
    if (body.key) {
      const ok = await queryCache.invalidate(body.key);
      return Response.json({ invalidated: ok ? 1 : 0 });
    }
    if (Array.isArray(body.tags) && body.tags.length > 0) {
      const count = await queryCache.invalidateByTags(body.tags);
      return Response.json({ invalidated: count });
    }
    return validationError("Provide either tags (array) or key (string)");
  });

  router.post("/query-cache/clear", async () => {
    if (!queryCache) return Response.json({ error: "Database disabled" }, { status: 503 });
    await queryCache.clear();
    return Response.json({ cleared: true });
  });

  // ── Database Proxy Endpoints ───────────────────────────

  router.get("/db-proxy/connectors", () => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    return Response.json({ connectors: dbProxy.list() });
  });

  router.post("/db-proxy/register", async (req) => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: DatabaseConnectorConfig;
    try {
      body = (await req.json()) as DatabaseConnectorConfig;
    } catch {
      return validationError("Invalid JSON body");
    }
    if (!body.name || !body.type || !body.connectionString) {
      return validationError("name, type, and connectionString are required");
    }
    if (!["postgresql", "mysql", "http", "mongodb", "redis", "elasticsearch"].includes(body.type)) {
      return validationError("type must be postgresql, mysql, http, mongodb, redis, or elasticsearch");
    }
    try {
      dbProxy.register(body);
      return Response.json({ registered: true, name: body.name }, { status: 201 });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 409 });
    }
  });

  router.post("/db-proxy/unregister", async (req) => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: { name?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }
    if (!body.name) return validationError("name is required");
    const ok = dbProxy.unregister(body.name);
    return Response.json({ unregistered: ok });
  });

  router.post("/db-proxy/query", async (req) => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: ProxyQueryRequest;
    try {
      body = (await req.json()) as ProxyQueryRequest;
    } catch {
      return validationError("Invalid JSON body");
    }
    if (!body.connector || !body.query) {
      return validationError("connector and query are required");
    }
    try {
      const result = await dbProxy.query(body);
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: String(err instanceof Error ? err.message : err) },
        { status: 502 }
      );
    }
  });

  router.post("/db-proxy/invalidate", async (req) => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    let body: { tags?: string[] };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }
    if (!Array.isArray(body.tags) || body.tags.length === 0) {
      return validationError("tags (non-empty array) is required");
    }
    const count = await dbProxy.invalidate(body.tags);
    return Response.json({ invalidated: count });
  });

  // Write-behind buffer stats
  router.get("/db-proxy/buffer/stats", () => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    const stats = dbProxy.getBufferStats();
    if (!stats) {
      return Response.json({ error: "Write-behind not enabled" }, { status: 404 });
    }
    return Response.json(stats);
  });

  // Write-behind buffer force-flush
  router.post("/db-proxy/buffer/flush", async () => {
    if (!dbProxy) return Response.json({ error: "Database disabled" }, { status: 503 });
    const result = await dbProxy.flushBuffer();
    if (!result) {
      return Response.json({ error: "Write-behind not enabled" }, { status: 404 });
    }
    return Response.json(result);
  });

  // ── Atomic Operations ──────────────────────────────────

  router.post("/cache/:key/incr", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { delta?: number; ns?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const ns = body.ns ?? new URL(req.url).searchParams.get("ns") ?? undefined;
    const delta = body.delta ?? 1;
    const result = cacheService.incr(params.key, delta, ns);

    if (result.ok) {
      return Response.json({ value: result.value });
    }
    return Response.json({ error: result.error }, { status: 400 });
  });

  router.post("/cache/:key/decr", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { delta?: number; ns?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const ns = body.ns ?? new URL(req.url).searchParams.get("ns") ?? undefined;
    const delta = body.delta ?? 1;
    const result = cacheService.decr(params.key, delta, ns);

    if (result.ok) {
      return Response.json({ value: result.value });
    }
    return Response.json({ error: result.error }, { status: 400 });
  });

  // ── Compare-and-Swap (CAS) ─────────────────────────────

  router.get("/cache/:key/version", (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    const ns = new URL(req.url).searchParams.get("ns") ?? undefined;
    const version = cacheService.getVersion(params.key, ns);

    if (version === 0) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }
    return Response.json({ key: params.key, version });
  });

  router.put("/cache/:key/cas", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { value?: unknown; expectedVersion?: number; ns?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    const vv = validateValue(body.value);
    if (!vv.valid) return validationError(vv.error!);

    if (typeof body.expectedVersion !== "number") {
      return validationError("expectedVersion is required and must be a number");
    }

    const ns = body.ns ?? new URL(req.url).searchParams.get("ns") ?? undefined;
    const result = cacheService.casPut(params.key, body.value as string, body.expectedVersion, ns);

    if (result.ok) {
      return Response.json({ ok: true, newVersion: result.newVersion });
    }
    return Response.json({ ok: false, error: result.error }, { status: 409 });
  });

  // ── TTL Operations ─────────────────────────────────────

  router.get("/cache/:key/ttl", (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    const ns = new URL(req.url).searchParams.get("ns") ?? undefined;
    const ttl = cacheService.ttl(params.key, ns);

    if (ttl === -2) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }
    return Response.json({ key: params.key, ttl, hasExpiry: ttl >= 0 });
  });

  router.post("/cache/:key/touch", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { ttl?: unknown; ns?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    const tv = validateTTL(body.ttl);
    if (!tv.valid) return validationError(tv.error!);

    if (typeof body.ttl !== "number" || body.ttl < 0) {
      return validationError("ttl is required and must be a non-negative number");
    }

    const ns = body.ns ?? new URL(req.url).searchParams.get("ns") ?? undefined;
    const ok = cacheService.touch(params.key, body.ttl, ns);

    if (ok) {
      return Response.json({ ok: true, ttl: body.ttl });
    }
    return Response.json({ error: "Key not found" }, { status: 404 });
  });

  // ── Cache Warmup ───────────────────────────────────────

  router.post("/cache/warmup", async (req) => {
    let body: { entries?: Array<{ key: string; value: string; ttl?: number; ns?: string }> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return validationError("entries (non-empty array) is required");
    }

    // Validate all entries first
    for (const e of body.entries) {
      const ek = validateKey(e.key);
      if (!ek.valid) return validationError(`warmup key error: ${ek.error}`);
      const ev = validateValue(e.value);
      if (!ev.valid) return validationError(`warmup value error for "${e.key}": ${ev.error}`);
      if (e.ttl !== undefined) {
        const et = validateTTL(e.ttl);
        if (!et.valid) return validationError(`warmup ttl error for "${e.key}": ${et.error}`);
      }
    }

    let loaded = 0;
    let failed = 0;
    for (const e of body.entries) {
      const ok = cacheService.set(e.key, e.value, e.ttl, e.ns);
      if (ok) loaded++;
      else failed++;
    }

    return Response.json({ loaded, failed, total: body.entries.length });
  });

  // ── Cache Info ─────────────────────────────────────────

  router.get("/cache/info", () => {
    const stats = cacheService.stats();
    return Response.json({
      evictionPolicy: cacheService.getEvictionPolicy(),
      memoryBytes: stats.memoryBytes,
      casHits: stats.casHits,
      casMisses: stats.casMisses,
      currentSize: stats.currentSize,
      maxSize: stats.maxSize,
    });
  });

  // ── Distributed Locks ──────────────────────────────────

  router.post("/locks/:key/acquire", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { owner?: string; ttl?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    if (!body.owner || typeof body.owner !== "string") {
      return validationError("owner is required");
    }

    const lock = lockService.acquire(params.key, body.owner, body.ttl);
    if (lock) {
      return Response.json({ acquired: true, lock }, { status: 201 });
    }
    return Response.json({ acquired: false, error: "Lock is already held" }, { status: 409 });
  });

  router.post("/locks/:key/release", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { owner?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!body.owner || typeof body.owner !== "string") {
      return validationError("owner is required");
    }

    const released = lockService.release(params.key, body.owner);
    return Response.json({ released });
  });

  router.post("/locks/:key/extend", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    let body: { owner?: string; ttl?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!body.owner || typeof body.owner !== "string") {
      return validationError("owner is required");
    }
    if (typeof body.ttl !== "number" || body.ttl <= 0) {
      return validationError("ttl must be a positive number");
    }

    const lock = lockService.extend(params.key, body.owner, body.ttl);
    if (lock) {
      return Response.json({ extended: true, lock });
    }
    return Response.json({ extended: false, error: "Lock not found or owner mismatch" }, { status: 404 });
  });

  router.get("/locks/:key", (_req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    const lock = lockService.getLock(params.key);
    if (lock) {
      return Response.json({ locked: true, lock });
    }
    return Response.json({ locked: false });
  });

  router.delete("/locks/:key", async (req, params) => {
    const kv = validateKey(params.key);
    if (!kv.valid) return validationError(kv.error!);

    // Force release (admin operation)
    const released = lockService.forceRelease(params.key);
    return Response.json({ forceReleased: released });
  });

  router.get("/locks", () => {
    const locks = lockService.listLocks();
    return Response.json({ locks, count: locks.length });
  });

  // ── Replication ────────────────────────────────────────

  router.get("/replication/status", () => {
    return Response.json({
      config: replicationService.getConfig(),
      stats: replicationService.getStats(),
    });
  });

  router.get("/replication/replicas", () => {
    return Response.json({ replicas: replicationService.listReplicas() });
  });

  router.post("/replication/replicas", async (req) => {
    let body: ReplicaConfig;
    try {
      body = (await req.json()) as ReplicaConfig;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!body.id || !body.url) {
      return validationError("id and url are required");
    }

    replicationService.addReplica({
      id: body.id,
      url: body.url,
      authToken: body.authToken,
      enabled: body.enabled ?? true,
      syncMode: body.syncMode ?? "async",
    });

    return Response.json({ added: true, id: body.id }, { status: 201 });
  });

  router.delete("/replication/replicas/:id", (_req, params) => {
    const removed = replicationService.removeReplica(params.id);
    return Response.json({ removed });
  });

  router.post("/replication/enable", () => {
    replicationService.setEnabled(true);
    return Response.json({ enabled: true });
  });

  router.post("/replication/disable", () => {
    replicationService.setEnabled(false);
    return Response.json({ enabled: false });
  });

  router.post("/replication/replicas/:id/enable", (_req, params) => {
    const ok = replicationService.setReplicaEnabled(params.id, true);
    if (ok) return Response.json({ enabled: true });
    return Response.json({ error: "Replica not found" }, { status: 404 });
  });

  router.post("/replication/replicas/:id/disable", (_req, params) => {
    const ok = replicationService.setReplicaEnabled(params.id, false);
    if (ok) return Response.json({ enabled: false });
    return Response.json({ error: "Replica not found" }, { status: 404 });
  });

  // ── Namespace Rate Limiting ────────────────────────────

  router.get("/rate-limits", () => {
    return Response.json({ limits: getNamespaceRateLimits() });
  });

  router.post("/rate-limits", async (req) => {
    let body: { namespace?: string; maxRequests?: number; windowMs?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!body.namespace || typeof body.namespace !== "string") {
      return validationError("namespace is required");
    }
    if (typeof body.maxRequests !== "number" || body.maxRequests <= 0) {
      return validationError("maxRequests must be a positive number");
    }
    if (typeof body.windowMs !== "number" || body.windowMs <= 0) {
      return validationError("windowMs must be a positive number");
    }

    configureNamespaceRateLimit({
      namespace: body.namespace,
      maxRequests: body.maxRequests,
      windowMs: body.windowMs,
    });

    return Response.json({ configured: true, namespace: body.namespace }, { status: 201 });
  });

  router.delete("/rate-limits/:namespace", (_req, params) => {
    const removed = removeNamespaceRateLimit(params.namespace);
    return Response.json({ removed });
  });

  router.get("/rate-limits/:namespace", (_req, params) => {
    const stats = getNamespaceRateLimitStats(params.namespace);
    if (!stats.config) {
      return Response.json({ error: "No rate limit configured for this namespace" }, { status: 404 });
    }
    return Response.json(stats);
  });

  // ── Admin: API Key Management ──────────────────────────

  router.post("/admin/keys", async (req) => {
    if (!rbacService) return Response.json({ error: "RBAC not enabled" }, { status: 503 });
    const permResp = checkPermission(req, "admin");
    if (permResp) return permResp;

    let body: { name?: string; permissions?: { read?: boolean; write?: boolean; delete?: boolean; admin?: boolean }; namespaces?: string[]; expiresAt?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return validationError("Invalid JSON body");
    }

    if (!body.name || typeof body.name !== "string") {
      return validationError("name is required");
    }
    if (!body.permissions || typeof body.permissions !== "object") {
      return validationError("permissions object is required");
    }

    const permissions = {
      read: body.permissions.read ?? false,
      write: body.permissions.write ?? false,
      delete: body.permissions.delete ?? false,
      admin: body.permissions.admin ?? false,
    };
    const namespaces = Array.isArray(body.namespaces) ? body.namespaces : ["*"];

    const result = await rbacService.createKey(body.name, permissions, namespaces, body.expiresAt);
    return Response.json(result, { status: 201 });
  });

  router.get("/admin/keys", async (req) => {
    if (!rbacService) return Response.json({ error: "RBAC not enabled" }, { status: 503 });
    const permResp = checkPermission(req, "admin");
    if (permResp) return permResp;

    const keys = await rbacService.listKeys();
    return Response.json({ keys });
  });

  router.get("/admin/keys/:id", async (req, params) => {
    if (!rbacService) return Response.json({ error: "RBAC not enabled" }, { status: 503 });
    const permResp = checkPermission(req, "admin");
    if (permResp) return permResp;

    const keyInfo = await rbacService.getKey(params.id);
    if (!keyInfo) return Response.json({ error: "Key not found" }, { status: 404 });
    return Response.json(keyInfo);
  });

  router.delete("/admin/keys/:id", async (req, params) => {
    if (!rbacService) return Response.json({ error: "RBAC not enabled" }, { status: 503 });
    const permResp = checkPermission(req, "admin");
    if (permResp) return permResp;

    const revoked = await rbacService.revokeKey(params.id);
    if (!revoked) return Response.json({ error: "Key not found" }, { status: 404 });
    return Response.json({ revoked: true, id: params.id });
  });

  // ── Prometheus Metrics ─────────────────────────────────

  router.get("/metrics", () => {
    const s = cacheService.stats();
    const latency = analytics.getLatencyStats();
    const lines = [
      "# HELP dunena_cache_hits_total Total cache hits",
      "# TYPE dunena_cache_hits_total counter",
      `dunena_cache_hits_total ${s.hits}`,
      "# HELP dunena_cache_misses_total Total cache misses",
      "# TYPE dunena_cache_misses_total counter",
      `dunena_cache_misses_total ${s.misses}`,
      "# HELP dunena_cache_evictions_total Total cache evictions",
      "# TYPE dunena_cache_evictions_total counter",
      `dunena_cache_evictions_total ${s.evictions}`,
      "# HELP dunena_cache_puts_total Total cache puts",
      "# TYPE dunena_cache_puts_total counter",
      `dunena_cache_puts_total ${s.puts}`,
      "# HELP dunena_cache_deletes_total Total cache deletes",
      "# TYPE dunena_cache_deletes_total counter",
      `dunena_cache_deletes_total ${s.deletes}`,
      "# HELP dunena_cache_entries Current number of entries",
      "# TYPE dunena_cache_entries gauge",
      `dunena_cache_entries ${s.currentSize}`,
      "# HELP dunena_cache_max_entries Maximum cache capacity",
      "# TYPE dunena_cache_max_entries gauge",
      `dunena_cache_max_entries ${s.maxSize}`,
      "# HELP dunena_cache_hit_rate Cache hit rate (0-1)",
      "# TYPE dunena_cache_hit_rate gauge",
      `dunena_cache_hit_rate ${s.hitRate}`,
      "# HELP dunena_cache_memory_bytes Memory used by cache entries",
      "# TYPE dunena_cache_memory_bytes gauge",
      `dunena_cache_memory_bytes ${s.memoryBytes}`,
      "# HELP dunena_cache_cas_hits_total Successful CAS operations",
      "# TYPE dunena_cache_cas_hits_total counter",
      `dunena_cache_cas_hits_total ${s.casHits}`,
      "# HELP dunena_cache_cas_misses_total Failed CAS operations (version mismatch)",
      "# TYPE dunena_cache_cas_misses_total counter",
      `dunena_cache_cas_misses_total ${s.casMisses}`,
      "# HELP dunena_locks_active Current number of active locks",
      "# TYPE dunena_locks_active gauge",
      `dunena_locks_active ${lockService.listLocks().length}`,
      "# HELP dunena_request_latency_ms Request latency in milliseconds",
      "# TYPE dunena_request_latency_ms summary",
      `dunena_request_latency_ms{quantile="0.5"} ${latency.p50.toFixed(3)}`,
      `dunena_request_latency_ms{quantile="0.95"} ${latency.p95.toFixed(3)}`,
      `dunena_request_latency_ms{quantile="0.99"} ${latency.p99.toFixed(3)}`,
      `dunena_request_latency_ms_sum ${(latency.mean * (latency.count || 1)).toFixed(3)}`,
      `dunena_request_latency_ms_count ${latency.count || 0}`,
      "# HELP dunena_uptime_seconds Server uptime in seconds",
      "# TYPE dunena_uptime_seconds gauge",
      `dunena_uptime_seconds ${process.uptime().toFixed(1)}`,
    ];
    return new Response(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  });

  // ── WebSocket handlers ─────────────────────────────────
  const wsHandlers = createWebSocketHandlers(cacheService);

  // Forward cache events → Bun WS topics so connected clients receive them
  pubsub.subscribe("cache", (msg) => {
    try {
      server.publish("cache-events", JSON.stringify(msg));
    } catch {
      /* server may not have started yet */
    }
  });

  // ── Bun.serve ──────────────────────────────────────────
  const dashboardPath = resolve(import.meta.dir, "../../public/dashboard.html");
  const apiDocsPath = resolve(import.meta.dir, "./api-docs.html");
  const openApiPath = resolve(import.meta.dir, "../../openapi.yaml");
  const docsDir = resolve(import.meta.dir, "../../docs");

  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".webp": "image/webp",
    ".yaml": "text/yaml",
    ".txt": "text/plain",
  };

  const server = Bun.serve<WebSocketData>({
    port: appConfig.server.port,
    hostname: appConfig.server.host,

    async fetch(req, server) {
      const start = performance.now();
      const url = new URL(req.url);
      const reqOrigin = req.headers.get("origin") ?? undefined;

      // CORS preflight
      const corsResp = handleCors(req, appConfig.server);
      if (corsResp) return corsResp;

      // WebSocket upgrade
      if (
        appConfig.server.enableWebSocket &&
        url.pathname === "/ws"
      ) {
        // Auth check for WebSocket
        const wsAuth = await authenticate(req, appConfig.server.authToken);
        if (wsAuth) return wsAuth;

        const upgraded = server.upgrade(req, {
          data: {
            subscribedChannels: new Set<string>(),
            connectedAt: Date.now(),
            id: "",
          } satisfies WebSocketData,
        });
        if (upgraded) return undefined as unknown as Response;
      }

      // Dashboard
      if (
        appConfig.server.enableDashboard &&
        url.pathname === "/dashboard"
      ) {
        return new Response(Bun.file(dashboardPath), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // API documentation (Redoc + OpenAPI spec)
      if (url.pathname === "/docs/redoc") {
        return new Response(Bun.file(apiDocsPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/docs/openapi.yaml") {
        if (existsSync(openApiPath)) {
          return new Response(Bun.file(openApiPath), {
            headers: { "Content-Type": "text/yaml" },
          });
        }
        return Response.json({ error: "OpenAPI spec not generated. Run: bun run docs:api" }, { status: 404 });
      }

      // Documentation site (Next.js static export)
      if (url.pathname === "/" || url.pathname.startsWith("/docs")) {
        // Redirection: / or /docs -> /docs/ (so relative assets resolve correctly)
        if (url.pathname === "/" || url.pathname === "/docs") {
          return Response.redirect(url.origin + "/docs/", 301);
        }

        let rel = url.pathname.slice(5); // strip "/docs"
        if (rel.startsWith("/")) rel = rel.slice(1);

        let filePath: string;
        if (rel === "" || rel === "/") {
          // /docs/ → index.html
          filePath = resolve(docsDir, "index.html");
        } else if (rel.includes(".")) {
          // Has extension — serve as-is (e.g. _next/static/..., logo.svg, openapi.yaml)
          filePath = resolve(docsDir, rel);
        } else {
          // No extension — try .html (e.g. getting-started → getting-started.html)
          filePath = resolve(docsDir, rel + ".html");
        }

        // Guard against path traversal — resolved path must stay within docsDir
        const normalised = resolve(filePath);
        if (!normalised.startsWith(docsDir)) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        if (existsSync(normalised)) {
          const ext = "." + normalised.split(".").pop();
          const mime = MIME_TYPES[ext] ?? "application/octet-stream";
          return new Response(Bun.file(normalised), { headers: { "Content-Type": mime } });
        }
      }

      // Auth
      const authResp = await authenticate(req, appConfig.server.authToken);
      if (authResp && !url.pathname.startsWith("/health") && !url.pathname.startsWith("/health/")) return authResp;

      // Body size check
      const bodyResp = checkBodySize(req);
      if (bodyResp) return bodyResp;

      // Rate limiting (global)
      const rlResp = rateLimit(req, appConfig.server);
      if (rlResp) return rlResp;

      // Namespace rate limiting - extract namespace from query params or body
      const nsParam = url.searchParams.get("ns");
      if (nsParam) {
        const nsRlResp = namespaceRateLimit(req, nsParam);
        if (nsRlResp) return nsRlResp;
      }

      // GraphQL Endpoint
      if (graphqlHandler && url.pathname === "/graphql") {
        if (req.method === "OPTIONS") {
          return new Response(null, { headers: corsHeaders(appConfig.server, reqOrigin) });
        }
        return graphqlHandler(req);
      }

      // ── Internal cluster endpoints (no auth) ──────────
      if (url.pathname.startsWith("/_cluster/")) {
        if (req.method === "POST" && url.pathname === "/_cluster/message") {
          const msg = await req.json();
          const result = clusterService.handleMessage(msg);
          return Response.json(result);
        }
        if (req.method === "POST" && url.pathname === "/_cluster/join") {
          const msg = await req.json();
          const result = clusterService.handleMessage(msg);
          return Response.json(result);
        }
        if (req.method === "GET" && url.pathname === "/_cluster/stats") {
          return Response.json(clusterService.getStats());
        }
        if (req.method === "GET" && url.pathname === "/_cluster/members") {
          return Response.json({ members: clusterService.getMembers() });
        }
        return Response.json({ error: "Unknown cluster endpoint" }, { status: 404 });
      }

      // Router
      const match = router.match(req.method, url.pathname);
      if (!match) {
        const resp = Response.json(
          { error: "Not found" },
          {
            status: 404,
            headers: corsHeaders(appConfig.server, reqOrigin),
          }
        );
        logRequest(req, url, 404, performance.now() - start);
        return resp;
      }

      analytics.recordRequest();

      try {
        const result = match.handler(req, match.params);
        const respond = (resp: Response) => {
          const duration = performance.now() - start;
          analytics.recordLatency(duration);
          // Build new response with CORS headers (Response.json headers may be immutable)
          const hdrs = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders(appConfig.server, reqOrigin))) {
            hdrs.set(k, v);
          }
          logRequest(req, url, resp.status, duration);
          return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: hdrs,
          });
        };

        if (result instanceof Promise) {
          return result.then(respond).catch((err) => {
            const duration = performance.now() - start;
            log.error("Handler error", { error: String(err) });
            logRequest(req, url, 500, duration);
            return Response.json(
              { error: "Internal server error" },
              { status: 500, headers: corsHeaders(appConfig.server, reqOrigin) }
            );
          });
        }
        return respond(result);
      } catch (err) {
        const duration = performance.now() - start;
        log.error("Handler error", { error: String(err) });
        logRequest(req, url, 500, duration);
        return Response.json(
          { error: "Internal server error" },
          { status: 500, headers: corsHeaders(appConfig.server, reqOrigin) }
        );
      }
    },

    websocket: wsHandlers,
  });

  // ── Startup Banner ──────────────────────────────────────
  const host = server.hostname;
  const port = server.port;
  const baseUrl = `http://${host}:${port}`;

  const banner = [
    "",
    "  ╔══════════════════════════════════════════╗",
    "  ║          Dunena v0.4.0                   ║",
    "  ║    High-Performance Cache Engine          ║",
    "  ║    Zig Core + Bun/TypeScript              ║",
    "  ╚══════════════════════════════════════════╝",
    "",
    `  🌐 Server:       ${baseUrl}`,
    `  📖 Docs:         ${baseUrl}/docs`,
    `  📘 REST API:     ${baseUrl}/docs/api`,
    `  📙 Redoc API:    ${baseUrl}/docs/redoc`,
  ];

  if (appConfig.server.enableDashboard)
    banner.push(`  📊 Dashboard:    ${baseUrl}/dashboard`);
  if (appConfig.server.enableWebSocket)
    banner.push(`  🔌 WebSocket:    ws://${host}:${port}/ws`);
  banner.push(`  📈 Metrics:      ${baseUrl}/metrics`);
  banner.push(`  ❤️  Health:       ${baseUrl}/health`);

  banner.push("");
  banner.push("  Features:");

  const features: string[] = [];
  if (appConfig.database.enabled) features.push("SQLite DB");
  if (appConfig.cache.enableBloomFilter) features.push("Bloom Filter");
  if ((appConfig.cache.compressionThreshold ?? 0) > 0) features.push("Compression");
  if (appConfig.persistence.enabled) features.push("Persistence");
  if (appConfig.server.enableWebSocket) features.push("WebSocket");
  if (appConfig.server.enableDashboard) features.push("Dashboard");
  if (appConfig.server.authToken) features.push("Auth");
  if (appConfig.telemetry.enabled) features.push("OpenTelemetry");
  if (graphqlHandler) features.push("GraphQL");
  if (appConfig.cluster.enabled) features.push("Cluster");
  if (appConfig.rbac?.enabled) features.push("RBAC");
  banner.push(`  ✅ ${features.join(" · ")}`);

  if (appConfig.database.enabled)
    banner.push(`  💾 SQLite: ${appConfig.database.sqlitePath}`);

  banner.push("");
  banner.push("  Quick test:");
  banner.push(`  curl -X POST ${baseUrl}/cache/hello -H "Content-Type: application/json" -d '{"value":"world"}'`);
  banner.push(`  curl ${baseUrl}/cache/hello`);
  banner.push("");

  log.info(banner.join("\n"));

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down\u2026");
    clusterService.stop();
    clearInterval(snapshotInterval);
    if (purgeInterval) clearInterval(purgeInterval);
    persistence.stop();
    if (appConfig.persistence.saveOnShutdown) {
      persistence.save();
    }
    if (sqliteAdapter) await sqliteAdapter.close();
    if (dbProxy) await dbProxy.stopWriteBehind();
    if (rbacService) await rbacService.close();
    cacheService.destroy();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start cluster after server is listening
  if (appConfig.cluster.enabled) {
    clusterService.start(appConfig.server.host, appConfig.server.port);
  }

  return { server, cacheService, analytics, pubsub, persistence, sqliteAdapter, queryCache, dbProxy, clusterService, rbacService };
}
