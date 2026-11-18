"""Deploy the app to a free Hugging Face Space (Docker) + private backup dataset.

Prerequisite (once):  huggingface-cli login     (token with *write* access)
Run:                  .venv/bin/python scripts/deploy_hf.py

What it does:
  1. creates a private dataset  <you>/ubike-data  and uploads your local data
     (places, routes, rides, prefs, collected snapshots) as the initial backup
  2. creates the Space  <you>/ubike  (Docker), stores secrets, uploads the code
  3. waits until the Space is running and prints your phone link

The Space's code is public (Hugging Face free tier); your personal data lives only
in the private dataset and every API call needs your access key.
Re-run any time to push code changes. Stop the local server first (DuckDB lock).
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from huggingface_hub import HfApi, create_repo, get_token  # noqa: E402

SPACE_NAME = os.environ.get("UBIKE_SPACE", "ubike")
DATA_NAME = os.environ.get("UBIKE_DATASET", "ubike-data")


def env_file() -> dict:
    out = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def main(skip_data: bool = False) -> None:
    token = os.environ.get("HF_TOKEN") or get_token()
    if not token:
        sys.exit("Not logged in. Run:  huggingface-cli login   (create a token with WRITE access)")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    space_id, data_id = f"{user}/{SPACE_NAME}", f"{user}/{DATA_NAME}"
    env = env_file()
    if not env.get("UBIKE_KEY"):
        sys.exit("No UBIKE_KEY in .env — start the app locally once (`python -m ubike serve`) to create it.")

    # 1) private dataset with the initial data -------------------------------
    print(f"→ dataset {data_id} (private)")
    create_repo(data_id, repo_type="dataset", private=True, exist_ok=True, token=token)
    existing = set(api.list_repo_files(data_id, repo_type="dataset"))
    if skip_data or "state.duckdb" in existing:
        print("  backup already exists — keeping it (the Space's data is newer than your Mac's)")
    else:
        os.environ["HF_TOKEN"], os.environ["UBIKE_BACKUP_REPO"] = token, data_id
        from ubike import cloud
        from ubike.db import connect
        try:
            con = connect()
        except Exception as e:
            sys.exit(f"Could not open the local database ({e}). Stop the local server first:\n"
                     "  launchctl bootout gui/$(id -u)/com.ubike.server   (or Ctrl-C `ubike serve`)")
        days = [r[0] for r in con.execute("SELECT DISTINCT info_time::DATE FROM snapshots ORDER BY 1").fetchall()]
        print(f"  uploading state + {len(days)} day(s) of snapshots …")
        cloud.backup_state(con)
        cloud.backup_snapshots(con, days)
        con.close()

    # 2) Space -----------------------------------------------------------------
    print(f"→ space {space_id} (Docker, free CPU)")
    create_repo(space_id, repo_type="space", space_sdk="docker", exist_ok=True, token=token)
    secrets = {"HF_TOKEN": token, "UBIKE_BACKUP_REPO": data_id, "UBIKE_KEY": env["UBIKE_KEY"]}
    if env.get("CWA_API_KEY"):
        secrets["CWA_API_KEY"] = env["CWA_API_KEY"]
    for k, v in secrets.items():
        api.add_space_secret(space_id, k, v)

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        for d in ("ubike", "web", "config"):
            shutil.copytree(ROOT / d, stage / d, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        for f in ("Dockerfile", "requirements.txt"):
            shutil.copy(ROOT / "deploy" / "hf" / f, stage / f)
        (stage / "README.md").write_text(
            "---\ntitle: Bike\nemoji: 🚲\ncolorFrom: blue\ncolorTo: indigo\nsdk: docker\napp_port: 7860\n"
            "pinned: false\n---\n\nPersonal bike-share helper for Taipei (regular bikes). "
            "The app needs an access key.\n", encoding="utf-8")
        print("  uploading code …")
        api.upload_folder(folder_path=str(stage), repo_id=space_id, repo_type="space",
                          commit_message="deploy", delete_patterns=["ubike/**", "web/**", "config/**"])

    # 3) wait for it -----------------------------------------------------------
    host = f"https://{space_id.replace('/', '-').replace('_', '-').replace('.', '-').lower()}.hf.space"
    print("→ building (first build takes ~3–5 min) …")
    stage_name = ""
    for _ in range(90):
        stage_name = api.get_space_runtime(space_id).stage
        if stage_name in ("RUNNING", "BUILD_ERROR", "RUNTIME_ERROR", "CONFIG_ERROR"):
            break
        time.sleep(10)
    print(f"  status: {stage_name}")
    if stage_name != "RUNNING":
        print(f"  check the logs: https://huggingface.co/spaces/{space_id}?logs=container")
    key = env["UBIKE_KEY"]
    print(f"\n  Phone (open in Safari → Share → Add to Home Screen):\n  {host}/app/?key={key}\n")


if __name__ == "__main__":
    main(skip_data="--skip-data" in sys.argv)
