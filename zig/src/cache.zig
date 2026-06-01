// ── Dunena Cache Engine ────────────────────────────────────
// LRU/LFU cache backed by a hash map and a doubly-linked list.
// All keys and values are arbitrary byte slices; the cache
// owns copies of both and frees them on eviction / destroy.
//
// Features:
// - Memory usage tracking (bytes used by keys + values)
// - Atomic increment/decrement for numeric values
// - Compare-and-swap (CAS) with version tracking
// - Switchable eviction policy (LRU / LFU)

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;

fn nanoTimestamp() i128 {
    if (builtin.os.tag == .windows) {
        const windows = std.os.windows;
        const KERNEL32 = struct {
            extern "kernel32" fn GetSystemTimeAsFileTime(lpFileTime: *windows.FILETIME) callconv(.winapi) void;
        };
        var ft: windows.FILETIME = undefined;
        KERNEL32.GetSystemTimeAsFileTime(&ft);
        const file_time = (@as(u64, ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        const epoch_100ns = file_time -% 116444736000000000;
        return @as(i128, epoch_100ns) * 100;
    } else {
        var ts: std.posix.timespec = undefined;
        std.posix.clock_gettime(std.posix.CLOCK.REALTIME, &ts) catch {
            return 0;
        };
        return @as(i128, ts.tv_sec) * 1_000_000_000 + ts.tv_nsec;
    }
}


pub const EvictionPolicy = enum(u8) {
    lru = 0, // Least Recently Used (default)
    lfu = 1, // Least Frequently Used
    arc = 2, // Adaptive Replacement Cache (hybrid LRU/LFU)
};

pub const CacheEntry = struct {
    key: []u8,
    value: []u8,
    prev: ?*CacheEntry = null,
    next: ?*CacheEntry = null,
    created_at_ns: i128,
    version: u64 = 1, // CAS version tracking
    access_count: u64 = 0, // LFU frequency tracking
};

pub const CacheStats = struct {
    hits: u64 = 0,
    misses: u64 = 0,
    evictions: u64 = 0,
    puts: u64 = 0,
    deletes: u64 = 0,
    current_size: u64 = 0,
    max_size: u64 = 0,
    memory_bytes: u64 = 0, // Total memory used by keys + values
    cas_hits: u64 = 0, // Successful CAS operations
    cas_misses: u64 = 0, // Failed CAS operations (version mismatch)
};

pub const Cache = struct {
    allocator: Allocator,
    map: std.StringHashMap(*CacheEntry),
    head: ?*CacheEntry = null, // most-recently used (LRU) / most-frequently used (LFU)
    tail: ?*CacheEntry = null, // least-recently used (LRU) / least-frequently used (LFU)
    max_entries: u32,
    stats: CacheStats,
    eviction_policy: EvictionPolicy,

    // ── Lifecycle ──────────────────────────────────────────

    pub fn init(allocator: Allocator, max_entries: u32) !*Cache {
        return initWithPolicy(allocator, max_entries, .lru);
    }

    pub fn initWithPolicy(allocator: Allocator, max_entries: u32, policy: EvictionPolicy) !*Cache {
        const self = try allocator.create(Cache);
        self.* = .{
            .allocator = allocator,
            .map = std.StringHashMap(*CacheEntry).init(allocator),
            .max_entries = max_entries,
            .stats = CacheStats{ .max_size = max_entries },
            .eviction_policy = policy,
        };
        return self;
    }

    pub fn deinit(self: *Cache) void {
        self.freeAllEntries();
        self.map.deinit();
        self.allocator.destroy(self);
    }

    // ── Core Operations ────────────────────────────────────

    pub fn put(self: *Cache, key: []const u8, value: []const u8) !void {
        self.stats.puts += 1;

        if (self.map.get(key)) |existing| {
            // Update memory tracking
            self.stats.memory_bytes -= existing.value.len;
            self.allocator.free(existing.value);
            existing.value = try self.allocator.dupe(u8, value);
            self.stats.memory_bytes += existing.value.len;
            existing.version += 1;
            existing.access_count += 1;
            self.promoteEntry(existing);
            return;
        }

        while (self.stats.current_size >= self.max_entries) {
            self.evictOne();
        }

        const entry = try self.allocator.create(CacheEntry);
        const key_copy = try self.allocator.dupe(u8, key);
        const val_copy = try self.allocator.dupe(u8, value);
        entry.* = .{
            .key = key_copy,
            .value = val_copy,
            .created_at_ns = nanoTimestamp(),
            .version = 1,
            .access_count = 1,
        };
        try self.map.put(key_copy, entry);
        self.pushFront(entry);
        self.stats.current_size += 1;
        self.stats.memory_bytes += key_copy.len + val_copy.len;
    }

    /// Compare-and-swap: only update if current version matches expected_version
    /// Returns: 0 = success, -1 = key not found, -2 = version mismatch
    pub fn casPut(self: *Cache, key: []const u8, value: []const u8, expected_version: u64) !i32 {
        if (self.map.get(key)) |existing| {
            if (existing.version != expected_version) {
                self.stats.cas_misses += 1;
                return -2; // version mismatch
            }
            // Update memory tracking
            self.stats.memory_bytes -= existing.value.len;
            self.allocator.free(existing.value);
            existing.value = try self.allocator.dupe(u8, value);
            self.stats.memory_bytes += existing.value.len;
            existing.version += 1;
            existing.access_count += 1;
            self.stats.cas_hits += 1;
            self.stats.puts += 1;
            self.promoteEntry(existing);
            return 0;
        }
        return -1; // key not found
    }

    pub fn get(self: *Cache, key: []const u8) ?[]const u8 {
        if (self.map.get(key)) |entry| {
            self.stats.hits += 1;
            entry.access_count += 1;
            self.promoteEntry(entry);
            return entry.value;
        }
        self.stats.misses += 1;
        return null;
    }

    /// Get the version number for a key (for CAS operations)
    pub fn getVersion(self: *Cache, key: []const u8) ?u64 {
        if (self.map.get(key)) |entry| {
            return entry.version;
        }
        return null;
    }

    /// Atomic increment: parse value as i64, add delta, store back
    /// Returns the new value, or error if key not found or not a number
    pub fn incr(self: *Cache, key: []const u8, delta: i64) !i64 {
        if (self.map.get(key)) |entry| {
            // Parse current value as i64
            const current = std.fmt.parseInt(i64, entry.value, 10) catch return error.NotANumber;
            const new_val = current + delta;

            // Format new value
            var buf: [32]u8 = undefined;
            const new_str = std.fmt.bufPrint(&buf, "{d}", .{new_val}) catch return error.FormatError;

            // Update memory tracking
            self.stats.memory_bytes -= entry.value.len;
            self.allocator.free(entry.value);
            entry.value = try self.allocator.dupe(u8, new_str);
            self.stats.memory_bytes += entry.value.len;
            entry.version += 1;
            entry.access_count += 1;
            self.promoteEntry(entry);
            return new_val;
        }
        return error.KeyNotFound;
    }

    pub fn delete(self: *Cache, key: []const u8) bool {
        const kv = self.map.fetchRemove(key) orelse return false;
        const entry = kv.value;
        self.detach(entry);
        self.stats.memory_bytes -= entry.key.len + entry.value.len;
        self.allocator.free(entry.key);
        self.allocator.free(entry.value);
        self.allocator.destroy(entry);
        self.stats.current_size -= 1;
        self.stats.deletes += 1;
        return true;
    }

    pub fn contains(self: *Cache, key: []const u8) bool {
        return self.map.contains(key);
    }

    pub fn count(self: *Cache) u32 {
        return @intCast(self.stats.current_size);
    }

    pub fn clear(self: *Cache) void {
        self.freeAllEntries();
        self.map.clearAndFree();
        self.head = null;
        self.tail = null;
        self.stats.current_size = 0;
        self.stats.memory_bytes = 0;
    }

    pub fn getStats(self: *Cache) CacheStats {
        return self.stats;
    }

    pub fn getEvictionPolicy(self: *Cache) EvictionPolicy {
        return self.eviction_policy;
    }

    // ── Linked-list helpers ────────────────────────────────

    /// Promote an entry based on eviction policy
    fn promoteEntry(self: *Cache, entry: *CacheEntry) void {
        switch (self.eviction_policy) {
            .lru => {
                // LRU: move to front (most recently used)
                self.detach(entry);
                self.pushFront(entry);
            },
            .lfu => {
                // LFU: reorder based on access_count
                // Move entry forward while its access_count > prev's access_count
                self.reorderByFrequency(entry);
            },
            .arc => {
                // ARC: hybrid strategy — entries with high frequency stay at front,
                // but recently accessed entries get a boost. This approximates
                // the adaptive behavior of true ARC by balancing recency and frequency.
                if (entry.access_count > 3) {
                    // Frequently accessed: promote by frequency (like LFU)
                    self.reorderByFrequency(entry);
                } else {
                    // Infrequently accessed: promote by recency (like LRU)
                    self.detach(entry);
                    self.pushFront(entry);
                }
            },
        }
    }

    /// LFU reordering: bubble entry towards head based on access count
    fn reorderByFrequency(self: *Cache, entry: *CacheEntry) void {
        // Keep moving entry towards head while it has higher frequency than prev
        while (entry.prev) |prev| {
            if (entry.access_count <= prev.access_count) break;
            // Swap positions in the list
            self.swapWithPrev(entry);
        }
    }

    fn swapWithPrev(self: *Cache, entry: *CacheEntry) void {
        const prev = entry.prev orelse return;

        // Update pointers
        if (prev.prev) |pp| {
            pp.next = entry;
        } else {
            self.head = entry;
        }

        if (entry.next) |en| {
            en.prev = prev;
        } else {
            self.tail = prev;
        }

        entry.prev = prev.prev;
        prev.next = entry.next;
        prev.prev = entry;
        entry.next = prev;
    }

    fn detach(self: *Cache, entry: *CacheEntry) void {
        if (entry.prev) |p| {
            p.next = entry.next;
        } else {
            self.head = entry.next;
        }
        if (entry.next) |n| {
            n.prev = entry.prev;
        } else {
            self.tail = entry.prev;
        }
        entry.prev = null;
        entry.next = null;
    }

    fn pushFront(self: *Cache, entry: *CacheEntry) void {
        entry.prev = null;
        entry.next = self.head;
        if (self.head) |h| h.prev = entry;
        self.head = entry;
        if (self.tail == null) self.tail = entry;
    }

    fn evictOne(self: *Cache) void {
        const victim = self.tail orelse return;
        self.detach(victim);
        _ = self.map.remove(victim.key);
        self.stats.memory_bytes -= victim.key.len + victim.value.len;
        self.allocator.free(victim.key);
        self.allocator.free(victim.value);
        self.allocator.destroy(victim);
        self.stats.evictions += 1;
        self.stats.current_size -= 1;
    }

    fn freeAllEntries(self: *Cache) void {
        var node = self.head;
        while (node) |n| {
            const next = n.next;
            self.allocator.free(n.key);
            self.allocator.free(n.value);
            self.allocator.destroy(n);
            node = next;
        }
        self.head = null;
        self.tail = null;
    }
};
