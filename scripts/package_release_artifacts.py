from pathlib import Path
import shutil

root = Path("artifacts")
out = Path("release")
out.mkdir(exist_ok=True)
for path in root.rglob("*"):
    if path.is_file():
        rel = path.relative_to(root)
        target = out / rel.name
        if target.exists():
            target = out / f"{rel.parts[0]}-{rel.name}"
        shutil.copy2(path, target)
for p in sorted(out.iterdir()):
    print(p.name, p.stat().st_size)
