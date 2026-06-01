// ── GraphQL API Layer ──────────────────────────────────────
// Provides a GraphQL endpoint at /graphql.  Uses graphql-yoga
// which runs natively on Bun with zero adapter overhead.
//
// This module exports a factory that creates a yoga handler
// from the same services already bootstrapped in app.ts.

import { logger } from "../utils/logger";

const log = logger.child("graphql");

// ── Types for resolver context ─────────────────────────────

export interface GraphQLContext {
  cacheService: any;
  analyticsService?: any;
  dbProxy?: any;
  sqliteAdapter?: any;
  queryCache?: any;
}

// ── Schema (SDL) ───────────────────────────────────────────

const typeDefs = /* GraphQL */ `
  type CacheEntry {
    key: String!
    value: String
    namespace: String
  }

  type KeyScanResult {
    cursor: Int!
    keys: [String!]!
  }

  type CacheStats {
    hits: Int!
    misses: Int!
    hitRate: Float!
    entries: Int!
    evictions: Int!
    memoryBytes: Int!
    maxEntries: Int!
  }

  type StorageEntry {
    key: String!
    value: String
    namespace: String
    tags: [String]
    createdAt: String
    expiresAt: String
  }

  type ProxyResult {
    data: String
    rowCount: Int
    cachedAt: String
  }

  type Connector {
    name: String!
    type: String!
  }

  type Query {
    "Retrieve a single cache entry by key"
    cache(key: String!, ns: String): CacheEntry

    "Retrieve multiple cache entries"
    cacheMulti(keys: [String!]!, ns: String): [CacheEntry!]!

    "Scan cache keys with optional glob pattern"
    keys(pattern: String, ns: String, cursor: Int, count: Int): KeyScanResult!

    "Get cache statistics"
    stats: CacheStats!

    "Check if a key exists"
    exists(key: String!, ns: String): Boolean!

    "Get the TTL remaining for a key (ms). -1 = no TTL, -2 = key not found"
    ttl(key: String!, ns: String): Int!

    "Get a database entry by key (requires DB enabled)"
    dbEntry(key: String!, ns: String): StorageEntry

    "Query database entries by pattern"
    dbQuery(pattern: String, tags: [String], limit: Int): [StorageEntry!]!

    "List registered database proxy connectors"
    connectors: [Connector!]!
  }

  type Mutation {
    "Set a cache entry"
    cacheSet(key: String!, value: String!, ttl: Int, ns: String): Boolean!

    "Delete a cache entry"
    cacheDelete(key: String!, ns: String): Boolean!

    "Flush the entire cache"
    flush: Boolean!

    "Set a database entry"
    dbSet(key: String!, value: String!, ttl: Int, ns: String, tags: [String]): Boolean!

    "Delete a database entry"
    dbDelete(key: String!, ns: String): Boolean!

    "Execute a query through a database proxy connector"
    proxyQuery(connector: String!, query: String!, params: [String], tags: [String]): ProxyResult
  }
`;

// ── Resolvers ──────────────────────────────────────────────

function buildResolvers(ctx: GraphQLContext) {
  const { cacheService, dbProxy, sqliteAdapter } = ctx;

  return {
    Query: {
      cache: (_: any, { key, ns }: { key: string; ns?: string }) => {
        const value = cacheService.get(key, ns);
        return value !== null ? { key, value, namespace: ns ?? null } : null;
      },

      cacheMulti: (_: any, { keys, ns }: { keys: string[]; ns?: string }) => {
        const results = cacheService.mget(keys, ns);
        return keys.map((k: string) => ({
          key: k,
          value: results[k] ?? null,
          namespace: ns ?? null,
        }));
      },

      keys: (_: any, { pattern, ns, cursor, count }: any) => {
        return cacheService.keys(pattern, ns, cursor ?? 0, count ?? 100);
      },

      stats: () => {
        const s = cacheService.stats();
        return {
          hits: s.hits,
          misses: s.misses,
          hitRate: s.hitRate,
          entries: s.currentSize,
          evictions: s.evictions,
          memoryBytes: s.memoryBytes,
          maxEntries: s.maxSize,
        };
      },

      exists: (_: any, { key, ns }: { key: string; ns?: string }) => {
        return cacheService.has(key, ns);
      },

      ttl: (_: any, { key, ns }: { key: string; ns?: string }) => {
        return cacheService.ttl(key, ns);
      },

      dbEntry: async (_: any, { key, ns }: { key: string; ns?: string }) => {
        if (!sqliteAdapter) return null;
        const row = await sqliteAdapter.get(key, ns ?? "");
        if (!row) return null;
        return {
          key,
          value: row.value,
          namespace: row.namespace || null,
          tags: row.tags,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        };
      },

      dbQuery: async (_: any, { pattern, tags, limit }: any) => {
        if (!sqliteAdapter) return [];
        const rows = await sqliteAdapter.query({ prefix: pattern, tags, limit: limit ?? 100 });
        return rows.map((r: any) => ({
          key: r.key,
          value: r.value,
          namespace: r.namespace || null,
          tags: r.tags,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        }));
      },

      connectors: () => {
        if (!dbProxy) return [];
        return dbProxy.list();
      },
    },

    Mutation: {
      cacheSet: (_: any, { key, value, ttl, ns }: any) => {
        return cacheService.set(key, value, ttl, ns);
      },

      cacheDelete: (_: any, { key, ns }: any) => {
        return cacheService.delete(key, ns);
      },

      flush: () => {
        cacheService.clear();
        return true;
      },

      dbSet: async (_: any, { key, value, ttl, ns, tags }: any) => {
        if (!sqliteAdapter) return false;
        await sqliteAdapter.set(key, value, { ttl, namespace: ns ?? "", tags });
        return true;
      },

      dbDelete: async (_: any, { key, ns }: any) => {
        if (!sqliteAdapter) return false;
        return await sqliteAdapter.delete(key, ns ?? "");
      },

      proxyQuery: async (_: any, { connector, query, params, tags }: any) => {
        if (!dbProxy) return null;
        const result = await dbProxy.query({
          connector,
          query,
          params: params ?? [],
          ttl: 0,
          tags: tags ?? [],
        });
        return {
          data: JSON.stringify(result.data),
          rowCount: result.rowCount,
          cachedAt: result.cachedAt,
        };
      },
    },
  };
}

// ── Yoga Handler Factory ───────────────────────────────────

/**
 * Create a graphql-yoga handler.  Returns null if graphql-yoga
 * is not installed (optional peer dependency).
 */
export async function createGraphQLHandler(
  ctx: GraphQLContext,
): Promise<((req: Request) => Response | Promise<Response>) | null> {
  try {
    const { createSchema, createYoga } = await import("graphql-yoga");

    const schema = createSchema({
      typeDefs,
      resolvers: buildResolvers(ctx),
    });

    const yoga = createYoga({
      schema,
      graphqlEndpoint: "/graphql",
      logging: {
        debug: (...args: any[]) => log.debug(args.join(" ")),
        info: (...args: any[]) => log.info(args.join(" ")),
        warn: (...args: any[]) => log.warn(args.join(" ")),
        error: (...args: any[]) => log.error(args.join(" ")),
      },
      // Disable GraphiQL in production; enable in development
      graphiql: process.env.NODE_ENV !== "production",
    });

    log.info("GraphQL endpoint mounted at /graphql");
    return yoga.fetch.bind(yoga);
  } catch (err: any) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
      log.warn(
        'GraphQL requires "graphql-yoga". Install with: bun add graphql-yoga'
      );
    } else {
      log.error("Failed to initialise GraphQL", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}
