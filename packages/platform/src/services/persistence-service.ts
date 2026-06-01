// ── Persistence Service ────────────────────────────────────
// Saves and restores cache state to/from disk as JSON snapshots.
// Supports periodic auto-save and on-demand save/load.

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "../utils/logger";
import type { CacheService } from "./cache-service";

const log = logger.child("persistence");

export interface PersistenceConfig {
  enabled: boolean;
  filePath: string;        // path to snapshot file
  intervalMs: number;      // auto-save interval (0 = disabled)
  saveOnShutdown: boolean; // save on SIGINT/SIGTERM
}

export interface SnapshotData {
  version: 1;
  timestamp: number;
  entries: Array<{ key: string; value: string }>;
}

export class PersistenceService {
  private config: PersistenceConfig;
  private cacheService: CacheService | null = null;
  private autoSaveTimer: Timer | null = null;
  private saving = false;

  constructor(config: PersistenceConfig) {
    this.config = config;
  }

  /** Wire up the cache service after construction (avoids circular dependency) */
  attach(cacheService: CacheService): void {
    this.cacheService = cacheService;
  }

  /** Start auto-save interval if configured */
  start(): void {
    if (!this.config.enabled) return;

    // Ensure directory exists
    const dir = dirname(resolve(this.config.filePath));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (this.config.intervalMs > 0) {
      this.autoSaveTimer = setInterval(() => {
        this.save();
      }, this.config.intervalMs);
      this.autoSaveTimer.unref();
      log.info("Auto-save enabled", { intervalMs: this.config.intervalMs });
    }
  }

  stop(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /** Save current cache state to disk */
  save(): boolean {
    if (!this.config.enabled || !this.cacheService || this.saving) return false;
    this.saving = true;

    try {
      const entries = this.cacheService.exportEntries();
      const snapshot: SnapshotData = {
        version: 1,
        timestamp: Date.now(),
        entries,
      };

      const filePath = resolve(this.config.filePath);
      const tmpPath = filePath + ".tmp";

      // Write to temp file first, then atomically rename — prevents corruption
      writeFileSync(tmpPath, JSON.stringify(snapshot));
      renameSync(tmpPath, filePath);

      log.info("Snapshot saved", { entries: entries.length, path: filePath });
      return true;
    } catch (err) {
      log.error("Snapshot save failed", { error: String(err) });
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** Load cache state from disk */
  load(): number {
    if (!this.config.enabled || !this.cacheService) return 0;

    const filePath = resolve(this.config.filePath);
    if (!existsSync(filePath)) {
      log.info("No snapshot file found, starting fresh", { path: filePath });
      return 0;
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const snapshot: SnapshotData = JSON.parse(raw);

      if (snapshot.version !== 1) {
        log.warn("Unknown snapshot version, skipping", { version: snapshot.version });
        return 0;
      }

      let restored = 0;
      for (const entry of snapshot.entries) {
        if (typeof entry.key === "string" && typeof entry.value === "string") {
          if (this.cacheService.setRaw(entry.key, entry.value)) {
            restored++;
          }
        }
      }

      const age = Date.now() - snapshot.timestamp;
      log.info("Snapshot restored", {
        entries: restored,
        total: snapshot.entries.length,
        ageMs: age,
      });
      return restored;
    } catch (err) {
      log.error("Snapshot load failed", { error: String(err) });
      return 0;
    }
  }

  /** Get the resolved snapshot file path */
  getFilePath(): string {
    return resolve(this.config.filePath);
  }

  /** Restore cache from an uploaded snapshot object (does not touch disk) */
  restoreFromSnapshot(snapshot: SnapshotData): number {
    if (!this.cacheService) return 0;

    if (snapshot.version !== 1) {
      log.warn("Unknown snapshot version in upload", { version: snapshot.version });
      return 0;
    }

    let restored = 0;
    for (const entry of snapshot.entries) {
      if (typeof entry.key === "string" && typeof entry.value === "string") {
        if (this.cacheService.setRaw(entry.key, entry.value)) {
          restored++;
        }
      }
    }

    log.info("Snapshot restored from upload", {
      entries: restored,
      total: snapshot.entries.length,
    });
    return restored;
  }
}
