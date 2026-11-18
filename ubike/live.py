"""Live availability: 60 s poller, in-memory state, trends and arrival predictions.

The poller is the single writer of `snapshots`. It keeps the last ~30 min per
station in memory so the API can answer "Find Bike" without touching the DB.
"""
from __future__ import annotations

import datetime as dt
import logging
import math
import threading
from collections import deque
from dataclasses import dataclass, field

from .config import now_local
from .db import upsert
from .http import get_json
from .stations import FEED_URL

log = logging.getLogger(__name__)

HISTORY_MIN = 30          # minutes of per-station history kept in memory
TREND_WINDOW_MIN = 20     # window for the trend slope
WALK_M_PER_MIN = 75       # relaxed walking pace
DETOUR = 1.25             # street-network detour vs. straight line
TREND_THRESHOLD = 0.12    # bikes/min (~2.4 bikes in 20 min) to call it filling/draining


@dataclass
class Station:
    sno: str
    name_zh: str
    name_en: str
    district_zh: str
    district_en: str
    lat: float
    lng: float
    capacity: int
    active: bool
    bikes: int
    docks: int
    info_time: dt.datetime
    history: deque = field(default_factory=lambda: deque(maxlen=HISTORY_MIN * 2))

    def slope(self) -> float:
        """Least-squares bikes/min over the trend window (0 if too little data)."""
        if not self.history:
            return 0.0
        t_end = self.history[-1][0]
        pts = [((t - t_end).total_seconds() / 60, b) for t, b in self.history
               if (t_end - t).total_seconds() <= TREND_WINDOW_MIN * 60]
        if len(pts) < 3 or pts[-1][0] - pts[0][0] < 5:
            return 0.0
        n = len(pts)
        mx = sum(p[0] for p in pts) / n
        my = sum(p[1] for p in pts) / n
        sxx = sum((p[0] - mx) ** 2 for p in pts)
        if sxx == 0:
            return 0.0
        s = sum((p[0] - mx) * (p[1] - my) for p in pts) / sxx
        # A rebalancing truck creates one big jump; don't extrapolate that.
        return max(-1.0, min(1.0, s))


def district_short(name: str | None) -> str:
    """'Daan Dist.' / 'Xinyi Dist' -> 'Daan' (the feed is inconsistent about the dot)."""
    import re
    return re.sub(r"\s*Dist\.?$", "", name or "")


def clean_name(name: str | None) -> str:
    if not name:
        return ""
    for p in ("YouBike2.0_", "YouBike 2.0_"):
        if name.startswith(p):
            return name[len(p):]
    return name


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def cardinal(deg: float) -> str:
    return CARDINALS[int((deg + 22.5) // 45) % 8]


def _phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def predict(current: int, slope: float, minutes: float, capacity: int) -> tuple[float, float]:
    """Expected count after `minutes` and P(count >= 1).

    Damped trend extrapolation with a random-walk spread. This is the naive
    baseline from §11 — it gets replaced by the learned model once we have
    enough history, but it is honest about uncertainty from day one.
    """
    m = max(0.0, minutes)
    expected = current + slope * m * 0.7
    expected = max(0.0, min(float(capacity), expected))
    sigma = math.sqrt(0.6 + 0.30 * m)
    p_ok = _phi((expected - 0.5) / sigma)
    if current >= 1 and m <= 1:
        p_ok = max(p_ok, 0.97)
    return round(expected, 1), round(p_ok, 3)


class LiveState:
    def __init__(self):
        self.stations: dict[str, Station] = {}
        self.fetched_at: dt.datetime | None = None
        self.last_error: str | None = None
        self.lock = threading.Lock()

    # ------------------------------------------------------------ ingest
    def ingest(self, feed: list[dict], fetched_at: dt.datetime) -> list[dict]:
        """Update state from a feed; return new snapshot rows (dedup on sno+infoTime)."""
        rows = []
        with self.lock:
            for s in feed:
                try:
                    info = dt.datetime.strptime(s["infoTime"], "%Y-%m-%d %H:%M:%S")
                    bikes = int(s.get("available_rent_bikes") or 0)
                    docks = int(s.get("available_return_bikes") or 0)
                    cap = int(s.get("Quantity") or 0)
                except (KeyError, ValueError, TypeError):
                    continue
                st = self.stations.get(s["sno"])
                if st is None:
                    st = Station(
                        sno=s["sno"], name_zh=clean_name(s.get("sna")), name_en=clean_name(s.get("snaen")),
                        district_zh=s.get("sarea") or "", district_en=district_short(s.get("sareaen")),
                        lat=float(s["latitude"]), lng=float(s["longitude"]), capacity=cap,
                        active=str(s.get("act")) == "1", bikes=bikes, docks=docks, info_time=info)
                    self.stations[st.sno] = st
                elif info <= st.info_time:
                    continue
                st.bikes, st.docks, st.capacity, st.info_time = bikes, docks, cap, info
                st.active = str(s.get("act")) == "1"
                st.lat, st.lng = float(s["latitude"]), float(s["longitude"])
                st.history.append((info, bikes))
                rows.append({"sno": st.sno, "info_time": info, "bikes": bikes, "docks": docks,
                             "capacity": cap, "active": st.active, "fetched_at": fetched_at})
            self.fetched_at = fetched_at
            self.last_error = None
        return rows

    def warm_start(self, con) -> None:
        """Load the last HISTORY_MIN minutes from the DB so trends work right after a restart."""
        since = now_local() - dt.timedelta(minutes=HISTORY_MIN)
        meta = {r[0]: r[1:] for r in con.execute(
            "SELECT sno, name_zh, name_en, district_zh, district_en, lat, lng FROM stations").fetchall()}
        rows = con.execute("""SELECT sno, info_time, bikes, docks, capacity, active FROM snapshots
                              WHERE info_time >= ? ORDER BY info_time""", [since]).fetchall()
        with self.lock:
            for sno, info, bikes, docks, cap, active in rows:
                m = meta.get(sno)
                if m is None:
                    continue
                st = self.stations.get(sno)
                if st is None:
                    st = Station(sno=sno, name_zh=clean_name(m[0]), name_en=clean_name(m[1]),
                                 district_zh=m[2] or "", district_en=district_short(m[3]),
                                 lat=m[4], lng=m[5], capacity=cap, active=active,
                                 bikes=bikes, docks=docks, info_time=info)
                    self.stations[sno] = st
                st.bikes, st.docks, st.capacity, st.info_time, st.active = bikes, docks, cap, info, active
                st.history.append((info, bikes))
        log.info("warm start: %d stations, %d snapshot rows", len(self.stations), len(rows))

    # ------------------------------------------------------------ queries
    def card(self, st: Station, lat: float | None = None, lng: float | None = None,
             now: dt.datetime | None = None) -> dict:
        now = now or now_local()
        slope = st.slope()
        trend = "filling" if slope >= TREND_THRESHOLD else "draining" if slope <= -TREND_THRESHOLD else "stable"
        d = {
            "sno": st.sno, "name": st.name_en, "name_zh": st.name_zh,
            "district": st.district_en, "lat": st.lat, "lng": st.lng,
            "bikes": st.bikes, "docks": st.docks, "capacity": st.capacity, "active": st.active,
            "info_time": st.info_time.isoformat(),
            "age_s": max(0, int((now - st.info_time).total_seconds())),
            "trend": trend, "slope_per_min": round(slope, 3),
            "offline": st.bikes == 0 and st.docks == 0,
        }
        if lat is not None and lng is not None:
            dist = haversine_m(lat, lng, st.lat, st.lng)
            walk = dist * DETOUR / WALK_M_PER_MIN
            brg = bearing_deg(lat, lng, st.lat, st.lng)
            exp_b, p_b = predict(st.bikes, slope, walk, st.capacity)
            exp_d, p_d = predict(st.docks, -slope, walk, st.capacity)
            d.update({"distance_m": round(dist), "walk_min": round(walk, 1),
                      "bearing": round(brg), "cardinal": cardinal(brg),
                      "pred_bikes": exp_b, "p_bike": p_b,
                      "pred_docks": exp_d, "p_dock": p_d})
        return d

    def nearest(self, lat: float, lng: float, *, limit: int = 12, max_m: float = 2000,
                mode: str = "bike", hide_empty: bool = False) -> list[dict]:
        with self.lock:
            cands = [(haversine_m(lat, lng, s.lat, s.lng), s) for s in self.stations.values() if s.active]
        cands = [c for c in cands if c[0] <= max_m]
        cands.sort(key=lambda c: c[0])
        out = []
        for _, st in cands:
            if st.bikes == 0 and st.docks == 0:
                continue  # out of service: useless for both renting and returning
            if hide_empty and ((mode == "bike" and st.bikes == 0) or (mode == "dock" and st.docks == 0)):
                continue
            out.append(self.card(st, lat, lng))
            if len(out) >= limit:
                break
        return out

    def all_cards(self) -> list[dict]:
        with self.lock:
            sts = list(self.stations.values())
        now = now_local()
        return [self.card(s, now=now) for s in sts]


STATE = LiveState()


def poll_once(con, archive_raw: bool = True) -> int:
    fetched = now_local()
    try:
        feed = get_json(FEED_URL, source="youbike_feed" if archive_raw else None, retries=2)
    except Exception as e:
        STATE.last_error = str(e)
        upsert(con, "poll_log", [{"fetched_at": fetched, "ok": False, "n_stations": 0,
                                  "n_new_rows": 0, "error": str(e)[:500]}])
        raise
    rows = STATE.ingest(feed, fetched)
    if rows:
        import pyarrow as pa
        cur = con.cursor()
        cur.register("_snap", pa.Table.from_pylist(rows))
        cur.execute("INSERT INTO snapshots SELECT sno, info_time, bikes, docks, capacity, active, fetched_at FROM _snap")
        cur.unregister("_snap")
        cur.close()
    upsert(con, "poll_log", [{"fetched_at": fetched, "ok": True, "n_stations": len(feed),
                              "n_new_rows": len(rows), "error": None}])
    return len(rows)
