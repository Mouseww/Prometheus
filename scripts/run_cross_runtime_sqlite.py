import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
PORT = "4315"


def wait_for(url: str, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except OSError as error:
            last_error = error
            time.sleep(0.25)
    raise RuntimeError(f"Service did not become ready: {url} ({last_error})")


def stop(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=8)


def request(method: str, path: str, body: dict | None = None) -> tuple[int, dict | list | None]:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw) if raw else None
            return response.status, payload
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        payload = json.loads(raw) if raw else None
        return error.code, payload


def assert_status(actual: int, expected: int, context: str, payload) -> None:
    if actual != expected:
        raise AssertionError(f"{context}: expected {expected}, got {actual}, body={payload}")


def start_node(env: dict, log_path: Path) -> subprocess.Popen:
    log = log_path.open("w+", encoding="utf-8")
    process = subprocess.Popen(
        ["node", str(ROOT / "apps" / "server" / "dist" / "index.js")],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=CREATE_NO_WINDOW,
    )
    process._prometheus_log = log  # type: ignore[attr-defined]
    return process


def start_rust(env: dict, log_path: Path) -> subprocess.Popen:
    binary = ROOT / "apps" / "server-rs" / "target" / "debug" / (
        "prometheus-server.exe" if os.name == "nt" else "prometheus-server"
    )
    if not binary.exists():
        subprocess.run(
            ["cargo", "build", "--manifest-path", str(ROOT / "apps" / "server-rs" / "Cargo.toml")],
            cwd=ROOT,
            check=True,
        )
    log = log_path.open("w+", encoding="utf-8")
    process = subprocess.Popen(
        [str(binary)],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=CREATE_NO_WINDOW,
    )
    process._prometheus_log = log  # type: ignore[attr-defined]
    return process


def close_log(process: subprocess.Popen | None) -> str:
    if process is None:
        return ""
    log = getattr(process, "_prometheus_log", None)
    if log is None:
        return ""
    path = Path(log.name)
    log.flush()
    log.close()
    return path.read_text(encoding="utf-8", errors="replace")


def main() -> None:
    node_dist = ROOT / "apps" / "server" / "dist" / "index.js"
    if not node_dist.exists():
        raise SystemExit("apps/server/dist/index.js missing; run pnpm --filter @prometheus/server build first")

    with tempfile.TemporaryDirectory(prefix="prometheus-cross-runtime-") as temporary:
        temporary_path = Path(temporary)
        workspace = temporary_path / "workspace"
        workspace.mkdir()
        (workspace / "README.md").write_text("# cross runtime\n", encoding="utf-8")
        data_file = temporary_path / "prometheus.db"
        env = os.environ.copy()
        env.update({
            "PROMETHEUS_WORKSPACE_ROOT": str(workspace),
            "PROMETHEUS_DATA_FILE": str(data_file),
            "PROMETHEUS_MASTER_KEY": MASTER_KEY,
            "PROMETHEUS_PORT": PORT,
            "PROMETHEUS_HOST": "127.0.0.1",
            "PROMETHEUS_WEB_ROOT": str(temporary_path / "empty-web"),
        })
        (temporary_path / "empty-web").mkdir()

        node = None
        rust = None
        try:
            node = start_node(env, temporary_path / "node-write.log")
            wait_for(f"http://127.0.0.1:{PORT}/api/health")

            status, body = request("POST", "/api/sessions", {"title": "Node durable seed"})
            assert_status(status, 201, "node create session", body)
            session_id = body["session"]["id"]
            event_id = "11111111-1111-4111-8111-111111111111"
            status, body = request(
                "POST",
                f"/api/sessions/{session_id}/events",
                {
                    "eventId": event_id,
                    "type": "message.user",
                    "actor": {"kind": "user", "id": "node-writer", "label": "Node"},
                    "payload": {"text": "seeded-by-node"},
                },
            )
            assert_status(status, 201, "node append event", body)
            first_sequence = body["event"]["sequence"]

            status, body = request(
                "POST",
                "/api/providers",
                {
                    "name": "Node Provider",
                    "kind": "openai_compatible",
                    "baseUrl": "https://api.example.com/v1",
                    "defaultModel": "gpt-node",
                    "apiKey": "sk-node-secret",
                },
            )
            assert_status(status, 201, "node create provider", body)
            provider_id = body["provider"]["id"]
            assert body["provider"]["hasApiKey"] is True

            status, body = request(
                "POST",
                "/api/agents",
                {
                    "name": "Node Agent",
                    "description": "seeded",
                    "systemPrompt": "Be precise",
                    "providerId": provider_id,
                    "model": "gpt-node",
                },
            )
            assert_status(status, 201, "node create agent", body)
            agent_id = body["agent"]["id"]

            status, body = request(
                "POST",
                "/api/permission-rules",
                {"toolName": "shell_command", "effect": "deny", "pattern": "rm *"},
            )
            assert_status(status, 201, "node create rule", body)
            rule_id = body["rule"]["id"]

            stop(node)
            node_log = close_log(node)
            node = None
            time.sleep(0.5)

            rust = start_rust(env, temporary_path / "rust-read.log")
            wait_for(f"http://127.0.0.1:{PORT}/api/health")

            status, body = request("GET", "/api/sessions")
            assert_status(status, 200, "rust list sessions", body)
            sessions = body["sessions"]
            assert len(sessions) == 1, sessions
            assert sessions[0]["id"] == session_id
            assert sessions[0]["title"] == "Node durable seed"
            assert sessions[0]["lastSequence"] == first_sequence

            status, body = request("GET", f"/api/sessions/{session_id}/events?afterSequence=0")
            assert_status(status, 200, "rust list events", body)
            assert body["events"][0]["eventId"] == event_id
            assert body["events"][0]["payload"]["text"] == "seeded-by-node"

            status, body = request("GET", "/api/providers")
            assert_status(status, 200, "rust list providers", body)
            assert body["providers"][0]["id"] == provider_id
            assert body["providers"][0]["name"] == "Node Provider"
            assert body["providers"][0]["hasApiKey"] is True
            assert "apiKey" not in body["providers"][0]

            status, body = request("GET", "/api/agents")
            assert_status(status, 200, "rust list agents", body)
            assert body["agents"][0]["id"] == agent_id

            status, body = request("GET", "/api/permission-rules")
            assert_status(status, 200, "rust list rules", body)
            assert body["rules"][0]["id"] == rule_id
            assert body["rules"][0]["effect"] == "deny"

            rust_event_id = "22222222-2222-4222-8222-222222222222"
            status, body = request(
                "POST",
                f"/api/sessions/{session_id}/events",
                {
                    "eventId": rust_event_id,
                    "type": "message.agent",
                    "actor": {"kind": "agent", "id": "rust-writer", "label": "Rust"},
                    "payload": {"text": "appended-by-rust"},
                },
            )
            assert_status(status, 201, "rust append event", body)
            second_sequence = body["event"]["sequence"]
            assert second_sequence > first_sequence

            status, body = request(
                "POST",
                "/api/providers",
                {
                    "name": "Rust Provider",
                    "kind": "openai",
                    "defaultModel": "gpt-rust",
                    "apiKey": "sk-rust-secret",
                },
            )
            assert_status(status, 201, "rust create provider", body)
            rust_provider_id = body["provider"]["id"]

            status, body = request(
                "POST",
                "/api/permission-rules",
                {"toolName": "write_file", "effect": "ask", "pattern": "docs/*"},
            )
            assert_status(status, 201, "rust create rule", body)
            rust_rule_id = body["rule"]["id"]

            stop(rust)
            rust_log = close_log(rust)
            rust = None
            time.sleep(0.5)

            node = start_node(env, temporary_path / "node-read.log")
            wait_for(f"http://127.0.0.1:{PORT}/api/health")

            status, body = request("GET", f"/api/sessions/{session_id}/events?afterSequence=0")
            assert_status(status, 200, "node reread events", body)
            event_ids = [event["eventId"] for event in body["events"]]
            assert event_id in event_ids
            assert rust_event_id in event_ids
            texts = [event["payload"]["text"] for event in body["events"]]
            assert "seeded-by-node" in texts
            assert "appended-by-rust" in texts

            status, body = request("GET", "/api/providers")
            assert_status(status, 200, "node reread providers", body)
            provider_ids = {provider["id"] for provider in body["providers"]}
            assert provider_id in provider_ids
            assert rust_provider_id in provider_ids
            assert all(provider["hasApiKey"] for provider in body["providers"])

            status, body = request("GET", "/api/permission-rules")
            assert_status(status, 200, "node reread rules", body)
            rule_ids = {rule["id"] for rule in body["rules"]}
            assert rule_id in rule_ids
            assert rust_rule_id in rule_ids
            # deny before ask ordering
            effects = [rule["effect"] for rule in body["rules"]]
            assert effects.index("deny") < effects.index("ask")

            print("node_to_rust_sessions=ok")
            print("node_to_rust_events=ok")
            print("node_to_rust_config=ok")
            print("rust_to_node_events=ok")
            print("rust_to_node_config=ok")
            print("cross_runtime_sqlite=ok")
        except BaseException:
            print("--- node write log ---", file=sys.stderr)
            print(close_log(node) if node else (temporary_path / "node-write.log").read_text(encoding="utf-8", errors="replace") if (temporary_path / "node-write.log").exists() else "", file=sys.stderr)
            print("--- rust log ---", file=sys.stderr)
            print(close_log(rust) if rust else (temporary_path / "rust-read.log").read_text(encoding="utf-8", errors="replace") if (temporary_path / "rust-read.log").exists() else "", file=sys.stderr)
            print("--- node read log ---", file=sys.stderr)
            print((temporary_path / "node-read.log").read_text(encoding="utf-8", errors="replace") if (temporary_path / "node-read.log").exists() else "", file=sys.stderr)
            raise
        finally:
            stop(rust)
            stop(node)
            close_log(rust)
            close_log(node)


if __name__ == "__main__":
    main()
