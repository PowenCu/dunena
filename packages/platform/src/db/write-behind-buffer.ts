// ── Write-Behind Buffer ────────────────────────────────────
// Accumulates mutation queries (INSERT/UPDATE/DELETE) in memory
// and flushes them asynchronously to the upstream database
// connectors. Supports configurable flush intervals, buffer
// size limits, exponential-backoff retries, and per-connector
// batching for efficiency.

import { logger } from "../utils/logger";

const log = logger.child("write-behind");

// ── Types ──────────────────────────────────────────────────

export interface WriteBehindEntry {
  id: string;
  connectorName: string;
  query: string;
  params?: unknown[];
  timestamp: number;
  retryCount: number;
  maxRetries: number;
}

export interface WriteBehindConfig {
  enabled: boolean;
  flushIntervalMs: number;    // default 1000
  maxBufferSize: number;      // default 1000
  retryAttempts: number;      // default 3
  retryDelayMs: number;       // default 500
  onFlushError?: (error: Error, entries: WriteBehindEntry[]) => void;
}

export interface WriteBehindStats {
  pendingWrites: number;
  totalFlushed: number;
  totalFailed: number;
  lastFlushAt: number | null;
  lastFlushDurationMs: number | null;
  lastError: string | null;
}

// ── Default Config ─────────────────────────────────────────

export const DEFAULT_WRITE_BEHIND_CONFIG: WriteBehindConfig = {
  enabled: false,
  flushIntervalMs: 1000,
  maxBufferSize: 1000,
  retryAttempts: 3,
  retryDelayMs: 500,
};

// ── Buffer Implementation ──────────────────────────────────

export class WriteBehindBuffer {
  private buffer: WriteBehindEntry[] = [];
  private flushInterval: Timer | null = null;
  private flushing = false;
  private stats: WriteBehindStats = {
    pendingWrites: 0,
    totalFlushed: 0,
    totalFailed: 0,
    lastFlushAt: null,
    lastFlushDurationMs: null,
    lastError: null,
  };
  private config: WriteBehindConfig;
  private executeFn: (connectorName: string, query: string, params?: unknown[]) => Promise<unknown>;

  constructor(
    config: WriteBehindConfig,
    executeFn: (connectorName: string, query: string, params?: unknown[]) => Promise<unknown>,
  ) {
    this.config = { ...DEFAULT_WRITE_BEHIND_CONFIG, ...config };
    this.executeFn = executeFn;
    log.info("Write-behind buffer initialised", {
      flushIntervalMs: this.config.flushIntervalMs,
      maxBufferSize: this.config.maxBufferSize,
      retryAttempts: this.config.retryAttempts,
    });
  }

  /**
   * Add a write operation to the buffer.
   * If the buffer is full (≥ maxBufferSize), triggers an immediate flush.
   */
  add(connectorName: string, query: string, params?: unknown[]): void {
    const entry: WriteBehindEntry = {
      id: crypto.randomUUID(),
      connectorName,
      query,
      params,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: this.config.retryAttempts,
    };

    this.buffer.push(entry);
    this.stats.pendingWrites = this.buffer.length;

    log.debug("Buffered write-behind entry", {
      id: entry.id,
      connector: connectorName,
      bufferSize: this.buffer.length,
    });

    // Auto-flush when buffer is full
    if (this.buffer.length >= this.config.maxBufferSize) {
      log.info("Buffer full, triggering immediate flush", {
        bufferSize: this.buffer.length,
        maxBufferSize: this.config.maxBufferSize,
      });
      // Fire-and-forget — errors are handled inside flush()
      this.flush().catch(() => {});
    }
  }

  /**
   * Flush all pending writes to their respective connectors.
   * Groups entries by connector name for batch efficiency.
   * Uses exponential backoff for retries.
   * Failed entries beyond maxRetries are logged and dropped.
   */
  async flush(): Promise<{ flushed: number; failed: number }> {
    if (this.flushing) {
      log.debug("Flush already in progress, skipping");
      return { flushed: 0, failed: 0 };
    }

    if (this.buffer.length === 0) {
      return { flushed: 0, failed: 0 };
    }

    this.flushing = true;
    const flushStart = performance.now();
    let flushed = 0;
    let failed = 0;

    // Snapshot and clear buffer so new writes during flush go to a fresh buffer
    const entries = this.buffer.splice(0);
    this.stats.pendingWrites = this.buffer.length;

    // Group by connector for batch efficiency
    const groups = new Map<string, WriteBehindEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.connectorName);
      if (group) {
        group.push(entry);
      } else {
        groups.set(entry.connectorName, [entry]);
      }
    }

    for (const [connectorName, groupEntries] of groups) {
      for (const entry of groupEntries) {
        try {
          await this.executeWithRetry(entry);
          flushed++;
        } catch (err) {
          failed++;
          const error = err instanceof Error ? err : new Error(String(err));
          this.stats.lastError = `[${connectorName}] ${error.message}`;

          log.warn("Write-behind entry permanently failed", {
            id: entry.id,
            connector: connectorName,
            query: entry.query.slice(0, 100),
            retries: entry.retryCount,
            error: error.message,
          });

          // Invoke the error callback if configured
          if (this.config.onFlushError) {
            try {
              this.config.onFlushError(error, [entry]);
            } catch {
              /* swallow callback errors */
            }
          }
        }
      }
    }

    const flushDuration = performance.now() - flushStart;
    this.stats.totalFlushed += flushed;
    this.stats.totalFailed += failed;
    this.stats.lastFlushAt = Date.now();
    this.stats.lastFlushDurationMs = parseFloat(flushDuration.toFixed(3));
    this.stats.pendingWrites = this.buffer.length;

    if (flushed > 0 || failed > 0) {
      log.info("Write-behind flush complete", {
        flushed,
        failed,
        durationMs: this.stats.lastFlushDurationMs,
        remaining: this.buffer.length,
      });
    }

    this.flushing = false;
    return { flushed, failed };
  }

  /**
   * Start periodic flush interval.
   */
  start(): void {
    if (this.flushInterval) {
      log.warn("Write-behind buffer already started");
      return;
    }

    this.flushInterval = setInterval(() => {
      this.flush().catch((err) => {
        log.error("Write-behind periodic flush error", { error: String(err) });
      });
    }, this.config.flushIntervalMs);

    // Don't keep the process alive just for the write-behind timer
    this.flushInterval.unref();

    log.info("Write-behind buffer started", {
      flushIntervalMs: this.config.flushIntervalMs,
    });
  }

  /**
   * Stop the periodic flush interval and perform a final flush.
   */
  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush to drain any remaining entries
    if (this.buffer.length > 0) {
      log.info("Performing final write-behind flush", { pending: this.buffer.length });
      await this.flush();
    }

    log.info("Write-behind buffer stopped", {
      totalFlushed: this.stats.totalFlushed,
      totalFailed: this.stats.totalFailed,
    });
  }

  /**
   * Returns current buffer statistics.
   */
  getStats(): WriteBehindStats {
    return {
      ...this.stats,
      pendingWrites: this.buffer.length,
    };
  }

  /**
   * Returns the count of pending entries.
   */
  getPendingCount(): number {
    return this.buffer.length;
  }

  // ── Private Helpers ────────────────────────────────────

  /**
   * Execute a single entry with exponential-backoff retries.
   * Throws if all retries are exhausted.
   */
  private async executeWithRetry(entry: WriteBehindEntry): Promise<void> {
    while (true) {
      try {
        await this.executeFn(entry.connectorName, entry.query, entry.params);
        return;
      } catch (err) {
        entry.retryCount++;

        if (entry.retryCount > entry.maxRetries) {
          throw err;
        }

        // Exponential backoff: retryDelayMs * 2^(retryCount-1)
        const delay = this.config.retryDelayMs * Math.pow(2, entry.retryCount - 1);
        log.debug("Retrying write-behind entry", {
          id: entry.id,
          connector: entry.connectorName,
          attempt: entry.retryCount,
          maxRetries: entry.maxRetries,
          delayMs: delay,
        });

        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
