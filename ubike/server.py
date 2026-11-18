"""FastAPI server: API + phone app (/app) + background jobs.

One process owns the DuckDB file (DuckDB allows a single writer process), so the
60 s poller and the hourly/daily context jobs run here as threads.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import cloud, personal
from .config import ROOT, now_local, secret
from .db import connect
from .live import STATE, poll_once

log = logging.getLogger("ubike.server")
WEB = ROOT / "web"
COOKIE = "ubike_key"


# ------------------------------------------------------------------ token
def access_key() -> str:
    key = secret("UBIKE_KEY")
    if key:
        return key
    key = secrets.token_urlsafe(18)
    env = ROOT / ".env"
    with env.open("a", encoding="utf-8") as f:
        f.write(f"\n# Access key for the app (open it once with ?key=...)\nUBIKE_KEY={key}\n")
    import os
    os.environ["UBIKE_KEY"] = key
    return key


# ------------------------------------------------------------------ background jobs
class Jobs:
    def __init__(self, con):
        self.con = con
        self.stop = threading.Event()
        self.status: dict[str, dict] = {}

    def _record(self, name, ok, info):
        self.status[name] = {"at": now_local().isoformat(), "ok": ok, "info": str(info)[:300]}

    def poller(self):
        cur = self.con.cursor()
        interval = personal.app_config()["poller"]["interval_s"]
        archive = personal.app_config()["poller"].get("archive_raw", True)
        if os.environ.get("UBIKE_ARCHIVE_RAW") is not None:
            archive = os.environ["UBIKE_ARCHIVE_RAW"] not in ("0", "false", "no")
        while not self.stop.is_set():
            t0 = time.monotonic()
            try:
                n = poll_once(cur, archive)
                self._record("poller", True, f"{n} new rows")
            except Exception as e:
                log.warning("poll failed: %s", e)
                self._record("poller", False, e)
            self.stop.wait(max(5, interval - (time.monotonic() - t0)))

    def context(self):
        from .cli import cmd_daily, cmd_hourly
        cur = self.con.cursor()
        last_daily = cur.execute("SELECT max(last_seen) FROM events").fetchone()[0]
        last_hourly = cur.execute("SELECT max(issued_at) FROM weather_forecast").fetchone()[0]
        while not self.stop.is_set():
            now = now_local()
            try:
                if last_hourly is None or now - last_hourly >= dt.timedelta(minutes=60):
                    self._record("hourly", cmd_hourly(cur, None), "weather + CWA")
                    last_hourly = now
                if last_daily is None or now - last_daily >= dt.timedelta(hours=24) or \
                        (now.hour == 4 and now.minute >= 30 and last_daily.date() < now.date()):
                    self._record("daily", cmd_daily(cur, None), "stations, elevation, calendar, events")
                    last_daily = now
            except Exception as e:
                log.exception("context job failed")
                self._record("context", False, e)
            self.stop.wait(60)

    def backup(self):
        cloud.backup_loop(self.con, self.stop, self.status)

    def start(self):
        jobs = [self.poller, self.context] + ([self.backup] if cloud.enabled() else [])
        for fn in jobs:
            threading.Thread(target=fn, name=fn.__name__, daemon=True).start()


# ------------------------------------------------------------------ app
_con = None
_jobs: Jobs | None = None


def db():
    return _con.cursor()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _con, _jobs
    _con = connect()
    if cloud.enabled():
        try:
            log.warning("cloud restore: %s", cloud.restore(_con))
        except Exception as e:
            log.warning("cloud restore failed: %s", e)
    personal.seed_defaults(_con)
    STATE.warm_start(_con)
    if not STATE.stations:
        poll_once(_con.cursor())
    if app.state.run_jobs:
        _jobs = Jobs(_con)
        _jobs.start()
    yield
    if _jobs:
        _jobs.stop.set()
    _con.close()


app = FastAPI(title="YouBike Optimizer", lifespan=lifespan, docs_url=None, redoc_url=None)
app.state.run_jobs = True


@app.middleware("http")
async def auth(request: Request, call_next):
    path = request.url.path
    key = access_key()
    given = request.query_params.get("key")
    if given and secrets.compare_digest(given, key):
        # Strip the key from the URL and remember it in a long-lived cookie.
        resp = RedirectResponse(str(request.url.remove_query_params("key")), status_code=303)
        resp.set_cookie(COOKIE, key, max_age=400 * 86400, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https")
        return resp
    public = path in ("/", "/favicon.ico", "/api/unlock") \
        or path.startswith(("/app/", "/shared/")) or path == "/app"
    if not public:
        cookie = request.cookies.get(COOKIE, "")
        header = request.headers.get("x-ubike-key", "")
        if not (secrets.compare_digest(cookie, key) or secrets.compare_digest(header, key)):
            return JSONResponse({"error": "locked", "hint": "open the app once with ?key=…"}, status_code=401)
    resp = await call_next(request)
    if request.method != "GET" and path.startswith("/api/") and resp.status_code < 400:
        cloud.mark_dirty()  # personal data changed → back up soon
    return resp


@app.get("/")
def root():
    return RedirectResponse("/app/")


# ---------------------------------------------------------------- live / personal
@app.get("/api/live")
def api_live(lat: float, lng: float, mode: str = "bike", limit: int = 12,
             max_m: float = 2000, hide_empty: bool = False):
    return {"fetched_at": STATE.fetched_at.isoformat() if STATE.fetched_at else None,
            "now": now_local().isoformat(),
            "stations": STATE.nearest(lat, lng, limit=limit, max_m=max_m, mode=mode, hide_empty=hide_empty)}


@app.get("/api/map")
def api_map():
    """Compact all-stations payload for the phone map: [sno, lat, lng, bikes, docks, capacity, name, name_zh]."""
    with STATE.lock:
        rows = [[s.sno, s.lat, s.lng, s.bikes, s.docks, s.capacity, s.name_en, s.name_zh]
                for s in STATE.stations.values() if s.active]
    return {"fetched_at": STATE.fetched_at.isoformat() if STATE.fetched_at else None, "stations": rows}


@app.get("/api/home")
def api_home():
    return personal.home(db())


@app.get("/api/places")
def api_places():
    return {"places": personal.get_places(db()), "routes": personal.get_routes(db())}


@app.post("/api/places")
def api_save_place(p: dict = Body(...)):
    return personal.save_place(db(), p)


@app.delete("/api/places/{pid}")
def api_delete_place(pid: str):
    personal.delete_place(db(), pid)
    return {"ok": True}


@app.post("/api/routes")
def api_save_route(r: dict = Body(...)):
    return personal.save_route(db(), r)


@app.delete("/api/routes/{rid}")
def api_delete_route(rid: str):
    personal.delete_route(db(), rid)
    return {"ok": True}


@app.get("/api/prefs")
def api_prefs():
    return personal.get_prefs(db())


@app.post("/api/prefs")
def api_set_prefs(values: dict = Body(...)):
    return personal.set_prefs(db(), values)


@app.get("/api/heatmap/{place_id}")
def api_heatmap(place_id: str, kind: str = "bike"):
    return personal.heatmap(db(), place_id, kind)


@app.get("/api/station/{sno}")
def api_station(sno: str, hours: int = 24):
    if sno not in STATE.stations:
        raise HTTPException(404, "unknown station")
    return personal.station_history(db(), sno, hours)


@app.get("/api/search")
def api_search(q: str, lat: float | None = None, lng: float | None = None):
    return personal.search_stations(q, lat, lng)


@app.get("/api/rides")
def api_rides():
    return personal.ride_history(db())


@app.post("/api/rides/start")
def api_ride_start(body: dict = Body(default={})):
    return personal.start_ride(db(), body.get("sno"))


@app.post("/api/rides/end")
def api_ride_end(body: dict = Body(default={})):
    r = personal.end_ride(db(), body.get("sno"))
    if r is None:
        raise HTTPException(409, "no active ride")
    return r


@app.post("/api/rides/cancel")
def api_ride_cancel():
    personal.cancel_ride(db())
    return {"ok": True}


@app.post("/api/rides")
def api_ride_add(body: dict = Body(...)):
    return personal.add_manual_ride(db(), body)


@app.delete("/api/rides/{rid}")
def api_ride_delete(rid: str):
    personal.delete_ride(db(), rid)
    return {"ok": True}


# ---------------------------------------------------------------- static
class NoCacheStatic(StaticFiles):
    """Revalidate on every load; the service worker handles offline."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


@app.post("/api/unlock")
def api_unlock(request: Request, body: dict = Body(...)):
    key = access_key()
    if not secrets.compare_digest(str(body.get("key", "")).strip(), key):
        raise HTTPException(403, "wrong key")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE, key, max_age=400 * 86400, httponly=True, samesite="lax",
                    secure=request.url.scheme == "https")
    return resp


@app.get("/app/manifest.webmanifest")
def manifest(request: Request):
    # An installed iOS web app has its own cookie jar, so its start URL carries
    # the key (only handed out to clients that are already unlocked).
    key = access_key()
    unlocked = secrets.compare_digest(request.cookies.get(COOKIE, ""), key)
    return JSONResponse({
        "name": "YouBike Optimizer", "short_name": "Bike",
        "start_url": f"/app/?key={key}" if unlocked else "/app/",
        "scope": "/app/", "display": "standalone",
        "background_color": "#000000", "theme_color": "#000000",
        "icons": [{"src": "/app/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/app/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/app/icons/icon-512.png", "sizes": "512x512", "type": "image/png",
                   "purpose": "maskable"}],
    }, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.get("/app/sw.js")
def service_worker():
    return FileResponse(WEB / "app" / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


app.mount("/app", NoCacheStatic(directory=WEB / "app", html=True), name="app")
app.mount("/shared", NoCacheStatic(directory=WEB / "shared"), name="shared")


def serve(host: str = "0.0.0.0", port: int = 8000, jobs: bool = True) -> None:
    import uvicorn
    app.state.run_jobs = jobs
    key = access_key()
    print()
    print(f"  Phone app:  http://localhost:{port}/app/?key={key}")
    print("  (GPS + compass on iPhone need HTTPS — see README → Phone)\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")


__all__ = ["app", "serve", "Path"]
