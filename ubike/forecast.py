"""Forecast model builder for the phone's Future tab.

Demand model (fit here, from Taipei YouBike 2.0 trip records):
  For every station s, day type d (workday / day off) and hour h:
     dep[s,d,h] = mean departures per hour,  arr[s,d,h] = mean arrivals per hour
  Day types come from the government calendar (holidays, make-up workdays).
  Rain: a multiplicative factor on demand per precipitation band, estimated by
  joining hourly system trips with Open-Meteo/ERA5 hourly precipitation.

The availability forecast itself runs on the phone (web/app/forecast.js): each
station is a probability distribution over 0..capacity bikes, stepped every 30 min
with Poisson departures/arrivals (bounded by empty/full) plus a weak pull that
stands in for rebalancing trucks.

  python -m ubike.forecast data/trips_raw/2026-05/trips_202605.csv [more.csv ...]
writes web/app/model.json and prints a hold-out validation of the demand model.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

from .config import ROOT, now_local
from .db import connect

OUT = ROOT / "web" / "app" / "model.json"
RAIN_BANDS = [0.2, 1.0, 4.0, 1e9]          # mm/h upper bounds; band 0 = dry
# Trucks: weak pull toward each station's *current* level (chronically empty/full stations stay so).
# Rate picked on the 1 h backtest (0.03/0.06/0.12 per h tried); refit once weeks of snapshots exist.
REVERT = {"rate_per_h": 0.06, "target": "initial", "target_fill": 0.4}


def _load_trips(con, csvs: list[str]) -> None:
    files = ", ".join(f"'{Path(c).resolve()}'" for c in csvs)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE trips AS
        SELECT CAST(rent_time AS TIMESTAMP) AS rent_t, rent_station AS a,
               CAST(return_time AS TIMESTAMP) AS return_t, return_station AS b
        FROM read_csv([{files}], header = true, all_varchar = true, ignore_errors = true)
        WHERE rent_time IS NOT NULL AND return_time IS NOT NULL""")
    # station names in trips = feed name without the "YouBike2.0_" prefix
    con.execute("""
        CREATE OR REPLACE TEMP TABLE name_map AS
        SELECT regexp_replace(name_zh, '^YouBike ?2\\.0_', '') AS name, any_value(sno) AS sno
        FROM stations GROUP BY 1""")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE days AS
        SELECT d::DATE AS date, coalesce(c.is_day_off, isodow(d) >= 6) AS off
        FROM (SELECT DISTINCT rent_t::DATE AS d FROM trips) t
        LEFT JOIN calendar_days c ON c.date = t.d""")


def _flows(con, where: str = "TRUE") -> dict:
    """{sno: {(off, hour): [dep, arr]}} as mean counts per hour."""
    rows = con.execute(f"""
        WITH ev AS (
            SELECT m.sno, rent_t AS t, 1 AS dep, 0 AS arr FROM trips JOIN name_map m ON m.name = trips.a WHERE {where}
            UNION ALL
            SELECT m.sno, return_t AS t, 0, 1 FROM trips JOIN name_map m ON m.name = trips.b WHERE {where}),
        nd AS (SELECT off, count(*) AS n FROM days WHERE date IN (SELECT DISTINCT t::DATE FROM ev) GROUP BY off)
        SELECT ev.sno, d.off, hour(ev.t) AS h, sum(dep) / any_value(nd.n) AS dep, sum(arr) / any_value(nd.n) AS arr
        FROM ev JOIN days d ON d.date = ev.t::DATE JOIN nd ON nd.off = d.off
        GROUP BY ALL""").fetchall()
    out: dict = {}
    for sno, off, h, dep, arr in rows:
        out.setdefault(sno, {})[(bool(off), h)] = (dep, arr)
    return out


def _rain_factors(con) -> list[float]:
    """Demand multiplier per rain band, relative to dry hours of the same day type + hour."""
    rows = con.execute("""
        WITH sys AS (
            SELECT rent_t AS t, count(*) AS n FROM trips GROUP BY 1),
        w AS (SELECT ts, avg(precip_mm) AS p FROM weather_hourly GROUP BY ts),
        j AS (
            SELECT sys.n, d.off, hour(sys.t) AS h, w.p FROM sys
            JOIN days d ON d.date = sys.t::DATE JOIN w ON w.ts = sys.t),
        base AS (SELECT off, h, median(n) AS b FROM j WHERE p < 0.2 GROUP BY ALL)
        SELECT CASE WHEN p < 0.2 THEN 0 WHEN p < 1 THEN 1 WHEN p < 4 THEN 2 ELSE 3 END AS band,
               median(n / b) AS f, count(*) AS hours
        FROM j JOIN base USING (off, h) WHERE h BETWEEN 6 AND 23 GROUP BY band ORDER BY band""").fetchall()
    f = {band: (fac, n) for band, fac, n in rows}
    out = []
    for band in range(4):
        fac, n = f.get(band, (None, 0))
        # need a few hours to trust it; otherwise a conservative prior
        prior = [1.0, 0.8, 0.55, 0.35][band]
        out.append(round(fac, 3) if fac is not None and n >= 5 else prior)
    out[0] = 1.0
    # rain never *increases* demand in this model; keep monotone
    for i in range(1, 4):
        out[i] = min(out[i], out[i - 1])
    return out


def validate(con) -> dict:
    """Hold-out check of the demand model: fit on days 1–20, test on the rest."""
    first = con.execute("SELECT min(date) FROM days").fetchone()[0]
    cut = first + dt.timedelta(days=20)
    train = _flows(con, f"rent_t < TIMESTAMP '{cut}'")
    actual = con.execute(f"""
        SELECT m.sno, d.off, rent_t::DATE AS day, hour(rent_t) AS h, count(*) AS n
        FROM trips JOIN name_map m ON m.name = trips.a JOIN days d ON d.date = rent_t::DATE
        WHERE rent_t >= TIMESTAMP '{cut}' GROUP BY ALL""").fetchall()
    obs = {(s, off, day, h): n for s, off, day, h, n in actual}
    test_days = con.execute(f"SELECT date, off FROM days WHERE date >= DATE '{cut}'").fetchall()
    err_model = err_naive = tot = 0.0
    n = 0
    for sno, prof in train.items():
        daily = {off: sum(prof.get((off, h), (0, 0))[0] for h in range(24)) for off in (False, True)}
        for day, off in test_days:
            off = bool(off)
            for h in range(24):
                y = obs.get((sno, off, day, h), 0)
                yhat = prof.get((off, h), (0, 0))[0]
                naive = daily[off] / 24          # same daily volume, no hourly shape
                err_model += abs(y - yhat)
                err_naive += abs(y - naive)
                tot += y
                n += 1
    return {"test_from": cut.isoformat(), "station_hours": n,
            "mae_model": round(err_model / n, 3), "mae_flat_baseline": round(err_naive / n, 3),
            "mean_departures_per_hour": round(tot / n, 3),
            "improvement_pct": round(100 * (1 - err_model / err_naive), 1)}


def build(csvs: list[str]) -> dict:
    con = connect()
    _load_trips(con, csvs)
    span = con.execute("SELECT min(rent_t)::DATE, max(rent_t)::DATE, count(*) FROM trips").fetchone()
    # weather history for the training period (for the rain factor)
    from .context.weather import fetch_history
    fetch_history(con, span[0], span[1])
    from .context.events import fetch_calendar
    fetch_calendar(con, sorted({span[0].year, span[1].year, now_local().year, now_local().year + 1}))
    _load_trips(con, csvs)  # re-derive day types now that the calendar is complete
    unmatched = con.execute("""
        SELECT count(*) FROM trips WHERE a NOT IN (SELECT name FROM name_map)""").fetchone()[0]
    flows = _flows(con)
    rain = _rain_factors(con)
    val = validate(con)
    today = now_local().date()
    off_days = [r[0].isoformat() for r in con.execute(
        "SELECT date FROM calendar_days WHERE is_day_off AND date BETWEEN ? AND ?",
        [today - dt.timedelta(days=1), today + dt.timedelta(days=120)]).fetchall()]
    workdays_on_weekend = [r[0].isoformat() for r in con.execute(
        "SELECT date FROM calendar_days WHERE day_type = 'makeup_workday' AND date BETWEEN ? AND ?",
        [today - dt.timedelta(days=1), today + dt.timedelta(days=120)]).fetchall()]
    stations = {}
    for sno, prof in flows.items():
        arr = []
        for off in (False, True):
            arr += [round(prof.get((off, h), (0, 0))[0] * 10) for h in range(24)]
            arr += [round(prof.get((off, h), (0, 0))[1] * 10) for h in range(24)]
        stations[sno] = arr   # [dep_work(24), arr_work(24), dep_off(24), arr_off(24)] in tenths/hour
    model = {
        "version": 1,
        "built_at": now_local().isoformat(),
        "source": f"Taipei YouBike 2.0 trip records {span[0]} – {span[1]} ({span[2]:,} trips)",
        "units": "tenths of trips per hour; layout dep_work, arr_work, dep_off, arr_off (24 each)",
        "rain_bands_mm": RAIN_BANDS[:3],
        "rain_factor": rain,
        "revert": REVERT,
        "off_days": off_days,
        "makeup_workdays": workdays_on_weekend,
        "validation": val,
        "stations": stations,
    }
    OUT.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
    con.close()
    return {"trips": span[2], "period": f"{span[0]} – {span[1]}", "stations": len(stations),
            "unmatched_trip_starts": unmatched, "rain_factor": rain, "validation": val,
            "model_kb": round(OUT.stat().st_size / 1024)}


if __name__ == "__main__":
    print(json.dumps(build(sys.argv[1:]), indent=2, default=str))
