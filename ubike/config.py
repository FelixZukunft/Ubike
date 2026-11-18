"""Paths, timezone, config + secrets loading."""
from __future__ import annotations

import datetime as dt
import os
from functools import cache
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = Path(os.environ.get("UBIKE_DATA_DIR", ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
DB_PATH = DATA_DIR / "ubike.duckdb"

TZ = ZoneInfo("Asia/Taipei")


def now_local() -> dt.datetime:
    """Current time in Asia/Taipei as a *naive* datetime (DB convention)."""
    return dt.datetime.now(TZ).replace(tzinfo=None, microsecond=0)


@cache
def context_config() -> dict:
    return yaml.safe_load((CONFIG_DIR / "context.yaml").read_text(encoding="utf-8"))


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def secret(name: str) -> str | None:
    _load_dotenv()
    return os.environ.get(name) or None
