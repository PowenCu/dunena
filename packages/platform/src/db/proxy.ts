// ── Database Proxy ─────────────────────────────────────────
// Connects Dunena as a caching proxy in front of external
// databases. Supports PostgreSQL, MySQL, MongoDB, Redis,
// Elasticsearch, and generic HTTP APIs.
// Queries flow through the QueryCacheService for automatic
// result caching and tag-based invalidation.

import type { QueryCacheService } from "./query-cache";
import { WriteBehindBuffer } from "./write-behind-buffer";
import type { WriteBehindConfig, WriteBehindStats } from "./write-behind-buffer";
import { logger } from "../utils/logger";

const log = logger.child("db-proxy");

// ── Connector Types ────────────────────────────────────────

export type DatabaseType = "postgresql" | "mysql" | "http" | "mongodb" | "redis" | "elasticsearch";

export interface DatabaseConnectorConfig {
  type: DatabaseType;
  name: string;           // unique identifier for this connection
  connectionString: string;  // DSN or URL
  readOnly?: boolean;
  maxCacheTTL?: number;   // max TTL for cached queries (ms)
  defaultTags?: string[]; // default tags applied to all cached queries
}

export interface ProxyQueryRequest {
  connector: string;      // name of the registered connector
  query: string;          // SQL query or HTTP endpoint
  params?: unknown[];     // parameterised query params  
  cacheKey?: string;      // custom cache key (auto-generated if omitted)
  ttl?: number;           // cache TTL override
  tags?: string[];        // cache invalidation tags
  skipCache?: boolean;    // force bypass cache
}

export interface ProxyQueryResult {
  data: unknown;
  cached: boolean;
  connector: string;
  durationMs: number;
  cacheKey: string;
}

// ── HTTP Database Connector ────────────────────────────────
// Forwards queries to an external HTTP-based database API
// (e.g., Supabase REST, PlanetScale HTTP, Turso, Neon serverless, etc.)

export class HttpDatabaseConnector {
  private config: DatabaseConnectorConfig;

  constructor(config: DatabaseConnectorConfig) {
    if (config.type !== "http") {
      throw new Error(`HttpDatabaseConnector requires type=http, got ${config.type}`);
    }
    this.config = config;
    log.info("HTTP database connector registered", { name: config.name, url: config.connectionString });
  }

  async execute(query: string, params?: unknown[]): Promise<unknown> {
    const url = this.config.connectionString;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, params }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP database query failed (${response.status}): ${text}`);
    }

    return response.json();
  }
}

// ── Elasticsearch Connector ────────────────────────────────
// Uses the Elasticsearch REST API via fetch (zero dependencies).

export class ElasticsearchConnector {
  private config: DatabaseConnectorConfig;

  constructor(config: DatabaseConnectorConfig) {
    if (config.type !== "elasticsearch") {
      throw new Error(`ElasticsearchConnector requires type=elasticsearch, got ${config.type}`);
    }
    this.config = config;
    log.info("Elasticsearch connector registered", { name: config.name, url: config.connectionString });
  }

  async execute(query: string, _params?: unknown[]): Promise<unknown> {
    // query is expected to be a JSON search body or an endpoint path
    const baseUrl = this.config.connectionString.replace(/\/$/, "");
    let url: string;
    let body: string | undefined;

    try {
      // If query is valid JSON, treat it as a search body
      JSON.parse(query);
      url = `${baseUrl}/_search`;
      body = query;
    } catch {
      // Otherwise treat it as a path (e.g., "/my-index/_search")
      url = `${baseUrl}${query.startsWith("/") ? query : "/" + query}`;
    }

    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Elasticsearch query failed (${response.status}): ${text}`);
    }

    return response.json();
  }
}

// ── MongoDB Connector ──────────────────────────────────────
// Uses the `mongodb` npm package (optional peer dependency).
// Install with: bun add mongodb

export class MongoDBConnector {
  private config: DatabaseConnectorConfig;
  private client: any = null;
  private db: any = null;

  constructor(config: DatabaseConnectorConfig) {
    if (config.type !== "mongodb") {
      throw new Error(`MongoDBConnector requires type=mongodb, got ${config.type}`);
    }
    this.config = config;
    log.info("MongoDB connector registered", { name: config.name });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    try {
      const { MongoClient } = await import("mongodb");
      this.client = new MongoClient(this.config.connectionString);
      await this.client.connect();
      // Extract database name from connection string or use default
      const url = new URL(this.config.connectionString);
      const dbName = url.pathname.slice(1) || "dunena";
      this.db = this.client.db(dbName);
    } catch (err) {
      if ((err as any)?.code === "ERR_MODULE_NOT_FOUND" || (err as any)?.code === "MODULE_NOT_FOUND") {
        throw new Error(
          'MongoDB connector requires the "mongodb" package. Install with: bun add mongodb'
        );
      }
      throw err;
    }
  }

  async execute(query: string, params?: unknown[]): Promise<unknown> {
    await this.ensureConnected();
    // query format: "collection.method" (e.g., "users.find", "users.insertOne")
    // params[0] is the filter/document, params[1] is options
    const [collectionName, method] = query.split(".");
    if (!collectionName || !method) {
      throw new Error('MongoDB query format: "collection.method" (e.g., "users.find")');
    }
    const collection = this.db.collection(collectionName);
    const arg1 = params?.[0] ?? {};
    const arg2 = params?.[1] ?? {};
    const result = await collection[method](arg1, arg2);
    // Handle cursor results (find returns a cursor)
    if (result && typeof result.toArray === "function") {
      return result.toArray();
    }
    return result;
  }
}

// ── Redis Connector ────────────────────────────────────────
// Uses the `ioredis` npm package (optional peer dependency).
// Install with: bun add ioredis

export class RedisConnector {
  private config: DatabaseConnectorConfig;
  private client: any = null;

  constructor(config: DatabaseConnectorConfig) {
    if (config.type !== "redis") {
      throw new Error(`RedisConnector requires type=redis, got ${config.type}`);
    }
    this.config = config;
    log.info("Redis connector registered", { name: config.name });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    try {
      const Redis = (await import("ioredis")).default;
      this.client = new Redis(this.config.connectionString);
    } catch (err) {
      if ((err as any)?.code === "ERR_MODULE_NOT_FOUND" || (err as any)?.code === "MODULE_NOT_FOUND") {
        throw new Error(
          'Redis connector requires the "ioredis" package. Install with: bun add ioredis'
        );
      }
      throw err;
    }
  }

  async execute(query: string, params?: unknown[]): Promise<unknown> {
    await this.ensureConnected();
    // query is a Redis command (e.g., "GET", "SET", "HGETALL")
    // params are the command arguments
    const args = params ?? [];
    return this.client.call(query.toUpperCase(), ...args);
  }
}

// ── SQL Connector (PostgreSQL / MySQL via HTTP bridge) ─────
// In Bun, we can use pg or mysql2 native drivers. However, to
// keep this zero-dependency, we support SQL databases through
// a generic HTTP bridge pattern — you run a sidecar that
// exposes your DB as an HTTP endpoint.

export class SqlDatabaseConnector {
  private config: DatabaseConnectorConfig;

  constructor(config: DatabaseConnectorConfig) {
    this.config = config;
    log.info("SQL database connector registered", {
      name: config.name,
      type: config.type,
    });
  }

  /**
   * Execute a query by posting to the connection string URL.
   * The URL should point to a database HTTP bridge that accepts
   * { query, params } and returns rows.
   */
  async execute(query: string, params?: unknown[]): Promise<unknown> {
    const response = await fetch(this.config.connectionString, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: this.config.type,
        query,
        params: params ?? [],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${this.config.type} query failed (${response.status}): ${text}`);
    }

    return response.json();
  }
}

// ── Connector Registry ─────────────────────────────────────

// (AnyConnector kept for backward compatibility — use AnyConnectorExtended internally)
type AnyConnector = HttpDatabaseConnector | SqlDatabaseConnector | ElasticsearchConnector | MongoDBConnector | RedisConnector;

type AnyConnectorExtended = HttpDatabaseConnector | SqlDatabaseConnector | ElasticsearchConnector | MongoDBConnector | RedisConnector;

function createConnector(config: DatabaseConnectorConfig): AnyConnectorExtended {
  switch (config.type) {
    case "http":
      return new HttpDatabaseConnector(config);
    case "postgresql":
    case "mysql":
      return new SqlDatabaseConnector(config);
    case "elasticsearch":
      return new ElasticsearchConnector(config);
    case "mongodb":
      return new MongoDBConnector(config);
    case "redis":
      return new RedisConnector(config);
    default:
      throw new Error(`Unknown database type: ${config.type}`);
  }
}

// ── Database Proxy Service ─────────────────────────────────

export class DatabaseProxy {
  private connectors = new Map<string, { connector: AnyConnector; config: DatabaseConnectorConfig }>();
  private queryCache: QueryCacheService;
  private writeBehindBuffer: WriteBehindBuffer | null = null;
  private writeBehindEnabled: boolean = false;

  constructor(queryCache: QueryCacheService, writeBehindConfig?: WriteBehindConfig) {
    this.queryCache = queryCache;

    if (writeBehindConfig?.enabled) {
      this.writeBehindBuffer = new WriteBehindBuffer(
        writeBehindConfig,
        (connectorName, query, params) => this.executeRaw(connectorName, query, params),
      );
      this.writeBehindEnabled = true;
      log.info("Write-behind mode enabled for database proxy");
    }
  }

  /**
   * Register a database connector.
   */
  register(config: DatabaseConnectorConfig): void {
    if (this.connectors.has(config.name)) {
      throw new Error(`Connector "${config.name}" is already registered`);
    }
    const connector = createConnector(config);
    this.connectors.set(config.name, { connector, config });
  }

  /**
   * Unregister a connector.
   */
  unregister(name: string): boolean {
    return this.connectors.delete(name);
  }

  /**
   * List all registered connectors.
   */
  list(): Array<{ name: string; type: DatabaseType; readOnly: boolean }> {
    return Array.from(this.connectors.entries()).map(([name, { config }]) => ({
      name,
      type: config.type,
      readOnly: config.readOnly ?? false,
    }));
  }

  /**
   * Execute a query through the proxy. Automatically caches
   * results unless skipCache is set.
   */
  async query(request: ProxyQueryRequest): Promise<ProxyQueryResult> {
    const entry = this.connectors.get(request.connector);
    if (!entry) {
      throw new Error(`Unknown connector: "${request.connector}"`);
    }

    const { connector, config } = entry;
    const cacheKey = request.cacheKey ?? this.generateCacheKey(request);
    const tags = [...(config.defaultTags ?? []), ...(request.tags ?? [])];

    // Check cache first (unless explicitly skipped)
    if (!request.skipCache) {
      const cached = await this.queryCache.get(cacheKey);
      if (cached) {
        return {
          data: cached.data,
          cached: true,
          connector: request.connector,
          durationMs: 0,
          cacheKey,
        };
      }
    }

    // Execute the real query
    const start = performance.now();

    // Route mutations through write-behind buffer if enabled
    if (this.writeBehindEnabled && this.writeBehindBuffer && this.isMutation(request.query)) {
      this.writeBehindBuffer.add(request.connector, request.query, request.params);
      const durationMs = performance.now() - start;
      return {
        data: { buffered: true, message: "Write queued for async execution" },
        cached: false,
        connector: request.connector,
        durationMs,
        cacheKey,
      };
    }

    const data = await connector.execute(request.query, request.params);
    const durationMs = performance.now() - start;

    // Enforce read-only
    if (config.readOnly && this.isMutation(request.query)) {
      throw new Error(`Connector "${request.connector}" is read-only`);
    }

    // Cache the result
    if (!request.skipCache) {
      const ttl = Math.min(
        request.ttl ?? config.maxCacheTTL ?? 60_000,
        config.maxCacheTTL ?? Infinity
      );
      await this.queryCache.set(cacheKey, data, { ttl, tags });
    }

    return {
      data,
      cached: false,
      connector: request.connector,
      durationMs,
      cacheKey,
    };
  }

  /**
   * Invalidate all cached queries tagged with the given tags.
   */
  async invalidate(tags: string[]): Promise<number> {
    return this.queryCache.invalidateByTags(tags);
  }

  private generateCacheKey(request: ProxyQueryRequest): string {
    const parts = [request.connector, request.query];
    if (request.params?.length) {
      parts.push(JSON.stringify(request.params));
    }
    // Simple FNV-1a-like hash for short, collision-resistant keys
    let hash = 2166136261;
    const str = parts.join("|");
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return `qc_${hash.toString(36)}`;
  }

  private isMutation(query: string): boolean {
    const upper = query.trimStart().toUpperCase();
    return upper.startsWith("INSERT") ||
           upper.startsWith("UPDATE") ||
           upper.startsWith("DELETE") ||
           upper.startsWith("DROP") ||
           upper.startsWith("ALTER") ||
           upper.startsWith("CREATE") ||
           upper.startsWith("TRUNCATE");
  }

  // ── Write-Behind Lifecycle ─────────────────────────────

  /**
   * Execute a query directly against a connector (bypassing cache).
   * Used as the executeFn callback for the WriteBehindBuffer.
   */
  private async executeRaw(connectorName: string, query: string, params?: unknown[]): Promise<unknown> {
    const entry = this.connectors.get(connectorName);
    if (!entry) {
      throw new Error(`Unknown connector: "${connectorName}"`);
    }
    return entry.connector.execute(query, params);
  }

  /**
   * Start the write-behind flush interval.
   */
  startWriteBehind(): void {
    this.writeBehindBuffer?.start();
  }

  /**
   * Stop the write-behind buffer and perform a final flush.
   */
  async stopWriteBehind(): Promise<void> {
    await this.writeBehindBuffer?.stop();
  }

  /**
   * Get write-behind buffer statistics.
   * Returns null if write-behind is not configured.
   */
  getBufferStats(): WriteBehindStats | null {
    return this.writeBehindBuffer?.getStats() ?? null;
  }

  /**
   * Force-flush all pending write-behind entries.
   * Returns null if write-behind is not configured.
   */
  async flushBuffer(): Promise<{ flushed: number; failed: number } | null> {
    if (!this.writeBehindBuffer) return null;
    return this.writeBehindBuffer.flush();
  }

  /**
   * Whether write-behind mode is currently enabled.
   */
  isWriteBehindEnabled(): boolean {
    return this.writeBehindEnabled;
  }
}
