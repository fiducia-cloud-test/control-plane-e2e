"""Authenticated SSE observer for the Agent Pontifex bridge."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from agent_pontifex_live_common import ConformanceError, MAX_RESPONSE_BYTES


class SseObserver:
    """One long-lived bridge subscription owned by a registered identity."""

    def __init__(self, *, base_url: str, channel: str, bearer: str, agent_id: str) -> None:
        channel = urllib.parse.quote(channel, safe="")
        agent = urllib.parse.quote(agent_id, safe="")
        self.url = f"{base_url.rstrip('/')}/channels/{channel}/stream?agent_key={agent}"
        self.bearer = bearer
        self.agent_id = agent_id
        self.ready = threading.Event()
        self.stop_requested = threading.Event()
        self._lock = threading.Lock()
        self._sequences: list[int] = []
        self._errors: list[str] = []
        self._response: Any = None
        self._thread = threading.Thread(target=self._run, name=f"sse-{agent_id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _error(self, message: str) -> None:
        with self._lock:
            self._errors.append(message)

    def _event(self, event: Any) -> None:
        if not isinstance(event, dict):
            self._error("SSE event was not an object")
            return
        if event.get("type") == "lagged":
            self._error("SSE observer reported a lagged event")
            return
        if event.get("type") != "message":
            return
        sequence = event.get("seq")
        if not isinstance(sequence, int) or sequence <= 0:
            self._error("SSE message omitted a positive sequence")
            return
        with self._lock:
            self._sequences.append(sequence)

    def _run(self) -> None:
        request = urllib.request.Request(
            self.url,
            headers={
                "Accept": "text/event-stream",
                "Authorization": f"Bearer {self.bearer}",
                "Cache-Control": "no-cache",
            },
            method="GET",
        )
        try:
            response = urllib.request.urlopen(request, timeout=300)
            self._response = response
            if response.status != 200:
                self._error(f"SSE endpoint returned HTTP {response.status}")
                return
            self.ready.set()
            data_lines: list[str] = []
            while not self.stop_requested.is_set():
                try:
                    raw_line = response.readline(MAX_RESPONSE_BYTES + 1)
                except (OSError, TimeoutError):
                    if not self.stop_requested.is_set():
                        self._error("SSE read failed")
                    break
                if len(raw_line) > MAX_RESPONSE_BYTES:
                    self._error("SSE line exceeded the response limit")
                    break
                if not raw_line:
                    if not self.stop_requested.is_set():
                        self._error("SSE stream ended unexpectedly")
                    break
                try:
                    line = raw_line.decode().rstrip("\r\n")
                except UnicodeDecodeError:
                    self._error("SSE stream contained invalid UTF-8")
                    break
                if line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                    continue
                if line or not data_lines:
                    continue
                raw_event = "\n".join(data_lines)
                data_lines.clear()
                if len(raw_event.encode()) > MAX_RESPONSE_BYTES:
                    self._error("SSE event exceeded the response limit")
                    break
                try:
                    self._event(json.loads(raw_event))
                except json.JSONDecodeError:
                    self._error("SSE event was not valid JSON")
                    break
        except urllib.error.HTTPError as error:
            self._error(f"SSE endpoint returned HTTP {error.code}")
        except urllib.error.URLError:
            self._error("SSE connection failed")
        finally:
            self.ready.set()
            if self._response is not None:
                try:
                    self._response.close()
                except OSError:
                    pass

    def wait_ready(self, timeout_seconds: float) -> None:
        if not self.ready.wait(timeout_seconds):
            raise ConformanceError(f"SSE observer did not become ready: {self.agent_id}")
        if self.errors():
            raise ConformanceError(
                f"SSE observer failed to start: {self.agent_id}: {self.errors()[0]}"
            )

    def wait_for(self, expected: list[int], timeout_seconds: float) -> None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if self.errors():
                raise ConformanceError(
                    f"SSE observer failed: {self.agent_id}: {self.errors()[0]}"
                )
            observed = self.sequences()
            if observed == expected:
                return
            if len(observed) >= len(expected):
                raise ConformanceError(
                    f"unexpected SSE sequence for {self.agent_id}: "
                    f"expected={expected}, observed={observed}"
                )
            time.sleep(0.05)
        raise ConformanceError(
            f"SSE observer {self.agent_id} missed sequences; "
            f"expected={expected}, observed={self.sequences()}"
        )

    def sequences(self) -> list[int]:
        with self._lock:
            return list(self._sequences)

    def errors(self) -> list[str]:
        with self._lock:
            return list(self._errors)

    def stop(self) -> None:
        # Do not close HTTPResponse from this thread: CPython may block waiting
        # for a concurrent readline lock. Axum keep-alives wake the daemon reader,
        # which observes stop_requested and closes its own response in _run.
        self.stop_requested.set()
        self._thread.join(timeout=2)
