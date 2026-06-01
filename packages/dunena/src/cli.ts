#!/usr/bin/env bun
// ── Dunena CLI ─────────────────────────────────────────────
// Standalone CLI client for the Dunena cache engine.
// Connects to a running Dunena server over HTTP.
// Install: bunx dunena <command> [args] [flags]

import { readFileSync, writeFileSync } from "fs";

const VERSION = "0.3.1";
const BASE = process.env.DUNENA_URL ?? "http://localhost:3000";
const TOKEN = process.env.DUNENA_AUTH_TOKEN;

// ── Helpers ────────────────────────────────────────────────

function parseFlags(args: string[]): { positional: string[]; ns?: string; json: boolean; format?: string; outputFile?: string } {
  const positional: string[] = [];
  let ns: string | undefined;
  let json = false;
  let format: string | undefined;
  let outputFile: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--ns=")) {
      ns = arg.slice(5);
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--format=")) {
      format = arg.slice(9);
    } else if (arg.startsWith("--output=")) {
      outputFile = arg.slice(9);
    } else {
      positional.push(arg);
    }
  }
  return { positional, ns, json, format, outputFile };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  return h;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return resp.json();
  } catch (err) {
    console.error(`Error: could not connect to ${BASE}${path}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ── Server-only guard ──────────────────────────────────────

function serverOnlyError(cmd: string): never {
  console.error(`
  ❌ '${cmd}' requires the full Dunena installation (Zig native library + monorepo).

  The 'bunx dunena' package provides CLI client commands only.
  To run the server, use one of these methods:

    Docker:       docker compose -f deploy/docker-compose.yml up -d
    Source build:  git clone https://github.com/PowenCu/dunena.git
                  cd dunena && bun install && bun run build:zig && bun run start

  See https://github.com/PowenCu/dunena/blob/main/INSTALL.md
`);
  process.exit(1);
}

// ── Commands ───────────────────────────────────────────────

const [cmd, ...rawArgs] = process.argv.slice(2);
const { positional: args, ns, json: jsonFlag, format: formatFlag, outputFile: outputFlag } = parseFlags(rawArgs);

function output(data: unknown) {
  if (jsonFlag) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function nsQuery(): string {
  return ns ? `?ns=${encodeURIComponent(ns)}` : "";
}

async function main() {
  switch (cmd) {
  // ── Server-only commands (graceful error) ─────────────
  case "start":
  case "dev":
    serverOnlyError(cmd);
    break;

  // ── Cache commands ────────────────────────────────────
  case "get": {
    const [key] = args;
    if (!key) {
      console.error("Usage: dunena get <key> [--ns=namespace]");
      process.exit(1);
    }
    output(await request("GET", `/cache/${encodeURIComponent(key)}${nsQuery()}`));
    break;
  }

  case "set": {
    const [key, value, ttlStr] = args;
    if (!key || value === undefined) {
      console.error("Usage: dunena set <key> <value> [ttl_ms] [--ns=namespace]");
      process.exit(1);
    }
    const body: Record<string, unknown> = { value };
    if (ttlStr) body.ttl = parseInt(ttlStr, 10);
    output(await request("POST", `/cache/${encodeURIComponent(key)}${nsQuery()}`, body));
    break;
  }

  case "del":
  case "delete": {
    const [key] = args;
    if (!key) {
      console.error("Usage: dunena del <key> [--ns=namespace]");
      process.exit(1);
    }
    output(await request("DELETE", `/cache/${encodeURIComponent(key)}${nsQuery()}`));
    break;
  }

  case "mget": {
    if (args.length === 0) {
      console.error("Usage: dunena mget <key1> <key2> ... [--ns=namespace]");
      process.exit(1);
    }
    output(await request("POST", "/cache", { action: "mget", keys: args, ns }));
    break;
  }

  case "mset": {
    if (args.length === 0) {
      console.error("Usage: dunena mset <key=value> [key=value ...] [--ns=namespace]");
      process.exit(1);
    }
    const entries: Array<{ key: string; value: string }> = [];
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (eq < 1) {
        console.error(`Invalid entry "${arg}". Use key=value format.`);
        process.exit(1);
      }
      entries.push({ key: arg.slice(0, eq), value: arg.slice(eq + 1) });
    }
    output(await request("POST", "/cache", { action: "mset", entries, ns }));
    break;
  }

  case "keys":
  case "scan": {
    const pattern = args[0] ?? "*";
    const qs = new URLSearchParams();
    qs.set("pattern", pattern);
    if (ns) qs.set("ns", ns);
    output(await request("GET", `/keys?${qs.toString()}`));
    break;
  }

  case "stats":
    output(await request("GET", "/stats"));
    break;

  case "history":
    output(await request("GET", "/stats/history"));
    break;

  case "flush":
    output(await request("POST", "/flush"));
    break;

  case "info":
    output(await request("GET", "/info"));
    break;

  case "health":
    output(await request("GET", "/health"));
    break;

  case "bench":
  case "benchmark": {
    const count = parseInt(args[0] ?? "1000", 10);
    console.log(`Running benchmark: ${count} SET + ${count} GET operations…\n`);

    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      await request("POST", `/cache/bench-${i}`, {
        value: `value-${i}-${"x".repeat(64)}`,
      });
    }
    const setTime = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < count; i++) {
      await request("GET", `/cache/bench-${i}`);
    }
    const getTime = performance.now() - t1;

    console.log(`SET: ${count} ops in ${setTime.toFixed(1)} ms  (${(count / (setTime / 1000)).toFixed(0)} ops/s)`);
    console.log(`GET: ${count} ops in ${getTime.toFixed(1)} ms  (${(count / (getTime / 1000)).toFixed(0)} ops/s)`);
    console.log(`\nTotal: ${(setTime + getTime).toFixed(1)} ms`);

    // Cleanup
    for (let i = 0; i < count; i++) {
      await request("DELETE", `/cache/bench-${i}`);
    }
    break;
  }

  // ── Database commands ─────────────────────────────────

  case "db-get": {
    const [key] = args;
    if (!key) {
      console.error("Usage: dunena db-get <key> [--ns=namespace]");
      process.exit(1);
    }
    const qs = ns ? `?ns=${encodeURIComponent(ns)}` : "";
    output(await request("GET", `/db/${encodeURIComponent(key)}${qs}`));
    break;
  }

  case "db-set": {
    const [key, value, ttlStr] = args;
    if (!key || value === undefined) {
      console.error("Usage: dunena db-set <key> <value> [ttl_ms] [--ns=namespace]");
      process.exit(1);
    }
    const body: Record<string, unknown> = { value };
    if (ttlStr) body.ttl = parseInt(ttlStr, 10);
    if (ns) body.ns = ns;
    output(await request("POST", `/db/${encodeURIComponent(key)}`, body));
    break;
  }

  case "db-del": {
    const [key] = args;
    if (!key) {
      console.error("Usage: dunena db-del <key> [--ns=namespace]");
      process.exit(1);
    }
    const qs = ns ? `?ns=${encodeURIComponent(ns)}` : "";
    output(await request("DELETE", `/db/${encodeURIComponent(key)}${qs}`));
    break;
  }

  case "db-keys": {
    const pattern = args[0] ?? "*";
    const qs = new URLSearchParams();
    qs.set("pattern", pattern);
    if (ns) qs.set("ns", ns);
    output(await request("GET", `/db-keys?${qs.toString()}`));
    break;
  }

  case "db-stats":
    output(await request("GET", "/db-stats"));
    break;

  case "db-clear":
    output(await request("POST", `/db-clear${ns ? `?ns=${encodeURIComponent(ns)}` : ""}`));
    break;

  case "db-purge":
    output(await request("POST", "/db-purge"));
    break;

  // ── Query Cache commands ──────────────────────────────

  case "qc-get": {
    const [key] = args;
    if (!key) {
      console.error("Usage: dunena qc-get <key>");
      process.exit(1);
    }
    output(await request("GET", `/query-cache/${encodeURIComponent(key)}`));
    break;
  }

  case "qc-set": {
    const [key, dataStr] = args;
    if (!key || !dataStr) {
      console.error("Usage: dunena qc-set <key> <json_data>");
      process.exit(1);
    }
    let data: unknown;
    try {
      data = JSON.parse(dataStr);
    } catch {
      data = dataStr;
    }
    output(await request("POST", "/query-cache", { key, data }));
    break;
  }

  case "qc-invalidate": {
    if (args.length === 0) {
      console.error("Usage: dunena qc-invalidate <tag1> [tag2] ...");
      process.exit(1);
    }
    output(await request("POST", "/query-cache/invalidate", { tags: args }));
    break;
  }

  case "qc-stats":
    output(await request("GET", "/query-cache/stats"));
    break;

  case "qc-clear":
    output(await request("POST", "/query-cache/clear"));
    break;

  // ── Database Proxy commands ───────────────────────────

  case "db-proxy-list":
    output(await request("GET", "/db-proxy/connectors"));
    break;

  case "db-proxy-register": {
    const [name, type, connStr] = args;
    if (!name || !type || !connStr) {
      console.error("Usage: dunena db-proxy-register <name> <type> <connectionString>");
      console.error("       Types: postgresql, mysql, http");
      process.exit(1);
    }
    output(await request("POST", "/db-proxy/register", {
      name, type, connectionString: connStr,
    }));
    break;
  }

  case "db-proxy-query": {
    const [connector, query] = args;
    if (!connector || !query) {
      console.error("Usage: dunena db-proxy-query <connector> <query>");
      process.exit(1);
    }
    output(await request("POST", "/db-proxy/query", { connector, query }));
    break;
  }

  // ── Snapshot & Import/Export commands ─────────────────

  case "snapshot-save": {
    const outPath = args[0] ?? "./dunena-snapshot.json";
    // First trigger a save on the server so the file is fresh
    await request("POST", "/snapshot");
    // Then download the snapshot file
    try {
      const resp = await fetch(`${BASE}/snapshot/download`, { headers: headers() });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        console.error(`Error: ${(err as Record<string, unknown>).error ?? resp.statusText}`);
        process.exit(1);
      }
      const data = await resp.arrayBuffer();
      writeFileSync(outPath, Buffer.from(data));
      console.log(`Snapshot saved to ${outPath} (${data.byteLength} bytes)`);
    } catch (err) {
      console.error(`Error: could not download snapshot from ${BASE}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "snapshot-restore": {
    const [filePath] = args;
    if (!filePath) {
      console.error("Usage: dunena snapshot-restore <path>");
      process.exit(1);
    }
    let fileData: string;
    try {
      fileData = readFileSync(filePath, "utf-8");
    } catch (err) {
      console.error(`Error: could not read file ${filePath}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(fileData);
    } catch {
      console.error("Error: file is not valid JSON");
      process.exit(1);
    }
    try {
      const resp = await fetch(`${BASE}/snapshot/upload`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(snapshot),
      });
      const result = await resp.json();
      output(result);
    } catch (err) {
      console.error(`Error: could not upload snapshot to ${BASE}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "snapshot-list":
    output(await request("GET", "/stats"));
    break;

  case "export": {
    const qs = new URLSearchParams();
    if (formatFlag) qs.set("format", formatFlag);
    if (ns) qs.set("ns", ns);
    const qsStr = qs.toString();

    try {
      const resp = await fetch(`${BASE}/export${qsStr ? `?${qsStr}` : ""}`, {
        headers: headers(),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        console.error(`Error: ${(err as Record<string, unknown>).error ?? resp.statusText}`);
        process.exit(1);
      }
      const body = await resp.text();

      if (outputFlag) {
        writeFileSync(outputFlag, body, "utf-8");
        console.log(`Exported to ${outputFlag} (${body.length} bytes)`);
      } else {
        console.log(body);
      }
    } catch (err) {
      console.error(`Error: could not export from ${BASE}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "import": {
    const [importPath] = args;
    if (!importPath) {
      console.error("Usage: dunena import <file>");
      process.exit(1);
    }
    let importData: string;
    try {
      importData = readFileSync(importPath, "utf-8");
    } catch (err) {
      console.error(`Error: could not read file ${importPath}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    let importBody: unknown;
    try {
      importBody = JSON.parse(importData);
    } catch {
      console.error("Error: file is not valid JSON");
      process.exit(1);
    }
    // Support both { entries: [...] } and raw array [...]
    let entries: unknown[];
    if (Array.isArray(importBody)) {
      entries = importBody;
    } else if (
      importBody !== null &&
      typeof importBody === "object" &&
      Array.isArray((importBody as Record<string, unknown>).entries)
    ) {
      entries = (importBody as Record<string, unknown>).entries as unknown[];
    } else {
      console.error("Error: JSON must be an array or { entries: [...] }");
      process.exit(1);
    }
    output(await request("POST", "/import", { entries }));
    break;
  }

  // ── Doctor ────────────────────────────────────────────

  case "doctor": {
    console.log(`\n  Dunena Doctor — Environment Check (CLI v${VERSION})\n`);

    // 1. Bun version
    const bunVer = typeof Bun !== "undefined" ? Bun.version : null;
    if (bunVer) {
      console.log(`  ✅ Bun runtime:    v${bunVer}`);
    } else {
      console.log("  ⚠️  Bun runtime:    Not detected");
    }

    // 2. Server reachability
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log(`  ✅ Server:         Running at ${BASE}`);
        const info = await fetch(`${BASE}/info`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null);
        if (info && typeof info === "object" && "version" in (info as Record<string, unknown>)) {
          console.log(`  ✅ Server version: v${(info as Record<string, unknown>).version}`);
        }
      } else {
        console.log(`  ⚠️  Server:         Responded with status ${res.status} at ${BASE}`);
      }
    } catch {
      console.log(`  ℹ️  Server:         Not running at ${BASE}`);
    }

    console.log(`\n  CLI version: ${VERSION}`);
    console.log(`  Server URL:  ${BASE}`);
    console.log("");
    break;
  }

  // ── Version ───────────────────────────────────────────

  case "version":
  case "--version":
  case "-v":
    console.log(`dunena v${VERSION}`);
    break;

  // ── Help ──────────────────────────────────────────────

  default:
    console.log(`
  Dunena CLI v${VERSION} — High-Performance Cache Engine

  Usage:  dunena <command> [args] [flags]
          bunx dunena <command> [args] [flags]

  Cache Commands:
    get   <key>                     Get a cached value
    set   <key> <value> [ttl_ms]    Set a cached value
    del   <key>                     Delete a cached value
    mget  <key1> <key2> ...         Get multiple values
    mset  <key=val> [key=val ...]   Set multiple key=value pairs
    keys  [pattern]                 Scan keys (supports * and ? wildcards)
    stats                           Show cache statistics
    history                         Show analytics history
    flush                           Clear all cached data
    info                            Show server info
    health                          Health check
    bench [count]                   Run benchmark (default: 1000)

  Snapshot & Data Commands:
    snapshot-save [path]            Save & download snapshot (default: ./dunena-snapshot.json)
    snapshot-restore <path>         Upload & restore a snapshot file
    snapshot-list                   Show current cache stats (entry count, etc.)
    export [--format=json|csv]      Export all cache entries
           [--output=file]          Write to file instead of stdout
    import <file>                   Import entries from JSON file

  Database Commands:
    db-get   <key>                  Get a durable DB entry
    db-set   <key> <value> [ttl]    Store a durable DB entry
    db-del   <key>                  Delete a DB entry
    db-keys  [pattern]              List DB keys
    db-stats                        Show database statistics
    db-clear                        Clear all DB entries
    db-purge                        Purge expired DB entries

  Query Cache Commands:
    qc-get   <key>                  Get a cached query result
    qc-set   <key> <json>           Cache a query result
    qc-invalidate <tag1> [tag2]     Invalidate by tags
    qc-stats                        Query cache statistics
    qc-clear                        Clear query cache

  Database Proxy Commands:
    db-proxy-list                   List registered connectors
    db-proxy-register <n> <t> <url> Register a connector
    db-proxy-query <conn> <query>   Execute a proxied query

  Diagnostic Commands:
    doctor                          Check environment & server status
    version                         Show CLI version

  Flags:
    --ns=<namespace>    Scope operations to a namespace
    --json              Output compact JSON (for scripting)
    --format=<fmt>      Export format: json (default) or csv
    --output=<path>     Write export output to file

  Environment:
    DUNENA_URL          Server URL (default: http://localhost:3000)
    DUNENA_AUTH_TOKEN    Bearer token for authentication

  More info: https://github.com/PowenCu/dunena
`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
