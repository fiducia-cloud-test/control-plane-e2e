#!/usr/bin/env python3
"""Fail-closed static and black-box Agent Pontifex conformance checks."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAX_DESCRIPTOR_BYTES = 64 * 1024
SENSITIVE_KEY_PARTS = (
    "authorization",
    "credential",
    "password",
    "private_key",
    "secret",
    "token",
)


class ConformanceError(RuntimeError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    if len(raw) > MAX_DESCRIPTOR_BYTES:
        raise ConformanceError(f"descriptor exceeds {MAX_DESCRIPTOR_BYTES} bytes: {path}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConformanceError(f"invalid JSON in {path}: {error}") from error
    if not isinstance(value, dict):
        raise ConformanceError(f"descriptor must be a JSON object: {path}")
    return value


def reject_sensitive_shape(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            lower = str(key).lower()
            if any(part in lower for part in SENSITIVE_KEY_PARTS):
                raise ConformanceError(f"credential-shaped descriptor key at {path}.{key}")
            reject_sensitive_shape(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            reject_sensitive_shape(nested, f"{path}[{index}]")
    elif isinstance(value, str):
        if len(value) > 4096 or any(character in value for character in "\r\n\x00"):
            raise ConformanceError(f"unsafe public descriptor string at {path}")


def validate_identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ConformanceError(f"{field} must be a non-empty string of at most 128 characters")
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789-_.")
    if any(character not in allowed for character in value):
        raise ConformanceError(f"{field} is not a lowercase ASCII identifier: {value!r}")
    return value


def validate_descriptor(
    descriptor: dict[str, Any],
    *,
    expected_service: str,
    expected_protocol: str,
    fiducia: bool,
) -> None:
    if descriptor.get("schema_version") != 1:
        raise ConformanceError("schema_version must be 1")
    if descriptor.get("service") != expected_service:
        raise ConformanceError(
            f"service mismatch: expected {expected_service!r}, got {descriptor.get('service')!r}"
        )
    if descriptor.get("protocol") != expected_protocol:
        raise ConformanceError(
            f"protocol mismatch: expected {expected_protocol!r}, got {descriptor.get('protocol')!r}"
        )
    validate_identifier(descriptor.get("service"), "service")
    validate_identifier(descriptor.get("protocol"), "protocol")
    validate_identifier(descriptor.get("implementation"), "implementation")

    versions = descriptor.get("protocol_versions")
    if not isinstance(versions, dict):
        raise ConformanceError("protocol_versions must be an object")
    minimum = versions.get("min_major")
    maximum = versions.get("max_major")
    if not isinstance(minimum, int) or not isinstance(maximum, int):
        raise ConformanceError("protocol version bounds must be integers")
    if minimum < 1 or maximum < minimum or not minimum <= 1 <= maximum:
        raise ConformanceError(f"protocol version range does not include major 1: {versions}")

    capabilities = descriptor.get("capabilities")
    if not isinstance(capabilities, list) or not capabilities:
        raise ConformanceError("capabilities must be a non-empty array")
    normalized = [validate_identifier(value, "capability") for value in capabilities]
    if normalized != sorted(normalized):
        raise ConformanceError("capabilities must be deterministically sorted")
    if len(normalized) != len(set(normalized)):
        raise ConformanceError("capabilities must be unique")
    expected_prefix = f"{expected_service}."
    if any(not capability.startswith(expected_prefix) for capability in normalized):
        raise ConformanceError(f"capabilities must use the {expected_prefix!r} namespace")

    extensions = descriptor.get("extensions")
    if not isinstance(extensions, dict):
        raise ConformanceError("extensions must be an object")
    for key, nested in extensions.items():
        validate_identifier(key, "extension")
        if "." not in key:
            raise ConformanceError(f"extension key is not vendor namespaced: {key!r}")
        if fiducia and not key.startswith("fiducia."):
            raise ConformanceError(f"Fiducia extension must use fiducia.*: {key!r}")
        if not isinstance(nested, dict):
            raise ConformanceError(f"extension payload must be an object: {key!r}")
    if fiducia and not extensions:
        raise ConformanceError("Fiducia descriptor must advertise namespaced extensions")
    if not fiducia and extensions:
        raise ConformanceError("community descriptor must not claim product extensions")

    reject_sensitive_shape(descriptor)


def validate_fixture_directory(directory: Path) -> None:
    profiles = {
        "bridge.json": ("bridge", "agent-pontifex.bridge", False),
        "coordinator.json": ("coordinator", "agent-pontifex.coordinator", False),
        "fiducia-bridge.json": ("bridge", "agent-pontifex.bridge", True),
        "fiducia-coordinator.json": ("coordinator", "agent-pontifex.coordinator", True),
    }
    loaded: dict[str, dict[str, Any]] = {}
    for name, (service, protocol, fiducia) in profiles.items():
        path = directory / name
        if not path.is_file():
            raise ConformanceError(f"required conformance fixture is missing: {path}")
        descriptor = load_json(path)
        validate_descriptor(
            descriptor,
            expected_service=service,
            expected_protocol=protocol,
            fiducia=fiducia,
        )
        loaded[name] = descriptor

    fiducia_coordinator = loaded["fiducia-coordinator.json"]
    capabilities = fiducia_coordinator["capabilities"]
    if any(capability.startswith("coordinator.jobs.") for capability in capabilities):
        raise ConformanceError(
            "Fiducia must not claim direct community job compatibility before an adapter exists"
        )
    compatibility = fiducia_coordinator["extensions"].get("fiducia.compatibility")
    expected_compatibility = {
        "community_job_adapter": "required",
        "direct_job_wire_compatible": False,
        "translation_must_preserve_fencing": True,
    }
    if compatibility != expected_compatibility:
        raise ConformanceError(
            "Fiducia coordinator adapter boundary drifted: "
            f"expected {expected_compatibility!r}, got {compatibility!r}"
        )

    fiducia_bridge = loaded["fiducia-bridge.json"]
    lease_extension = fiducia_bridge["extensions"].get("fiducia.file-leases")
    if not isinstance(lease_extension, dict) or lease_extension.get("monotonic_fencing") is not True:
        raise ConformanceError("Fiducia bridge must advertise monotonic lease fencing")


def request_json(
    method: str,
    url: str,
    *,
    bearer: str | None = None,
    body: dict[str, Any] | None = None,
    expected_statuses: tuple[int, ...] = (200,),
) -> tuple[int, dict[str, Any] | None]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            raw = response.read(MAX_DESCRIPTOR_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read(MAX_DESCRIPTOR_BYTES + 1)
    except urllib.error.URLError as error:
        raise ConformanceError(f"request failed for {url}: {error.reason}") from error

    if status not in expected_statuses:
        raise ConformanceError(f"unexpected HTTP {status} from {method} {url}")
    if len(raw) > MAX_DESCRIPTOR_BYTES:
        raise ConformanceError(f"response exceeded {MAX_DESCRIPTOR_BYTES} bytes: {url}")
    if not raw:
        return status, None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConformanceError(f"non-JSON response from {url}") from error
    if not isinstance(value, dict):
        raise ConformanceError(f"JSON response must be an object: {url}")
    return status, value


def validate_bridge_runtime(base_url: str, bearer: str) -> None:
    base_url = base_url.rstrip("/")
    _, discovery = request_json("GET", f"{base_url}/.well-known/agent-pontifex")
    assert discovery is not None
    validate_descriptor(
        discovery,
        expected_service="bridge",
        expected_protocol="agent-pontifex.bridge",
        fiducia=False,
    )

    request_json(
        "GET",
        f"{base_url}/channels",
        expected_statuses=(401, 403),
    )

    producer = "conformance-producer"
    observer = "conformance-observer"
    for agent_key in (producer, observer):
        _, registered = request_json(
            "POST",
            f"{base_url}/agents/register",
            bearer=bearer,
            body={
                "agent_key": agent_key,
                "display_name": agent_key,
                "kind": "other",
                "meta": {"suite": "fiducia-cloud-test/control-plane-e2e"},
            },
        )
        if registered is None or registered.get("ok") is not True:
            raise ConformanceError(f"agent registration failed for {agent_key}")

    _, resolved = request_json(
        "POST",
        f"{base_url}/channels/resolve",
        bearer=bearer,
        body={
            "query": "cross implementation Agent Pontifex release certification",
            "created_by": producer,
        },
    )
    if resolved is None or resolved.get("ok") is not True:
        raise ConformanceError("channel resolution failed")
    channel = resolved.get("channel")
    if not isinstance(channel, dict) or not isinstance(channel.get("slug"), str):
        raise ConformanceError("resolved channel did not include a slug")
    slug = channel["slug"]
    encoded_slug = urllib.parse.quote(slug, safe="")
    message_text = "producer confirms the public bridge contract is reachable"

    _, posted = request_json(
        "POST",
        f"{base_url}/channels/{encoded_slug}/messages",
        bearer=bearer,
        body={
            "from": producer,
            "content": message_text,
            "role": "assistant",
            "meta": {"observer": observer, "suite": "agent-pontifex-conformance"},
        },
    )
    if posted is None or posted.get("ok") is not True:
        raise ConformanceError("message post failed")
    posted_message = posted.get("message")
    if not isinstance(posted_message, dict) or not isinstance(posted_message.get("seq"), int):
        raise ConformanceError("posted message did not include a monotonic sequence")

    _, listed = request_json(
        "GET",
        f"{base_url}/channels/{encoded_slug}/messages",
        bearer=bearer,
    )
    messages = None if listed is None else listed.get("messages")
    if not isinstance(messages, list):
        raise ConformanceError("message listing did not return an array")
    if not any(
        isinstance(message, dict)
        and message.get("from") == producer
        and message.get("content") == message_text
        and isinstance(message.get("seq"), int)
        for message in messages
    ):
        raise ConformanceError("posted coordination message was not observable")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--bridge-url")
    parser.add_argument("--bridge-bearer")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        validate_fixture_directory(args.fixtures)
        if args.bridge_url:
            if not args.bridge_bearer:
                raise ConformanceError("--bridge-bearer is required with --bridge-url")
            validate_bridge_runtime(args.bridge_url, args.bridge_bearer)
    except ConformanceError as error:
        print(f"conformance failed: {error}", file=sys.stderr)
        return 1
    print("Agent Pontifex conformance passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
