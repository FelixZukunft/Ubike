"""Personal layer: places, routes, rides, prefs, home summary, heatmaps."""
from __future__ import annotations

import datetime as dt
import json
import math
import uuid
from functools import cache

import yaml

from .config import CONFIG_DIR, now_local
from .db import upsert
from .live import STATE, cardinal, bearing_deg, haversine_m, DETOUR, WALK_M_PER_MIN


@cache
def app_config() -> dict:
    return yaml.safe_load((CONFIG_DIR / "app.yaml").read_text(encoding="utf-8"))


def seed_defaults(con) -> None:
    cfg = app_config()
    if con.execute("SELECT count(*) FROM my_places").fetchone()[0] == 0:
        upsert(con, "my_places", [{**{k: p[k] for k in ("id", "name", "icon", "lat", "lng", "radius_m", "mode")},
                                   "sort": i} for i, p in enumerate(cfg["places"])])
    if con.execute("SELECT count(*) FROM my_routes").fetchone()[0] == 0:
        upsert(con, "my_routes", cfg["routes"])
    existing = {r[0] for r in con.execute("SELECT key FROM prefs").fetchall()}
    upsert(con, "prefs", [{"key": k, "value": json.dumps(v)}
                          for k, v in cfg["prefs"].items() if k not in existing])


# ------------------------------------------------------------------ CRUD
def _dicts(cur) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def get_prefs(con) -> dict:
    return {k: json.loads(v) for k, v in con.execute("SELECT key, value FROM prefs").fetchall()}


def set_prefs(con, values: dict) -> dict:
    allowed = set(app_config()["prefs"])
    upsert(con, "prefs", [{"key": k, "value": json.dumps(v)} for k, v in values.items() if k in allowed])
    return get_prefs(con)


def get_places(con) -> list[dict]:
    return _dicts(con.execute("SELECT * FROM my_places ORDER BY sort, name"))


def save_place(con, p: dict) -> dict:
    p = {**p}
    p["id"] = p.get("id") or f"p-{uuid.uuid4().hex[:8]}"
    if p.get("sort") is None:
        p["sort"] = con.execute("SELECT coalesce(max(sort), 0) + 1 FROM my_places").fetchone()[0]
    row = {k: p.get(k) for k in ("id", "name", "icon", "lat", "lng", "radius_m", "mode", "sort")}
    row["lat"], row["lng"] = float(row["lat"]), float(row["lng"])
    row["radius_m"] = int(row["radius_m"] or 500)
    row["mode"] = row["mode"] or "both"
    row["icon"] = row["icon"] or "mappin"
    upsert(con, "my_places", [row])
    return row


def delete_place(con, pid: str) -> None:
    con.execute("DELETE FROM my_places WHERE id = ?", [pid])
    con.execute("DELETE FROM my_routes WHERE from_place = ? OR to_place = ?", [pid, pid])


def get_routes(con) -> list[dict]:
    return _dicts(con.execute("SELECT * FROM my_routes ORDER BY depart"))


def save_route(con, r: dict) -> dict:
    row = {"id": r.get("id") or f"r-{uuid.uuid4().hex[:8]}",
           "from_place": r["from_place"], "to_place": r["to_place"],
           "weekdays": sorted({int(w) for w in r.get("weekdays", [])}),
           "depart": r["depart"], "enabled": bool(r.get("enabled", True))}
    upsert(con, "my_routes", [row])
    return row


def delete_route(con, rid: str) -> None:
    con.execute("DELETE FROM my_routes WHERE id = ?", [rid])


# ------------------------------------------------------------------ rides
def fare_nt(minutes: float) -> float:
    """YouBike 2.0 Taipei: NT$5 first 30 min, then tiered per 30 min."""
    if minutes <= 0:
        return 0.0
    blocks = math.ceil(minutes / 30)
    cost, done = 0.0, 0
    for tier in app_config()["fare"]:
        tier_blocks = tier["upto_min"] // 30
        while done < blocks and done < tier_blocks:
            cost += tier["first_30min"] if (done == 0 and "first_30min" in tier) else tier["per_30min"]
            done += 1
    return cost


def _station_name(sno: str | None) -> str | None:
    st = STATE.stations.get(sno) if sno else None
    return st.name_en if st else None


def start_ride(con, sno: str | None) -> dict:
    active = active_ride(con)
    if active:
        return active
    row = {"id": f"ride-{uuid.uuid4().hex[:10]}", "start_ts": now_local(), "end_ts": None,
           "from_sno": sno, "to_sno": None, "from_name": _station_name(sno), "to_name": None,
           "distance_m": None, "cost_nt": None, "source": "app", "note": None}
    upsert(con, "my_rides", [row])
    return _ride_out(row)


def end_ride(con, sno: str | None) -> dict | None:
    ride = active_ride(con)
    if not ride:
        return None
    end = now_local()
    start = dt.datetime.fromisoformat(ride["start_ts"])
    dist = None
    a, b = STATE.stations.get(ride["from_sno"] or ""), STATE.stations.get(sno or "")
    if a and b:
        dist = haversine_m(a.lat, a.lng, b.lat, b.lng) * DETOUR
    minutes = (end - start).total_seconds() / 60
    con.execute("""UPDATE my_rides SET end_ts = ?, to_sno = ?, to_name = ?, distance_m = ?, cost_nt = ?
                   WHERE id = ?""", [end, sno, _station_name(sno), dist, fare_nt(minutes), ride["id"]])
    return get_ride(con, ride["id"])


def cancel_ride(con) -> None:
    con.execute("DELETE FROM my_rides WHERE end_ts IS NULL")


def add_manual_ride(con, r: dict) -> dict:
    start = dt.datetime.fromisoformat(r["start_ts"])
    end = dt.datetime.fromisoformat(r["end_ts"])
    a, b = STATE.stations.get(r.get("from_sno") or ""), STATE.stations.get(r.get("to_sno") or "")
    dist = haversine_m(a.lat, a.lng, b.lat, b.lng) * DETOUR if a and b else r.get("distance_m")
    row = {"id": f"ride-{uuid.uuid4().hex[:10]}", "start_ts": start, "end_ts": end,
           "from_sno": r.get("from_sno"), "to_sno": r.get("to_sno"),
           "from_name": r.get("from_name") or _station_name(r.get("from_sno")),
           "to_name": r.get("to_name") or _station_name(r.get("to_sno")),
           "distance_m": dist,
           "cost_nt": r.get("cost_nt") if r.get("cost_nt") is not None else fare_nt((end - start).total_seconds() / 60),
           "source": r.get("source", "manual"), "note": r.get("note")}
    upsert(con, "my_rides", [row])
    return _ride_out(row)


def delete_ride(con, rid: str) -> None:
    con.execute("DELETE FROM my_rides WHERE id = ?", [rid])


def _ride_out(r: dict) -> dict:
    r = dict(r)
    for k in ("start_ts", "end_ts"):
        if isinstance(r.get(k), dt.datetime):
            r[k] = r[k].isoformat()
    if r.get("start_ts") and r.get("end_ts"):
        r["duration_min"] = round((dt.datetime.fromisoformat(r["end_ts"])
                                   - dt.datetime.fromisoformat(r["start_ts"])).total_seconds() / 60, 1)
    return r


def get_ride(con, rid: str) -> dict | None:
    rows = _dicts(con.execute("SELECT * FROM my_rides WHERE id = ?", [rid]))
    return _ride_out(rows[0]) if rows else None


def active_ride(con) -> dict | None:
    rows = _dicts(con.execute("SELECT * FROM my_rides WHERE end_ts IS NULL ORDER BY start_ts DESC LIMIT 1"))
    return _ride_out(rows[0]) if rows else None


def ride_history(con) -> dict:
    rides = [_ride_out(r) for r in _dicts(con.execute(
        "SELECT * FROM my_rides WHERE end_ts IS NOT NULL ORDER BY start_ts DESC LIMIT 500"))]
    now = now_local()
    week_start = (now - dt.timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0)

    def summary(rs):
        return {"count": len(rs),
                "minutes": round(sum(r.get("duration_min") or 0 for r in rs)),
                "distance_km": round(sum(r.get("distance_m") or 0 for r in rs) / 1000, 1),
                "cost_nt": round(sum(r.get("cost_nt") or 0 for r in rs))}
    this_week = [r for r in rides if dt.datetime.fromisoformat(r["start_ts"]) >= week_start]
    # rides per day, last 8 weeks
    daily = {}
    for r in rides:
        d = r["start_ts"][:10]
        daily[d] = daily.get(d, 0) + 1
    return {"rides": rides, "all": summary(rides), "week": summary(this_week), "daily": daily}


# ------------------------------------------------------------------ home
def _place_status(place: dict, prefs: dict) -> dict:
    cards = STATE.nearest(place["lat"], place["lng"], limit=8,
                          max_m=max(place["radius_m"], 300), mode="bike")
    cards = [c for c in cards if not c["offline"]]
    bikes = sum(c["bikes"] for c in cards)
    docks = sum(c["docks"] for c in cards)
    mode = place["mode"]

    def level(vals: list[int]) -> int:
        # What matters is one good station nearby, not the sum over all of them.
        best = max(vals, default=0)
        if best >= 5 or sum(v >= 3 for v in vals) >= 2:
            return 2
        return 1 if best >= 1 else 0
    levels = []
    if mode in ("bike", "both"):
        levels.append(level([c["bikes"] for c in cards]))
    if mode in ("dock", "both"):
        levels.append(level([c["docks"] for c in cards]))
    status = ["critical", "warning", "good"][min(levels)]
    best_bike = max(cards, key=lambda c: (c["p_bike"] - c["walk_min"] * 0.03), default=None)
    best_dock = max(cards, key=lambda c: (c["p_dock"] - c["walk_min"] * 0.03), default=None)
    return {**place, "status": status, "bikes": bikes, "docks": docks,
            "n_stations": len(cards), "best_bike": best_bike, "best_dock": best_dock,
            "stations": cards}


def _next_trip(routes: list[dict], places: dict, now: dt.datetime) -> dict | None:
    best = None
    for r in routes:
        if not r["enabled"] or r["from_place"] not in places or r["to_place"] not in places:
            continue
        hh, mm = map(int, r["depart"].split(":"))
        for add in range(0, 8):
            day = now.date() + dt.timedelta(days=add)
            if day.weekday() not in (r["weekdays"] or []):
                continue
            t = dt.datetime.combine(day, dt.time(hh, mm))
            if t < now - dt.timedelta(minutes=10):
                continue
            if best is None or t < best[0]:
                best = (t, r)
            break
    if not best:
        return None
    t, r = best
    return {"route": r, "depart": t.isoformat(), "from": places[r["from_place"]], "to": places[r["to_place"]]}


def weather_now(con) -> dict:
    out = {}
    row = con.execute("""
        SELECT station_name, obs_time, temperature_c, weather_desc, humidity_pct
        FROM weather_obs WHERE temperature_c IS NOT NULL
          AND obs_time = (SELECT max(obs_time) FROM weather_obs)
        ORDER BY (lat - 25.026)^2 + (lng - 121.535)^2 LIMIT 1""").fetchone()
    if row:
        out.update(station=row[0], obs_time=row[1].isoformat(), temperature_c=row[2],
                   desc=row[3], humidity_pct=row[4], source="CWA")
    rain = con.execute("""
        SELECT max(past1hr_mm), max(past10min_mm) FROM rain_obs
        WHERE obs_time = (SELECT max(obs_time) FROM rain_obs) AND district IN ('大安區','中正區','信義區')""").fetchone()
    if rain and rain[0] is not None:
        out.update(rain_1h_mm=rain[0], rain_10min_mm=rain[1])
    now = now_local()
    fc = con.execute("""
        WITH last AS (SELECT max(issued_at) t FROM weather_forecast)
        SELECT ts, avg(temperature_c), max(precip_prob_pct), max(precip_mm), max(weather_code)
        FROM weather_forecast, last WHERE issued_at = last.t
          AND ts >= date_trunc('hour', ?::TIMESTAMP) AND ts < ?::TIMESTAMP + INTERVAL 12 HOUR
        GROUP BY ts ORDER BY ts""", [now, now]).fetchall()
    out["hours"] = [{"ts": r[0].isoformat(), "temperature_c": round(r[1], 1) if r[1] is not None else None,
                     "precip_prob": r[2], "precip_mm": r[3], "code": r[4]} for r in fc]
    if "temperature_c" not in out and fc:
        out["temperature_c"] = fc[0][1]
        out["source"] = "Open-Meteo"
    nc = con.execute("""
        WITH last AS (SELECT max(issued_at) t FROM weather_nowcast_15min)
        SELECT ts, max(precip_mm) FROM weather_nowcast_15min, last
        WHERE issued_at = last.t AND ts >= ?::TIMESTAMP - INTERVAL 15 MINUTE AND ts < ?::TIMESTAMP + INTERVAL 2 HOUR
        GROUP BY ts ORDER BY ts""", [now, now]).fetchall()
    out["next2h"] = [{"ts": r[0].isoformat(), "precip_mm": r[1]} for r in nc]
    wet = [r for r in nc if (r[1] or 0) >= 0.3]
    out["rain_soon"] = {"at": wet[0][0].isoformat(), "mm": wet[0][1]} if wet else None
    warn = con.execute("""SELECT phenomena, significance, end_time FROM weather_warnings
                          WHERE end_time IS NULL OR end_time > ? ORDER BY start_time""", [now]).fetchall()
    out["warnings"] = [{"phenomena": w[0], "significance": w[1],
                        "end_time": w[2].isoformat() if w[2] else None} for w in warn]
    return out


def events_near(con, places: list[dict], hours: int = 24) -> list[dict]:
    now = now_local()
    rows = _dicts(con.execute("""
        SELECT title, category, venue, lat, lng, start_ts, end_ts, expected_attendance, source
        FROM events_v WHERE NOT is_long_running AND lat IS NOT NULL
          AND end_ts >= ? AND start_ts <= ? + to_hours(?::INTEGER)
        ORDER BY start_ts""", [now, now, hours]))
    out = []
    for e in rows:
        near = [(p["name"], haversine_m(p["lat"], p["lng"], e["lat"], e["lng"])) for p in places]
        name, d = min(near, key=lambda x: x[1]) if near else (None, 1e9)
        if d <= 1500 or (e["expected_attendance"] or 0) >= 10000:
            out.append({**e, "start_ts": e["start_ts"].isoformat(), "end_ts": e["end_ts"].isoformat(),
                        "near_place": name, "distance_m": round(d)})
    out.sort(key=lambda e: (-(e["expected_attendance"] or 0), e["start_ts"]))
    return out[:6]


def home(con) -> dict:
    prefs = get_prefs(con)
    places = get_places(con)
    pmap = {p["id"]: p for p in places}
    statuses = [_place_status(p, prefs) for p in places]
    smap = {s["id"]: s for s in statuses}
    now = now_local()
    trip = _next_trip(get_routes(con), pmap, now)
    if trip:
        origin, dest = smap[trip["from"]["id"]], smap[trip["to"]["id"]]
        depart = dt.datetime.fromisoformat(trip["depart"])
        bb = origin["best_bike"]
        walk = bb["walk_min"] if bb else 0
        trip.update({
            "best_bike": bb, "best_dock": dest["best_dock"],
            "leave_by": (depart - dt.timedelta(minutes=math.ceil(walk))).isoformat(),
            "minutes_until": round((depart - now).total_seconds() / 60),
        })
    return {"now": now.isoformat(), "fetched_at": STATE.fetched_at.isoformat() if STATE.fetched_at else None,
            "places": [{k: v for k, v in s.items() if k != "stations"} for s in statuses],
            "next_trip": trip, "weather": weather_now(con), "events": events_near(con, places),
            "active_ride": active_ride(con), "prefs": prefs}


# ------------------------------------------------------------------ heatmap
def heatmap(con, place_id: str, kind: str = "bike") -> dict:
    """P(at least 1 bike/dock) per station × weekday × hour from collected snapshots."""
    place = next((p for p in get_places(con) if p["id"] == place_id), None)
    if not place:
        return {"error": "unknown place"}
    stations = STATE.nearest(place["lat"], place["lng"], limit=6, max_m=max(place["radius_m"], 300))
    snos = [s["sno"] for s in stations]
    col = "bikes" if kind == "bike" else "docks"
    if not snos:
        return {"place": place, "stations": [], "days_of_data": 0}
    rows = con.execute(f"""
        SELECT sno, isodow(info_time) - 1 AS wd, hour(info_time) AS h,
               avg(({col} >= 1)::INT) AS p, count(*) AS n, avg({col}) AS mean
        FROM snapshots WHERE sno IN (SELECT unnest(?::VARCHAR[]))
        GROUP BY ALL""", [snos]).fetchall()
    span = con.execute("SELECT min(info_time), max(info_time) FROM snapshots").fetchone()
    days = round((span[1] - span[0]).total_seconds() / 86400, 1) if span[0] else 0
    grid = {s: [[None] * 24 for _ in range(7)] for s in snos}
    for sno, wd, h, p, n, mean in rows:
        grid[sno][wd][h] = {"p": round(p, 3), "n": n, "mean": round(mean, 1)}
    return {"place": place, "kind": kind, "days_of_data": days,
            "stations": [{**s, "grid": grid[s["sno"]]} for s in stations]}


def station_history(con, sno: str, hours: int = 24) -> dict:
    since = now_local() - dt.timedelta(hours=hours)
    rows = con.execute("""SELECT info_time, bikes, docks FROM snapshots
                          WHERE sno = ? AND info_time >= ? ORDER BY info_time""", [sno, since]).fetchall()
    st = STATE.stations.get(sno)
    return {"station": STATE.card(st) if st else None,
            "points": [{"t": r[0].isoformat(), "bikes": r[1], "docks": r[2]} for r in rows]}


def search_stations(q: str, lat: float | None = None, lng: float | None = None, limit: int = 20) -> list[dict]:
    ql = q.lower().strip()
    with STATE.lock:
        sts = [s for s in STATE.stations.values()
               if ql in s.name_en.lower() or ql in s.name_zh or ql == s.sno]
    if lat is not None and lng is not None:
        sts.sort(key=lambda s: haversine_m(lat, lng, s.lat, s.lng))
    return [STATE.card(s, lat, lng) for s in sts[:limit]]


__all__ = ["cardinal", "bearing_deg", "WALK_M_PER_MIN"]
