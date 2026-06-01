// ── Dunena k6 Benchmark: WebSocket Events ──────────────────
// Measures WebSocket message throughput and roundtrip latency.
//
// Usage:
//   k6 run scripts/bench/k6/websocket-events.js
//   k6 run scripts/bench/k6/websocket-events.js --vus 20

import { check, sleep } from "k6";
import ws from "k6/ws";
import { Counter, Trend } from "k6/metrics";
import { config } from "./config.js";

// Custom metrics
const wsRoundtrip = new Trend("ws_roundtrip_ms", true);
const wsMessages = new Counter("ws_messages_total");
const wsErrors = new Counter("ws_errors_total");

export const options = {
  stages: [
    { duration: "5s", target: 10 },   // ramp up
    { duration: "20s", target: 20 },   // sustain
    { duration: "5s", target: 0 },     // ramp down
  ],
  thresholds: {
    ws_roundtrip_ms: ["p(95)<15", "p(99)<30"],
    ws_errors_total: ["count<10"],
  },
};

const wsUrl = (config.baseUrl || "http://localhost:3000")
  .replace("http://", "ws://")
  .replace("https://", "wss://") + "/ws";

export default function () {
  const res = ws.connect(wsUrl, {}, function (socket) {
    let messageId = 0;
    let pendingTimestamp = 0;

    socket.on("open", function () {
      // Wait for "connected" message
    });

    socket.on("message", function (rawMsg) {
      let msg;
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        wsErrors.add(1);
        return;
      }

      if (msg.type === "connected") {
        // Start sending operations after connection handshake
        runBenchmark(socket);
        return;
      }

      if (msg.type === "result" || msg.type === "pong") {
        const now = Date.now();
        if (pendingTimestamp > 0) {
          wsRoundtrip.add(now - pendingTimestamp);
          pendingTimestamp = 0;
        }
        wsMessages.add(1);
      }

      if (msg.type === "error") {
        wsErrors.add(1);
      }
    });

    socket.on("error", function () {
      wsErrors.add(1);
    });

    function runBenchmark(sock) {
      const OPS_PER_VU = 100;
      let opsCompleted = 0;

      function sendNext() {
        if (opsCompleted >= OPS_PER_VU) {
          // All operations done, close
          sock.close();
          return;
        }

        messageId++;
        opsCompleted++;
        pendingTimestamp = Date.now();
        const opType = Math.random();

        if (opType < 0.1) {
          // 10% ping
          sock.send(JSON.stringify({ type: "ping" }));
        } else if (opType < 0.5) {
          // 40% set
          sock.send(JSON.stringify({
            type: "set",
            key: `ws-bench-${__VU}-${messageId}`,
            value: `ws-val-${messageId}-${"w".repeat(32)}`,
          }));
        } else if (opType < 0.9) {
          // 40% get
          sock.send(JSON.stringify({
            type: "get",
            key: `ws-bench-${__VU}-${Math.floor(Math.random() * messageId) + 1}`,
          }));
        } else {
          // 10% del
          sock.send(JSON.stringify({
            type: "del",
            key: `ws-bench-${__VU}-${Math.floor(Math.random() * messageId) + 1}`,
          }));
        }
      }

      // Use socket.setInterval to space out operations slightly
      sock.setInterval(function () {
        sendNext();
      }, 10); // 10ms between ops = ~100 ops/sec per VU
    }

    // Keep the connection alive for the full operation set
    socket.setTimeout(function () {
      socket.close();
    }, 30000); // 30s max per connection
  });

  check(res, {
    "WebSocket connected successfully": (r) => r && r.status === 101,
  });
}
