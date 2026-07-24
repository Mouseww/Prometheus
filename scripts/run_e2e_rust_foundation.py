import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def wait_for(url: str, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError(f"Service did not become ready: {url}")


def stop(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=8)


with tempfile.TemporaryDirectory(prefix="prometheus-rust-foundation-e2e-") as temporary:
    temporary_path = Path(temporary)
    workspace = temporary_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("# Prometheus Rust foundation workspace\n", encoding="utf-8")
    (workspace / "src").mkdir()
    (workspace / "src" / "main.rs").write_text("fn main() {}\n", encoding="utf-8")

    web_root = ROOT / "apps" / "client" / "dist"
    if not (web_root / "index.html").exists():
        subprocess.run(
            ["pnpm", "--filter", "@prometheus/client", "build"],
            cwd=ROOT,
            check=True,
            shell=(os.name == "nt"),
        )

    binary = ROOT / "apps" / "server-rs" / "target" / "debug" / (
        "prometheus-server.exe" if os.name == "nt" else "prometheus-server"
    )
    if not binary.exists():
        subprocess.run(
            ["cargo", "build", "--manifest-path", str(ROOT / "apps" / "server-rs" / "Cargo.toml")],
            cwd=ROOT,
            check=True,
        )

    server_log_path = temporary_path / "server.log"
    server_log = server_log_path.open("w+", encoding="utf-8")
    server = None
    try:
        env = os.environ.copy()
        env.update({
            "PROMETHEUS_WORKSPACE_ROOT": str(workspace),
            "PROMETHEUS_DATA_FILE": str(temporary_path / "prometheus.db"),
            "PROMETHEUS_MASTER_KEY": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "PROMETHEUS_PORT": "4310",
            "PROMETHEUS_HOST": "127.0.0.1",
            "PROMETHEUS_WEB_ROOT": str(web_root),
        })
        server = subprocess.Popen(
            [str(binary)],
            cwd=ROOT,
            env=env,
            stdout=server_log,
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        wait_for("http://127.0.0.1:4310/api/health")
        wait_for("http://127.0.0.1:4310/")

        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "e2e_rust_foundation.py")],
            cwd=ROOT,
            check=True,
        )
    except BaseException:
        server_log.flush()
        print("--- rust foundation server log ---", file=sys.stderr)
        print(server_log_path.read_text(encoding="utf-8", errors="replace"), file=sys.stderr)
        raise
    finally:
        stop(server)
        server_log.close()
