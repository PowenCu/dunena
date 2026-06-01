// ── Configuration ──────────────────────────────────────────
import type { AppConfig } from "../types";

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

export function loadConfig(): AppConfig {
  return {
    cache: {
      maxEntries: envInt("DUNENA_MAX_ENTRIES", 100_000),
      defaultTTL: envInt("DUNENA_DEFAULT_TTL", 0),
      enableBloomFilter: envBool("DUNENA_BLOOM_FILTER", true),
      bloomFilterSize: envInt("DUNENA_BLOOM_SIZE", 1_000_000),
      bloomFilterHashes: envInt("DUNENA_BLOOM_HASHES", 7),
      compressionThreshold: envInt("DUNENA_COMPRESSION_THRESHOLD", 0),
    },
    server: {
      port: envInt("DUNENA_PORT", 3000),
      host: env("DUNENA_HOST", "127.0.0.1"),
      enableWebSocket: envBool("DUNENA_WS", true),
      enableDashboard: envBool("DUNENA_DASHBOARD", true),
      authToken: process.env.DUNENA_AUTH_TOKEN,
      rateLimit: {
        windowMs: envInt("DUNENA_RATE_WINDOW", 60_000),
        maxRequests: envInt("DUNENA_RATE_MAX", 1000),
      },
      cors: {
        origins: env("DUNENA_CORS_ORIGINS", "*").split(","),
        methods: ["GET", "POST", "PUT", "DELETE"],
      },
    },
    persistence: {
      enabled: envBool("DUNENA_PERSIST", false),
      filePath: env("DUNENA_PERSIST_PATH", "./data/dunena-snapshot.json"),
      intervalMs: envInt("DUNENA_PERSIST_INTERVAL", 300_000), // 5 min
      saveOnShutdown: envBool("DUNENA_PERSIST_ON_SHUTDOWN", true),
    },
    database: {
      enabled: envBool("DUNENA_DB", true),
      sqlitePath: env("DUNENA_DB_PATH", "./data/dunena.db"),
      queryCacheTTL: envInt("DUNENA_QUERY_CACHE_TTL", 60_000),
      purgeIntervalMs: envInt("DUNENA_DB_PURGE_INTERVAL", 60_000),
    },
    log: {
      level: validateLogLevel(env("DUNENA_LOG_LEVEL", "info")),
      format: validateLogFormat(env("DUNENA_LOG_FORMAT", "text")),
    },
    telemetry: {
      enabled: envBool("DUNENA_OTEL_ENABLED", false),
      endpoint: env("DUNENA_OTEL_ENDPOINT", "http://localhost:4318"),
      serviceName: env("DUNENA_OTEL_SERVICE_NAME", "dunena"),
      serviceVersion: "0.3.1",
      environment: process.env.NODE_ENV,
    },
    cluster: {
      enabled: envBool("DUNENA_CLUSTER_ENABLED", false),
      nodeId: env("DUNENA_CLUSTER_NODE_ID", `node-${process.pid}`),
      seeds: env("DUNENA_CLUSTER_SEEDS", "").split(",").filter(Boolean),
      heartbeatIntervalMs: envInt("DUNENA_CLUSTER_HEARTBEAT_MS", 2000),
      suspectTimeoutMs: envInt("DUNENA_CLUSTER_SUSPECT_TIMEOUT_MS", 6000),
      deadTimeoutMs: envInt("DUNENA_CLUSTER_DEAD_TIMEOUT_MS", 15000),
      electionTimeoutMs: envInt("DUNENA_CLUSTER_ELECTION_TIMEOUT_MS", 5000),
      priority: envInt("DUNENA_CLUSTER_PRIORITY", 100),
      localReads: envBool("DUNENA_CLUSTER_LOCAL_READS", true),
    },
    rbac: {
      enabled: envBool("DUNENA_RBAC_ENABLED", false),
      dbPath: env("DUNENA_RBAC_DB_PATH", "./data/rbac.sqlite"),
      adminKey: process.env.DUNENA_RBAC_ADMIN_KEY,
    },
  };
}

function validateLogLevel(v: string): AppConfig["log"]["level"] {
  const valid = ["debug", "info", "warn", "error"] as const;
  return valid.includes(v as typeof valid[number]) ? (v as typeof valid[number]) : "info";
}

function validateLogFormat(v: string): AppConfig["log"]["format"] {
  return v === "json" ? "json" : "text";
}

export const config = loadConfig();
