# YouBike Optimizer Taipei – System Requirements

## 0. Scope

- City: Taipei only.
- Focus districts: Daan (大安區), Xinyi / Taipei 101 (信義區), NTU / Gongguan (大安區 + 中正區).
- System: YouBike 2.0 only. **E-bikes (2.0E) are out of scope** – I don't ride them.
- Three products: personal phone app, big analytics dashboard, incentive simulator.
- Secondary goal: publishable research paper.
- Single user first (me).

## 1. Data Sources

### 1.1 Live

- Taipei live feed: `https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json`
- No API key needed.
- Updates about every minute.
- Fields: `sno`, `sna`, `snaen`, `sarea`, `sareaen`, `ar`, `aren`, `Quantity`, `available_rent_bikes`, `available_return_bikes`, `latitude`, `longitude`, `act`, `mday`, `srcUpdateTime`, `updateTime`, `infoTime`, `infoDate`.
- TDX national platform (backup + e-bike split).
- TDX needs free account + API key.
- TDX gives regular vs. e-bike availability separately → used only to count *regular* bikes (the Taipei feed's `available_rent_bikes` may include e-bikes).
- TDX has a "nearby" spatial query endpoint.
- TDX rate limits depend on plan. Respect them.

### 1.2 Historical / static (data.taipei / data.gov.tw)

- Monthly trip records 2023 (rental time, start station, return time, end station, duration, date).
- Start/end station OD statistics (GeoJSON, with geometry + district).
- Usage-rate statistics.
- Monthly usage per station.
- Station count per district.
- Station construction cost (for cost-benefit analysis).
- MRT / bus / YouBike station volume analysis dataset.
- Old archives on GitHub (e.g. 2015 API dumps) for long-term comparison.

### 1.3 Context data

Connected 2026-11-18 (see README → Context data): weather, holidays, public events and elevation. Still open: MRT, NTU school calendar, POIs.

- ✅ Weather: Open-Meteo forecast + 15-min nowcast + ERA5 history (no key); CWA station obs, rain gauges, warnings (needs free key).
- MRT station locations + exits.
- MRT ridership per station per hour (if available).
- ✅ Public holidays + make-up workdays (government calendar). ⏳ School calendar (NTU semester, exams).
- ✅ Events: Ministry of Culture open data (concerts, theatre, …, geolocated) + `config/events_curated.yaml` (Taipei 101 New Year, marathons).
- ✅ Elevation / slope (bikes pile up downhill): SRTM + ASTER 30 m (+ Copernicus 90 m), median per station; `station_terrain` / `station_pairs` views.
- POIs: universities, offices, night markets, gyms.

## 2. Ingestion

- Poller fetches live feed every 60 s.
- Store every snapshot. Never overwrite.
- Store raw JSON (compressed) + parsed rows.
- Deduplicate by `sno` + `infoTime`.
- Retry with backoff on failure.
- Log gaps (missing minutes).
- Health check: alert me if poller is down > 10 min.
- Run 24/7 (cheap VPS, Raspberry Pi, or serverless cron). just prototype
- Separate poller for TDX (regular-bike count, to exclude e-bikes), lower frequency.
- One-time import job for all historical CSV/GeoJSON.
- Station metadata table updated daily (new/removed stations).

## 3. Storage

- Time-series DB: PostgreSQL + TimescaleDB, or DuckDB + Parquet.
- Tables: `stations`, `snapshots`, `trips_hist`, `od_stats`, `weather`, `events`, `my_places`, `my_trips`, `alerts`.
- Partition snapshots by day.
- Keep raw data forever (research reproducibility).
- Precompute hourly + 15-min aggregates.
- Spatial index (PostGIS or H3 hex cells).

## 4. Data Quality

- Fix encoding: decode feed as UTF-8 (sample showed mojibake like `æ·é‹`).
- Validate `available_rent_bikes + available_return_bikes <= Quantity`.
- Flag stations with `act = 0` (inactive).
- Flag frozen stations (no change for many hours).
- Use `infoTime`, not fetch time, as truth.
- Handle timezone: Asia/Taipei everywhere.
- Detect station ID changes / renames.
- Mark missing data instead of interpolating silently.

## 5. Derived Metrics

- Net flow per station per minute: Δ bikes between snapshots.
- Estimated departures / arrivals (lower bound).
- Empty flag: `available_rent_bikes == 0`.
- Full flag: `available_return_bikes == 0`.
- "Almost empty": ≤ 2 bikes. "Almost full": ≤ 2 docks.
- Fill ratio = bikes / Quantity.
- Time-to-empty from current trend.
- Time-to-full from current trend.
- Empty minutes per day per station.
- Full minutes per day per station.
- Rebalancing event: jump ≥ +5 / −5 bikes within 1–2 min.
- Truck route reconstruction: chain nearby rebalancing events in time.
- Station reliability score per hour + weekday.
- District imbalance index (supply vs. demand).

## 6. My Places & Profile

- Save places: home (set in the app), NTU, national library
- Each place: lat/lng, radius, list of nearby stations.
- Save usual departure times per weekday.
- Save typical routes
- Mode per place: "need bike" (start) or "need dock" (end).
- Import my own ride history (YouBike app export / manual). how can i do that? please help me here, i have the ubike app on my phone
- Preferences: max walk distance, notify channels. (No e-bike option – regular bikes only.)

## 7. Personal Analytics

- Heatmap: chance of ≥1 bike, per station, hour × weekday.
- Heatmap: chance of ≥1 free dock, per station, hour × weekday.
- Do both for every saved place, not only home.
- Best departure window per route.
- "Latest safe time to leave" per place.
- Best backup station per place + time.
- Ranking of nearby stations by reliability.
- Refill times per station (from rebalancing detection).
- Weather effect on my stations.
- Weekly summary: rides, minutes saved, failed attempts avoided.
- My ride stats: count, duration, distance, cost
- 

## 8. Quick "Find Bike" Button

- One tap from home screen.
- Uses current GPS.
- Lists nearest stations, closest first.
- Each card: station name (English + Chinese), regular bikes available, free docks.
- Each card: distance in m + walking minutes.
- Each card: direction from me (N, NE, E, SE, S, SW, W, NW) + arrow.
- Arrow rotates with phone compass.
- Each card: data age ("updated 40 s ago").
- Each card: trend (filling / draining / stable).
- Each card: predicted bikes on arrival.
- Swipe left/right to next station.
- Skip stations with 0 bikes (toggle).
- Tap = start navigation automatically.
- Navigation via Apple Maps / Google Maps deep link, walking mode.
- Auto-refresh every 30–60 s.
- Haptic feedback if the selected station drops to 0.
- Auto-suggest switch: "Station emptied, next one 180 m NE." -> when i telect it google maps navigation so save the coordinates

## 9. "Find Dock" Mode

- Same UI as Find Bike, for returning.
- Based on destination, not current position.
- Shows free docks + predicted free docks on arrival.
- Warn before I arrive if destination station fills up.
- Suggest alternative dock station on the route.

## 10. Alerts & Notifications

- "Leave now": my station has X bikes and usually empties in Y min.
- "Station refilled": truck just added bikes.
- "Dock warning": destination likely full on arrival.
- "Rain coming": take MRT instead.
- Morning briefing at fixed time: best station + leave time.
- Alerts only in my saved time windows.
- Quiet hours.
- Max alerts per day (no spam).
- Channels: LINE (Messaging API bot; LINE Notify is discontinued).
- Channels: iOS push (PWA web push or native app).
- Channels: Telegram / ntfy / Pushover as backup.
- iOS Shortcuts / widget: one-glance station status.
- Apple Watch complication (later).
- Each alert has deep link to Find Bike screen.
- Log every alert + whether it was useful (feedback button).

## 11. Prediction Models

- Baseline: historical average per station × hour × weekday.
- Model: gradient boosting (LightGBM) with time, weather, holiday, neighbors.
- Model: Poisson / negative binomial for departures and arrivals.
- Model: survival model for time-to-empty.
- Model: graph neural network across station network (research).
- Forecast horizons: 5, 15, 30, 60 min.
- Output probabilities, not just counts.
- Uncertainty bands in UI.
- Backtest on held-out weeks.
- Metrics: MAE, Brier score, empty-event precision/recall.
- Retrain weekly.
- Compare model vs. naive baseline always.

## 12. Phone Dashboard (Personal)

- Mobile-first PWA, installable on iPhone home screen.
- Dark mode.
- Large touch targets, one-hand use.
- Home screen: next trip, best station, leave-by time.
- Tiles: my places with live status color (green / yellow / red).
- Mini map with nearby stations, colored by bikes.
- Heatmap tab per place.
- History tab: my rides + saved time.
- Settings: places, times, alerts, channels.
- Loads in < 2 s on mobile data.
- Offline: show last known data with timestamp.
- English UI, Chinese station names optional.

## 13. Big Analytics Dashboard

- Desktop-first, also usable on tablet.
- Map of all Taipei stations, focus filter on Daan / Xinyi / NTU.
- Time slider: replay any day minute by minute.
- Animated flow lines between stations (from OD data).
- Hex-grid (H3) heatmap of net flow.
- Empty / full hotspots by hour.
- District imbalance over the day.
- Morning vs. evening "tide" (residential → office → residential).
- MRT station catchments: bike flow around each MRT exit.
- NTU semester vs. holiday comparison.
- Weekday vs. weekend patterns.
- Rain vs. dry day comparison.
- Rebalancing truck activity map + timeline.
- Station clustering (k-means / DTW) by daily profile.
- Top routes, top stations, longest empty streaks.
- Station efficiency: rides per dock per day.
- Cost per ride per station (with construction cost data).
- "Underserved" areas: high demand, frequent empty, few stations.
- Proposed new station locations.
- Export charts as PNG/SVG (paper + video).
- Export filtered data as CSV/Parquet.
- Every chart shows data source + time range.

## 14. Incentive Simulation

### 14.1 Concept

- Discount for returning bikes in deficit regions (often empty).
- Tiny surcharge (e.g. NT$1) for returning bikes in surplus regions (often full).
- Goal: users rebalance the system, fewer trucks needed.

### 14.2 Model

- Region definition: district, H3 hex, or station cluster.
- Classify regions live: deficit / balanced / surplus.
- Demand from historical OD + live flows.
- Agent-based sim: each trip = agent with origin, destination, time.
- Agents may shift end station if nearby + incentive is worth it.
- Willingness-to-walk parameter (meters).
- Price elasticity parameter (share of users reacting per NT$).
- Share of users who see incentives (app adoption %).
- Max detour distance.
- Time-of-day dependent incentives.
- Dynamic pricing vs. fixed zones (compare both).
- Rebalancing trucks as separate agents (capacity, speed, cost).

### 14.3 Interactive Controls (sliders)

- Discount amount (NT$).
- Surcharge amount (NT$1, 2, 5 …).
- Deficit / surplus thresholds (% fill).
- Region size.
- Walking tolerance.
- Elasticity.
- Adoption rate.
- Time window (rush hour only / all day).
- Number of trucks.
- Weather scenario.
- Day type (weekday, weekend, exam week, holiday).

### 14.4 Output KPIs (update live)

- Empty-station minutes (before vs. after).
- Full-station minutes (before vs. after).
- Failed rental attempts (estimated).
- Truck km + truck cost saved.
- Total discounts paid vs. surcharges collected.
- Net cost to operator / city.
- CO₂ saved by fewer truck km.
- Average extra walking per user.
- Fairness: who pays, who benefits, per district.
- Side-by-side map: baseline vs. incentive scenario.
- Time-series chart: system balance over the day.
- Save + compare scenarios.
- Sensitivity analysis: which parameter matters most.

## 15. Research Paper Track

- Research question 1: How predictable are empty/full events per station?
- Research question 2: How much do rebalancing trucks actually move?
- Research question 3: Can small user incentives replace part of truck rebalancing?
- Research question 4: How do weather + MRT + semester affect flows?
- Literature review: bike-sharing rebalancing, incentive schemes (e.g. Citi Bike Angels), YouBike studies.
- Use existing Taiwanese YouBike theses as related work.
- Clear data description section (sources, period, coverage, gaps).
- Reproducible pipeline (code + config + data version).
- Fixed random seeds for simulations.
- Baselines + ablation studies.
- Statistical tests + confidence intervals.
- Limitations: net flow ≠ true trips, no user-level data.
- Ethics: no personal data in published datasets.
- Publish code on GitHub, data snapshot on Zenodo (DOI).
- Target venues: transport / urban computing journals or conferences.
- Possible collaboration: NTU / NTUST transport research groups.
- Possible collaboration: Taipei Department of Transportation, YouBike operator.

## 16. Tech Stack (suggested)

- Backend: Python (FastAPI).
- Poller: Python + scheduler (cron / APScheduler).
- DB: PostgreSQL + TimescaleDB + PostGIS (or DuckDB for research).
- Analytics: pandas / polars, scikit-learn, LightGBM, statsmodels.
- Simulation: Python (Mesa or custom), vectorized.
- Phone app: PWA (React / Next.js or SvelteKit) first, native iOS later.
- Maps: MapLibre / Leaflet + OpenStreetMap tiles.
- Big dashboard: deck.gl for flow animations, Plotly / Observable for charts.
- Hosting: cheap VPS or Fly.io / Railway; Cloudflare for edge cache.
- Notifications: LINE Messaging API, Web Push, Telegram bot.
- Version control: Git + GitHub.
- CI: tests + lint on push.

## 18. Non-Functional

- Live data latency < 90 s end to end.
- Find Bike screen < 2 s to first result.
- Poller uptime > 99 %.
- Cost < NT$500 / month.
- All times in Asia/Taipei.
- Bilingual station names.
- Accessible colors (color-blind safe).
