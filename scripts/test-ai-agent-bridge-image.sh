#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_PATH="${1:-${ROOT_DIR}/ai-agent-bridge-image-contract.json}"
HTTP_PORT="${AI_AGENT_BRIDGE_TEST_HTTP_PORT:-18142}"
TCP_PORT="${AI_AGENT_BRIDGE_TEST_TCP_PORT:-18143}"
TOKEN="synthetic-test-org-bridge-bearer-7f3d94d9"
INVALID_TOKEN="synthetic-invalid-bridge-bearer-91a8c62e"
CONTAINER_NAME="ai-agent-bridge-image-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
WORK_DIR="$(mktemp -d)"
LOG_PATH="${WORK_DIR}/container.log"
SSE_PATH="${WORK_DIR}/stream.log"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command is unavailable: $1" >&2
    exit 1
  }
}

for command in curl docker jq python3; do
  require "${command}"
done

cleanup() {
  local status=$?
  if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    docker logs "${CONTAINER_NAME}" >"${LOG_PATH}" 2>&1 || true
    if (( status != 0 )); then
      echo "--- published bridge container logs ---" >&2
      sed -n '1,240p' "${LOG_PATH}" >&2 || true
    fi
    docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"
  trap - EXIT
  exit "${status}"
}
trap cleanup EXIT

jq -e '
  .schema_version == 1 and
  .source_repository == "ORESoftware/ai-agent-bridge.rs" and
  (.source_revision | test("^[0-9a-f]{40}$")) and
  (.image_digest | test("^sha256:[0-9a-f]{64}$")) and
  .image_ref == (.image + "@" + .image_digest) and
  .expected_user == "nonroot:nonroot" and
  (.expected_entrypoint | startswith("/usr/local/bin/")) and
  .credential_mode == "synthetic-only" and
  .provider_calls == false and
  .production_mutation == false and
  (.security_properties | length) >= 8
' "${CONTRACT_PATH}" >/dev/null

SOURCE_SHA="$(jq -r '.source_revision' "${CONTRACT_PATH}")"
IMAGE_DIGEST="$(jq -r '.image_digest' "${CONTRACT_PATH}")"
IMAGE_REF="$(jq -r '.image_ref' "${CONTRACT_PATH}")"
EXPECTED_USER="$(jq -r '.expected_user' "${CONTRACT_PATH}")"
EXPECTED_ENTRYPOINT="$(jq -r '.expected_entrypoint' "${CONTRACT_PATH}")"

printf '%s\n' \
  "HOST=0.0.0.0" \
  "HTTP_PORT=8142" \
  "TCP_PORT=8143" \
  "API_AUTH_BEARER=${TOKEN}" \
  "AI_AGENT_BRIDGE_DIR=/var/lib/bridge/claude-inbox" \
  "MAX_HTTP_BODY_BYTES=1024" \
  "MAX_TCP_LINE_BYTES=4096" \
  "TCP_AUTH_DEADLINE_SECS=2" \
  "TCP_IDLE_DEADLINE_SECS=10" \
  >"${WORK_DIR}/runtime.env"
chmod 0600 "${WORK_DIR}/runtime.env"

printf 'header = "Authorization: Bearer %s"\n' "${TOKEN}" >"${WORK_DIR}/curl-auth.conf"
printf 'header = "Authorization: Bearer %s"\n' "${INVALID_TOKEN}" >"${WORK_DIR}/curl-invalid-auth.conf"
chmod 0600 "${WORK_DIR}/curl-auth.conf" "${WORK_DIR}/curl-invalid-auth.conf"

echo "Pulling exact published bridge digest: ${IMAGE_REF}"
docker pull "${IMAGE_REF}" >/dev/null

test "$(docker image inspect --format '{{.Config.User}}' "${IMAGE_REF}")" = "${EXPECTED_USER}"
test "$(docker image inspect --format '{{index .Config.Entrypoint 0}}' "${IMAGE_REF}")" = "${EXPECTED_ENTRYPOINT}"
case "$(docker image inspect --format '{{json .Config.Cmd}}' "${IMAGE_REF}")" in
  null|'[]') ;;
  *)
    echo "published image unexpectedly defines a default command" >&2
    exit 1
    ;;
esac
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE_REF}")" = "${SOURCE_SHA}"
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${IMAGE_REF}" | grep -Fx "${IMAGE_REF}" >/dev/null

docker run --detach \
  --name "${CONTAINER_NAME}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /var/lib/bridge:rw,nosuid,nodev,noexec,size=32m,uid=65532,gid=65532,mode=0700 \
  --env-file "${WORK_DIR}/runtime.env" \
  --publish "127.0.0.1:${HTTP_PORT}:8142" \
  --publish "127.0.0.1:${TCP_PORT}:8143" \
  "${IMAGE_REF}" >/dev/null

docker inspect "${CONTAINER_NAME}" | jq -e '
  .[0].HostConfig.ReadonlyRootfs == true and
  (.[0].HostConfig.CapDrop | index("ALL")) != null and
  (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true")) != null and
  .[0].State.Running == true
' >/dev/null

BASE_URL="http://127.0.0.1:${HTTP_PORT}"
ready=false
for _ in $(seq 1 60); do
  if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "${BASE_URL}/healthz" || true)" == "200" ]] &&
     [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "${BASE_URL}/readyz" || true)" == "200" ]]; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || true)" != "true" ]]; then
    echo "published bridge container exited before readiness" >&2
    exit 1
  fi
  sleep 0.5
done
[[ "${ready}" == "true" ]] || {
  echo "published bridge did not become ready" >&2
  exit 1
}

expect_status() {
  local expected="$1"
  local label="$2"
  shift 2
  local output="${WORK_DIR}/${label}.json"
  local actual
  actual="$(curl --silent --show-error --output "${output}" --write-out '%{http_code}' "$@")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "${label}: expected HTTP ${expected}, received ${actual}" >&2
    cat "${output}" >&2 || true
    exit 1
  fi
}

expect_status 200 healthz "${BASE_URL}/healthz"
expect_status 200 readyz "${BASE_URL}/readyz"
expect_status 200 service-index "${BASE_URL}/"
expect_status 401 agents-missing-auth "${BASE_URL}/agents"
expect_status 401 agents-invalid-auth --config "${WORK_DIR}/curl-invalid-auth.conf" "${BASE_URL}/agents"

expect_status 200 register \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary '{"agent_key":"image-smoke-agent","display_name":"Published image smoke","kind":"codex"}' \
  "${BASE_URL}/agents/register"
jq -e '.agent.agent_key == "image-smoke-agent"' "${WORK_DIR}/register.json" >/dev/null

expect_status 200 resolve \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary '{"query":"immutable published bridge image smoke","created_by":"image-smoke-agent"}' \
  "${BASE_URL}/channels/resolve"
CHANNEL_SLUG="$(jq -r '.channel.slug' "${WORK_DIR}/resolve.json")"
[[ -n "${CHANNEL_SLUG}" && "${CHANNEL_SLUG}" != "null" ]]

expect_status 200 post-http \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary '{"from":"image-smoke-agent","role":"assistant","content":"published image HTTP round-trip"}' \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/messages"
jq -e '.message.seq == 1' "${WORK_DIR}/post-http.json" >/dev/null

expect_status 200 messages-http \
  --config "${WORK_DIR}/curl-auth.conf" \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/messages"
jq -e '.messages | any(.from == "image-smoke-agent" and .content == "published image HTTP round-trip")' \
  "${WORK_DIR}/messages-http.json" >/dev/null

expect_status 200 context-public \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request PUT \
  --header 'content-type: application/json' \
  --data-binary '{"key":"public.image-smoke","value":{"verified":true},"updated_by":"image-smoke-agent"}' \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/context"

expect_status 200 context-read \
  --config "${WORK_DIR}/curl-auth.conf" \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/context"
jq -e '.context | any(.key == "public.image-smoke" and .value.verified == true)' \
  "${WORK_DIR}/context-read.json" >/dev/null

expect_status 403 context-reserved \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request PUT \
  --header 'content-type: application/json' \
  --data-binary '{"key":"workflow.plan.v1","value":{"forged":true},"updated_by":"image-smoke-agent"}' \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/context"
jq -e '.error == "reserved_context_namespace"' "${WORK_DIR}/context-reserved.json" >/dev/null

python3 - <<'PY' >"${WORK_DIR}/oversized.json"
import json
print(json.dumps({
    "from": "image-smoke-agent",
    "content": "x" * 2048,
}))
PY
expect_status 413 oversized-http \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary "@${WORK_DIR}/oversized.json" \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/messages"

timeout --signal=TERM 10s curl \
  --config "${WORK_DIR}/curl-auth.conf" \
  --no-buffer \
  --silent \
  --show-error \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/stream?agent_key=image-smoke-agent" \
  >"${SSE_PATH}" 2>&1 &
SSE_PID=$!
sleep 1
expect_status 200 post-sse \
  --config "${WORK_DIR}/curl-auth.conf" \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary '{"from":"image-smoke-agent","role":"assistant","content":"published image SSE round-trip"}' \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/messages"
SSE_SEEN=false
for _ in $(seq 1 40); do
  if grep -F 'published image SSE round-trip' "${SSE_PATH}" >/dev/null 2>&1; then
    SSE_SEEN=true
    break
  fi
  sleep 0.25
done
kill "${SSE_PID}" >/dev/null 2>&1 || true
wait "${SSE_PID}" >/dev/null 2>&1 || true
[[ "${SSE_SEEN}" == "true" ]] || {
  echo "SSE stream did not observe the published image message" >&2
  cat "${SSE_PATH}" >&2 || true
  exit 1
}

BRIDGE_TEST_TCP_PORT="${TCP_PORT}" \
BRIDGE_TEST_BEARER="${TOKEN}" \
BRIDGE_TEST_INVALID_BEARER="${INVALID_TOKEN}" \
BRIDGE_TEST_CHANNEL="${CHANNEL_SLUG}" \
python3 <<'PY'
import json
import os
import socket

host = "127.0.0.1"
port = int(os.environ["BRIDGE_TEST_TCP_PORT"])
token = os.environ["BRIDGE_TEST_BEARER"]
invalid = os.environ["BRIDGE_TEST_INVALID_BEARER"]
channel = os.environ["BRIDGE_TEST_CHANNEL"]


def receive(stream):
    line = stream.readline()
    assert line, "TCP peer closed before returning a JSONL frame"
    return json.loads(line.decode("utf-8"))


def connect():
    sock = socket.create_connection((host, port), timeout=5)
    stream = sock.makefile("rwb", buffering=0)
    hello = receive(stream)
    assert hello.get("ok") is True, hello
    return sock, stream


def request(stream, payload):
    stream.write(json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n")
    return receive(stream)


sock, stream = connect()
assert request(stream, {"op": "ping"}).get("pong") is True
assert request(stream, {"op": "list_channels"}).get("error") == "unauthorized"
sock.close()

sock, stream = connect()
invalid_response = request(stream, {"op": "auth", "token": invalid})
assert invalid_response.get("error") == "unauthorized", invalid_response
assert invalid not in json.dumps(invalid_response)
sock.close()

sock, stream = connect()
auth = request(stream, {"op": "auth", "token": token})
assert auth.get("ok") is True, auth
assert auth.get("auth", {}).get("principal") == "operator", auth
assert token not in json.dumps(auth)
channels = request(stream, {"op": "list_channels"})
assert channels.get("ok") is True, channels
assert channel in json.dumps(channels), channels
registered = request(stream, {
    "op": "register",
    "agent_key": "tcp-image-smoke-agent",
    "display_name": "TCP published image smoke",
    "kind": "other",
})
assert registered.get("ok") is True, registered
posted = request(stream, {
    "op": "post",
    "channel": channel,
    "from": "tcp-image-smoke-agent",
    "content": "published image TCP round-trip",
})
assert posted.get("ok") is True, posted
reserved = request(stream, {
    "op": "set_context",
    "channel": channel,
    "key": "internal.provider-token",
    "value": {"forged": True},
    "updated_by": "tcp-image-smoke-agent",
})
assert reserved.get("error") == "bad_request", reserved
assert "reserved_context_namespace" in reserved.get("message", ""), reserved
sock.close()
PY

expect_status 200 messages-after-tcp \
  --config "${WORK_DIR}/curl-auth.conf" \
  "${BASE_URL}/channels/${CHANNEL_SLUG}/messages"
jq -e '.messages | any(.from == "tcp-image-smoke-agent" and .content == "published image TCP round-trip")' \
  "${WORK_DIR}/messages-after-tcp.json" >/dev/null

test "$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}")" = "true"
docker logs "${CONTAINER_NAME}" >"${LOG_PATH}" 2>&1
for secret in "${TOKEN}" "${INVALID_TOKEN}"; do
  if grep -F "${secret}" "${LOG_PATH}" "${SSE_PATH}" "${WORK_DIR}"/*.json >/dev/null 2>&1; then
    echo "synthetic bearer material appeared in captured output" >&2
    exit 1
  fi
done

jq -n \
  --arg image_ref "${IMAGE_REF}" \
  --arg source_sha "${SOURCE_SHA}" \
  --arg channel "${CHANNEL_SLUG}" \
  --arg digest "${IMAGE_DIGEST}" \
  '{
    ok: true,
    image_ref: $image_ref,
    image_digest: $digest,
    source_sha: $source_sha,
    channel: $channel,
    http_auth: "passed",
    http_round_trip: "passed",
    sse_round_trip: "passed",
    tcp_auth_and_round_trip: "passed",
    reserved_namespace_denial: "passed",
    request_body_limit: "passed",
    credential_reflection_scan: "passed",
    hardened_runtime: "passed"
  }'
