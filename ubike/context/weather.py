"""Weather: Open-Meteo (forecast, nowcast, history; no key) + CWA (observations,
rain gauges, warnings; needs CWA_API_KEY)."""
from __future__ import annotations

import datetime as dt
import logging

from ..config import context_config, now_local, secret
from ..db import upsert
from ..http import get_json

log = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
# Same model output on a different server; used when FORECAST_URL is unreachable
# (seen from some networks). Needs explicit start/end dates instead of forecast_days.
FORECAST_FALLBACK_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
CWA_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/{dataset}"

_HOURLY = ["temperature_2m", "apparent_temperature", "precipitation", "rain",
           "relative_humidity_2m", "weather_code", "wind_speed_10m", "wind_gusts_10m"]


def _points() -> dict[str, dict]:
    return context_config()["weather"]["points"]


def _multi(params: dict) -> tuple[list[str], dict]:
    pts = _points()
    ids = list(pts)
    params = {**params,
              "latitude": ",".join(str(pts[i]["lat"]) for i in ids),
              "longitude": ",".join(str(pts[i]["lng"]) for i in ids),
              "timezone": "Asia/Taipei"}
    return ids, params


def _as_list(resp) -> list[dict]:
    return resp if isinstance(resp, list) else [resp]


def _ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s)


# ---------------------------------------------------------------- Open-Meteo
def fetch_forecast(con) -> dict[str, int]:
    """Hourly forecast + 15-min precipitation nowcast. Every issue is kept."""
    days = context_config()["weather"].get("forecast_days", 2)
    ids, params = _multi({
        "hourly": ",".join(_HOURLY[:3] + ["precipitation_probability"] + _HOURLY[4:]),
        "minutely_15": "precipitation",
        "forecast_days": days,
    })
    issued = now_local()
    try:
        resp = get_json(FORECAST_URL, params=params, source="openmeteo_forecast", retries=1)
    except Exception as e:
        log.warning("primary forecast host failed (%s); using fallback host", e)
        fb = {k: v for k, v in params.items() if k != "forecast_days"}
        fb["start_date"] = issued.date().isoformat()
        fb["end_date"] = (issued.date() + dt.timedelta(days=days)).isoformat()
        resp = get_json(FORECAST_FALLBACK_URL, params=fb, source="openmeteo_forecast")
    hourly, m15 = [], []
    for pid, block in zip(ids, _as_list(resp)):
        h = block["hourly"]
        for i, t in enumerate(h["time"]):
            hourly.append({
                "issued_at": issued, "point_id": pid, "ts": _ts(t),
                "temperature_c": h["temperature_2m"][i],
                "apparent_c": h["apparent_temperature"][i],
                "precip_mm": h["precipitation"][i],
                "precip_prob_pct": h["precipitation_probability"][i],
                "weather_code": h["weather_code"][i],
                "wind_kmh": h["wind_speed_10m"][i],
                "gust_kmh": h["wind_gusts_10m"][i],
            })
        m = block.get("minutely_15") or {}
        for t, p in zip(m.get("time", []), m.get("precipitation", [])):
            m15.append({"issued_at": issued, "point_id": pid, "ts": _ts(t), "precip_mm": p})
    return {"weather_forecast": upsert(con, "weather_forecast", hourly),
            "weather_nowcast_15min": upsert(con, "weather_nowcast_15min", m15)}


def fetch_history(con, start: dt.date, end: dt.date) -> int:
    """Hourly reanalysis history (ERA5 via Open-Meteo archive). ~5 day lag."""
    fetched = now_local()
    end = min(end, fetched.date() - dt.timedelta(days=1))  # today = model guess, not history
    total = 0
    cur = start
    while cur <= end:  # chunk per calendar year to keep responses small
        chunk_end = min(end, dt.date(cur.year, 12, 31))
        ids, params = _multi({"hourly": ",".join(_HOURLY),
                              "start_date": cur.isoformat(), "end_date": chunk_end.isoformat()})
        rows = []
        for pid, block in zip(ids, _as_list(get_json(ARCHIVE_URL, params=params, source="openmeteo_archive"))):
            h = block["hourly"]
            for i, t in enumerate(h["time"]):
                if h["temperature_2m"][i] is None and h["precipitation"][i] is None:
                    continue  # not yet available (archive lag)
                rows.append({
                    "point_id": pid, "ts": _ts(t), "source": "openmeteo_era5",
                    "temperature_c": h["temperature_2m"][i],
                    "apparent_c": h["apparent_temperature"][i],
                    "precip_mm": h["precipitation"][i],
                    "rain_mm": h["rain"][i],
                    "humidity_pct": h["relative_humidity_2m"][i],
                    "weather_code": h["weather_code"][i],
                    "wind_kmh": h["wind_speed_10m"][i],
                    "gust_kmh": h["wind_gusts_10m"][i],
                    "fetched_at": fetched,
                })
        total += upsert(con, "weather_hourly", rows)
        cur = chunk_end + dt.timedelta(days=1)
    return total


# ---------------------------------------------------------------- CWA
def _ci(d, *path):
    """Case-insensitive nested dict lookup (CWA field casing varies by dataset)."""
    for key in path:
        if not isinstance(d, dict):
            return None
        lk = key.lower()
        d = next((v for k, v in d.items() if k.lower() == lk), None)
    return d


def _num(v):
    """CWA uses -99 / -999 / 'X' / 'T' (trace) as sentinels."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        if v.upper() == "T":
            return 0.05  # trace precipitation
        try:
            v = float(v)
        except ValueError:
            return None
    return None if v <= -98 else float(v)


def _cwa_time(s):
    if not s:
        return None
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if t.tzinfo:
        t = t.astimezone(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None)
    return t


def _wgs84(station) -> tuple[float | None, float | None]:
    for c in _ci(station, "GeoInfo", "Coordinates") or []:
        if str(_ci(c, "CoordinateName")).upper() == "WGS84":
            return _num(_ci(c, "StationLatitude")), _num(_ci(c, "StationLongitude"))
    return None, None


def _cwa(dataset: str, key: str) -> dict:
    return get_json(CWA_URL.format(dataset=dataset),
                    params={"Authorization": key, "format": "JSON"}, source=f"cwa_{dataset}")


def fetch_cwa(con) -> dict[str, int]:
    key = secret("CWA_API_KEY")
    if not key:
        raise RuntimeError("CWA_API_KEY not set. Get a free key at "
                           "https://opendata.cwa.gov.tw/user/authkey and put it in .env")
    counties = set(context_config()["weather"]["cwa_counties"])
    out = {}

    # Automatic weather stations (10-min obs)
    rows = []
    for s in _ci(_cwa("O-A0001-001", key), "records", "Station") or []:
        if _ci(s, "GeoInfo", "CountyName") not in counties:
            continue
        lat, lng = _wgs84(s)
        we = _ci(s, "WeatherElement") or {}
        rows.append({
            "station_id": _ci(s, "StationId"),
            "obs_time": _cwa_time(_ci(s, "ObsTime", "DateTime")),
            "station_name": _ci(s, "StationName"),
            "district": _ci(s, "GeoInfo", "TownName"),
            "lat": lat, "lng": lng,
            "weather_desc": None if str(_ci(we, "Weather")).startswith("-99") else _ci(we, "Weather"),
            "temperature_c": _num(_ci(we, "AirTemperature")),
            "humidity_pct": _num(_ci(we, "RelativeHumidity")),
            "wind_ms": _num(_ci(we, "WindSpeed")),
            "gust_ms": _num(_ci(we, "GustInfo", "PeakGustSpeed")),
            "precip_mm": _num(_ci(we, "Now", "Precipitation")),
        })
    out["weather_obs"] = upsert(con, "weather_obs", [r for r in rows if r["obs_time"]])

    # Rain gauges
    rows = []
    for s in _ci(_cwa("O-A0002-001", key), "records", "Station") or []:
        if _ci(s, "GeoInfo", "CountyName") not in counties:
            continue
        lat, lng = _wgs84(s)
        re_ = _ci(s, "RainfallElement") or {}
        rows.append({
            "station_id": _ci(s, "StationId"),
            "obs_time": _cwa_time(_ci(s, "ObsTime", "DateTime")),
            "station_name": _ci(s, "StationName"),
            "district": _ci(s, "GeoInfo", "TownName"),
            "lat": lat, "lng": lng,
            "past10min_mm": _num(_ci(re_, "Past10Min", "Precipitation")),
            "past1hr_mm": _num(_ci(re_, "Past1hr", "Precipitation")),
            "past3hr_mm": _num(_ci(re_, "Past3hr", "Precipitation")),
            "past24hr_mm": _num(_ci(re_, "Past24hr", "Precipitation")),
            "today_mm": _num(_ci(re_, "Now", "Precipitation")),
        })
    out["rain_obs"] = upsert(con, "rain_obs", [r for r in rows if r["obs_time"]])

    # Warnings (heavy rain, typhoon, ...) per county
    now = now_local()
    rows = []
    for loc in _ci(_cwa("W-C0033-001", key), "records", "location") or []:
        name = _ci(loc, "locationName")
        if name not in counties:
            continue
        for hz in _ci(loc, "hazardConditions", "hazards") or []:
            rows.append({
                "location": name,
                "phenomena": _ci(hz, "info", "phenomena"),
                "significance": _ci(hz, "info", "significance"),
                "start_time": _cwa_time(_ci(hz, "validTime", "startTime")),
                "end_time": _cwa_time(_ci(hz, "validTime", "endTime")),
                "first_seen": now,
            })
    out["weather_warnings"] = upsert(con, "weather_warnings", rows, keep_first_seen=("first_seen",))
    return out
