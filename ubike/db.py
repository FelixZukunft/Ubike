"""DuckDB connection, schema and upsert helper.

Convention: every TIMESTAMP column is naive Asia/Taipei local time, matching the
YouBike feed's `infoTime`, so joins need no conversion.
"""
from __future__ import annotations

import duckdb
import pyarrow as pa

from .config import DATA_DIR, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    sno          VARCHAR PRIMARY KEY,
    name_zh      VARCHAR,
    name_en      VARCHAR,
    district_zh  VARCHAR,
    district_en  VARCHAR,
    address_zh   VARCHAR,
    address_en   VARCHAR,
    lat          DOUBLE,
    lng          DOUBLE,
    capacity     INTEGER,
    active       BOOLEAN,
    first_seen   TIMESTAMP,
    last_seen    TIMESTAMP
);

-- Live availability, one row per station per feed update (deduplicated on
-- sno + info_time by the poller; no PK to keep inserts cheap).
CREATE TABLE IF NOT EXISTS snapshots (
    sno         VARCHAR,
    info_time   TIMESTAMP,
    bikes       SMALLINT,
    docks       SMALLINT,
    capacity    SMALLINT,
    active      BOOLEAN,
    fetched_at  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS poll_log (
    fetched_at   TIMESTAMP PRIMARY KEY,
    ok           BOOLEAN,
    n_stations   INTEGER,
    n_new_rows   INTEGER,
    error        VARCHAR
);

-- ---------- personal ----------
CREATE TABLE IF NOT EXISTS my_places (
    id         VARCHAR PRIMARY KEY,
    name       VARCHAR,
    icon       VARCHAR,
    lat        DOUBLE,
    lng        DOUBLE,
    radius_m   INTEGER,
    mode       VARCHAR,   -- bike | dock | both
    sort       INTEGER
);

-- Usual trips: weekdays is a list of 0..6 (Mon = 0), depart is 'HH:MM'.
CREATE TABLE IF NOT EXISTS my_routes (
    id         VARCHAR PRIMARY KEY,
    from_place VARCHAR,
    to_place   VARCHAR,
    weekdays   INTEGER[],
    depart     VARCHAR,
    enabled    BOOLEAN
);

CREATE TABLE IF NOT EXISTS my_rides (
    id           VARCHAR PRIMARY KEY,
    start_ts     TIMESTAMP,
    end_ts       TIMESTAMP,
    from_sno     VARCHAR,
    to_sno       VARCHAR,
    from_name    VARCHAR,
    to_name      VARCHAR,
    distance_m   DOUBLE,
    cost_nt      DOUBLE,
    source       VARCHAR,   -- app | manual | import
    note         VARCHAR
);

CREATE TABLE IF NOT EXISTS prefs (
    key    VARCHAR PRIMARY KEY,
    value  JSON
);

-- ---------- weather ----------
-- Hourly weather history (Open-Meteo archive = ERA5 reanalysis, ~5 day lag).
CREATE TABLE IF NOT EXISTS weather_hourly (
    point_id       VARCHAR,
    ts             TIMESTAMP,
    source         VARCHAR,
    temperature_c  DOUBLE,
    apparent_c     DOUBLE,
    precip_mm      DOUBLE,
    rain_mm        DOUBLE,
    humidity_pct   DOUBLE,
    weather_code   INTEGER,
    wind_kmh       DOUBLE,
    gust_kmh       DOUBLE,
    fetched_at     TIMESTAMP,
    PRIMARY KEY (point_id, ts, source)
);

-- Every issued forecast is kept (forecast vintages matter for honest backtests).
CREATE TABLE IF NOT EXISTS weather_forecast (
    issued_at        TIMESTAMP,
    point_id         VARCHAR,
    ts               TIMESTAMP,
    temperature_c    DOUBLE,
    apparent_c       DOUBLE,
    precip_mm        DOUBLE,
    precip_prob_pct  DOUBLE,
    weather_code     INTEGER,
    wind_kmh         DOUBLE,
    gust_kmh         DOUBLE,
    PRIMARY KEY (issued_at, point_id, ts)
);

-- 15-minute precipitation nowcast, for "rain coming" alerts.
CREATE TABLE IF NOT EXISTS weather_nowcast_15min (
    issued_at  TIMESTAMP,
    point_id   VARCHAR,
    ts         TIMESTAMP,
    precip_mm  DOUBLE,
    PRIMARY KEY (issued_at, point_id, ts)
);

-- CWA automatic weather station observations (needs CWA_API_KEY).
CREATE TABLE IF NOT EXISTS weather_obs (
    station_id     VARCHAR,
    obs_time       TIMESTAMP,
    station_name   VARCHAR,
    district       VARCHAR,
    lat            DOUBLE,
    lng            DOUBLE,
    weather_desc   VARCHAR,
    temperature_c  DOUBLE,
    humidity_pct   DOUBLE,
    wind_ms        DOUBLE,
    gust_ms        DOUBLE,
    precip_mm      DOUBLE,   -- accumulated since midnight
    PRIMARY KEY (station_id, obs_time)
);

-- CWA rain gauges (denser network than weather_obs; needs CWA_API_KEY).
CREATE TABLE IF NOT EXISTS rain_obs (
    station_id     VARCHAR,
    obs_time       TIMESTAMP,
    station_name   VARCHAR,
    district       VARCHAR,
    lat            DOUBLE,
    lng            DOUBLE,
    past10min_mm   DOUBLE,
    past1hr_mm     DOUBLE,
    past3hr_mm     DOUBLE,
    past24hr_mm    DOUBLE,
    today_mm       DOUBLE,
    PRIMARY KEY (station_id, obs_time)
);

-- CWA weather warnings: heavy rain, typhoon, cold surge, ... (needs CWA_API_KEY).
CREATE TABLE IF NOT EXISTS weather_warnings (
    location      VARCHAR,
    phenomena     VARCHAR,
    significance  VARCHAR,
    start_time    TIMESTAMP,
    end_time      TIMESTAMP,
    first_seen    TIMESTAMP,
    PRIMARY KEY (location, phenomena, significance, start_time)
);

-- ---------- calendar + events ----------
CREATE TABLE IF NOT EXISTS calendar_days (
    date         DATE PRIMARY KEY,
    weekday      INTEGER,      -- 0 = Monday
    is_day_off   BOOLEAN,
    day_type     VARCHAR,      -- workday | weekend | holiday | makeup_workday
    description  VARCHAR
);

CREATE TABLE IF NOT EXISTS events (
    event_id             VARCHAR PRIMARY KEY,
    source               VARCHAR,
    title                VARCHAR,
    category             VARCHAR,
    venue                VARCHAR,
    address              VARCHAR,
    district_zh          VARCHAR,
    lat                  DOUBLE,
    lng                  DOUBLE,
    start_ts             TIMESTAMP,
    end_ts               TIMESTAMP,
    expected_attendance  INTEGER,
    url                  VARCHAR,
    first_seen           TIMESTAMP,
    last_seen            TIMESTAMP
);

-- ---------- elevation ----------
CREATE TABLE IF NOT EXISTS station_elevation_src (
    sno         VARCHAR,
    source      VARCHAR,
    lat         DOUBLE,
    lng         DOUBLE,
    elev_m      DOUBLE,
    fetched_at  TIMESTAMP,
    PRIMARY KEY (sno, source)
);

CREATE OR REPLACE MACRO haversine_m(lat1, lng1, lat2, lng2) AS
    2 * 6371008.8 * asin(sqrt(
        pow(sin(radians(lat2 - lat1) / 2), 2)
        + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lng2 - lng1) / 2), 2)));

-- Best elevation per station = median over sources.
CREATE OR REPLACE VIEW station_elevation AS
SELECT sno, median(elev_m) AS elev_m, count(*) AS n_sources,
       max(elev_m) - min(elev_m) AS source_spread_m
FROM station_elevation_src
WHERE elev_m IS NOT NULL
GROUP BY sno;

-- Directed station pairs within 1.5 km with straight-line grade.
-- grade_pct > 0 means riding a -> b is uphill.
CREATE OR REPLACE VIEW station_pairs AS
SELECT a.sno AS from_sno, b.sno AS to_sno,
       haversine_m(a.lat, a.lng, b.lat, b.lng) AS dist_m,
       eb.elev_m - ea.elev_m AS climb_m,
       100 * (eb.elev_m - ea.elev_m) / nullif(haversine_m(a.lat, a.lng, b.lat, b.lng), 0) AS grade_pct
FROM stations a
JOIN stations b
  ON a.sno <> b.sno
 AND abs(a.lat - b.lat) < 0.0135 AND abs(a.lng - b.lng) < 0.015
JOIN station_elevation ea ON ea.sno = a.sno
JOIN station_elevation eb ON eb.sno = b.sno
WHERE haversine_m(a.lat, a.lng, b.lat, b.lng) <= 1500;

-- Terrain features per station. relief_m > 0: station sits higher than its
-- neighbourhood (bikes tend to drain away downhill); < 0: in a dip (bikes pile up).
CREATE OR REPLACE VIEW station_terrain AS
SELECT s.sno, s.name_en, s.district_en, e.elev_m,
       count(p.to_sno) FILTER (WHERE p.dist_m <= 500)              AS neighbors_500m,
       -avg(p.climb_m) FILTER (WHERE p.dist_m <= 500)              AS relief_500m,
       -avg(p.climb_m)                                             AS relief_1500m,
       max(p.grade_pct) FILTER (WHERE p.dist_m >= 150)             AS steepest_climb_out_pct,
       min(p.grade_pct) FILTER (WHERE p.dist_m >= 150)             AS steepest_descent_out_pct
FROM stations s
JOIN station_elevation e USING (sno)
LEFT JOIN station_pairs p ON p.from_sno = s.sno
GROUP BY ALL;

-- Events with duration; long-running exhibitions are usually noise for bike demand.
CREATE OR REPLACE VIEW events_v AS
SELECT *, date_diff('minute', start_ts, end_ts) / 60.0 AS duration_h,
       date_diff('minute', start_ts, end_ts) > 24 * 60 AS is_long_running
FROM events;
"""


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH), read_only=read_only)
    if not read_only:
        con.execute(SCHEMA)
    con.execute("SET TimeZone = 'Asia/Taipei'")
    return con


def upsert(con: duckdb.DuckDBPyConnection, table: str, rows: list[dict],
           *, keep_first_seen: tuple[str, ...] = ()) -> int:
    """Insert rows, replacing existing rows with the same primary key.

    Columns listed in `keep_first_seen` keep their existing value on conflict
    (e.g. `first_seen`).
    """
    if not rows:
        return 0
    con = con.cursor()  # own cursor: DuckDB 2 refuses register() while a result is pending
    tbl = pa.Table.from_pylist(rows)
    con.register("_upsert_src", tbl)
    try:
        cols = tbl.column_names
        pk = [r[0] for r in con.execute(
            "SELECT unnest(constraint_column_names) FROM duckdb_constraints() "
            "WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'", [table]).fetchall()]
        updates = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in pk and c not in keep_first_seen)
        col_list = ", ".join(cols)
        conflict = f"ON CONFLICT ({', '.join(pk)}) DO UPDATE SET {updates}" if updates else "ON CONFLICT DO NOTHING"
        con.execute(f"INSERT INTO {table} ({col_list}) SELECT {col_list} FROM _upsert_src {conflict}")
    finally:
        con.unregister("_upsert_src")
    return len(rows)
