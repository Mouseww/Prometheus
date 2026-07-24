import json
import os
from pathlib import Path

team = os.environ.get("TEAM") or "0000000000"
for rel in ["src-tauri/tauri.conf.json", "src-tauri/tauri.ios.conf.json"]:
    path = Path(rel)
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("bundle", {}).setdefault("iOS", {})["developmentTeam"] = team
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"configured {rel} developmentTeam={team}")
