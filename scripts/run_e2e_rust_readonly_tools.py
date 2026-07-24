from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main() -> int:
    build = subprocess.run(
        ["cargo", "build", "--manifest-path", str(ROOT / "apps" / "server-rs" / "Cargo.toml")],
        cwd=str(ROOT),
        check=False,
    )
    if build.returncode != 0:
        return build.returncode
    return subprocess.call([sys.executable, str(ROOT / "scripts" / "e2e_rust_readonly_tools.py")])

if __name__ == "__main__":
    raise SystemExit(main())
