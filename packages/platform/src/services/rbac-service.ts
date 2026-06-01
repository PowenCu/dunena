// ── RBAC Service ───────────────────────────────────────────
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger";
import type { RBACConfig, ApiKeyPermissions, ApiKeyInfo } from "../types";

const log = logger.child("rbac");

export class RBACService {
  private db: Database;
  private config: RBACConfig;

  constructor(config: RBACConfig) {
    this.config = config;
    this.db = new Database(config.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        permissions TEXT NOT NULL,
        namespaces TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        last_used_at INTEGER
      )
    `);

    log.info("RBAC service initialized", { dbPath: config.dbPath });
  }

  /**
   * Create a new API key with the given permissions and namespace access.
   * Returns the key ID and the plaintext key (only time it's visible).
   */
  async createKey(
    name: string,
    permissions: ApiKeyPermissions,
    namespaces: string[],
    expiresAt?: number,
  ): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();

    // Generate secure key: dun_ + 32 random hex chars
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const hexStr = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const key = `dun_${hexStr}`;

    // Hash the key using SHA-256 for storage
    const keyHash = this.hashKey(key);

    const stmt = this.db.prepare(
      `INSERT INTO api_keys (id, key_hash, name, permissions, namespaces, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      id,
      keyHash,
      name,
      JSON.stringify(permissions),
      JSON.stringify(namespaces),
      Date.now(),
      expiresAt ?? null,
    );

    log.info("API key created", { id, name, namespaces });
    return { id, key };
  }

  /**
   * Validate an API key and return its info if valid.
   * Returns null if the key is invalid, expired, or revoked.
   */
  async validateKey(key: string): Promise<ApiKeyInfo | null> {
    const keyHash = this.hashKey(key);

    const stmt = this.db.prepare(
      `SELECT id, name, permissions, namespaces, created_at, expires_at, active, last_used_at
       FROM api_keys WHERE key_hash = ?`,
    );
    const row = stmt.get(keyHash) as {
      id: string;
      name: string;
      permissions: string;
      namespaces: string;
      created_at: number;
      expires_at: number | null;
      active: number;
      last_used_at: number | null;
    } | null;

    if (!row) return null;

    // Check if active
    if (!row.active) {
      log.debug("API key validation failed: key revoked", { id: row.id });
      return null;
    }

    // Check expiry
    if (row.expires_at !== null && Date.now() > row.expires_at) {
      log.debug("API key validation failed: key expired", { id: row.id });
      return null;
    }

    // Update last_used_at
    const updateStmt = this.db.prepare(
      `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
    );
    updateStmt.run(Date.now(), row.id);

    return {
      id: row.id,
      name: row.name,
      permissions: JSON.parse(row.permissions) as ApiKeyPermissions,
      namespaces: JSON.parse(row.namespaces) as string[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      active: true,
      lastUsedAt: row.last_used_at,
    };
  }

  /**
   * Revoke an API key by setting active = 0.
   */
  async revokeKey(keyId: string): Promise<boolean> {
    const stmt = this.db.prepare(
      `UPDATE api_keys SET active = 0 WHERE id = ?`,
    );
    const result = stmt.run(keyId);
    const revoked = result.changes > 0;
    if (revoked) {
      log.info("API key revoked", { id: keyId });
    }
    return revoked;
  }

  /**
   * Get details of a specific API key by ID.
   */
  async getKey(keyId: string): Promise<ApiKeyInfo | null> {
    const stmt = this.db.prepare(
      `SELECT id, name, permissions, namespaces, created_at, expires_at, active, last_used_at
       FROM api_keys WHERE id = ?`,
    );
    const row = stmt.get(keyId) as {
      id: string;
      name: string;
      permissions: string;
      namespaces: string;
      created_at: number;
      expires_at: number | null;
      active: number;
      last_used_at: number | null;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      permissions: JSON.parse(row.permissions) as ApiKeyPermissions,
      namespaces: JSON.parse(row.namespaces) as string[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      active: row.active === 1,
      lastUsedAt: row.last_used_at,
    };
  }

  /**
   * List all API keys (never expose the hash).
   */
  async listKeys(): Promise<ApiKeyInfo[]> {
    const stmt = this.db.prepare(
      `SELECT id, name, permissions, namespaces, created_at, expires_at, active, last_used_at
       FROM api_keys ORDER BY created_at DESC`,
    );
    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      permissions: string;
      namespaces: string;
      created_at: number;
      expires_at: number | null;
      active: number;
      last_used_at: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      permissions: JSON.parse(row.permissions) as ApiKeyPermissions,
      namespaces: JSON.parse(row.namespaces) as string[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      active: row.active === 1,
      lastUsedAt: row.last_used_at,
    }));
  }

  /**
   * Check if a key has the required permission for a given namespace.
   * Admin permission implies all other permissions.
   * Wildcard '*' namespace allows access to all namespaces.
   */
  checkPermission(
    keyInfo: ApiKeyInfo,
    action: "read" | "write" | "delete" | "admin",
    namespace?: string,
  ): boolean {
    // Admin permission implies all others
    if (keyInfo.permissions.admin) return true;

    // Check action-specific permission
    if (!keyInfo.permissions[action]) return false;

    // Check namespace access
    if (namespace !== undefined) {
      const allowed = keyInfo.namespaces.includes("*") || keyInfo.namespaces.includes(namespace);
      if (!allowed) return false;
    }

    return true;
  }

  /**
   * Hash a key using SHA-256 via Bun.CryptoHasher.
   */
  private hashKey(key: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(key);
    return hasher.digest("hex");
  }

  /**
   * Close the SQLite database.
   */
  async close(): Promise<void> {
    this.db.close();
    log.info("RBAC service closed");
  }
}
