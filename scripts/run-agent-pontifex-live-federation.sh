#!/usr/bin/env bash
# Start the pinned Rust bridge/coordinator and run the four-agent federation lane.
#
# This script intentionally does not enable GitHub, Linear, telemetry, email, or
# repository-administration mutation. Provider credentials are read by the Rust
# coordinator from environment variables and are never echoed by this harness.
set -euo pipefail
umask 077

mode="${1:-}"
evidence_path="${2:-}"
case "$mode" in
  mock|live) ;;
  *)
    printf 'usage: %s <mock|live> <evidence-path>\n' "$0" >&2
    exit 2
    ;;
esac
if [[ -z "$evidence_path" ]]; then
  printf 'evidence path is required\n' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/agent-pontifex-live-federation.json"
bridge_source="${BRIDGE_SOURCE_DIR:-$repo_root/sources/bridge}"
coordinator_source="${COORDINATOR_SOURCE_DIR:-$repo_root/sources/coordinator}"
run_root="${RUN_ROOT:-${RUNNER_TEMP:-/tmp}/agent-pontifex-live-federation}"
bridge_url="${BRIDGE_URL:-http://127.0.0.1:18142}"
coordinator_url="${COORDINATOR_URL:-http://127.0.0.1:18080}"
mock_origin="${MOCK_PROVIDER_ORIGIN:-http://127.0.0.1:19990}"
config_path="$run_root/coordinator-$mode.json"
bridge_log="$run_root/bridge.log"
coordinator_log="$run_root/coordinator.log"
mock_log="$run_root/mock-provider.log"
bridge_pid=""
coordinator_pid=""
mock_pid=""
mkdir -p "$run_root" "$(dirname "$evidence_path")" "$run_root/bridge-state"

required_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'required environment variable is unset: %s\n' "$name" >&2
    exit 1
  fi
}

required_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    printf 'required file is missing: %s\n' "$path" >&2
    exit 1
  fi
}

required_env BRIDGE_BEARER
required_env COORDINATOR_BEARER
required_env AI_AGENT_COORDINATOR_DATABASE_URL
required_env GITHUB_WEBHOOK_SECRET
if [[ "$mode" == mock ]]; then
  required_env MOCK_PROVIDER_API_KEY
else
  required_env XAI_API_KEY
  required_env GEMINI_API_KEY
  required_env ANTHROPIC_API_KEY
  required_env OPENAI_API_KEY
fi
required_file "$manifest"
required_file "$bridge_source/Cargo.toml"
required_file "$coordinator_source/Cargo.toml"
required_file "$coordinator_source/tests/fixtures/ai_agent_coordinator.schema.sql"

python3 - "$manifest" "$bridge_source" "$coordinator_source" <<'PYVERIFY'
import json
import subprocess
import sys
from pathlib import Path

manifest_path, bridge_source, coordinator_source = map(Path, sys.argv[1:])
manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
for source_name, source_path in (
    ("bridge", bridge_source),
    ("coordinator", coordinator_source),
):
    expected = manifest_data["sources"][source_name]["revision"]
    observed = subprocess.check_output(
        ["git", "-C", str(source_path), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    if observed != expected:
        raise SystemExit(
            f"{source_name} revision mismatch: expected {expected}, observed {observed}"
        )
print("immutable Agent Pontifex source pins verified")
PYVERIFY

print_diagnostics() {
  local status="$1"
  if [[ "$status" -eq 0 ]]; then
    return
  fi
  for pair in \
    "bridge:$bridge_log" \
    "coordinator:$coordinator_log" \
    "mock-provider:$mock_log"; do
    local name="${pair%%:*}"
    local path="${pair#*:}"
    if [[ -f "$path" ]]; then
      printf -- '--- %s diagnostics ---\n' "$name" >&2
      tail -n 250 "$path" >&2 || true
    fi
  done
}

cleanup() {
  local status=$?
  for pid in "$bridge_pid" "$coordinator_pid" "$mock_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  print_diagnostics "$status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_http() {
  local url="$1"
  local pid="$2"
  local log_path="$3"
  local attempts="${4:-180}"
  local index
  for ((index = 1; index <= attempts; index += 1)); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      printf 'service exited before becoming ready: %s\n' "$url" >&2
      if [[ -f "$log_path" ]]; then
        tail -n 250 "$log_path" >&2 || true
      fi
      return 1
    fi
    sleep 1
  done
  printf 'service readiness timed out: %s\n' "$url" >&2
  if [[ -f "$log_path" ]]; then
    tail -n 250 "$log_path" >&2 || true
  fi
  return 1
}

python3 "$repo_root/scripts/render-agent-pontifex-live-federation-config.py" \
  --manifest "$manifest" \
  --mode "$mode" \
  --output "$config_path" \
  --mock-origin "$mock_origin"
python3 -m json.tool "$config_path" >/dev/null

schema="$coordinator_source/tests/fixtures/ai_agent_coordinator.schema.sql"
docker run --rm \
  --network host \
  --env PGPASSWORD=postgres \
  --volume "$schema:/schema.sql:ro" \
  postgres:17 \
  psql \
    --host 127.0.0.1 \
    --username postgres \
    --dbname coordinator \
    --set ON_ERROR_STOP=1 \
    --file /schema.sql \
    >/dev/null

if [[ "$mode" == mock ]]; then
  MOCK_PROVIDER_API_KEY="$MOCK_PROVIDER_API_KEY" \
    python3 "$repo_root/scripts/mock-openai-federation.py" \
      --manifest "$manifest" \
      --bind 127.0.0.1 \
      --port 19990 \
      >"$mock_log" 2>&1 &
  mock_pid=$!
  wait_http "$mock_origin/healthz" "$mock_pid" "$mock_log" 60
fi

(
  cd "$bridge_source"
  HOST=127.0.0.1 \
  HTTP_PORT=18142 \
  TCP_PORT=18143 \
  API_AUTH_BEARER="$BRIDGE_BEARER" \
  AI_AGENT_BRIDGE_DIR="$run_root/bridge-state" \
  RUST_LOG=info \
    cargo run --locked --bin fiducia-ai-agent-bridge
) >"$bridge_log" 2>&1 &
bridge_pid=$!
wait_http "$bridge_url/healthz" "$bridge_pid" "$bridge_log" 240

COORDINATOR_API_TOKEN="$COORDINATOR_BEARER" \
AI_AGENT_COORDINATOR_DATABASE_URL="$AI_AGENT_COORDINATOR_DATABASE_URL" \
GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" \
GITHUB_REPOSITORY_ADMIN_ENABLED=false \
LINEAR_DELIVERY_ENABLED=false \
TELEMETRY_AUTOMATION_ENABLED=false \
EMAIL_ATTENTION_ENABLED=false \
RUST_LOG=info \
  cargo run \
    --manifest-path "$coordinator_source/Cargo.toml" \
    --locked \
    --bin ai-agent-coordinator \
    -- \
    --config "$config_path" \
    >"$coordinator_log" 2>&1 &
coordinator_pid=$!
wait_http "$coordinator_url/readyz" "$coordinator_pid" "$coordinator_log" 300

python3 "$repo_root/scripts/run-agent-pontifex-live-ring.py" \
  --manifest "$manifest" \
  --bridge-url "$bridge_url" \
  --coordinator-url "$coordinator_url" \
  --output "$evidence_path" \
  --event-timeout-seconds 90
python3 -m json.tool "$evidence_path" >/dev/null
