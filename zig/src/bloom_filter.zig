// ── Bloom Filter (SIMD-Accelerated) ──────────────────────────
// Probabilistic set membership using SIMD-parallel hashing.
// Computes multiple hash indices simultaneously via @Vector.
// Falls back to scalar path when SIMD is unavailable or for
// remainder hashes. No false negatives, tunable false-positive
// rate via size and hash count.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const BloomFilter = struct {
    bits: []u8,
    num_bits: u32,
    num_hashes: u8,
    allocator: Allocator,
    items_added: u64 = 0,

    pub fn init(allocator: Allocator, num_bits: u32, num_hashes: u8) !*BloomFilter {
        const self = try allocator.create(BloomFilter);
        const byte_count = (num_bits + 7) / 8;
        const bits = try allocator.alloc(u8, byte_count);
        @memset(bits, 0);
        self.* = .{
            .bits = bits,
            .num_bits = num_bits,
            .num_hashes = num_hashes,
            .allocator = allocator,
        };
        return self;
    }

    pub fn deinit(self: *BloomFilter) void {
        self.allocator.free(self.bits);
        self.allocator.destroy(self);
    }

    // ── SIMD Hash Core ────────────────────────────────────────
    // xxHash-inspired round function processed in 4-wide SIMD lanes.

    const PRIME1: u64 = 0x9E3779B97F4A7C15;
    const PRIME2: u64 = 0x85EBCA6B;
    const PRIME3: u64 = 0xC2B2AE3D;
    const PRIME4: u64 = 0x27D4EB2F;
    const PRIME5: u64 = 0x165667B1;

    const Vec4 = @Vector(4, u64);

    /// Compute base hash using xxHash-style mixing.
    /// Processes data in 32-byte blocks using 4 SIMD accumulators.
    fn xxHashBase(data: []const u8) u64 {
        const len: u64 = data.len;
        var h: u64 = undefined;

        if (data.len >= 32) {
            // Initialize 4 accumulators (SIMD parallel)
            var acc: Vec4 = .{
                PRIME1 +% PRIME2,
                PRIME2,
                0,
                @as(u64, 0) -% PRIME1,
            };

            // Process 32-byte blocks
            var offset: usize = 0;
            while (offset + 32 <= data.len) {
                // Load 4 × u64 from data (little-endian)
                var lanes: Vec4 = undefined;
                inline for (0..4) |lane| {
                    const start = offset + lane * 8;
                    lanes[lane] = std.mem.readInt(u64, data[start..][0..8], .little);
                }

                // xxHash round: acc = (acc + lane * PRIME2) <<< 31 * PRIME1
                const prime2_vec: Vec4 = @splat(PRIME2);
                const prime1_vec: Vec4 = @splat(PRIME1);
                acc = acc +% (lanes *% prime2_vec);
                // Rotate left by 31: (x << 31) | (x >> 33)
                acc = (acc << @splat(31)) | (acc >> @splat(33));
                acc = acc *% prime1_vec;

                offset += 32;
            }

            // Merge accumulators
            h = std.math.rotl(u64, acc[0], 1) +%
                std.math.rotl(u64, acc[1], 7) +%
                std.math.rotl(u64, acc[2], 12) +%
                std.math.rotl(u64, acc[3], 18);

            // Merge each accumulator with a finalization step
            inline for (0..4) |i| {
                const round_val = acc[i] *% PRIME2;
                const rotated = std.math.rotl(u64, round_val, 31) *% PRIME1;
                h ^= rotated;
                h = h *% PRIME1 +% PRIME4;
            }
        } else {
            h = PRIME5;
        }

        h +%= len;

        // Process remaining 8-byte chunks
        var remaining = data;
        if (data.len >= 32) {
            remaining = data[(data.len / 32) * 32 ..];
        }

        var pos: usize = 0;
        while (pos + 8 <= remaining.len) {
            const k1 = std.mem.readInt(u64, remaining[pos..][0..8], .little) *% PRIME2;
            const rotated = std.math.rotl(u64, k1, 31) *% PRIME1;
            h ^= rotated;
            h = std.math.rotl(u64, h, 27) *% PRIME1 +% PRIME4;
            pos += 8;
        }

        // Process remaining 4-byte chunk
        if (pos + 4 <= remaining.len) {
            const k1 = @as(u64, std.mem.readInt(u32, remaining[pos..][0..4], .little)) *% PRIME1;
            h ^= k1;
            h = std.math.rotl(u64, h, 23) *% PRIME2 +% PRIME3;
            pos += 4;
        }

        // Process remaining bytes
        while (pos < remaining.len) {
            h ^= @as(u64, remaining[pos]) *% PRIME5;
            h = std.math.rotl(u64, h, 11) *% PRIME1;
            pos += 1;
        }

        // Avalanche finalization
        h ^= h >> 33;
        h *%= PRIME2;
        h ^= h >> 29;
        h *%= PRIME3;
        h ^= h >> 32;

        return h;
    }

    /// Secondary hash using a different seed for double-hashing.
    fn secondaryHash(data: []const u8) u64 {
        // djb2 — intentionally simple for secondary hash
        var h: u64 = 5381;
        for (data) |byte| {
            h = ((h << 5) +% h) +% byte;
        }
        return h;
    }

    // ── Bit manipulation ──────────────────────────────────────

    fn getBit(self: *const BloomFilter, idx: u32) bool {
        const byte_idx = idx / 8;
        const bit_idx: u3 = @intCast(idx % 8);
        return (self.bits[byte_idx] & (@as(u8, 1) << bit_idx)) != 0;
    }

    fn setBit(self: *BloomFilter, idx: u32) void {
        const byte_idx = idx / 8;
        const bit_idx: u3 = @intCast(idx % 8);
        self.bits[byte_idx] |= (@as(u8, 1) << bit_idx);
    }

    // ── SIMD Batch Index Computation ──────────────────────────
    // Computes 4 hash indices at once using SIMD vectors.

    fn computeIndices4(h1: u64, h2: u64, base_i: u8, num_bits_u64: u64) Vec4 {
        const h1_vec: Vec4 = @splat(h1);
        const h2_vec: Vec4 = @splat(h2);
        const i_vec: Vec4 = .{
            @as(u64, base_i),
            @as(u64, base_i) + 1,
            @as(u64, base_i) + 2,
            @as(u64, base_i) + 3,
        };
        const combined = h1_vec +% (i_vec *% h2_vec);
        const mod_vec: Vec4 = @splat(num_bits_u64);
        return combined % mod_vec;
    }

    // ── Public API ────────────────────────────────────────────

    pub fn add(self: *BloomFilter, data: []const u8) void {
        const h1 = xxHashBase(data);
        const h2 = secondaryHash(data);
        const num_bits_u64: u64 = self.num_bits;

        // Process 4 hashes at a time using SIMD
        var i: u8 = 0;
        while (i + 4 <= self.num_hashes) : (i += 4) {
            const indices = computeIndices4(h1, h2, i, num_bits_u64);
            self.setBit(@intCast(indices[0]));
            self.setBit(@intCast(indices[1]));
            self.setBit(@intCast(indices[2]));
            self.setBit(@intCast(indices[3]));
        }

        // Scalar tail for remaining hashes
        while (i < self.num_hashes) : (i += 1) {
            const combined = h1 +% (@as(u64, i) *% h2);
            const idx: u32 = @intCast(combined % self.num_bits);
            self.setBit(idx);
        }

        self.items_added += 1;
    }

    pub fn check(self: *const BloomFilter, data: []const u8) bool {
        const h1 = xxHashBase(data);
        const h2 = secondaryHash(data);
        const num_bits_u64: u64 = self.num_bits;

        // Process 4 hashes at a time using SIMD
        var i: u8 = 0;
        while (i + 4 <= self.num_hashes) : (i += 4) {
            const indices = computeIndices4(h1, h2, i, num_bits_u64);
            if (!self.getBit(@intCast(indices[0]))) return false;
            if (!self.getBit(@intCast(indices[1]))) return false;
            if (!self.getBit(@intCast(indices[2]))) return false;
            if (!self.getBit(@intCast(indices[3]))) return false;
        }

        // Scalar tail for remaining hashes
        while (i < self.num_hashes) : (i += 1) {
            const combined = h1 +% (@as(u64, i) *% h2);
            const idx: u32 = @intCast(combined % self.num_bits);
            if (!self.getBit(idx)) return false;
        }

        return true;
    }

    pub fn clear(self: *BloomFilter) void {
        @memset(self.bits, 0);
        self.items_added = 0;
    }

    pub fn estimatedFPR(self: *const BloomFilter) f64 {
        const k: f64 = @floatFromInt(self.num_hashes);
        const n: f64 = @floatFromInt(self.items_added);
        const m: f64 = @floatFromInt(self.num_bits);
        const exp_val = @exp(-k * n / m);
        return std.math.pow(f64, 1.0 - exp_val, k);
    }
};
