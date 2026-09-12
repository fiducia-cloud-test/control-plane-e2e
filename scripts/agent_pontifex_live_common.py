"""Shared, dependency-free contracts for Agent Pontifex live federation tests."""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PROVIDER_CONTENT_BYTES = 32 * 1024
SUITE = "agent-pontifex.live-federation.v1"
CONTROLLER_ID = "agent-pontifex-test-controller"
IDENTIFIER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
FULL_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
ACK_KEYS = {"ack", "agent", "previous_seq", "previous_sha256", "run_id"}
PROVIDERS = {"anthropic", "google", "openai", "xai"}


class ConformanceError(RuntimeError):
    """A bridge, coordinator, provider, or evidence invariant failed."""


@dataclass(frozen=True)
class AgentRoute:
    agent_id: str
    display_name: str
    bridge_kind: str
    requested_label: str
    provider_id: str
    route_model: str
    upstream_model: str
    output_limit_field: str


def require_string(value: Any, field: str, *, identifier: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConformanceError(f"{field} must be a non-empty string")
    value = value.strip()
    if len(value) > 512:
        raise ConformanceError(f"{field} is too long")
    if identifier and not IDENTIFIER_RE.fullmatch(value):
        raise ConformanceError(f"{field} is not a safe lowercase identifier")
    return value


def load_routes(path: Path) -> list[AgentRoute]:
    try:
        raw = path.read_bytes()
        manifest = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        raise ConformanceError(f"failed to load manifest {path}") from error
    if len(raw) > 128 * 1024:
        raise ConformanceError("manifest exceeds 128 KiB")
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ConformanceError("manifest schema_version must be 1")
    if manifest.get("suite") != SUITE:
        raise ConformanceError("unexpected federation suite identifier")
    agents = manifest.get("agents")
    if not isinstance(agents, list) or len(agents) != 4:
        raise ConformanceError("manifest must define exactly four agents")

    routes: list[AgentRoute] = []
    seen_agents: set[str] = set()
    seen_models: set[str] = set()
    seen_providers: set[str] = set()
    for index, item in enumerate(agents):
        if not isinstance(item, dict):
            raise ConformanceError(f"agents[{index}] must be an object")
        route = AgentRoute(
            agent_id=require_string(item.get("agent_id"), f"agents[{index}].agent_id", identifier=True),
            display_name=require_string(item.get("display_name"), f"agents[{index}].display_name"),
            bridge_kind=require_string(item.get("bridge_kind"), f"agents[{index}].bridge_kind", identifier=True),
            requested_label=require_string(item.get("requested_label"), f"agents[{index}].requested_label"),
            provider_id=require_string(item.get("provider_id"), f"agents[{index}].provider_id", identifier=True),
            route_model=require_string(item.get("route_model"), f"agents[{index}].route_model", identifier=True),
            upstream_model=require_string(item.get("upstream_model"), f"agents[{index}].upstream_model"),
            output_limit_field=require_string(
                item.get("output_limit_field"),
                f"agents[{index}].output_limit_field",
                identifier=True,
            ),
        )
        if route.bridge_kind not in {"claude", "codex", "gemini", "other"}:
            raise ConformanceError(f"unsupported bridge kind: {route.bridge_kind}")
        if route.output_limit_field not in {"max_tokens", "max_completion_tokens"}:
            raise ConformanceError(f"unsupported output limit field: {route.output_limit_field}")
        if route.agent_id in seen_agents or route.route_model in seen_models:
            raise ConformanceError("agent and route model identifiers must be unique")
        if route.provider_id in seen_providers:
            raise ConformanceError("provider identifiers must be unique")
        seen_agents.add(route.agent_id)
        seen_models.add(route.route_model)
        seen_providers.add(route.provider_id)
        routes.append(route)
    if seen_providers != PROVIDERS:
        raise ConformanceError("provider set must be anthropic, google, openai, and xai")
    return routes


def request_json(
    method: str,
    url: str,
    *,
    bearer: str | None = None,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 60,
    expected_statuses: tuple[int, ...] = (200,),
) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request_headers = {"Accept": "application/json"}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    if bearer is not None:
        request_headers["Authorization"] = f"Bearer {bearer}"
    request_headers.update(headers or {})
    request = urllib.request.Request(url, data=payload, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = response.status
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.URLError as error:
        raise ConformanceError(f"request failed: {method} {url}: {error.reason}") from error
    if status not in expected_statuses:
        raise ConformanceError(f"unexpected HTTP {status}: {method} {url}")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ConformanceError(f"response exceeded {MAX_RESPONSE_BYTES} bytes: {url}")
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConformanceError(f"response was not JSON: {method} {url}") from error
    if not isinstance(value, dict):
        raise ConformanceError(f"response was not an object: {method} {url}")
    return value


def extract_message(response: dict[str, Any], operation: str) -> dict[str, Any]:
    message = response.get("message") if response.get("ok") is True else None
    if not isinstance(message, dict):
        raise ConformanceError(f"bridge operation omitted message: {operation}")
    if not isinstance(message.get("seq"), int) or message["seq"] <= 0:
        raise ConformanceError(f"bridge message omitted a positive sequence: {operation}")
    if not isinstance(message.get("content"), str):
        raise ConformanceError(f"bridge message omitted content: {operation}")
    return message


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def parse_acknowledgement(content: str, expected: dict[str, Any]) -> tuple[str, str]:
    if len(content.encode()) > MAX_PROVIDER_CONTENT_BYTES:
        raise ConformanceError("provider completion exceeded the content limit")
    digest = sha256_text(content)
    try:
        acknowledgement = json.loads(content.strip())
    except json.JSONDecodeError as error:
        raise ConformanceError(
            "provider acknowledgement was not a standalone JSON object"
        ) from error
    if not isinstance(acknowledgement, dict) or set(acknowledgement) != ACK_KEYS:
        raise ConformanceError("provider acknowledgement had an unexpected key set")
    if acknowledgement != expected:
        raise ConformanceError("provider acknowledgement did not preserve the chain template")
    return canonical_json(acknowledgement), digest


def validate_models(base_url: str, bearer: str, routes: list[AgentRoute]) -> None:
    response = request_json("GET", f"{base_url.rstrip('/')}/v1/models", bearer=bearer)
    data = response.get("data")
    if not isinstance(data, list):
        raise ConformanceError("coordinator model discovery omitted its data array")
    indexed = {
        item.get("id"): item
        for item in data
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for route in routes:
        model = indexed.get(route.route_model)
        if not isinstance(model, dict):
            raise ConformanceError(f"coordinator omitted route {route.route_model}")
        if model.get("provider") != route.provider_id or model.get("enabled") is not True:
            raise ConformanceError(f"coordinator route is unavailable: {route.route_model}")


def validate_evidence(evidence: dict[str, Any], routes: list[AgentRoute]) -> None:
    expected_keys = {
        "bridge", "completed_at", "coordinator", "run_id", "schema_version",
        "sse_delivery", "suite", "turns",
    }
    if set(evidence) != expected_keys:
        raise ConformanceError("evidence top-level key set drifted")
    if evidence.get("schema_version") != 1 or evidence.get("suite") != SUITE:
        raise ConformanceError("evidence identity is invalid")
    turns = evidence.get("turns")
    if not isinstance(turns, list) or len(turns) != 4:
        raise ConformanceError("evidence must contain exactly four turns")
    if [turn.get("agent_id") for turn in turns if isinstance(turn, dict)] != [
        route.agent_id for route in routes
    ]:
        raise ConformanceError("evidence agent order drifted")
    sequences = evidence.get("bridge", {}).get("message_sequences")
    if not isinstance(sequences, list) or len(sequences) != 5:
        raise ConformanceError("evidence must contain five message sequences")
    if sequences != sorted(sequences) or len(sequences) != len(set(sequences)):
        raise ConformanceError("evidence sequences are not strictly monotonic")
    delivery = evidence.get("sse_delivery")
    if not isinstance(delivery, dict) or set(delivery) != {r.agent_id for r in routes}:
        raise ConformanceError("evidence SSE observer set drifted")
    for agent_id, observed in delivery.items():
        if observed != sequences:
            raise ConformanceError(
                f"non-exact SSE delivery for {agent_id}: expected={sequences}, observed={observed}"
            )
    for turn in turns:
        if not isinstance(turn, dict):
            raise ConformanceError("evidence turn was not an object")
        for field in ("previous_sha256", "provider_response_sha256"):
            if not isinstance(turn.get(field), str) or not FULL_DIGEST_RE.fullmatch(turn[field]):
                raise ConformanceError(f"invalid evidence digest: {field}")
        if not isinstance(turn.get("latency_ms"), int) or turn["latency_ms"] < 0:
            raise ConformanceError("invalid evidence latency")


def required_environment(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise ConformanceError(f"required environment variable is unset: {name}")
    return value
