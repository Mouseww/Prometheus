"""HTTP-level E2E: real openai_compatible fixture + Rust control plane agent run."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "scripts" / "openai_compatible_fixture.py"
SERVER_BIN = ROOT / "apps" / "server-rs" / "target" / "debug" / "prometheus-server.exe"
if not SERVER_BIN.exists():
    SERVER_BIN = ROOT / "apps" / "server-rs" / "target" / "debug" / "prometheus-server"


def wait_http(url: str, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception as error:  # noqa: BLE001 - poll until ready
            last_error = error
            time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


def http_json(method: str, url: str, payload: dict | None = None, expected: int | None = None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if payload is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8")
        status = error.code
    parsed = json.loads(body) if body else {}
    if expected is not None and status != expected:
        raise AssertionError(f"{method} {url} expected {expected}, got {status}: {parsed}")
    return status, parsed


def main() -> int:
    workspace = ROOT / ".prometheus-e2e-rust-agent"
    workspace.mkdir(exist_ok=True)
    data_file = workspace / "prometheus.db"
    if data_file.exists():
        data_file.unlink()

    env = os.environ.copy()
    env["PROMETHEUS_WORKSPACE_ROOT"] = str(workspace)
    env["PROMETHEUS_DATA_FILE"] = str(data_file)
    env["PROMETHEUS_PORT"] = "4317"
    env["PROMETHEUS_HOST"] = "127.0.0.1"
    env["PROMETHEUS_MASTER_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

    fixture = subprocess.Popen(
        [sys.executable, str(FIXTURE)],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    server = subprocess.Popen(
        [str(SERVER_BIN)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_http("http://127.0.0.1:4320/health")
        wait_http("http://127.0.0.1:4317/api/health")

        _, provider_body = http_json(
            "POST",
            "http://127.0.0.1:4317/api/providers",
            {
                "name": "Local protocol fixture",
                "kind": "openai_compatible",
                "baseUrl": "http://127.0.0.1:4320/v1",
                "defaultModel": "fixture-model",
                "apiKey": "fixture-secret",
            },
            expected=201,
        )
        provider_id = provider_body["provider"]["id"]

        _, agent_body = http_json(
            "POST",
            "http://127.0.0.1:4317/api/agents",
            {
                "name": "Runtime verifier",
                "description": "Validates the real provider path",
                "systemPrompt": "Answer with verifiable evidence.",
                "providerId": provider_id,
                "model": "fixture-model",
            },
            expected=201,
        )
        agent_id = agent_body["agent"]["id"]

        _, session_body = http_json(
            "POST",
            "http://127.0.0.1:4317/api/sessions",
            {"title": "Rust agent runtime E2E"},
            expected=201,
        )
        session_id = session_body["session"]["id"]

        http_json(
            "POST",
            f"http://127.0.0.1:4317/api/sessions/{session_id}/events",
            {
                "eventId": str(uuid.uuid4()),
                "type": "message.user",
                "actor": {"kind": "user", "id": "user", "label": "You"},
                "payload": {"text": "Verify the complete runtime path."},
            },
            expected=201,
        )

        _, run_body = http_json(
            "POST",
            f"http://127.0.0.1:4317/api/sessions/{session_id}/runs",
            {"agentId": agent_id},
            expected=201,
        )
        assert run_body["run"]["replyEvent"]["payload"]["text"] == (
            "Fixture provider reply: end-to-end runtime works."
        ), run_body

        _, events_body = http_json(
            "GET",
            f"http://127.0.0.1:4317/api/sessions/{session_id}/events",
            expected=200,
        )
        types = [event["type"] for event in events_body["events"]]
        assert types == [
            "message.user",
            "agent.run.started",
            "message.agent",
            "agent.run.completed",
        ], types

        print("rust_agent_run=ok")
        print(f"session_id={session_id}")
        print(f"run_id={run_body['run']['runId']}")
        return 0
    finally:
        for process in (server, fixture):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
