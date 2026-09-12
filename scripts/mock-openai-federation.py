#!/usr/bin/env python3
"""Credential-free OpenAI-compatible endpoints for federation conformance.

One loopback HTTP server exposes four provider-specific paths. It validates the
model selected by the Rust coordinator, then echoes only the exact bounded
acknowledgement template requested by the live-ring driver. Request bodies and
bearer values are never logged.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 256 * 1024
MAX_TEMPLATE_BYTES = 16 * 1024
TEMPLATE_MARKER = "ACKNOWLEDGEMENT_TEMPLATE="


class MockProviderError(RuntimeError):
    pass


def load_routes(path: Path) -> dict[str, tuple[str, str]]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MockProviderError(f"failed to load federation manifest: {error}") from error
    agents = manifest.get("agents") if isinstance(manifest, dict) else None
    if not isinstance(agents, list) or len(agents) != 4:
        raise MockProviderError("manifest must define exactly four agents")
    routes: dict[str, tuple[str, str]] = {}
    for index, agent in enumerate(agents):
        if not isinstance(agent, dict):
            raise MockProviderError(f"agents[{index}] must be an object")
        provider = agent.get("provider_id")
        model = agent.get("upstream_model")
        base_path = agent.get("mock_path")
        if not all(isinstance(value, str) and value for value in (provider, model, base_path)):
            raise MockProviderError(f"agents[{index}] has incomplete mock routing metadata")
        endpoint = f"{base_path.rstrip('/')}/chat/completions"
        if endpoint in routes:
            raise MockProviderError(f"duplicate mock endpoint: {endpoint}")
        routes[endpoint] = (provider, model)
    return routes


def extract_acknowledgement(messages: Any) -> str:
    if not isinstance(messages, list):
        raise MockProviderError("messages must be an array")
    user_content = None
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                user_content = content
                break
    if user_content is None:
        raise MockProviderError("a user message is required")
    for line in user_content.splitlines():
        if line.startswith(TEMPLATE_MARKER):
            candidate = line[len(TEMPLATE_MARKER) :]
            if len(candidate.encode("utf-8")) > MAX_TEMPLATE_BYTES:
                raise MockProviderError("acknowledgement template is too large")
            try:
                value = json.loads(candidate)
            except json.JSONDecodeError as error:
                raise MockProviderError("acknowledgement template is invalid JSON") from error
            if not isinstance(value, dict):
                raise MockProviderError("acknowledgement template must be an object")
            return json.dumps(value, sort_keys=True, separators=(",", ":"))
    raise MockProviderError("acknowledgement template marker is missing")


class FederationServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        *,
        routes: dict[str, tuple[str, str]],
        api_key: str,
    ) -> None:
        super().__init__(server_address, handler)
        self.routes = routes
        self.api_key = api_key
        self._counter = 0
        self._counter_lock = threading.Lock()

    def next_id(self, provider: str) -> str:
        with self._counter_lock:
            self._counter += 1
            return f"mock-{provider}-{self._counter}"


class Handler(BaseHTTPRequestHandler):
    server: FederationServer
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        # Deliberately suppress BaseHTTPRequestHandler logging because it can be
        # extended by callers in ways that accidentally include request material.
        return

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        if self.path == "/healthz":
            self.send_json(200, {"ok": True, "providers": sorted(p for p, _ in self.server.routes.values())})
            return
        self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
        route = self.server.routes.get(self.path)
        if route is None:
            self.send_json(404, {"error": "not_found"})
            return
        if self.headers.get("Authorization") != f"Bearer {self.server.api_key}":
            self.send_json(401, {"error": "unauthorized"})
            return
        content_length_raw = self.headers.get("Content-Length")
        try:
            content_length = int(content_length_raw or "0")
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "request_size_rejected"})
            return
        raw = self.rfile.read(content_length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid_json"})
            return
        if not isinstance(body, dict):
            self.send_json(400, {"error": "request_must_be_object"})
            return
        if body.get("stream") is True:
            self.send_json(400, {"error": "mock_streaming_not_supported"})
            return

        provider, expected_model = route
        if body.get("model") != expected_model:
            self.send_json(400, {"error": "unexpected_model"})
            return
        try:
            acknowledgement = extract_acknowledgement(body.get("messages"))
        except MockProviderError as error:
            self.send_json(400, {"error": str(error)})
            return

        response = {
            "id": self.server.next_id(provider),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": expected_model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": acknowledgement},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 32, "completion_tokens": 16, "total_tokens": 48},
        }
        self.send_json(200, response)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19990)
    parser.add_argument("--api-key-env", default="MOCK_PROVIDER_API_KEY")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        routes = load_routes(args.manifest)
        api_key = os.environ.get(args.api_key_env, "")
        if not api_key:
            raise MockProviderError(f"required environment variable is unset: {args.api_key_env}")
        server = FederationServer((args.bind, args.port), Handler, routes=routes, api_key=api_key)
    except (MockProviderError, OSError, ValueError) as error:
        print(f"mock provider startup failed: {error}", file=sys.stderr)
        return 1
    print(f"mock provider federation listening on {args.bind}:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
