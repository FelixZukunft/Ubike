"""Calendar (public holidays, make-up workdays) + public events.

Sources:
- Taiwan government calendar (DGPA data, mirrored by github.com/ruyut/TaiwanCalendar)
- Ministry of Culture open data (concerts, theatre, exhibitions; geolocated).
  It only lists current/upcoming events, so run daily to build history.
- config/events_curated.yaml for big things the feeds miss (fireworks, marathons).
"""
from __future__ import annotations

import datetime as dt
import re

import yaml

from ..config import CONFIG_DIR, context_config, now_local
from ..db import upsert
from ..http import get_json

CALENDAR_URL = "https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/{year}.json"
CULTURE_URL = "https://cloud.culture.tw/frontsite/trans/SearchShowAction.do"

CULTURE_CATEGORIES = {
    "1": "music", "2": "theatre", "3": "dance", "4": "family", "5": "indie_music",
    "6": "exhibition", "7": "talk", "8": "film", "11": "variety", "13": "competition",
    "14": "audition", "15": "other", "16": "other", "17": "concert", "19": "workshop",
    "200": "reading",
}

_DISTRICT_RE = re.compile(r"[臺台]北市\s*(\S{1,3}區)")


# ---------------------------------------------------------------- calendar
def fetch_calendar(con, years: list[int]) -> int:
    rows = []
    for y in years:
        try:
            days = get_json(CALENDAR_URL.format(year=y), source="calendar")
        except Exception as e:  # next year's calendar is published ~mid-year
            if y > now_local().year:
                continue
            raise e
        for d in days:
            date = dt.datetime.strptime(d["date"], "%Y%m%d").date()
            off = bool(d["isHoliday"])
            desc = (d.get("description") or "").strip() or None
            weekend = date.weekday() >= 5
            if off and (desc or not weekend):
                day_type = "holiday"
            elif off:
                day_type = "weekend"
            elif weekend:
                day_type = "makeup_workday"
            else:
                day_type = "workday"
            rows.append({"date": date, "weekday": date.weekday(), "is_day_off": off,
                         "day_type": day_type, "description": desc})
    return upsert(con, "calendar_days", rows)


# ---------------------------------------------------------------- events
def _in_bbox(lat, lng) -> bool:
    b = context_config()["events"]["bbox"]
    return lat is not None and lng is not None and \
        b["min_lat"] <= lat <= b["max_lat"] and b["min_lng"] <= lng <= b["max_lng"]


def _capacity(venue: str | None) -> int | None:
    if not venue or any(w in venue for w in ("會議室", "教室", "排練", "實驗劇場", "大廳", "室")):
        return None  # side rooms inside a big venue are not the big venue
    for k, cap in context_config()["events"]["venue_capacity"].items():
        if k in venue:
            return cap
    return None


def _f(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def _t(s):
    if not s:
        return None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(s.strip(), fmt)
        except ValueError:
            pass
    return None


def fetch_culture_events(con) -> int:
    data = get_json(CULTURE_URL, params={"method": "doFindTypeJ", "category": "all"},
                    source="culture_events")
    now = now_local()
    rows = []
    for ev in data:
        cat = CULTURE_CATEGORIES.get(str(ev.get("category")), "other")
        for i, show in enumerate(ev.get("showInfo") or []):
            addr = (show.get("location") or "").strip()
            lat, lng = _f(show.get("latitude")), _f(show.get("longitude"))
            in_taipei = bool(re.match(r"^\s*[臺台]北市", addr)) if addr else _in_bbox(lat, lng)
            if not in_taipei:
                continue
            start = _t(show.get("time"))
            if start is None:
                continue
            m = _DISTRICT_RE.search(addr)
            venue = (show.get("locationName") or "").strip() or None
            rows.append({
                "event_id": f"culture:{ev['UID']}:{start:%Y%m%d%H%M}:{i}",
                "source": "culture.tw",
                "title": ev.get("title"),
                "category": cat,
                "venue": venue,
                "address": addr or None,
                "district_zh": m.group(1) if m else None,
                "lat": lat, "lng": lng,
                "start_ts": start,
                "end_ts": _t(show.get("endTime")) or start + dt.timedelta(hours=2),
                "expected_attendance": _capacity(venue),
                "url": ev.get("sourceWebPromote") or ev.get("webSales") or None,
                "first_seen": now, "last_seen": now,
            })
    return upsert(con, "events", rows, keep_first_seen=("first_seen",))


def load_curated_events(con) -> int:
    path = CONFIG_DIR / "events_curated.yaml"
    items = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    now = now_local()

    def ts(v):
        return v if isinstance(v, dt.datetime) else dt.datetime.fromisoformat(str(v))

    rows = [{
        "event_id": f"curated:{e['id']}",
        "source": "curated",
        "title": e["title"],
        "category": e.get("category"),
        "venue": e.get("venue"),
        "address": e.get("address"),
        "district_zh": e.get("district_zh"),
        "lat": e.get("lat"), "lng": e.get("lng"),
        "start_ts": ts(e["start"]), "end_ts": ts(e["end"]),
        "expected_attendance": e.get("expected_attendance"),
        "url": e.get("url"),
        "first_seen": now, "last_seen": now,
    } for e in items]
    return upsert(con, "events", rows, keep_first_seen=("first_seen",))
