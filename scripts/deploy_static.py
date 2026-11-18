"""Build the serverless phone app and publish it as a free *static* Hugging Face Space.

  .venv/bin/python scripts/deploy_static.py            # build + deploy, prints your private install link
  .venv/bin/python scripts/deploy_static.py --build    # build only, into deploy/static-build/

The page runs entirely in the phone's browser (live YouBike feed + Open-Meteo, data in
localStorage). Your places/trips are NOT in the published files: they travel in the
#setup=… fragment of the install link, which browsers never send to the server.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deploy" / "static-build"
SPACE_NAME = os.environ.get("UBIKE_SPACE", "ubike")


def setup_token() -> str:
    """Places, trips and prefs from the local DB (falls back to config/app.yaml)."""
    sys.path.insert(0, str(ROOT))
    data = None
    try:
        import duckdb
        con = duckdb.connect(str(ROOT / "data" / "ubike.duckdb"), read_only=True)
        q = lambda sql: [dict(zip([d[0] for d in c.description], r)) for c in [con.execute(sql)] for r in c.fetchall()]
        data = {"places": q("SELECT id, name, icon, lat, lng, radius_m, mode, sort FROM my_places ORDER BY sort"),
                "routes": q("SELECT id, from_place, to_place, weekdays, depart, enabled FROM my_routes"),
                "prefs": {r["key"]: json.loads(r["value"]) for r in q("SELECT key, value FROM prefs")}}
        con.close()
    except Exception as e:
        # DB locked by a running `ubike serve` → ask that server instead
        try:
            import httpx
            key = next(l.split("=", 1)[1].strip() for l in (ROOT / ".env").read_text().splitlines() if l.startswith("UBIKE_KEY="))
            h = {"x-ubike-key": key}
            pl = httpx.get("http://localhost:8000/api/places", headers=h, timeout=5).json()
            pr = httpx.get("http://localhost:8000/api/prefs", headers=h, timeout=5).json()
            data = {"places": pl["places"], "routes": pl["routes"], "prefs": pr}
            print("  (read places from the running local server)", file=sys.stderr)
        except Exception as e2:
            print(f"  (local DB not readable: {e}; server not reachable: {e2}; using config/app.yaml)", file=sys.stderr)
    if not data or not data["places"]:
        import yaml
        cfg = yaml.safe_load((ROOT / "config" / "app.yaml").read_text(encoding="utf-8"))
        data = {"places": [{**p, "sort": i} for i, p in enumerate(cfg["places"])], "routes": cfg["routes"], "prefs": cfg["prefs"]}
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def build() -> Path:
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(ROOT / "web" / "app", OUT / "app")
    shutil.copytree(ROOT / "web" / "shared", OUT / "shared")
    idx = OUT / "app" / "index.html"
    html = idx.read_text(encoding="utf-8")
    html = html.replace('<script type="module" src="/app/app.js"></script>',
                        '<script>window.UBIKE_STATIC = true;</script>\n  <script type="module" src="/app/app.js"></script>')
    assert "UBIKE_STATIC" in html
    idx.write_text(html, encoding="utf-8")
    # HF static hosting does not map "/app/" to index.html → always use the file URL.
    sw = OUT / "app" / "sw.js"
    sw.write_text(sw.read_text(encoding="utf-8").replace("'/app/',", "'/app/index.html',"), encoding="utf-8")
    # No start_url: iOS then keeps the exact page URL (incl. #setup=…) for the home-screen icon.
    (OUT / "app" / "manifest.webmanifest").write_text(json.dumps({
        "name": "Bike", "short_name": "Bike", "scope": "/app/", "display": "standalone",
        "background_color": "#000000", "theme_color": "#000000",
        "icons": [{"src": "/app/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/app/icons/icon-512.png", "sizes": "512x512", "type": "image/png"}]}), encoding="utf-8")
    (OUT / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Bike</title>'
        '<script>location.replace("/app/index.html" + location.hash)</script>', encoding="utf-8")
    (OUT / "README.md").write_text(
        "---\ntitle: Bike\nemoji: 🚲\ncolorFrom: blue\ncolorTo: indigo\nsdk: static\napp_file: index.html\npinned: false\n---\n\n"
        "Bike-share helper for Taipei (regular bikes). Runs entirely in the browser; "
        "personal data stays on the device.\n", encoding="utf-8")
    return OUT


def deploy() -> None:
    from huggingface_hub import HfApi, create_repo, get_token
    token = os.environ.get("HF_TOKEN") or get_token()
    if not token:
        sys.exit("Not logged in. Run:  huggingface-cli login")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    space_id = f"{user}/{SPACE_NAME}"
    print(f"→ static space {space_id}")
    create_repo(space_id, repo_type="space", space_sdk="static", exist_ok=True, token=token)
    api.upload_folder(folder_path=str(OUT), repo_id=space_id, repo_type="space", commit_message="deploy static app",
                      delete_patterns=["app/**", "shared/**"])
    stage = ""
    for _ in range(30):
        stage = api.get_space_runtime(space_id).stage
        if stage in ("RUNNING", "BUILD_ERROR", "RUNTIME_ERROR", "CONFIG_ERROR"):
            break
        time.sleep(5)
    host = "https://" + re.sub(r"[^a-z0-9]+", "-", space_id.lower()) + ".static.hf.space"
    print(f"  status: {stage}")
    print(f"\n  Your private install link (open in Safari → Share → Add to Home Screen):\n"
          f"  {host}/app/index.html#setup={setup_token()}\n")
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "install_link.txt").write_text(f"{host}/app/index.html#setup={setup_token()}\n")
    print("  (also saved to data/install_link.txt — don't share it, it contains your places)")


if __name__ == "__main__":
    build()
    print(f"built {OUT}")
    if "--build" not in sys.argv:
        deploy()
