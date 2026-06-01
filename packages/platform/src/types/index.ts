// ── Cache Types ────────────────────────────────────────────

export type EvictionPolicy = "lru" | "lfu" | "arc";

export type { ClusterConfig } from "../cluster/types";

export interface CacheConfig {
  maxEntries: number;
  defaultTTL?: number;
  enableBloomFilter?: boolean;
  bloomFilterSize?: number;
  bloomFilterHashes?: number;
  compressionThreshold?: number;
  evictionPolicy?: EvictionPolicy;
}

export interface PersistenceConfig {
  enabled: boolean;
  filePath: string;
  intervalMs: number;
  saveOnShutdown: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  puts: number;
  deletes: number;
  currentSize: number;
  maxSize: number;
  hitRate: number;
  memoryBytes: number;
  casHits: number;
  casMisses: number;
}

// ── Server Types ───────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  enableWebSocket: boolean;
  enableDashboard: boolean;
  authToken?: string;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  cors: {
    origins: string[];
    methods: string[];
  };
}

export interface AppConfig {
  cache: CacheConfig;
  server: ServerConfig;
  persistence: PersistenceConfig;
  database: DatabaseConfig;
  rbac?: RBACConfig;
  log: {
    level: "debug" | "info" | "warn" | "error";
    format: "text" | "json";
  };
  telemetry: {
    enabled: boolean;
    endpoint: string;
    serviceName: string;
    serviceVersion: string;
    environment?: string;
  };
  cluster: import("../cluster/types").ClusterConfig;
}

export interface DatabaseConfig {
  enabled: boolean;
  sqlitePath: string;
  queryCacheTTL: number;  // default TTL for query cache entries (ms)
  purgeIntervalMs: number; // how often to purge expired DB entries
  writeBehind?: WriteBehindConfig;
}

// ── RBAC Types ─────────────────────────────────────────────

export interface RBACConfig {
  enabled: boolean;
  dbPath: string;
  adminKey?: string;
}

export interface ApiKeyPermissions {
  read: boolean;
  write: boolean;
  delete: boolean;
  admin: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  permissions: ApiKeyPermissions;
  namespaces: string[];
  createdAt: number;
  expiresAt: number | null;
  active: boolean;
  lastUsedAt: number | null;
}

// Write-Behind Buffer
export interface WriteBehindConfig {
  enabled: boolean;
  flushIntervalMs: number;    // default 1000
  maxBufferSize: number;      // default 1000
  retryAttempts: number;      // default 3
  retryDelayMs: number;       // default 500
}

// ── Pub/Sub Types ──────────────────────────────────────────

export interface PubSubMessage {
  channel: string;
  event: string;
  data: unknown;
  timestamp: number;
}

// ── Analytics Types ────────────────────────────────────────

export interface AnalyticsSnapshot {
  timestamp: number;
  stats: CacheStats;
  requestsPerSecond: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
}

// ── HTTP Types ─────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type HandlerFn = (
  req: Request,
  params: Record<string, string>
) => Promise<Response> | Response;

export interface RouteHandler {
  method: HttpMethod;
  path: string;
  handler: HandlerFn;
}

// ── WebSocket Types ────────────────────────────────────────

export interface WebSocketData {
  subscribedChannels: Set<string>;
  connectedAt: number;
  id: string;
}

export interface WSIncomingMessage {
  type: "subscribe" | "unsubscribe" | "ping" | "get" | "set" | "del" | "mget" | "mset";
  channel?: string;
  key?: string;
  value?: string;
  ns?: string;
  ttl?: number;
  keys?: string[];
  entries?: Array<{ key: string; value: string; ttl?: number }>;
}

export interface WSOutgoingMessage {
  type: string;
  data?: unknown;
  timestamp: number;
}

// ── Distributed Lock Types ─────────────────────────────────

export interface Lock {
  key: string;
  owner: string;
  acquiredAt: number;
  expiresAt: number;
  ttl: number;
}

export interface LockConfig {
  defaultTTL: number; // Default lock TTL in ms
  maxTTL: number;     // Maximum allowed TTL
  retryDelay: number; // Delay between retry attempts
  maxRetries: number; // Max retry attempts for acquiring lock
}

// ── Replication Types ──────────────────────────────────────

export interface ReplicaConfig {
  id: string;
  url: string;
  authToken?: string;
  enabled: boolean;
  syncMode: "async" | "sync";
}

export interface ReplicationConfig {
  enabled: boolean;
  replicas: ReplicaConfig[];
  retryAttempts: number;
  retryDelayMs: number;
}

export interface ReplicationStats {
  replicaId: string;
  lastSyncAt: number;
  syncCount: number;
  errorCount: number;
  lastError?: string;
}

// ── Rate Limiting Types ────────────────────────────────────

export interface NamespaceRateLimitConfig {
  namespace: string;
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitConfig {
  global: {
    windowMs: number;
    maxRequests: number;
  };
  perNamespace: NamespaceRateLimitConfig[];
}

// ── Warmup Types ───────────────────────────────────────────

export interface WarmupEntry {
  key: string;
  value: string;
  ttl?: number;
  ns?: string;
}
