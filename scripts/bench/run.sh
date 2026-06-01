#!/usr/bin/env bash
# ── Dunena Benchmark Runner ─────────────────────────────────
# Convenience script to run all k6 benchmarks sequentially.
#
# Usage:
#   ./scripts/bench/run.sh                    # Run all Dunena benchmarks
#   ./scripts/bench/run.sh --with-redis       # Also run Redis comparison
#   ./scripts/bench/run.sh --only cache-crud  # Run a specific benchmark
#
# Environment:
#   DUNENA_URL       — Dunena server URL (default: http://localhost:3000)
#   REDIS_URL        — Redis HTTP bridge URL (default: http://localhost:7379)
#   K6_OUT           — k6 output flag (e.g., --out json=results.json)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="${SCRIPT_DIR}/k6"
COMPARE_DIR="${SCRIPT_DIR}/compare"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

DUNENA_URL="${DUNENA_URL:-http://localhost:3000}"
REDIS_URL="${REDIS_URL:-http://localhost:7379}"
K6_OUT="${K6_OUT:-}"

RUN_REDIS=false
ONLY=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --with-redis)
      RUN_REDIS=true
      shift
      ;;
    --only)
      ONLY="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--with-redis] [--only <benchmark-name>]"
      echo ""
      echo "Benchmarks: cache-crud, cache-batch, mixed-workload, db-operations, websocket-events"
      echo ""
      echo "Environment variables:"
      echo "  DUNENA_URL  — Server URL (default: http://localhost:3000)"
      echo "  REDIS_URL   — Redis bridge URL (default: http://localhost:7379)"
      echo "  K6_OUT      — Extra k6 output flags"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      exit 1
      ;;
  esac
done

# Check k6 is installed
if ! command -v k6 &> /dev/null; then
  echo -e "${RED}k6 is not installed. Install it from https://k6.io/docs/get-started/installation/${NC}"
  exit 1
fi

# Check Dunena is running
echo -e "${CYAN}Checking Dunena at ${DUNENA_URL}...${NC}"
if ! curl -sf "${DUNENA_URL}/health" > /dev/null 2>&1; then
  echo -e "${RED}Dunena is not running at ${DUNENA_URL}${NC}"
  echo "Start with: bun run start"
  exit 1
fi
echo -e "${GREEN}Dunena is healthy ✓${NC}"
echo ""

run_benchmark() {
  local name="$1"
  local script="$2"
  local extra_env="${3:-}"

  if [[ -n "$ONLY" && "$ONLY" != "$name" ]]; then
    return 0
  fi

  echo -e "${YELLOW}═══════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  Running: ${name}${NC}"
  echo -e "${YELLOW}═══════════════════════════════════════════════${NC}"

  local k6_cmd="k6 run"
  if [[ -n "$K6_OUT" ]]; then
    k6_cmd="$k6_cmd $K6_OUT"
  fi

  if [[ -n "$extra_env" ]]; then
    eval "$extra_env $k6_cmd $script"
  else
    eval "DUNENA_URL=$DUNENA_URL $k6_cmd $script"
  fi

  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}✓ ${name} completed successfully${NC}"
  else
    echo -e "${RED}✗ ${name} failed (exit code: ${exit_code})${NC}"
  fi
  echo ""

  return $exit_code
}

echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       Dunena Benchmark Suite v0.4.0          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

FAILURES=0

# ── Dunena Benchmarks ────────────────────────────────────
run_benchmark "cache-crud" "${K6_DIR}/cache-crud.js" || ((FAILURES++))
run_benchmark "cache-batch" "${K6_DIR}/cache-batch.js" || ((FAILURES++))
run_benchmark "mixed-workload" "${K6_DIR}/mixed-workload.js" || ((FAILURES++))
run_benchmark "db-operations" "${K6_DIR}/db-operations.js" || ((FAILURES++))
run_benchmark "websocket-events" "${K6_DIR}/websocket-events.js" || ((FAILURES++))

# ── Redis Comparison ─────────────────────────────────────
if [[ "$RUN_REDIS" == "true" ]]; then
  echo -e "${CYAN}Running Redis baseline comparison...${NC}"
  echo ""

  # Check Redis bridge is running
  if ! curl -sf "${REDIS_URL}/PING" > /dev/null 2>&1; then
    echo -e "${RED}Redis HTTP bridge is not running at ${REDIS_URL}${NC}"
    echo "Start with: docker run -d -p 7379:7379 nicolas/webdis"
    ((FAILURES++))
  else
    run_benchmark "redis-baseline" "${COMPARE_DIR}/redis-baseline.js" \
      "REDIS_URL=$REDIS_URL" || ((FAILURES++))
  fi
fi

# ── Summary ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}All benchmarks completed successfully ✓${NC}"
else
  echo -e "${RED}${FAILURES} benchmark(s) failed ✗${NC}"
fi
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"

exit $FAILURES
