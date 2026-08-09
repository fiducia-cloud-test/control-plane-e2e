#!/usr/bin/env python3
"""Exercise the public Agent Pontifex coordinator job contract end to end."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def load_shared_conformance_module() -> Any:
    module_path = Path(__file__).with_name("verify-agent-pontifex.py")
    spec = importlib.util.spec_from_file_location(
        "agent_pontifex_shared_conformance", module_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load shared conformance verifier: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARED = load_shared_conformance_module()
ConformanceError = SHARED.ConformanceError


def request_json(
    method: str,
    url: str,
    *,
    bearer: str | None = None,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    expected_statuses: tuple[int, ...] = (200,),
) -> tuple[int, dict[str, Any] | None]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request_headers = {"Accept": "application/json"}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    if bearer is not None:
        request_headers["Authorization"] = f"Bearer {bearer}"
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(
        url,
        data=payload,
        headers=request_headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = response.status
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.URLError as error:
        raise ConformanceError(f"request failed for {url}: {error.reason}") from error

    if status not in expected_statuses:
        raise ConformanceError(f"unexpected HTTP {status} from {method} {url}")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ConformanceError(f"response exceeded {MAX_RESPONSE_BYTES} bytes: {url}")
    if not raw:
        return status, None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConformanceError(f"non-JSON response from {url}") from error
    if not isinstance(value, dict):
        raise ConformanceError(f"JSON response must be an object: {url}")
    return status, value


def require_job(payload: dict[str, Any] | None, operation: str) -> dict[str, Any]:
    if payload is None:
        raise ConformanceError(f"{operation} returned no JSON body")
    job = payload.get("job")
    if not isinstance(job, dict):
        raise ConformanceError(f"{operation} did not return a job object")
    required_keys = {
        "id",
        "org",
        "repo",
        "task_type",
        "payload",
        "priority",
        "status",
        "created_at",
        "updated_at",
        "available_at",
        "claimed_by",
        "lease_expires_at",
        "attempts",
        "max_attempts",
        "result",
        "last_error",
        "budget_usd",
    }
    if set(job) != required_keys:
        missing = sorted(required_keys - set(job))
        unexpected = sorted(set(job) - required_keys)
        raise ConformanceError(
            f"{operation} job envelope drifted; missing={missing}, unexpected={unexpected}"
        )
    if not isinstance(job["id"], str) or not job["id"]:
        raise ConformanceError(f"{operation} returned an invalid job id")
    for key in ("created_at", "updated_at", "available_at"):
        if not isinstance(job[key], str) or not job[key]:
            raise ConformanceError(f"{operation} returned an invalid {key}")
    return job


def require_error_code(payload: dict[str, Any] | None, expected: str, operation: str) -> None:
    if payload is None:
        raise ConformanceError(f"{operation} returned no error body")
    error = payload.get("error")
    if not isinstance(error, dict) or error.get("code") != expected:
        raise ConformanceError(
            f"{operation} returned the wrong error code: {payload!r}"
        )


def assert_identity(job: dict[str, Any], job_id: str) -> None:
    expected = {
        "id": job_id,
        "org": "fiducia-cloud-test",
        "repo": "control-plane-e2e",
        "task_type": "conformance_probe",
        "priority": 25,
        "max_attempts": 3,
        "budget_usd": 1.25,
    }
    for key, value in expected.items():
        if job.get(key) != value:
            raise ConformanceError(
                f"job identity drifted for {key}: expected {value!r}, got {job.get(key)!r}"
            )
    if job.get("payload") != {
        "goal": "certify the public leased-job lifecycle",
        "suite": "fiducia-cloud-test/control-plane-e2e",
    }:
        raise ConformanceError("job payload drifted")


def validate_runtime(base_url: str, bearer: str) -> None:
    base_url = base_url.rstrip("/")

    _, discovery = request_json(
        "GET", f"{base_url}/.well-known/agent-pontifex"
    )
    if discovery is None:
        raise ConformanceError("coordinator discovery returned no body")
    SHARED.validate_descriptor(
        discovery,
        expected_service="coordinator",
        expected_protocol="agent-pontifex.coordinator",
        fiducia=False,
    )

    status, unauthorized = request_json(
        "GET",
        f"{base_url}/v1/jobs/not-a-job",
        expected_statuses=(401,),
    )
    if status != 401:
        raise ConformanceError("coordinator application route did not require authentication")
    require_error_code(unauthorized, "unauthorized", "unauthenticated get")

    create_body = {
        "org": "fiducia-cloud-test",
        "repo": "control-plane-e2e",
        "task_type": "conformance_probe",
        "priority": 25,
        "max_attempts": 3,
        "budget_usd": 1.25,
        "payload": {
            "goal": "certify the public leased-job lifecycle",
            "suite": "fiducia-cloud-test/control-plane-e2e",
        },
    }
    idempotency_key = "agent-pontifex-conformance:leased-job-v1"
    create_headers = {"Idempotency-Key": idempotency_key}

    _, created_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs",
        bearer=bearer,
        headers=create_headers,
        body=create_body,
        expected_statuses=(202,),
    )
    created = require_job(created_payload, "create")
    job_id = created["id"]
    assert_identity(created, job_id)
    if (
        created["status"] != "queued"
        or created["attempts"] != 0
        or created["claimed_by"] is not None
        or created["lease_expires_at"] is not None
        or created["result"] is not None
    ):
        raise ConformanceError(f"new job was not queued cleanly: {created!r}")

    _, replay_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs",
        bearer=bearer,
        headers=create_headers,
        body=create_body,
        expected_statuses=(202,),
    )
    replay = require_job(replay_payload, "idempotent create replay")
    if replay["id"] != job_id or replay["status"] != "queued":
        raise ConformanceError("idempotent create did not return the original queued job")

    status, wrong_filter_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs/claim",
        bearer=bearer,
        body={
            "worker_id": "wrong-filter-worker",
            "orgs": ["agent-pontifex-test"],
            "repositories": ["control-plane-e2e"],
            "task_types": ["conformance_probe"],
            "lease_seconds": 30,
        },
        expected_statuses=(204,),
    )
    if status != 204 or wrong_filter_payload is not None:
        raise ConformanceError("claim filters did not isolate unrelated organizations")

    worker_id = "conformance-worker"
    _, claimed_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs/claim",
        bearer=bearer,
        body={
            "worker_id": worker_id,
            "orgs": ["fiducia-cloud-test"],
            "repositories": ["fiducia-cloud-test/control-plane-e2e"],
            "task_types": ["conformance_probe"],
            "lease_seconds": 30,
        },
    )
    claimed = require_job(claimed_payload, "claim")
    assert_identity(claimed, job_id)
    if (
        claimed["status"] != "running"
        or claimed["claimed_by"] != worker_id
        or claimed["attempts"] != 1
        or not isinstance(claimed["lease_expires_at"], str)
    ):
        raise ConformanceError(f"claimed job did not carry the expected lease: {claimed!r}")

    _, wrong_heartbeat = request_json(
        "POST",
        f"{base_url}/v1/jobs/{job_id}/heartbeat",
        bearer=bearer,
        body={"worker_id": "lease-thief", "lease_seconds": 30},
        expected_statuses=(400,),
    )
    require_error_code(wrong_heartbeat, "bad_request", "wrong-worker heartbeat")

    _, after_wrong_heartbeat_payload = request_json(
        "GET", f"{base_url}/v1/jobs/{job_id}", bearer=bearer
    )
    after_wrong_heartbeat = require_job(
        after_wrong_heartbeat_payload, "get after wrong-worker heartbeat"
    )
    if (
        after_wrong_heartbeat["status"] != "running"
        or after_wrong_heartbeat["claimed_by"] != worker_id
    ):
        raise ConformanceError("a wrong-worker heartbeat mutated lease ownership")

    _, heartbeat_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs/{job_id}/heartbeat",
        bearer=bearer,
        body={"worker_id": worker_id, "lease_seconds": 45},
    )
    heartbeat = require_job(heartbeat_payload, "heartbeat")
    if (
        heartbeat["status"] != "running"
        or heartbeat["claimed_by"] != worker_id
        or heartbeat["attempts"] != 1
        or not isinstance(heartbeat["lease_expires_at"], str)
    ):
        raise ConformanceError("valid heartbeat did not preserve and renew the lease")

    _, wrong_completion = request_json(
        "POST",
        f"{base_url}/v1/jobs/{job_id}/complete",
        bearer=bearer,
        body={
            "worker_id": "lease-thief",
            "outcome": "succeeded",
            "result": {"certified": False},
            "retryable": False,
        },
        expected_statuses=(400,),
    )
    require_error_code(wrong_completion, "bad_request", "wrong-worker completion")

    result = {
        "certified": True,
        "producer": "conformance-worker",
        "observer": "test-org-release-gate",
    }
    _, completed_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs/{job_id}/complete",
        bearer=bearer,
        body={
            "worker_id": worker_id,
            "outcome": "succeeded",
            "result": result,
            "retryable": False,
        },
    )
    completed = require_job(completed_payload, "complete")
    assert_identity(completed, job_id)
    if (
        completed["status"] != "succeeded"
        or completed["result"] != result
        or completed["claimed_by"] is not None
        or completed["lease_expires_at"] is not None
    ):
        raise ConformanceError(f"completed job did not enter a clean terminal state: {completed!r}")

    _, terminal_payload = request_json(
        "GET", f"{base_url}/v1/jobs/{job_id}", bearer=bearer
    )
    terminal = require_job(terminal_payload, "terminal readback")
    if terminal != completed:
        raise ConformanceError("terminal job readback differs from completion response")

    _, terminal_replay_payload = request_json(
        "POST",
        f"{base_url}/v1/jobs",
        bearer=bearer,
        headers=create_headers,
        body=create_body,
        expected_statuses=(202,),
    )
    terminal_replay = require_job(
        terminal_replay_payload, "terminal idempotent create replay"
    )
    if terminal_replay["id"] != job_id or terminal_replay["status"] != "succeeded":
        raise ConformanceError("idempotent replay did not preserve terminal job identity")

    status, empty_claim = request_json(
        "POST",
        f"{base_url}/v1/jobs/claim",
        bearer=bearer,
        body={
            "worker_id": "post-completion-worker",
            "orgs": ["fiducia-cloud-test"],
            "repositories": ["control-plane-e2e"],
            "task_types": ["conformance_probe"],
            "lease_seconds": 30,
        },
        expected_statuses=(204,),
    )
    if status != 204 or empty_claim is not None:
        raise ConformanceError("completed work was claimable again")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--bearer", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        validate_runtime(args.url, args.bearer)
    except ConformanceError as error:
        print(f"coordinator conformance failed: {error}", file=sys.stderr)
        return 1
    print("Agent Pontifex coordinator conformance passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
