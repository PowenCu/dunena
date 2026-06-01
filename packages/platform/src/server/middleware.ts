// ── Middleware ──────────────────────────────────────────────
import { timingSafeEqual } from "crypto";
import type { ServerConfig, NamespaceRateLimitConfig } from "../types";
import { logger } from "../utils/logger";

const log = logger.child("http");

// ── CORS ───────────────────────────────────────────────────

export function corsHeaders(config: ServerConfig, requestOrigin?: string): Record<string, string> {
  // For a single wildcard or single origin, we can cache
  const origins = config.cors.origins;

  let allowOrigin: string;
  if (origins.length === 1 && origins[0] === "*") {
    allowOrigin = "*";
  } else if (origins.length === 1) {
    allowOrigin = origins[0];
  } else if (requestOrigin && origins.includes(requestOrigin)) {
    // Per spec: reflect the matching origin back, with Vary: Origin
    allowOrigin = requestOrigin;
  } else {
    // No matching origin — return the first configured origin
    allowOrigin = origins[0];
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": config.cors.methods.join(", "),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  // When reflecting a specific origin, add Vary header for caching correctness
  if (allowOrigin !== "*") {
    headers["Vary"] = "Origin";
  }
  return headers;
}

export function handleCors(
  req: Request,
  config: ServerConfig
): Response | null {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin") ?? undefined;
    return new Response(null, { status: 204, headers: corsHeaders(config, origin) });
  }
  return null;
}

// ── Authentication ─────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // Compare against self to keep constant time, but return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// Optional reference to the RBAC service, set via setRBACService()
let rbacService: import("../services/rbac-service").RBACService | null = null;

/**
 * Wire the RBAC service into the middleware layer.
 * Called once during app bootstrap when RBAC is enabled.
 */
export function setRBACService(service: import("../services/rbac-service").RBACService): void {
  rbacService = service;
}

/**
 * Authenticate the request.
 * - If a legacy authToken is configured and the bearer matches, pass through.
 * - If the bearer is a `dun_*` RBAC key, validate via RBACService.
 * - Attaches RBAC metadata headers for downstream permission checks.
 */
export async function authenticate(
  req: Request,
  token: string | undefined,
): Promise<Response | null> {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  // Legacy single-token auth: if token is configured and matches, allow
  if (token && bearer && constantTimeEqual(bearer, token)) {
    return null; // authenticated via legacy token
  }

  // RBAC key auth: if the bearer starts with `dun_`, try RBAC validation
  if (rbacService && bearer?.startsWith("dun_")) {
    const keyInfo = await rbacService.validateKey(bearer);
    if (keyInfo) {
      // Stash RBAC metadata on request headers for downstream checks
      // (Headers are mutable on the server side in Bun)
      req.headers.set("x-rbac-permissions", JSON.stringify(keyInfo.permissions));
      req.headers.set("x-rbac-namespaces", JSON.stringify(keyInfo.namespaces));
      req.headers.set("x-rbac-key-id", keyInfo.id);
      return null; // authenticated via RBAC key
    }
    // dun_ key was provided but invalid
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // No auth configured at all → open access
  if (!token && !rbacService) return null;

  // If we reach here, auth is required but no valid credentials provided
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Check whether the current request has the required RBAC permission.
 * Returns a 403 Response if the check fails, or null if it passes.
 *
 * If RBAC is not enabled (no x-rbac-permissions header), this is a no-op
 * (returns null) to preserve backward compatibility with legacy auth.
 */
export function checkPermission(
  req: Request,
  action: "read" | "write" | "delete" | "admin",
  namespace?: string,
): Response | null {
  const permHeader = req.headers.get("x-rbac-permissions");
  if (!permHeader) {
    // No RBAC metadata → legacy auth or open access, allow through
    return null;
  }

  let permissions: import("../types").ApiKeyPermissions;
  try {
    permissions = JSON.parse(permHeader);
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Admin implies all permissions
  if (permissions.admin) return null;

  // Check action permission
  if (!permissions[action]) {
    return Response.json(
      { error: "Forbidden", detail: `Missing '${action}' permission` },
      { status: 403 },
    );
  }

  // Check namespace access
  if (namespace !== undefined) {
    const nsHeader = req.headers.get("x-rbac-namespaces");
    let namespaces: string[] = [];
    try {
      namespaces = nsHeader ? JSON.parse(nsHeader) : [];
    } catch { /* empty */ }

    const allowed = namespaces.includes("*") || namespaces.includes(namespace);
    if (!allowed) {
      return Response.json(
        { error: "Forbidden", detail: `No access to namespace '${namespace}'` },
        { status: 403 },
      );
    }
  }

  return null;
}


// ── Rate Limiting ──────────────────────────────────────────

interface RateBucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, RateBucket>();

// Periodically purge stale buckets to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now - bucket.windowStart > 120_000) buckets.delete(ip);
  }
}, 60_000).unref();

export function rateLimit(
  req: Request,
  config: ServerConfig
): Response | null {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  let bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart > config.rateLimit.windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(ip, bucket);
  }

  bucket.count++;
  if (bucket.count > config.rateLimit.maxRequests) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  return null;
}

// ── Namespace Rate Limiting ────────────────────────────────

interface NamespaceRateBucket {
  count: number;
  windowStart: number;
}

// Map: namespace -> IP -> bucket
const namespaceBuckets = new Map<string, Map<string, NamespaceRateBucket>>();
const namespaceConfigs = new Map<string, NamespaceRateLimitConfig>();

// Periodically purge stale namespace buckets
setInterval(() => {
  const now = Date.now();
  for (const [ns, ipMap] of namespaceBuckets) {
    for (const [ip, bucket] of ipMap) {
      if (now - bucket.windowStart > 120_000) ipMap.delete(ip);
    }
    if (ipMap.size === 0) namespaceBuckets.delete(ns);
  }
}, 60_000).unref();

/**
 * Configure rate limit for a specific namespace
 */
export function configureNamespaceRateLimit(config: NamespaceRateLimitConfig): void {
  namespaceConfigs.set(config.namespace, config);
  log.info("Namespace rate limit configured", { namespace: config.namespace, maxRequests: config.maxRequests, windowMs: config.windowMs });
}

/**
 * Remove rate limit configuration for a namespace
 */
export function removeNamespaceRateLimit(namespace: string): boolean {
  const existed = namespaceConfigs.delete(namespace);
  if (existed) {
    namespaceBuckets.delete(namespace);
    log.info("Namespace rate limit removed", { namespace });
  }
  return existed;
}

/**
 * Get all configured namespace rate limits
 */
export function getNamespaceRateLimits(): NamespaceRateLimitConfig[] {
  return Array.from(namespaceConfigs.values());
}

/**
 * Check namespace-specific rate limit
 * Returns 429 response if limit exceeded, null otherwise
 */
export function namespaceRateLimit(
  req: Request,
  namespace: string | undefined
): Response | null {
  if (!namespace) return null;
  
  const config = namespaceConfigs.get(namespace);
  if (!config) return null; // No specific limit for this namespace

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();

  let ipMap = namespaceBuckets.get(namespace);
  if (!ipMap) {
    ipMap = new Map();
    namespaceBuckets.set(namespace, ipMap);
  }

  let bucket = ipMap.get(ip);
  if (!bucket || now - bucket.windowStart > config.windowMs) {
    bucket = { count: 0, windowStart: now };
    ipMap.set(ip, bucket);
  }

  bucket.count++;
  if (bucket.count > config.maxRequests) {
    log.warn("Namespace rate limit exceeded", { namespace, ip });
    return Response.json(
      { error: "Namespace rate limit exceeded", namespace },
      { status: 429 }
    );
  }
  return null;
}

/**
 * Get rate limit stats for a namespace
 */
export function getNamespaceRateLimitStats(namespace: string): { activeClients: number; config: NamespaceRateLimitConfig | null } {
  const config = namespaceConfigs.get(namespace) ?? null;
  const ipMap = namespaceBuckets.get(namespace);
  return {
    activeClients: ipMap?.size ?? 0,
    config,
  };
}

// ── Request Logging ────────────────────────────────────────

export function logRequest(
  req: Request,
  url: URL,
  status: number,
  durationMs: number
) {
  log.info(`${req.method} ${url.pathname} ${status}`, {
    ms: Math.round(durationMs * 100) / 100,
  });
}

// ── Body Size Limit ────────────────────────────────────────

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

export function checkBodySize(req: Request): Response | null {
  const cl = req.headers.get("content-length");
  if (cl && parseInt(cl, 10) > MAX_BODY_SIZE) {
    return Response.json(
      { error: "Request body too large" },
      { status: 413 }
    );
  }
  return null;
}
