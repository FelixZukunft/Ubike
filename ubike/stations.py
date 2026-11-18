"""Station metadata from the Taipei live feed (refresh daily)."""
from __future__ import annotations

from .config import now_local
from .db import upsert
from .http import get_json

FEED_URL = "https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json"


def refresh_stations(con) -> int:
    data = get_json(FEED_URL, source="youbike_feed")
    now = now_local()
    rows = [{
        "sno": s["sno"],
        "name_zh": s.get("sna"),
        "name_en": s.get("snaen"),
        "district_zh": s.get("sarea"),
        "district_en": s.get("sareaen"),
        "address_zh": s.get("ar"),
        "address_en": s.get("aren"),
        "lat": float(s["latitude"]),
        "lng": float(s["longitude"]),
        "capacity": int(s.get("Quantity") or 0),
        "active": str(s.get("act")) == "1",
        "first_seen": now,
        "last_seen": now,
    } for s in data]
    return upsert(con, "stations", rows, keep_first_seen=("first_seen",))
