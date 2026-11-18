"""Station elevation from several public DEMs; downstream uses the median.

- OpenTopoData public API: SRTM 30 m, ASTER 30 m (100 points/call, 1 call/s, 1000 calls/day)
- Open-Meteo elevation API: Copernicus GLO-90 (100 points/call)

Only stations with no value yet for a source (or that moved > 25 m) are fetched.
"""
from __future__ import annotations

import logging
import time

from ..config import context_config, now_local
from ..db import upsert
from ..http import get_json

log = logging.getLogger(__name__)

OPENTOPO_URL = "https://api.opentopodata.org/v1/{dataset}"
OPENMETEO_URL = "https://api.open-meteo.com/v1/elevation"
BATCH = 100


def _opentopodata(dataset: str, pts: list[tuple[float, float]]) -> list[float | None]:
    locs = "|".join(f"{lat:.6f},{lng:.6f}" for lat, lng in pts)
    data = get_json(OPENTOPO_URL.format(dataset=dataset), params={"locations": locs})
    time.sleep(1.1)  # public API limit: 1 call / second
    return [r.get("elevation") for r in data["results"]]


def _openmeteo(pts: list[tuple[float, float]]) -> list[float | None]:
    data = get_json(OPENMETEO_URL, params={
        "latitude": ",".join(f"{p[0]:.6f}" for p in pts),
        "longitude": ",".join(f"{p[1]:.6f}" for p in pts)})
    return data["elevation"]


def _fetch(source: str, pts):
    provider, dataset = source.split(":", 1)
    if provider == "opentopodata":
        return _opentopodata(dataset, pts)
    if provider == "openmeteo":
        return _openmeteo(pts)
    raise ValueError(f"unknown elevation source {source}")


def update_elevation(con, *, force: bool = False) -> dict[str, int]:
    out = {}
    for source in context_config()["elevation"]["sources"]:
        todo = con.execute("""
            SELECT s.sno, s.lat, s.lng FROM stations s
            LEFT JOIN station_elevation_src e ON e.sno = s.sno AND e.source = ?
            WHERE ? OR e.sno IS NULL OR e.elev_m IS NULL
               OR haversine_m(s.lat, s.lng, e.lat, e.lng) > 25
            ORDER BY s.sno""", [source, force]).fetchall()
        n = 0
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            try:
                elevs = _fetch(source, [(lat, lng) for _, lat, lng in chunk])
            except Exception as e:
                log.warning("elevation %s failed at batch %d: %s", source, i // BATCH, e)
                break
            now = now_local()
            n += upsert(con, "station_elevation_src", [
                {"sno": sno, "source": source, "lat": lat, "lng": lng,
                 "elev_m": float(el) if el is not None else None, "fetched_at": now}
                for (sno, lat, lng), el in zip(chunk, elevs)])
        out[source] = n
    return out
