"""Command line: `python -m ubike <command>` (or `ubike <command>` once installed)."""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys

from .config import now_local, secret
from .db import connect


def _report(name: str, result) -> None:
    print(f"  {name:<22} {result}")


def _run(name, fn, *args, **kw) -> bool:
    try:
        _report(name, fn(*args, **kw))
        return True
    except Exception as e:
        _report(name, f"FAILED: {e}")
        logging.getLogger("ubike").debug("trace", exc_info=True)
        return False


def cmd_hourly(con, _args) -> bool:
    """Fast-changing context: forecast/nowcast, CWA obs + warnings."""
    from .context import weather
    ok = _run("weather forecast", weather.fetch_forecast, con)
    if secret("CWA_API_KEY"):
        ok &= _run("cwa obs/warnings", weather.fetch_cwa, con)
    else:
        _report("cwa obs/warnings", "skipped (no CWA_API_KEY in .env)")
    return ok


def cmd_daily(con, _args) -> bool:
    """Slow-changing context: stations, elevation, calendar, events, weather history."""
    from . import stations
    from .context import elevation, events, weather
    today = now_local().date()
    ok = _run("stations", stations.refresh_stations, con)
    ok &= _run("elevation", elevation.update_elevation, con)
    ok &= _run("calendar", events.fetch_calendar, con, [today.year, today.year + 1])
    ok &= _run("culture events", events.fetch_culture_events, con)
    ok &= _run("curated events", events.load_curated_events, con)
    ok &= _run("weather history", weather.fetch_history, con,
               today - dt.timedelta(days=14), today)
    return ok


def cmd_history(con, args) -> bool:
    """Backfill weather + calendar for a historical period (e.g. 2023 trip data)."""
    from .context import events, weather
    start, end = dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end)
    ok = _run("weather history", weather.fetch_history, con, start, end)
    ok &= _run("calendar", events.fetch_calendar, con, list(range(start.year, end.year + 1)))
    return ok


def cmd_status(con, _args) -> bool:
    q = {
        "stations": "SELECT count(*) FROM stations",
        "elevation (stations)": "SELECT count(*) FROM station_elevation",
        "weather_hourly": "SELECT count(*) || ' rows, ' || coalesce(min(ts)::VARCHAR,'-') || ' → ' || coalesce(max(ts)::VARCHAR,'-') FROM weather_hourly",
        "weather_forecast": "SELECT count(*) || ' rows, last issued ' || coalesce(max(issued_at)::VARCHAR,'-') FROM weather_forecast",
        "weather_obs (CWA)": "SELECT count(*) FROM weather_obs",
        "rain_obs (CWA)": "SELECT count(*) FROM rain_obs",
        "weather_warnings": "SELECT count(*) FROM weather_warnings",
        "calendar_days": "SELECT count(*) || ' days, ' || count(*) FILTER (WHERE day_type='holiday') || ' holidays' FROM calendar_days",
        "events": "SELECT count(*) || ' (' || count(*) FILTER (WHERE NOT is_long_running) || ' short)' FROM events_v",
    }
    for name, sql in q.items():
        _report(name, con.execute(sql).fetchone()[0])
    return True


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="ubike")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hourly", help="weather forecast/nowcast + CWA observations/warnings")
    sub.add_parser("daily", help="stations, elevation, calendar, events, recent weather history")
    h = sub.add_parser("history", help="backfill weather + calendar for a date range")
    h.add_argument("--start", required=True)
    h.add_argument("--end", required=True)
    sub.add_parser("status", help="row counts per context table")
    s = sub.add_parser("serve", help="API + phone app + poller + context jobs")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--host", default="0.0.0.0")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "serve":
        from .server import serve
        serve(args.host, args.port)
        return
    try:
        con = connect()
    except Exception as e:
        if "lock" in str(e).lower():
            sys.exit("The database is in use by `ubike serve`, which already runs these jobs.")
        raise
    print(f"[{now_local():%Y-%m-%d %H:%M:%S}] {args.cmd}")
    ok = {"hourly": cmd_hourly, "daily": cmd_daily, "history": cmd_history,
          "status": cmd_status}[args.cmd](con, args)
    con.close()
    sys.exit(0 if ok else 1)
