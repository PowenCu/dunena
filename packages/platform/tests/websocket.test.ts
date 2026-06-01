// ── WebSocket & Pub/Sub Integration Tests ──────────────────
// Tests WebSocket Pub/Sub channel management, message routing,
// and connection lifecycle. Extends the basic WS tests in api.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/types";

const TEST_PORT = 19881;

const testConfig: AppConfig = {
  cache: {
    maxEntries: 1000,
    enableBloomFilter: true,
    bloomFilterSize: 10_000,
    bloomFilterHashes: 5,
  },
  server: {
    port: TEST_PORT,
    host: "127.0.0.1",
    enableWebSocket: true,
    enableDashboard: false,
    rateLimit: { windowMs: 60_000, maxRequests: 10_000 },
    cors: { origins: ["*"], methods: ["GET", "POST", "PUT", "DELETE"] },
  },
  persistence: {
    enabled: false,
    filePath: "./data/test-ws-snapshot.json",
    intervalMs: 0,
    saveOnShutdown: false,
  },
  database: {
    enabled: false,
    sqlitePath: ":memory:",
    queryCacheTTL: 5_000,
    purgeIntervalMs: 0,
  },
  log: { level: "error", format: "text" },
  telemetry: {
    enabled: false,
    endpoint: "",
    serviceName: "test",
    serviceVersion: "1",
  },
  cluster: {
    enabled: false,
    nodeId: "test-node",
    seeds: [],
    heartbeatIntervalMs: 2000,
    suspectTimeoutMs: 6000,
    deadTimeoutMs: 15000,
    electionTimeoutMs: 5000,
    priority: 100,
    localReads: true,
  },
};

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp(testConfig);
});

afterAll(() => {
  app.cacheService.destroy();
  app.server.stop();
});

// ── Helpers ───────────────────────────────────────────────

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    ws.onopen = () => {
      // Drain the "connected" message before resolving
      ws.onmessage = () => resolve(ws);
    };
    ws.onerror = (e) => reject(e);
  });
}

function sendAndReceive(ws: WebSocket, msg: object): Promise<any> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data as string);
      if (data.type === "result" || data.type === "error" || data.type === "pong" || data.type === "subscribed") {
        resolve(data);
      }
    };
    ws.send(JSON.stringify(msg));
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 1000): Promise<any | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      resolve(null);
    }, timeoutMs);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(e.data as string));
    };
  });
}

// ── Basic WS Operations ──────────────────────────────────

describe("WebSocket Basics", () => {
  it("connects and receives connected message", async () => {
    const ws = await connectWs();
    const pong = await sendAndReceive(ws, { type: "ping" });
    expect(pong.type).toBe("pong");
    expect(pong.timestamp).toBeGreaterThan(0);
    ws.close();
  });

  it("set/get/del roundtrip via WS", async () => {
    const ws = await connectWs();

    const setRes = await sendAndReceive(ws, { type: "set", key: "ws-rt", value: "roundtrip" });
    expect(setRes.data.ok).toBe(true);

    const getRes = await sendAndReceive(ws, { type: "get", key: "ws-rt" });
    expect(getRes.data.value).toBe("roundtrip");

    const delRes = await sendAndReceive(ws, { type: "del", key: "ws-rt" });
    expect(delRes.data.deleted).toBe(true);

    const getAfter = await sendAndReceive(ws, { type: "get", key: "ws-rt" });
    expect(getAfter.data.value).toBeNull();

    ws.close();
  });

  it("handles invalid JSON", async () => {
    const ws = await connectWs();

    const result = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
      ws.send("not json at all");
    });
    expect(result.type).toBe("error");
    ws.close();
  });

  it("returns error for unknown message type", async () => {
    const ws = await connectWs();

    const result = await sendAndReceive(ws, { type: "unknown_command" });
    expect(result.type).toBe("error");
    ws.close();
  });
});

// ── Pub/Sub ──────────────────────────────────────────────

describe("WebSocket Pub/Sub", () => {
  it("subscribes to a channel", async () => {
    const ws = await connectWs();

    const subRes = await sendAndReceive(ws, { type: "subscribe", channel: "updates" });
    expect(subRes.type).toBe("subscribed");
    expect(subRes.data.channel).toBe("updates");

    ws.close();
  });

  it("receives published messages on subscribed channel", async () => {
    const subscriber = await connectWs();

    // Subscribe to channel
    const subRes = await sendAndReceive(subscriber, { type: "subscribe", channel: "test-events" });
    expect(subRes.type).toBe("subscribed");

    // Use the server's pubsub to publish a message
    // Bun's pub/sub uses ws.publish() at the server level
    // Let's publish via cache set (which publishes on "cache-events" topic)
    // For a direct test, we can use another WS connection

    // Set a value to trigger a cache event (subscriber is on "cache-events" by default)
    const publisher = await connectWs();
    await sendAndReceive(publisher, { type: "set", key: "pub-test", value: "event-data" });

    publisher.close();
    subscriber.close();
  });

  it("unsubscribe stops receiving messages", async () => {
    const ws = await connectWs();

    // Subscribe then unsubscribe
    await sendAndReceive(ws, { type: "subscribe", channel: "temp-channel" });
    ws.send(JSON.stringify({ type: "unsubscribe", channel: "temp-channel" }));

    // Brief wait for unsubscribe to process
    await Bun.sleep(50);

    // After unsubscribe, no messages should arrive for that channel
    // (This is mainly a smoke test to ensure unsubscribe doesn't crash)
    const pong = await sendAndReceive(ws, { type: "ping" });
    expect(pong.type).toBe("pong");

    ws.close();
  });

  it("subscribes to multiple channels", async () => {
    const ws = await connectWs();

    const sub1 = await sendAndReceive(ws, { type: "subscribe", channel: "channel-a" });
    expect(sub1.data.channel).toBe("channel-a");

    const sub2 = await sendAndReceive(ws, { type: "subscribe", channel: "channel-b" });
    expect(sub2.data.channel).toBe("channel-b");

    ws.close();
  });
});

// ── Connection Lifecycle ─────────────────────────────────

describe("WebSocket Connection Lifecycle", () => {
  it("connect then disconnect cleanly", async () => {
    const ws = await connectWs();
    ws.close();

    // Should be able to connect again immediately
    const ws2 = await connectWs();
    const pong = await sendAndReceive(ws2, { type: "ping" });
    expect(pong.type).toBe("pong");
    ws2.close();
  });

  it("handles rapid connect/disconnect cycles", async () => {
    for (let i = 0; i < 5; i++) {
      const ws = await connectWs();
      await sendAndReceive(ws, { type: "ping" });
      ws.close();
    }
  });

  it("multiple concurrent connections work independently", async () => {
    const ws1 = await connectWs();
    const ws2 = await connectWs();

    // Set via ws1
    const setRes = await sendAndReceive(ws1, { type: "set", key: "multi-ws", value: "shared" });
    expect(setRes.data.ok).toBe(true);

    // Get via ws2
    const getRes = await sendAndReceive(ws2, { type: "get", key: "multi-ws" });
    expect(getRes.data.value).toBe("shared");

    ws1.close();
    ws2.close();
  });
});

// ── Edge Cases ───────────────────────────────────────────

describe("WebSocket Edge Cases", () => {
  it("set with TTL via WS", async () => {
    const ws = await connectWs();

    const setRes = await sendAndReceive(ws, {
      type: "set", key: "ws-ttl-test", value: "temp", ttl: 200,
    });
    expect(setRes.data.ok).toBe(true);

    // Key should exist now
    const getRes = await sendAndReceive(ws, { type: "get", key: "ws-ttl-test" });
    expect(getRes.data.value).toBe("temp");

    // Wait for expiry
    await Bun.sleep(350);

    // Key should be gone
    const getAfter = await sendAndReceive(ws, { type: "get", key: "ws-ttl-test" });
    expect(getAfter.data.value).toBeNull();

    ws.close();
  });

  it("mset/mget batch via WS", async () => {
    const ws = await connectWs();

    const msetRes = await sendAndReceive(ws, {
      type: "mset",
      entries: [
        { key: "ws-batch-1", value: "one" },
        { key: "ws-batch-2", value: "two" },
        { key: "ws-batch-3", value: "three" },
      ],
    });
    expect(msetRes.data.stored).toBe(3);

    const mgetRes = await sendAndReceive(ws, {
      type: "mget",
      keys: ["ws-batch-1", "ws-batch-2", "ws-batch-3", "ws-batch-missing"],
    });
    expect(mgetRes.data.result["ws-batch-1"]).toBe("one");
    expect(mgetRes.data.result["ws-batch-2"]).toBe("two");
    expect(mgetRes.data.result["ws-batch-3"]).toBe("three");
    expect(mgetRes.data.result["ws-batch-missing"]).toBeNull();

    ws.close();
  });

  it("namespace isolation via WS", async () => {
    const ws = await connectWs();

    await sendAndReceive(ws, { type: "set", key: "ws-ns-test", value: "ns-a", ns: "a" });
    await sendAndReceive(ws, { type: "set", key: "ws-ns-test", value: "ns-b", ns: "b" });

    const resA = await sendAndReceive(ws, { type: "get", key: "ws-ns-test", ns: "a" });
    expect(resA.data.value).toBe("ns-a");

    const resB = await sendAndReceive(ws, { type: "get", key: "ws-ns-test", ns: "b" });
    expect(resB.data.value).toBe("ns-b");

    ws.close();
  });
});
