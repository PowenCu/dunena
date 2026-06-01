// ── RBAC Service Tests ─────────────────────────────────────
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { RBACService } from "../src/services/rbac-service";

// Use in-memory SQLite for tests — avoids filesystem issues
const service = new RBACService({
  enabled: true,
  dbPath: ":memory:",
});

afterAll(async () => {
  await service.close();
});


describe("RBACService", () => {
  // ── Key Creation ────────────────────────────────────────

  describe("createKey", () => {
    it("creates a key with dun_ prefix", async () => {
      const result = await service.createKey(
        "test-key",
        { read: true, write: false, delete: false, admin: false },
        ["default"],
      );

      expect(result.id).toBeDefined();
      expect(result.key).toStartWith("dun_");
      expect(result.key.length).toBe(4 + 64); // dun_ + 64 hex chars
    });

    it("returns unique keys each time", async () => {
      const perms = { read: true, write: true, delete: false, admin: false };
      const a = await service.createKey("key-a", perms, ["*"]);
      const b = await service.createKey("key-b", perms, ["*"]);

      expect(a.key).not.toBe(b.key);
      expect(a.id).not.toBe(b.id);
    });

    it("stores the key with an expiration", async () => {
      const expiresAt = Date.now() + 60_000;
      const result = await service.createKey(
        "expiring-key",
        { read: true, write: false, delete: false, admin: false },
        ["ns1"],
        expiresAt,
      );

      const keyInfo = await service.getKey(result.id);
      expect(keyInfo).not.toBeNull();
      expect(keyInfo!.expiresAt).toBe(expiresAt);
    });
  });

  // ── Key Validation ──────────────────────────────────────

  describe("validateKey", () => {
    it("validates a valid key", async () => {
      const { key } = await service.createKey(
        "valid",
        { read: true, write: true, delete: false, admin: false },
        ["*"],
      );

      const info = await service.validateKey(key);
      expect(info).not.toBeNull();
      expect(info!.name).toBe("valid");
      expect(info!.permissions.read).toBe(true);
      expect(info!.permissions.write).toBe(true);
      expect(info!.permissions.delete).toBe(false);
      expect(info!.permissions.admin).toBe(false);
      expect(info!.active).toBe(true);
    });

    it("returns null for invalid key", async () => {
      const info = await service.validateKey("dun_invalid_key_that_does_not_exist_at_all_1234");
      expect(info).toBeNull();
    });

    it("returns null for revoked key", async () => {
      const { id, key } = await service.createKey(
        "revokable",
        { read: true, write: false, delete: false, admin: false },
        ["*"],
      );

      await service.revokeKey(id);

      const info = await service.validateKey(key);
      expect(info).toBeNull();
    });

    it("returns null for expired key", async () => {
      const { key } = await service.createKey(
        "expired",
        { read: true, write: false, delete: false, admin: false },
        ["*"],
        Date.now() - 1000, // already expired
      );

      const info = await service.validateKey(key);
      expect(info).toBeNull();
    });

    it("updates last_used_at on validation", async () => {
      const { id, key } = await service.createKey(
        "tracked",
        { read: true, write: false, delete: false, admin: false },
        ["*"],
      );

      const before = await service.getKey(id);
      expect(before!.lastUsedAt).toBeNull();

      await service.validateKey(key);

      const after = await service.getKey(id);
      expect(after!.lastUsedAt).not.toBeNull();
      expect(after!.lastUsedAt!).toBeGreaterThan(0);
    });
  });

  // ── Key Revocation ──────────────────────────────────────

  describe("revokeKey", () => {
    it("revokes an existing key", async () => {
      const { id } = await service.createKey(
        "to-revoke",
        { read: true, write: false, delete: false, admin: false },
        ["*"],
      );

      const revoked = await service.revokeKey(id);
      expect(revoked).toBe(true);

      const keyInfo = await service.getKey(id);
      expect(keyInfo!.active).toBe(false);
    });

    it("returns false for non-existent key", async () => {
      const revoked = await service.revokeKey("non-existent-id");
      expect(revoked).toBe(false);
    });
  });

  // ── Key Listing ─────────────────────────────────────────

  describe("listKeys", () => {
    it("lists keys (includes all created so far)", async () => {
      const keys = await service.listKeys();
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  // ── Permission Checking ─────────────────────────────────

  describe("checkPermission", () => {
    it("allows action when permission is granted", async () => {
      const { key } = await service.createKey(
        "reader",
        { read: true, write: false, delete: false, admin: false },
        ["*"],
      );

      const info = (await service.validateKey(key))!;
      expect(service.checkPermission(info, "read")).toBe(true);
      expect(service.checkPermission(info, "write")).toBe(false);
      expect(service.checkPermission(info, "delete")).toBe(false);
      expect(service.checkPermission(info, "admin")).toBe(false);
    });

    it("admin permission grants all actions", async () => {
      const { key } = await service.createKey(
        "admin",
        { read: false, write: false, delete: false, admin: true },
        ["*"],
      );

      const info = (await service.validateKey(key))!;
      expect(service.checkPermission(info, "read")).toBe(true);
      expect(service.checkPermission(info, "write")).toBe(true);
      expect(service.checkPermission(info, "delete")).toBe(true);
      expect(service.checkPermission(info, "admin")).toBe(true);
    });

    it("allows wildcard namespace access", async () => {
      const { key } = await service.createKey(
        "wildcard",
        { read: true, write: true, delete: false, admin: false },
        ["*"],
      );

      const info = (await service.validateKey(key))!;
      expect(service.checkPermission(info, "read", "any-namespace")).toBe(true);
      expect(service.checkPermission(info, "read", "another-one")).toBe(true);
    });

    it("restricts access to specific namespaces", async () => {
      const { key } = await service.createKey(
        "restricted",
        { read: true, write: true, delete: false, admin: false },
        ["ns1", "ns2"],
      );

      const info = (await service.validateKey(key))!;
      expect(service.checkPermission(info, "read", "ns1")).toBe(true);
      expect(service.checkPermission(info, "read", "ns2")).toBe(true);
      expect(service.checkPermission(info, "read", "ns3")).toBe(false);
    });

    it("allows when no namespace is specified", async () => {
      const { key } = await service.createKey(
        "no-ns",
        { read: true, write: false, delete: false, admin: false },
        ["ns1"],
      );

      const info = (await service.validateKey(key))!;
      // No namespace means no namespace check
      expect(service.checkPermission(info, "read")).toBe(true);
    });
  });

  // ── Get Key ─────────────────────────────────────────────

  describe("getKey", () => {
    it("returns key info by ID", async () => {
      const { id } = await service.createKey(
        "detailed",
        { read: true, write: true, delete: true, admin: false },
        ["ns1", "ns2"],
      );

      const info = await service.getKey(id);
      expect(info).not.toBeNull();
      expect(info!.id).toBe(id);
      expect(info!.name).toBe("detailed");
      expect(info!.permissions.read).toBe(true);
      expect(info!.permissions.write).toBe(true);
      expect(info!.permissions.delete).toBe(true);
      expect(info!.permissions.admin).toBe(false);
      expect(info!.namespaces).toEqual(["ns1", "ns2"]);
      expect(info!.active).toBe(true);
      expect(info!.createdAt).toBeGreaterThan(0);
    });

    it("returns null for non-existent key", async () => {
      const info = await service.getKey("does-not-exist");
      expect(info).toBeNull();
    });
  });
});
