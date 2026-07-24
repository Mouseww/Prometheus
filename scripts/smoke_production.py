import json
from urllib.request import urlopen


with urlopen("http://127.0.0.1:4310/api/health", timeout=5) as response:
    health = json.load(response)

with urlopen("http://127.0.0.1:4310/", timeout=5) as response:
    html = response.read().decode("utf-8")

assert health["status"] == "ok"
assert "<title>Prometheus</title>" in html
print("production_api=ok")
print("hosted_webui=ok")
