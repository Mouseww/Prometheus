import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def wait_for(url: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError(f"Service did not become ready: {url}")


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


with tempfile.TemporaryDirectory(prefix="prometheus-team-e2e-") as temporary:
    temporary_path = Path(temporary)
    workspace = temporary_path / "workspace"
    workspace.mkdir()
    fixture_log_path = temporary_path / "fixture.log"
    server_log_path = temporary_path / "server.log"
    fixture_log = fixture_log_path.open("w+", encoding="utf-8")
    server_log = server_log_path.open("w+", encoding="utf-8")
    fixture = None
    server = None
    try:
        fixture = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts" / "openai_compatible_fixture.py")],
            cwd=ROOT,
            stdout=fixture_log,
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        server_env = os.environ.copy()
        server_env.update({
            "PROMETHEUS_WORKSPACE_ROOT": str(workspace),
            "PROMETHEUS_DATA_FILE": str(temporary_path / "prometheus.db"),
            "PROMETHEUS_MASTER_KEY": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "PROMETHEUS_PORT": "4310",
        })
        server = subprocess.Popen(
            ["node", str(ROOT / "apps" / "server" / "dist" / "index.js")],
            cwd=ROOT,
            env=server_env,
            stdout=server_log,
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        wait_for("http://127.0.0.1:4320/health")
        wait_for("http://127.0.0.1:4310/api/health")

        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "e2e_team_runtime.py")],
            cwd=ROOT,
            check=True,
        )
    except BaseException:
        fixture_log.flush()
        server_log.flush()
        print("--- fixture log ---", file=sys.stderr)
        print(fixture_log_path.read_text(encoding="utf-8"), file=sys.stderr)
        print("--- server log ---", file=sys.stderr)
        print(server_log_path.read_text(encoding="utf-8"), file=sys.stderr)
        raise
    finally:
        if server is not None:
            stop(server)
        if fixture is not None:
            stop(fixture)
        fixture_log.close()
        server_log.close()
