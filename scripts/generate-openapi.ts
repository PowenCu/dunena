#!/usr/bin/env bun
// ── OpenAPI 3.0.3 Specification Generator for Dunena ─────────────────────────
// Usage: bun run scripts/generate-openapi.ts [output-path]
// Default output: packages/platform/openapi.yaml

import { resolve } from "path";
import { writeFileSync } from "fs";

// ── Minimal YAML serializer (no external deps) ──────────────────────────────

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    // Strings that need quoting: empty, contain special chars, look like numbers/booleans
    if (
      obj === "" ||
      obj.includes("\n") ||
      obj.includes(":") ||
      obj.includes("#") ||
      obj.includes("'") ||
      obj.includes('"') ||
      obj.includes("{") ||
      obj.includes("}") ||
      obj.includes("[") ||
      obj.includes("]") ||
      obj.includes(",") ||
      obj.includes("&") ||
      obj.includes("*") ||
      obj.includes("!") ||
      obj.includes("|") ||
      obj.includes(">") ||
      obj.includes("%") ||
      obj.includes("@") ||
      obj.includes("`") ||
      obj === "true" ||
      obj === "false" ||
      obj === "null" ||
      obj === "yes" ||
      obj === "no" ||
      /^\d+(\.\d+)?$/.test(obj) ||
      /^0[xXoObB]/.test(obj)
    ) {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    // Check if all items are primitives for inline array
    const allPrimitive = obj.every(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    );
    if (allPrimitive && obj.length <= 5) {
      const items = obj.map((v) =>
        typeof v === "string" ? `"${v}"` : String(v)
      );
      return `[${items.join(", ")}]`;
    }
    return obj
      .map((item) => {
        const val = toYaml(item, indent + 1);
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          // Object items: put first key on same line as dash
          const lines = val.split("\n");
          return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).join("\n")}`;
        }
        return `${pad}- ${val}`;
      })
      .join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => {
        const yamlKey = /[:\s{}\[\],#&*!|>'"%@`]/.test(key) ? `"${key}"` : key;
        if (value === null || value === undefined) {
          return `${pad}${yamlKey}: null`;
        }
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          return `${pad}${yamlKey}: ${toYaml(value, indent)}`;
        }
        if (Array.isArray(value) && value.length === 0) {
          return `${pad}${yamlKey}: []`;
        }
        // Inline short primitive arrays
        if (
          Array.isArray(value) &&
          value.length <= 5 &&
          value.every(
            (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          )
        ) {
          return `${pad}${yamlKey}: ${toYaml(value, indent)}`;
        }
        return `${pad}${yamlKey}:\n${toYaml(value, indent + 1)}`;
      })
      .join("\n");
  }

  return String(obj);
}

// ── Reusable schema & parameter helpers ─────────────────────────────────────

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const paramRef = (name: string) => ({ $ref: `#/components/parameters/${name}` });

const jsonContent = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});

const jsonResponse = (desc: string, schema: Record<string, unknown>) => ({
  description: desc,
  content: jsonContent(schema),
});

const errorResponse = (desc: string) =>
  jsonResponse(desc, ref("ErrorResponse"));

const keyParam = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Cache key",
};

const nsQuery = {
  name: "ns",
  in: "query",
  required: false,
  schema: { type: "string" },
  description: "Namespace",
};

// ── OpenAPI specification ───────────────────────────────────────────────────

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Dunena Cache Engine API",
    version: "0.4.0",
    description:
      "High-performance cache engine with Zig core, Bun/TypeScript control layer, SQLite persistence, distributed locks, replication, and database proxying.",
    contact: {
      name: "Dunena",
      url: "https://github.com/powencu/dunena",
    },
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development server",
    },
  ],
  tags: [
    { name: "Health", description: "Health checks and diagnostics" },
    { name: "Cache", description: "Core cache CRUD and operations" },
    { name: "Batch", description: "Batch cache operations (mget/mset/mdelete)" },
    { name: "Atomic", description: "Atomic increment/decrement operations" },
    { name: "CAS", description: "Compare-and-swap operations" },
    { name: "TTL", description: "TTL inspection and modification" },
    { name: "Management", description: "Cache stats, flush, and snapshots" },
    { name: "Database", description: "SQLite key-value storage" },
    { name: "QueryCache", description: "Query result caching layer" },
    { name: "Proxy", description: "Database proxy connectors" },
    { name: "Locks", description: "Distributed lock management" },
    { name: "Replication", description: "Data replication across nodes" },
    { name: "RateLimits", description: "Namespace-scoped rate limiting" },
    { name: "Metrics", description: "Prometheus metrics export" },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "API authentication via Bearer token. Health endpoints are exempt.",
      },
    },
    parameters: {
      KeyPath: keyParam,
      NamespaceQuery: nsQuery,
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
        required: ["error"],
      },
      CacheEntry: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
      },
      CacheSetRequest: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "string", description: "Value to store" },
          ttl: { type: "number", description: "TTL in seconds (optional)" },
          ns: { type: "string", description: "Namespace (optional)" },
        },
      },
      BatchMgetRequest: {
        type: "object",
        required: ["action", "keys"],
        properties: {
          action: { type: "string", enum: ["mget"] },
          keys: { type: "array", items: { type: "string" } },
          ns: { type: "string" },
        },
      },
      BatchMsetRequest: {
        type: "object",
        required: ["action", "entries"],
        properties: {
          action: { type: "string", enum: ["mset"] },
          entries: {
            type: "array",
            items: {
              type: "object",
              required: ["key", "value"],
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                ttl: { type: "number" },
              },
            },
          },
          ns: { type: "string" },
        },
      },
      BatchMdeleteRequest: {
        type: "object",
        required: ["action", "keys"],
        properties: {
          action: { type: "string", enum: ["mdelete"] },
          keys: { type: "array", items: { type: "string" } },
          ns: { type: "string" },
        },
      },
      IncrDecrRequest: {
        type: "object",
        properties: {
          delta: { type: "number", description: "Amount to increment/decrement (default: 1)" },
          ns: { type: "string" },
        },
      },
      CASRequest: {
        type: "object",
        required: ["value", "expectedVersion"],
        properties: {
          value: { type: "string" },
          expectedVersion: { type: "number", description: "Expected current version for optimistic locking" },
          ns: { type: "string" },
        },
      },
      TouchRequest: {
        type: "object",
        required: ["ttl"],
        properties: {
          ttl: { type: "number", description: "New TTL in seconds" },
          ns: { type: "string" },
        },
      },
      WarmupRequest: {
        type: "object",
        required: ["entries"],
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              required: ["key", "value"],
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                ttl: { type: "number" },
                ns: { type: "string" },
              },
            },
          },
        },
      },
      DbSetRequest: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "string" },
          ttl: { type: "number" },
          ns: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      DbBatchRequest: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["mget", "mset", "mdelete", "query", "deleteByTags"] },
          keys: { type: "array", items: { type: "string" } },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                ttl: { type: "number" },
                tags: { type: "array", items: { type: "string" } },
              },
            },
          },
          ns: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          pattern: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          orderBy: { type: "string", enum: ["key", "createdAt", "updatedAt"] },
          order: { type: "string", enum: ["asc", "desc"] },
        },
      },
      QueryCacheStoreRequest: {
        type: "object",
        required: ["key", "data"],
        properties: {
          key: { type: "string" },
          data: { description: "Query result data (any JSON)" },
          ttl: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      QueryCacheInvalidateRequest: {
        type: "object",
        properties: {
          key: { type: "string", description: "Specific cache key to invalidate" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to invalidate by" },
        },
      },
      ConnectorConfig: {
        type: "object",
        required: ["name", "type", "connectionString"],
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["postgresql", "mysql", "http", "mongodb", "redis", "elasticsearch"] },
          connectionString: { type: "string" },
        },
      },
      ProxyQueryRequest: {
        type: "object",
        required: ["connector", "query"],
        properties: {
          connector: { type: "string", description: "Name of the registered connector" },
          query: { type: "string", description: "Query or URL to execute" },
          params: { type: "array", description: "Query parameters" },
          cacheTTL: { type: "number", description: "Cache TTL for the result" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      LockAcquireRequest: {
        type: "object",
        required: ["owner"],
        properties: {
          owner: { type: "string", description: "Lock owner identifier" },
          ttl: { type: "number", description: "Lock TTL in seconds" },
        },
      },
      LockReleaseRequest: {
        type: "object",
        required: ["owner"],
        properties: {
          owner: { type: "string" },
        },
      },
      LockExtendRequest: {
        type: "object",
        required: ["owner", "ttl"],
        properties: {
          owner: { type: "string" },
          ttl: { type: "number", description: "New TTL in seconds (must be positive)" },
        },
      },
      ReplicaConfig: {
        type: "object",
        required: ["id", "url"],
        properties: {
          id: { type: "string" },
          url: { type: "string", format: "uri" },
          authToken: { type: "string" },
          enabled: { type: "boolean", default: true },
          syncMode: { type: "string", enum: ["async", "sync"], default: "async" },
        },
      },
      RateLimitConfig: {
        type: "object",
        required: ["namespace", "maxRequests", "windowMs"],
        properties: {
          namespace: { type: "string" },
          maxRequests: { type: "number", description: "Max requests per window" },
          windowMs: { type: "number", description: "Window duration in milliseconds" },
        },
      },
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string" },
          version: { type: "string" },
          uptime: { type: "number" },
          checks: {
            type: "object",
            properties: {
              zigCore: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  latencyMs: { type: "number" },
                },
              },
              sqlite: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  latencyMs: { type: "number" },
                },
              },
              memory: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  heapUsedMB: { type: "number" },
                  heapTotalMB: { type: "number" },
                  rssMB: { type: "number" },
                },
              },
              cache: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  entries: { type: "integer" },
                  maxEntries: { type: "integer" },
                  hitRate: { type: "number" },
                  memoryBytes: { type: "integer" },
                },
              },
            },
          },
          timestamp: { type: "string", format: "date-time" },
        },
      },
      CacheStats: {
        type: "object",
        properties: {
          cache: {
            type: "object",
            properties: {
              hits: { type: "integer" },
              misses: { type: "integer" },
              puts: { type: "integer" },
              deletes: { type: "integer" },
              evictions: { type: "integer" },
              currentSize: { type: "integer" },
              maxSize: { type: "integer" },
              hitRate: { type: "number" },
              memoryBytes: { type: "integer" },
              casHits: { type: "integer" },
              casMisses: { type: "integer" },
            },
          },
          latency: {
            type: "object",
            properties: {
              mean: { type: "number" },
              p50: { type: "number" },
              p95: { type: "number" },
              p99: { type: "number" },
              count: { type: "integer" },
            },
          },
        },
      },
      CacheInfo: {
        type: "object",
        properties: {
          evictionPolicy: { type: "string" },
          memoryBytes: { type: "integer" },
          casHits: { type: "integer" },
          casMisses: { type: "integer" },
          currentSize: { type: "integer" },
          maxSize: { type: "integer" },
        },
      },
      ServerInfo: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string" },
          entries: { type: "integer" },
          uptime: { type: "number" },
          database: { type: "boolean" },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    // ── Health & Info ──────────────────────────────────────────────────────
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Full health diagnostics",
        description: "Returns structured health information including Zig core latency, SQLite status, memory usage, and cache statistics.",
        security: [],
        responses: {
          "200": jsonResponse("Health check passed", ref("HealthResponse")),
        },
      },
    },
    "/health/live": {
      get: {
        tags: ["Health"],
        summary: "Kubernetes liveness probe",
        description: "Returns 200 if the process is alive. Used for K8s liveness checks.",
        security: [],
        responses: {
          "200": jsonResponse("Process is alive", {
            type: "object",
            properties: { status: { type: "string", example: "alive" } },
          }),
        },
      },
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        summary: "Kubernetes readiness probe",
        description: "Verifies the server is ready to accept traffic. Checks SQLite connectivity when database is enabled.",
        security: [],
        responses: {
          "200": jsonResponse("Server is ready", {
            type: "object",
            properties: { status: { type: "string", example: "ready" } },
          }),
          "503": errorResponse("Server not ready (e.g. SQLite unavailable)"),
        },
      },
    },
    "/info": {
      get: {
        tags: ["Health"],
        summary: "Server information",
        description: "Returns basic server information including version, entry count, uptime, and database status.",
        responses: {
          "200": jsonResponse("Server info", ref("ServerInfo")),
        },
      },
    },
    "/metrics": {
      get: {
        tags: ["Metrics"],
        summary: "Prometheus metrics",
        description: "Exposes cache and server metrics in Prometheus text exposition format.",
        responses: {
          "200": {
            description: "Prometheus metrics in text format",
            content: {
              "text/plain": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },

    // ── Cache CRUD ────────────────────────────────────────────────────────
    "/cache/{key}": {
      get: {
        tags: ["Cache"],
        summary: "Get cache entry",
        description: "Retrieves a value by key from the in-memory cache.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("Cache hit", ref("CacheEntry")),
          "404": errorResponse("Key not found"),
          "400": errorResponse("Invalid key"),
        },
      },
      post: {
        tags: ["Cache"],
        summary: "Set cache entry",
        description: "Stores a key-value pair in the in-memory cache with optional TTL and namespace.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        requestBody: {
          required: true,
          content: jsonContent(ref("CacheSetRequest")),
        },
        responses: {
          "201": jsonResponse("Entry stored", {
            type: "object",
            properties: { ok: { type: "boolean" } },
          }),
          "400": errorResponse("Validation error"),
        },
      },
      delete: {
        tags: ["Cache"],
        summary: "Delete cache entry",
        description: "Removes a key from the in-memory cache.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("Entry deleted", {
            type: "object",
            properties: { deleted: { type: "boolean" } },
          }),
          "400": errorResponse("Invalid key"),
        },
      },
    },

    // ── Batch ─────────────────────────────────────────────────────────────
    "/cache": {
      post: {
        tags: ["Batch"],
        summary: "Batch cache operations",
        description: "Perform bulk mget or mset operations on the cache.",
        requestBody: {
          required: true,
          content: jsonContent({
            oneOf: [ref("BatchMgetRequest"), ref("BatchMsetRequest")],
          }),
        },
        responses: {
          "200": jsonResponse("Batch result", {
            type: "object",
            properties: {
              result: { type: "object", description: "Map of key to value (mget)" },
              stored: { type: "integer", description: "Number of entries stored (mset)" },
            },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },

    // ── Atomic Operations ─────────────────────────────────────────────────
    "/cache/{key}/incr": {
      post: {
        tags: ["Atomic"],
        summary: "Atomic increment",
        description: "Atomically increments a numeric cache value. Creates the key with value 0 + delta if it does not exist.",
        parameters: [paramRef("KeyPath")],
        requestBody: {
          content: jsonContent(ref("IncrDecrRequest")),
        },
        responses: {
          "200": jsonResponse("Incremented value", {
            type: "object",
            properties: { value: { type: "number" } },
          }),
          "400": errorResponse("Value is not numeric"),
        },
      },
    },
    "/cache/{key}/decr": {
      post: {
        tags: ["Atomic"],
        summary: "Atomic decrement",
        description: "Atomically decrements a numeric cache value. Creates the key with value 0 - delta if it does not exist.",
        parameters: [paramRef("KeyPath")],
        requestBody: {
          content: jsonContent(ref("IncrDecrRequest")),
        },
        responses: {
          "200": jsonResponse("Decremented value", {
            type: "object",
            properties: { value: { type: "number" } },
          }),
          "400": errorResponse("Value is not numeric"),
        },
      },
    },

    // ── Compare-and-Swap ──────────────────────────────────────────────────
    "/cache/{key}/version": {
      get: {
        tags: ["CAS"],
        summary: "Get CAS version",
        description: "Returns the current version number of a cache entry for use in compare-and-swap operations.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("Version info", {
            type: "object",
            properties: {
              key: { type: "string" },
              version: { type: "integer" },
            },
          }),
          "404": errorResponse("Key not found"),
        },
      },
    },
    "/cache/{key}/cas": {
      put: {
        tags: ["CAS"],
        summary: "Compare-and-swap update",
        description: "Updates a cache entry only if the current version matches the expected version. Provides optimistic concurrency control.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        requestBody: {
          required: true,
          content: jsonContent(ref("CASRequest")),
        },
        responses: {
          "200": jsonResponse("CAS succeeded", {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              newVersion: { type: "integer" },
            },
          }),
          "409": jsonResponse("Version conflict", {
            type: "object",
            properties: {
              ok: { type: "boolean", example: false },
              error: { type: "string" },
            },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },

    // ── TTL Operations ────────────────────────────────────────────────────
    "/cache/{key}/ttl": {
      get: {
        tags: ["TTL"],
        summary: "Get TTL",
        description: "Returns the remaining TTL for a cache entry. Returns -1 for entries without expiry, -2 if key not found.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("TTL info", {
            type: "object",
            properties: {
              key: { type: "string" },
              ttl: { type: "number", description: "Remaining TTL in seconds, or -1 for no expiry" },
              hasExpiry: { type: "boolean" },
            },
          }),
          "404": errorResponse("Key not found"),
        },
      },
    },
    "/cache/{key}/touch": {
      post: {
        tags: ["TTL"],
        summary: "Update TTL",
        description: "Sets a new TTL on an existing cache entry without changing its value.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        requestBody: {
          required: true,
          content: jsonContent(ref("TouchRequest")),
        },
        responses: {
          "200": jsonResponse("TTL updated", {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              ttl: { type: "number" },
            },
          }),
          "404": errorResponse("Key not found"),
          "400": errorResponse("Validation error"),
        },
      },
    },

    // ── Cache Warmup ──────────────────────────────────────────────────────
    "/cache/warmup": {
      post: {
        tags: ["Cache"],
        summary: "Bulk warmup",
        description: "Loads multiple entries into the cache at once. Useful for pre-populating the cache on startup.",
        requestBody: {
          required: true,
          content: jsonContent(ref("WarmupRequest")),
        },
        responses: {
          "200": jsonResponse("Warmup result", {
            type: "object",
            properties: {
              loaded: { type: "integer" },
              failed: { type: "integer" },
              total: { type: "integer" },
            },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },

    // ── Cache Info ─────────────────────────────────────────────────────────
    "/cache/info": {
      get: {
        tags: ["Cache"],
        summary: "Cache info",
        description: "Returns cache configuration and status including eviction policy, memory usage, and CAS statistics.",
        responses: {
          "200": jsonResponse("Cache info", ref("CacheInfo")),
        },
      },
    },

    // ── Key Scanning ──────────────────────────────────────────────────────
    "/keys": {
      get: {
        tags: ["Cache"],
        summary: "Scan keys",
        description: "Iterates over cache keys matching a glob pattern with cursor-based pagination.",
        parameters: [
          { name: "pattern", in: "query", schema: { type: "string", default: "*" }, description: "Glob pattern to match keys" },
          paramRef("NamespaceQuery"),
          { name: "cursor", in: "query", schema: { type: "integer", default: 0 }, description: "Cursor for pagination" },
          { name: "count", in: "query", schema: { type: "integer", default: 100, maximum: 1000 }, description: "Max keys per page" },
        ],
        responses: {
          "200": jsonResponse("Scan result", {
            type: "object",
            properties: {
              keys: { type: "array", items: { type: "string" } },
              cursor: { type: "integer" },
              hasMore: { type: "boolean" },
            },
          }),
        },
      },
    },

    // ── Management ────────────────────────────────────────────────────────
    "/stats": {
      get: {
        tags: ["Management"],
        summary: "Cache statistics",
        description: "Returns detailed cache performance statistics and request latency percentiles.",
        responses: {
          "200": jsonResponse("Statistics", ref("CacheStats")),
        },
      },
    },
    "/stats/history": {
      get: {
        tags: ["Management"],
        summary: "Analytics history",
        description: "Returns the last 60 snapshots of cache statistics taken at 60-second intervals.",
        responses: {
          "200": jsonResponse("Historical snapshots", {
            type: "object",
            properties: {
              snapshots: { type: "array", items: { type: "object" } },
            },
          }),
        },
      },
    },
    "/flush": {
      post: {
        tags: ["Management"],
        summary: "Flush cache",
        description: "Removes all entries from the in-memory cache. This is a destructive operation.",
        responses: {
          "200": jsonResponse("Cache flushed", {
            type: "object",
            properties: { flushed: { type: "boolean" } },
          }),
        },
      },
    },
    "/snapshot": {
      post: {
        tags: ["Management"],
        summary: "Trigger snapshot",
        description: "Forces an immediate snapshot of the cache to disk via the persistence layer.",
        responses: {
          "200": jsonResponse("Snapshot result", {
            type: "object",
            properties: { saved: { type: "boolean" } },
          }),
        },
      },
    },

    // ── Database (SQLite) ─────────────────────────────────────────────────
    "/db/{key}": {
      get: {
        tags: ["Database"],
        summary: "Get database entry",
        description: "Retrieves a key-value entry from the SQLite persistent store.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("Entry found", { type: "object" }),
          "404": errorResponse("Key not found"),
          "503": errorResponse("Database disabled"),
        },
      },
      post: {
        tags: ["Database"],
        summary: "Set database entry",
        description: "Stores or updates a key-value entry in SQLite with optional TTL and tags.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        requestBody: {
          required: true,
          content: jsonContent(ref("DbSetRequest")),
        },
        responses: {
          "201": jsonResponse("Entry stored", {
            type: "object",
            properties: { ok: { type: "boolean" } },
          }),
          "400": errorResponse("Validation error"),
          "503": errorResponse("Database disabled"),
        },
      },
      delete: {
        tags: ["Database"],
        summary: "Delete database entry",
        description: "Removes a key-value entry from the SQLite store.",
        parameters: [paramRef("KeyPath"), paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("Entry deleted", {
            type: "object",
            properties: { deleted: { type: "boolean" } },
          }),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db": {
      post: {
        tags: ["Database"],
        summary: "Batch database operations",
        description: "Perform bulk operations on the SQLite store: mget, mset, mdelete, query, or deleteByTags.",
        requestBody: {
          required: true,
          content: jsonContent(ref("DbBatchRequest")),
        },
        responses: {
          "200": jsonResponse("Batch result", { type: "object" }),
          "400": errorResponse("Validation error"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-stats": {
      get: {
        tags: ["Database"],
        summary: "Database statistics",
        description: "Returns SQLite storage statistics including entry count and size.",
        responses: {
          "200": jsonResponse("Database stats", { type: "object" }),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-keys": {
      get: {
        tags: ["Database"],
        summary: "List database keys",
        description: "Lists keys stored in the SQLite database, with optional glob pattern and namespace filtering.",
        parameters: [
          { name: "pattern", in: "query", schema: { type: "string", default: "*" }, description: "Glob pattern" },
          paramRef("NamespaceQuery"),
        ],
        responses: {
          "200": jsonResponse("Key list", {
            type: "object",
            properties: {
              keys: { type: "array", items: { type: "string" } },
              count: { type: "integer" },
            },
          }),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-clear": {
      post: {
        tags: ["Database"],
        summary: "Clear database",
        description: "Removes all entries from the SQLite store, optionally scoped to a namespace.",
        parameters: [paramRef("NamespaceQuery")],
        responses: {
          "200": jsonResponse("Database cleared", {
            type: "object",
            properties: { cleared: { type: "boolean" } },
          }),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-purge": {
      post: {
        tags: ["Database"],
        summary: "Purge expired entries",
        description: "Removes all expired entries from the SQLite store.",
        responses: {
          "200": jsonResponse("Purge result", {
            type: "object",
            properties: { purged: { type: "integer" } },
          }),
          "503": errorResponse("Database disabled"),
        },
      },
    },

    // ── Query Cache ───────────────────────────────────────────────────────
    "/query-cache/stats": {
      get: {
        tags: ["QueryCache"],
        summary: "Query cache stats",
        description: "Returns hit/miss statistics and entry count for the query result cache.",
        responses: {
          "200": jsonResponse("Query cache stats", { type: "object" }),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/query-cache/{key}": {
      get: {
        tags: ["QueryCache"],
        summary: "Get cached query",
        description: "Retrieves a cached query result by key.",
        parameters: [paramRef("KeyPath")],
        responses: {
          "200": jsonResponse("Cache hit", { type: "object" }),
          "404": errorResponse("Cache miss"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/query-cache": {
      post: {
        tags: ["QueryCache"],
        summary: "Store query result",
        description: "Caches a query result with optional TTL and tags for later retrieval or tag-based invalidation.",
        requestBody: {
          required: true,
          content: jsonContent(ref("QueryCacheStoreRequest")),
        },
        responses: {
          "201": jsonResponse("Cached", {
            type: "object",
            properties: {
              cached: { type: "boolean" },
              key: { type: "string" },
            },
          }),
          "400": errorResponse("Validation error"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/query-cache/invalidate": {
      post: {
        tags: ["QueryCache"],
        summary: "Invalidate cached queries",
        description: "Invalidates cached query results by specific key or by tags.",
        requestBody: {
          required: true,
          content: jsonContent(ref("QueryCacheInvalidateRequest")),
        },
        responses: {
          "200": jsonResponse("Invalidation result", {
            type: "object",
            properties: { invalidated: { type: "integer" } },
          }),
          "400": errorResponse("Provide either tags or key"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/query-cache/clear": {
      post: {
        tags: ["QueryCache"],
        summary: "Clear query cache",
        description: "Removes all entries from the query result cache.",
        responses: {
          "200": jsonResponse("Cleared", {
            type: "object",
            properties: { cleared: { type: "boolean" } },
          }),
          "503": errorResponse("Database disabled"),
        },
      },
    },

    // ── Database Proxy ────────────────────────────────────────────────────
    "/db-proxy/connectors": {
      get: {
        tags: ["Proxy"],
        summary: "List connectors",
        description: "Returns all registered database proxy connectors.",
        responses: {
          "200": jsonResponse("Connector list", {
            type: "object",
            properties: {
              connectors: { type: "array", items: { type: "object" } },
            },
          }),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-proxy/register": {
      post: {
        tags: ["Proxy"],
        summary: "Register connector",
        description: "Registers a new database connector for proxied queries. Supports PostgreSQL, MySQL, HTTP, MongoDB, Redis, and Elasticsearch.",
        requestBody: {
          required: true,
          content: jsonContent(ref("ConnectorConfig")),
        },
        responses: {
          "201": jsonResponse("Connector registered", {
            type: "object",
            properties: {
              registered: { type: "boolean" },
              name: { type: "string" },
            },
          }),
          "400": errorResponse("Validation error"),
          "409": errorResponse("Connector already exists"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-proxy/unregister": {
      post: {
        tags: ["Proxy"],
        summary: "Remove connector",
        description: "Unregisters an existing database connector by name.",
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          }),
        },
        responses: {
          "200": jsonResponse("Connector removed", {
            type: "object",
            properties: { unregistered: { type: "boolean" } },
          }),
          "400": errorResponse("Validation error"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-proxy/query": {
      post: {
        tags: ["Proxy"],
        summary: "Execute proxied query",
        description: "Executes a query through a registered database connector with optional result caching.",
        requestBody: {
          required: true,
          content: jsonContent(ref("ProxyQueryRequest")),
        },
        responses: {
          "200": jsonResponse("Query result", { type: "object" }),
          "400": errorResponse("Validation error"),
          "502": errorResponse("Upstream database error"),
          "503": errorResponse("Database disabled"),
        },
      },
    },
    "/db-proxy/invalidate": {
      post: {
        tags: ["Proxy"],
        summary: "Invalidate by tags",
        description: "Invalidates cached proxy query results matching the given tags.",
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["tags"],
            properties: {
              tags: { type: "array", items: { type: "string" } },
            },
          }),
        },
        responses: {
          "200": jsonResponse("Invalidation result", {
            type: "object",
            properties: { invalidated: { type: "integer" } },
          }),
          "400": errorResponse("tags (non-empty array) is required"),
          "503": errorResponse("Database disabled"),
        },
      },
    },

    // ── Distributed Locks ─────────────────────────────────────────────────
    "/locks/{key}/acquire": {
      post: {
        tags: ["Locks"],
        summary: "Acquire lock",
        description: "Attempts to acquire a distributed lock for the given key. Returns 409 if the lock is already held.",
        parameters: [paramRef("KeyPath")],
        requestBody: {
          required: true,
          content: jsonContent(ref("LockAcquireRequest")),
        },
        responses: {
          "201": jsonResponse("Lock acquired", {
            type: "object",
            properties: {
              acquired: { type: "boolean" },
              lock: { type: "object" },
            },
          }),
          "409": jsonResponse("Lock contention", {
            type: "object",
            properties: {
              acquired: { type: "boolean", example: false },
              error: { type: "string" },
            },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },
    "/locks/{key}/release": {
      post: {
        tags: ["Locks"],
        summary: "Release lock",
        description: "Releases a distributed lock. Only the owner can release the lock.",
        parameters: [paramRef("KeyPath")],
        requestBody: {
          required: true,
          content: jsonContent(ref("LockReleaseRequest")),
        },
        responses: {
          "200": jsonResponse("Lock released", {
            type: "object",
            properties: { released: { type: "boolean" } },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },
    "/locks/{key}/extend": {
      post: {
        tags: ["Locks"],
        summary: "Extend lock TTL",
        description: "Extends the TTL of an existing lock. Only the owner can extend the lock.",
        parameters: [paramRef("KeyPath")],
        requestBody: {
          required: true,
          content: jsonContent(ref("LockExtendRequest")),
        },
        responses: {
          "200": jsonResponse("Lock extended", {
            type: "object",
            properties: {
              extended: { type: "boolean" },
              lock: { type: "object" },
            },
          }),
          "404": errorResponse("Lock not found or owner mismatch"),
          "400": errorResponse("Validation error"),
        },
      },
    },
    "/locks/{key}": {
      get: {
        tags: ["Locks"],
        summary: "Check lock status",
        description: "Returns whether a lock is currently held for the given key and its details.",
        parameters: [paramRef("KeyPath")],
        responses: {
          "200": jsonResponse("Lock status", {
            type: "object",
            properties: {
              locked: { type: "boolean" },
              lock: { type: "object", nullable: true },
            },
          }),
        },
      },
      delete: {
        tags: ["Locks"],
        summary: "Force release lock",
        description: "Force-releases a lock regardless of owner. This is an admin operation.",
        parameters: [paramRef("KeyPath")],
        responses: {
          "200": jsonResponse("Force released", {
            type: "object",
            properties: { forceReleased: { type: "boolean" } },
          }),
        },
      },
    },
    "/locks": {
      get: {
        tags: ["Locks"],
        summary: "List all locks",
        description: "Returns all currently held distributed locks.",
        responses: {
          "200": jsonResponse("Lock list", {
            type: "object",
            properties: {
              locks: { type: "array", items: { type: "object" } },
              count: { type: "integer" },
            },
          }),
        },
      },
    },

    // ── Replication ───────────────────────────────────────────────────────
    "/replication/status": {
      get: {
        tags: ["Replication"],
        summary: "Replication status",
        description: "Returns current replication configuration and synchronization statistics.",
        responses: {
          "200": jsonResponse("Replication status", {
            type: "object",
            properties: {
              config: { type: "object" },
              stats: { type: "object" },
            },
          }),
        },
      },
    },
    "/replication/replicas": {
      get: {
        tags: ["Replication"],
        summary: "List replicas",
        description: "Returns all configured replication replicas.",
        responses: {
          "200": jsonResponse("Replica list", {
            type: "object",
            properties: {
              replicas: { type: "array", items: { type: "object" } },
            },
          }),
        },
      },
      post: {
        tags: ["Replication"],
        summary: "Add replica",
        description: "Registers a new replication target.",
        requestBody: {
          required: true,
          content: jsonContent(ref("ReplicaConfig")),
        },
        responses: {
          "201": jsonResponse("Replica added", {
            type: "object",
            properties: {
              added: { type: "boolean" },
              id: { type: "string" },
            },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },
    "/replication/replicas/{id}": {
      delete: {
        tags: ["Replication"],
        summary: "Remove replica",
        description: "Removes a replication replica by its ID.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Replica ID" },
        ],
        responses: {
          "200": jsonResponse("Replica removed", {
            type: "object",
            properties: { removed: { type: "boolean" } },
          }),
        },
      },
    },
    "/replication/enable": {
      post: {
        tags: ["Replication"],
        summary: "Enable replication",
        description: "Enables data replication to all configured replicas.",
        responses: {
          "200": jsonResponse("Replication enabled", {
            type: "object",
            properties: { enabled: { type: "boolean" } },
          }),
        },
      },
    },
    "/replication/disable": {
      post: {
        tags: ["Replication"],
        summary: "Disable replication",
        description: "Disables data replication.",
        responses: {
          "200": jsonResponse("Replication disabled", {
            type: "object",
            properties: { enabled: { type: "boolean" } },
          }),
        },
      },
    },

    // ── Rate Limits ───────────────────────────────────────────────────────
    "/rate-limits": {
      get: {
        tags: ["RateLimits"],
        summary: "List rate limits",
        description: "Returns all configured namespace-scoped rate limit rules.",
        responses: {
          "200": jsonResponse("Rate limit list", {
            type: "object",
            properties: {
              limits: { type: "array", items: { type: "object" } },
            },
          }),
        },
      },
      post: {
        tags: ["RateLimits"],
        summary: "Configure rate limit",
        description: "Creates or updates a namespace-scoped rate limit rule.",
        requestBody: {
          required: true,
          content: jsonContent(ref("RateLimitConfig")),
        },
        responses: {
          "201": jsonResponse("Rate limit configured", {
            type: "object",
            properties: {
              configured: { type: "boolean" },
              namespace: { type: "string" },
            },
          }),
          "400": errorResponse("Validation error"),
        },
      },
    },
    "/rate-limits/{namespace}": {
      delete: {
        tags: ["RateLimits"],
        summary: "Remove rate limit",
        description: "Removes a namespace-scoped rate limit rule.",
        parameters: [
          { name: "namespace", in: "path", required: true, schema: { type: "string" }, description: "Namespace" },
        ],
        responses: {
          "200": jsonResponse("Rate limit removed", {
            type: "object",
            properties: { removed: { type: "boolean" } },
          }),
        },
      },
      get: {
        tags: ["RateLimits"],
        summary: "Get rate limit stats",
        description: "Returns rate limit configuration and current usage statistics for a specific namespace.",
        parameters: [
          { name: "namespace", in: "path", required: true, schema: { type: "string" }, description: "Namespace" },
        ],
        responses: {
          "200": jsonResponse("Rate limit stats", { type: "object" }),
          "404": errorResponse("No rate limit configured for this namespace"),
        },
      },
    },
  },
};

// ── Generate & write ────────────────────────────────────────────────────────

const outputPath = resolve(
  process.argv[2] ?? resolve(import.meta.dir, "../packages/platform/openapi.yaml")
);

const yaml = toYaml(spec);
writeFileSync(outputPath, yaml + "\n", "utf-8");

// Also output to the static docs folder for deployment compatibility if using default path
if (!process.argv[2]) {
  const docsSpecPath = resolve(import.meta.dir, "../packages/platform/docs/openapi.yaml");
  writeFileSync(docsSpecPath, yaml + "\n", "utf-8");
  console.log(`✅ Also output to docs: ${docsSpecPath}`);
}

console.log(`✅ OpenAPI spec generated: ${outputPath}`);
console.log(`   ${Object.keys(spec.paths).length} paths, ${Object.keys(spec.components.schemas).length} schemas`);
