"""Cloud persistence for hosts with an ephemeral disk (Hugging Face Spaces).

Backs the DuckDB file up to a *private* Hugging Face dataset and restores it on a
fresh start:
  state.duckdb                     every table except snapshots/poll_log (small)
  snapshots/YYYY-MM-DD.parquet     one file per day (today's is re-uploaded)

Enabled when HF_TOKEN and UBIKE_BACKUP_REPO (e.g. "you/ubike-data") are set.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import shutil
import threading
import time

import duckdb

from .config import DATA_DIR, now_local
from .db import SCHEMA

log = logging.getLogger("ubike.cloud")

BIG = {"snapshots", "poll_log"}
RESTORE_DAYS = int(os.environ.get("UBIKE_RESTORE_DAYS", "60"))
_dirty = threading.Event()
_lock = threading.Lock()


def enabled() -> bool:
    return bool(os.environ.get("HF_TOKEN") and os.environ.get("UBIKE_BACKUP_REPO"))


def _repo() -> str:
    return os.environ["UBIKE_BACKUP_REPO"]


def _api():
    from huggingface_hub import HfApi
    return HfApi(token=os.environ["HF_TOKEN"])


def mark_dirty() -> None:
    """Personal data changed (ride, place, ...): back up soon."""
    _dirty.set()


def _tables(con) -> list[str]:
    return [r[0] for r in con.execute(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main'"
    ).fetchall()]


# ------------------------------------------------------------------ backup
def backup_state(con) -> None:
    work = DATA_DIR / "backup"
    work.mkdir(parents=True, exist_ok=True)
    path = work / "state.duckdb"
    path.unlink(missing_ok=True)
    tmp = duckdb.connect(str(path))
    tmp.execute(SCHEMA)          # same schema → primary keys survive
    tmp.close()
    cur = con.cursor()
    cur.execute(f"ATTACH '{path}' AS bk")
    try:
        for t in _tables(cur):
            if t not in BIG:
                cur.execute(f"INSERT INTO bk.{t} BY NAME SELECT * FROM main.{t}")
    finally:
        cur.execute("DETACH bk")
    _api().upload_file(path_or_fileobj=str(path), path_in_repo="state.duckdb",
                       repo_id=_repo(), repo_type="dataset", commit_message="state backup")


def backup_snapshots(con, days: list[dt.date]) -> None:
    work = DATA_DIR / "backup" / "snapshots"
    work.mkdir(parents=True, exist_ok=True)
    cur = con.cursor()
    for d in days:
        f = work / f"{d.isoformat()}.parquet"
        n = cur.execute("SELECT count(*) FROM snapshots WHERE info_time >= ? AND info_time < ?",
                        [d, d + dt.timedelta(days=1)]).fetchone()[0]
        if not n:
            continue
        cur.execute(f"""COPY (SELECT * FROM snapshots WHERE info_time >= DATE '{d.isoformat()}'
                              AND info_time < DATE '{(d + dt.timedelta(days=1)).isoformat()}' ORDER BY sno, info_time)
                        TO '{f}' (FORMAT parquet, COMPRESSION zstd)""")
        _api().upload_file(path_or_fileobj=str(f), path_in_repo=f"snapshots/{f.name}",
                           repo_id=_repo(), repo_type="dataset", commit_message=f"snapshots {d}")


def backup_loop(con, stop: threading.Event, status: dict) -> None:
    last_state = time.monotonic()
    last_snap = time.monotonic()
    done_days: set[dt.date] = set()
    while not stop.is_set():
        try:
            now = time.monotonic()
            if (_dirty.is_set() and now - last_state > 90) or now - last_state > 3600:
                _dirty.clear()
                with _lock:
                    backup_state(con)
                last_state = now
                status["backup_state"] = now_local().isoformat()
            if now - last_snap > 3600:
                today = now_local().date()
                yesterday = today - dt.timedelta(days=1)
                days = [today] if yesterday in done_days else [yesterday, today]
                with _lock:
                    backup_snapshots(con, days)
                done_days.add(yesterday)  # finished day uploaded once, completely
                last_snap = now
                status["backup_snapshots"] = now_local().isoformat()
        except Exception as e:  # never kill the server over a failed backup
            log.warning("backup failed: %s", e)
            status["backup_error"] = str(e)[:300]
        stop.wait(30)


# ------------------------------------------------------------------ restore
def restore(con) -> str:
    """On a fresh disk, pull state + recent snapshots from the dataset."""
    if con.execute("SELECT count(*) FROM stations").fetchone()[0] > 0:
        return "local data present, no restore"
    from huggingface_hub import create_repo, snapshot_download
    create_repo(_repo(), repo_type="dataset", private=True, exist_ok=True, token=os.environ["HF_TOKEN"])
    since = now_local().date() - dt.timedelta(days=RESTORE_DAYS)
    files = [f for f in _api().list_repo_files(_repo(), repo_type="dataset")
             if f == "state.duckdb" or (f.startswith("snapshots/") and f[10:20] >= since.isoformat())]
    if not files:
        return "backup repo empty"
    dl = DATA_DIR / "restore"
    shutil.rmtree(dl, ignore_errors=True)
    snapshot_download(_repo(), repo_type="dataset", allow_patterns=files, local_dir=str(dl),
                      token=os.environ["HF_TOKEN"])
    cur = con.cursor()
    msg = []
    if (dl / "state.duckdb").exists():
        cur.execute(f"ATTACH '{dl / 'state.duckdb'}' AS st (READ_ONLY)")
        src = {r[0] for r in cur.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name = 'st'").fetchall()}
        for t in _tables(cur):
            if t in src and t not in BIG:
                cur.execute(f"INSERT INTO main.{t} BY NAME SELECT * FROM st.{t}")
        cur.execute("DETACH st")
        msg.append("state")
    snaps = list((dl / "snapshots").glob("*.parquet")) if (dl / "snapshots").exists() else []
    if snaps:
        cur.execute(f"INSERT INTO snapshots BY NAME SELECT * FROM read_parquet('{dl / 'snapshots'}/*.parquet')")
        msg.append(f"{len(snaps)} snapshot days")
    shutil.rmtree(dl, ignore_errors=True)
    return "restored " + ", ".join(msg)
