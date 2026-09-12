#!/usr/bin/env python3
"""Render a fail-closed coordinator config for the four-agent federation lane.

The emitted document is JSON, which is also valid YAML and can be consumed by
`ai-agent-coordinator`. It contains provider endpoint metadata and environment
variable names only; provider credentials are never read or written here.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

IDENTIFIER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ALLOWED_BRIDGE_KINDS = {"claude", "codex", "gemini", "other"}
ALLOWED_OUTPUT_LIMIT_FIELDS = {"max_tokens", "max_completion_tokens"}
REQUIRED_PROVIDER_IDS = {"anthropic", "google", "openai", "xai"}


class ConfigurationError(RuntimeError):
    """Raised for malformed or unsafe federation manifests."""


def require_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigurationError(f"{field} must be an object")
    return value


def require_string(value: Any, field: str, *, identifier: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{field} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > 512:
        raise ConfigurationError(f"{field} is too long")
    if identifier and not IDENTIFIER_RE.fullmatch(normalized):
        raise ConfigurationError(f"{field} is not a safe lowercase identifier")
    return normalized


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ConfigurationError(f"failed to read manifest {path}") from error
    if len(raw) > 128 * 1024:
        raise ConfigurationError("manifest exceeds 128 KiB")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConfigurationError(f"manifest is not valid JSON: {error}") from error
    manifest = require_object(manifest, "manifest")
    if manifest.get("schema_version") != 1:
        raise ConfigurationError("manifest schema_version must be 1")
    if require_string(manifest.get("suite"), "suite", identifier=True) != "agent-pontifex.live-federation.v1":
        raise ConfigurationError("unexpected federation suite identifier")

    sources = require_object(manifest.get("sources"), "sources")
    for source_name in ("bridge", "coordinator"):
        source = require_object(sources.get(source_name), f"sources.{source_name}")
        require_string(source.get("repository"), f"sources.{source_name}.repository")
        revision = require_string(source.get("revision"), f"sources.{source_name}.revision")
        if not FULL_SHA_RE.fullmatch(revision):
            raise ConfigurationError(f"sources.{source_name}.revision must be a full commit SHA")

    agents = manifest.get("agents")
    if not isinstance(agents, list) or len(agents) != 4:
        raise ConfigurationError("agents must contain exactly four entries")

    seen_agents: set[str] = set()
    seen_providers: set[str] = set()
    seen_models: set[str] = set()
    seen_mock_paths: set[str] = set()
    for index, raw_agent in enumerate(agents):
        agent = require_object(raw_agent, f"agents[{index}]")
        agent_id = require_string(agent.get("agent_id"), f"agents[{index}].agent_id", identifier=True)
        provider_id = require_string(
            agent.get("provider_id"), f"agents[{index}].provider_id", identifier=True
        )
        route_model = require_string(
            agent.get("route_model"), f"agents[{index}].route_model", identifier=True
        )
        require_string(agent.get("display_name"), f"agents[{index}].display_name")
        require_string(agent.get("requested_label"), f"agents[{index}].requested_label")
        require_string(agent.get("upstream_model"), f"agents[{index}].upstream_model")
        bridge_kind = require_string(
            agent.get("bridge_kind"), f"agents[{index}].bridge_kind", identifier=True
        )
        if bridge_kind not in ALLOWED_BRIDGE_KINDS:
            raise ConfigurationError(f"unsupported bridge kind: {bridge_kind}")
        output_limit_field = require_string(
            agent.get("output_limit_field"),
            f"agents[{index}].output_limit_field",
            identifier=True,
        )
        if output_limit_field not in ALLOWED_OUTPUT_LIMIT_FIELDS:
            raise ConfigurationError(f"unsupported output limit field: {output_limit_field}")
        live_base_url = require_string(agent.get("live_base_url"), f"agents[{index}].live_base_url")
        if not live_base_url.startswith("https://") or any(ch in live_base_url for ch in "\r\n\x00"):
            raise ConfigurationError("live provider base URLs must be HTTPS URLs")
        require_string(agent.get("api_key_env"), f"agents[{index}].api_key_env")
        mock_path = require_string(agent.get("mock_path"), f"agents[{index}].mock_path")
        if not mock_path.startswith("/") or ".." in mock_path or any(ch in mock_path for ch in "?#\r\n\x00"):
            raise ConfigurationError(f"unsafe mock path: {mock_path!r}")

        if agent_id in seen_agents or provider_id in seen_providers or route_model in seen_models:
            raise ConfigurationError("agent, provider, and route model identifiers must be unique")
        if mock_path in seen_mock_paths:
            raise ConfigurationError("mock paths must be unique")
        seen_agents.add(agent_id)
        seen_providers.add(provider_id)
        seen_models.add(route_model)
        seen_mock_paths.add(mock_path)

    if seen_providers != REQUIRED_PROVIDER_IDS:
        raise ConfigurationError(
            f"provider set must be exactly {sorted(REQUIRED_PROVIDER_IDS)!r}"
        )
    return manifest


def render_config(
    manifest: dict[str, Any],
    *,
    mode: str,
    bind: str,
    mock_origin: str,
) -> dict[str, Any]:
    providers: dict[str, Any] = {}
    models: dict[str, Any] = {}
    route_order: list[str] = []

    for agent in manifest["agents"]:
        provider_id = agent["provider_id"]
        if mode == "mock":
            base_url = f"{mock_origin.rstrip('/')}{agent['mock_path']}"
            api_key_env = "MOCK_PROVIDER_API_KEY"
            trust = "local"
        else:
            base_url = agent["live_base_url"].rstrip("/")
            api_key_env = agent["api_key_env"]
            trust = "public"

        providers[provider_id] = {
            "kind": "openai-compatible",
            "base_url": base_url,
            "api_key_env": api_key_env,
            "trust": trust,
            "timeout_seconds": 180,
        }
        route_model = agent["route_model"]
        route_order.append(route_model)
        models[route_model] = {
            "provider": provider_id,
            "upstream_model": agent["upstream_model"],
            "tier": "frontier",
            # These are intentionally conservative accounting guard rates, not
            # claims about current vendor pricing. They keep the coordinator's
            # request and run budgets active even when vendor prices change.
            "input_cost_per_million_usd": 100.0,
            "output_cost_per_million_usd": 200.0,
            "task_types": ["live-agent-ring"],
            "enabled": True,
        }

    return {
        "server": {
            "bind": bind,
            "max_concurrent_model_requests": 4,
        },
        "database": {"url_env": "AI_AGENT_COORDINATOR_DATABASE_URL"},
        "auth": {"required": True, "token_env": "COORDINATOR_API_TOKEN"},
        "github": {
            "webhook_secret_env": "GITHUB_WEBHOOK_SECRET",
            "issue_trigger_labels": ["agent:run"],
            "review_trigger_labels": ["agent:review"],
            "auto_enqueue_failed_workflows": False,
        },
        "workers": {
            "default_org_concurrency": 4,
            "default_repo_concurrency": 4,
        },
        "routing": {
            "require_repository_context": True,
            "default_order": route_order,
            "task_orders": {"live-agent-ring": route_order},
            "fallbacks": {},
        },
        "budgets": {
            "default_org_daily_usd": 0.5,
            "default_repo_daily_usd": 0.5,
        },
        "security": {
            "max_request_bytes": 1048576,
            "redact_secrets": True,
            "deny_remote_when_secrets_cannot_be_redacted": True,
            "restricted_requires_local": True,
        },
        "providers": providers,
        "models": models,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--mode", choices=("mock", "live"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bind", default="127.0.0.1:18080")
    parser.add_argument("--mock-origin", default="http://127.0.0.1:19990")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = load_manifest(args.manifest)
        config = render_config(
            manifest,
            mode=args.mode,
            bind=args.bind,
            mock_origin=args.mock_origin,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (ConfigurationError, OSError) as error:
        print(f"configuration render failed: {error}", file=sys.stderr)
        return 1
    print(f"rendered {args.mode} coordinator configuration: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
