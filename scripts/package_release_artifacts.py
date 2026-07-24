from __future__ import annotations

from pathlib import Path
import shutil
import sys

root = Path("artifacts")
out = Path("release")

if not root.exists():
    print("artifacts/ directory not found", file=sys.stderr)
    raise SystemExit(1)

if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)

copied = 0
for path in sorted(root.rglob("*")):
    if not path.is_file():
        continue
    rel = path.relative_to(root)
    # Prefer flat release names; disambiguate collisions with artifact folder prefix.
    target = out / rel.name
    if target.exists():
        prefix = rel.parts[0] if rel.parts else "artifact"
        target = out / f"{prefix}-{rel.name}"
    shutil.copy2(path, target)
    copied += 1
    print(f"copied {rel.as_posix()} -> {target.name} ({target.stat().st_size} bytes)")

if copied == 0:
    print("no artifact files found under artifacts/", file=sys.stderr)
    raise SystemExit(1)

print(f"packaged {copied} files into release/")
for item in sorted(out.iterdir()):
    print(item.name, item.stat().st_size)
