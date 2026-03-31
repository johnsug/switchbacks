# Switchback MCP — Trail Runner Analytics MCP Server
## Build Specification for Claude Code

---

## Overview

**Switchback MCP** is an open-source MCP (Model Context Protocol) server that gives AI assistants like Claude a trail-running-aware analytics layer on top of Strava/Garmin data. It pulls raw activity data from the GetFast MCP (or directly from Strava/Garmin APIs), enriches it with elevation profiles, real weather, and altitude corrections, and exposes a set of tools that let Claude reason about training load and fitness using *effort-adjusted* metrics rather than raw pace and HR.

**Target user:** Trail runners who want to ask Claude questions like:
- "Am I getting fitter or just fatigued?"
- "How did weather affect my performance this block?"
- "What's my equivalent flat-road pace for this mountain run?"
- "Compare my fitness this month vs last month, accounting for terrain and conditions."

**License:** MIT  
**Distribution:** GitHub, self-hosted  
**Language:** TypeScript (Node.js) — matches the MCP SDK's primary ecosystem  
**Dependencies:** Minimal by design — no heavy frameworks

---

## Architecture

```
Claude (MCP client)
      |
      | MCP protocol (stdio or HTTP/SSE)
      v
Switchback MCP Server
      |
      |-- GetFast MCP tools (activity data, GPS, HR, elevation gain)
      |-- Open-Meteo API (historical weather, free, no key)
      |-- Open-Elevation API (route elevation profiles, free, no key)
      |-- Local SQLite cache (avoid re-fetching same data)
      |
      v
Enriched, adjusted activity records
```

Switchback MCP does **not** replace GetFast — it wraps it. If GetFast is not connected, it falls back to direct Strava API calls using a user-provided token.

---

## Data Sources

### 1. Activity Data — GetFast MCP (primary) or Strava API (fallback)
- Distance, moving time, raw pace, average/max HR
- Total elevation gain (meters)
- GPS polyline (encoded) — used to decode start lat/lon and sample route elevation
- Cadence

### 2. Elevation Profiles — Open-Elevation
- **URL:** `https://api.open-elevation.com/api/v1/lookup`
- **Free, no API key**
- Used to: decode GPS polyline into lat/lon points, sample elevation every ~200m, compute average route elevation (not just start elevation)
- Fallback: Open-Meteo also returns surface elevation for a single point at no cost

### 3. Weather — Open-Meteo Historical Archive
- **URL:** `https://archive-api.open-meteo.com/v1/archive`
- **Free, no API key, no rate limit for reasonable use**
- Fields to request: `temperature_2m`, `relativehumidity_2m`, `dewpoint_2m`, `apparent_temperature`, `windspeed_10m`, `precipitation`
- Timezone: user-configurable (default `America/Chicago`)

### 4. Altitude Adjustment
- Computed from Open-Elevation average route elevation (not just start point)
- Threshold: 3,000 ft (914m) — no adjustment below this
- Formula: `1% slower per 1,000 ft above 3,000 ft` (conservative; configurable)
- For routes with significant elevation change, use the *mean* elevation of the route

---

## Adjustment Models

All adjustments produce an **effort-equivalent flat sea-level cool-weather pace** — what the run would have been under ideal conditions. Higher adjusted efficiency = fitter.

### Grade Adjusted Pace (GAP)
```
gain_per_mile = total_elevation_gain_ft / distance_miles
time_penalty_sec = (gain_per_mile / 100) * 8    # 8 sec/mile per 100 ft/mile gain
gap_pace = raw_pace - (time_penalty_sec / 60)
```
Default coefficient: 8 sec/mile per 100 ft/mile. Configurable via `TRAIL_MCP_GAP_COEFF` env var (range: 6–12).

### Altitude Adjustment
```
avg_elev_ft = mean(sampled_elevation_points) * 3.28084
if avg_elev_ft <= 3000:
    alt_penalty = 0
else:
    alt_penalty = ((avg_elev_ft - 3000) / 1000) * 0.01   # 1% per 1000ft above 3000ft
alt_adj_pace = gap_pace * (1 - alt_penalty)
```
Note: This adjusts *downward* (making the equivalent sea-level pace faster) to reflect extra effort expended at altitude.

### Heat / Humidity Adjustment (Dew Point model)
```
dew_point_f -> pct_penalty:
  < 50°F  → 0%
  50–54°F → 1%
  55–59°F → 2.5%
  60–64°F → 4%
  65–69°F → 6.5%
  70–74°F → 9%
  ≥ 75°F  → 12%

heat_adj_pace = alt_adj_pace * (1 - pct_penalty)
```

### Aerobic Efficiency Index
```
efficiency = 10000 / (fully_adjusted_pace * average_hr)
```
Higher is better. Comparable across runs only when all three adjustments are applied.

---

## MCP Tools to Expose

### `get_recent_runs`
Fetch and enrich the last N runs (default 20, max 100).

**Parameters:**
- `days_back` (int, optional) — limit to last N days
- `activity_type` (string, optional) — default "running"
- `include_weather` (bool, default true)
- `include_elevation_profile` (bool, default true)

**Returns per run:**
- All raw fields (distance, pace, HR, elevation gain)
- `start_lat`, `start_lon` (decoded from GPS polyline)
- `avg_route_elevation_ft` (sampled from Open-Elevation)
- Weather fields: `temp_f`, `humidity_pct`, `dewpoint_f`, `apparent_temp_f`, `wind_mph`
- Adjustment fields: `gap_pace`, `alt_adj_pace`, `heat_adj_pace`, `gap_pct`, `alt_pct`, `heat_pct`
- `efficiency_raw`, `efficiency_gap`, `efficiency_full`

---

### `get_fitness_trend`
Weekly aggregated efficiency trend over a date range.

**Parameters:**
- `weeks` (int, default 12)
- `metric` (enum: `efficiency_raw` | `efficiency_gap` | `efficiency_full`, default `efficiency_full`)

**Returns:**
- Array of weekly summaries: week label, miles, vert_ft, avg efficiency (raw/gap/full), avg temp, avg dewpoint, n_runs
- Trend direction: linear regression slope over the period
- Peak week and trough week

---

### `get_activity_detail`
Deep dive on a single activity with full adjustment breakdown.

**Parameters:**
- `activity_id` (string)

**Returns:**
- All `get_recent_runs` fields
- Elevation profile array (sampled points)
- Full adjustment waterfall: raw pace → GAP → altitude adj → heat adj → final equiv pace
- Percentile vs user's own history (e.g. "top 15% effort by adjusted efficiency")

---

### `compare_periods`
Compare fitness between two date ranges, normalized for conditions.

**Parameters:**
- `period_a_start`, `period_a_end` (ISO dates)
- `period_b_start`, `period_b_end` (ISO dates)
- `min_distance_miles` (float, default 3.0 — filter out shakeouts)

**Returns:**
- Mean efficiency (raw and full-adjusted) for each period
- Mean conditions (temp, dew point, terrain difficulty) for each period
- Delta and direction ("You are 8.3% more aerobically efficient in period B")
- Confidence note if sample sizes are small

---

### `get_weather_impact`
Analyze how weather has affected performance over time.

**Parameters:**
- `days_back` (int, default 90)

**Returns:**
- Correlation between dew point and efficiency
- Distribution of dew point conditions across runs
- "Best weather window" — periods with favorable conditions
- Estimated pace slow-down per 10°F dew point increase in user's personal data

---

### `estimate_race_time`
Predict finish time for a target race, adjusted for expected conditions.

**Parameters:**
- `distance_miles` (float)
- `elevation_gain_ft` (float)
- `avg_route_elevation_ft` (float)
- `expected_temp_f` (float, optional)
- `expected_dewpoint_f` (float, optional)

**Returns:**
- Predicted finish time based on user's recent fully-adjusted efficiency
- Pace bands (conservative / target / aggressive)
- Condition adjustment breakdown

---

## Caching Layer

Use **SQLite** (via `better-sqlite3`) to cache:
- Weather fetches keyed by `(lat_round2, lon_round2, date)` — TTL: permanent (historical data doesn't change)
- Elevation profiles keyed by polyline hash — TTL: permanent
- Activity enrichments keyed by `activity_id` — TTL: 24 hours (in case of corrections)

Cache lives at `~/.switchback-mcp/cache.db` by default. Configurable via `TRAIL_MCP_CACHE_DIR` env var.

This means after the first enrichment pass, all subsequent Claude conversations are fast and token-cheap — no re-fetching weather or elevation for old runs.

---

## Configuration

All config via environment variables or a `~/.switchback-mcp/config.json` file:

```json
{
  "strava_access_token": "...",        // only needed if not using GetFast
  "strava_refresh_token": "...",       // only needed if not using GetFast
  "strava_client_id": "...",           // only needed if not using GetFast
  "strava_client_secret": "...",       // only needed if not using GetFast
  "timezone": "America/Chicago",       // for weather hour matching
  "gap_coefficient": 8,                // sec/mile per 100ft/mile gain (6–12)
  "altitude_threshold_ft": 3000,       // ft above which altitude adj kicks in
  "altitude_coefficient": 0.01,        // % slower per 1000ft above threshold
  "cache_dir": "~/.switchback-mcp",
  "elevation_sample_interval_m": 200,  // how often to sample route elevation
  "use_getfast": true                  // prefer GetFast MCP over direct Strava API
}
```

---

## Project Structure

```
switchback-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── .env.example
├── src/
│   ├── index.ts              # MCP server entry point, tool registration
│   ├── config.ts             # Config loading and validation
│   ├── cache.ts              # SQLite cache layer
│   ├── tools/
│   │   ├── get_recent_runs.ts
│   │   ├── get_fitness_trend.ts
│   │   ├── get_activity_detail.ts
│   │   ├── compare_periods.ts
│   │   ├── get_weather_impact.ts
│   │   └── estimate_race_time.ts
│   ├── sources/
│   │   ├── strava.ts         # Direct Strava API client (fallback)
│   │   ├── getfast.ts        # GetFast MCP tool caller (primary)
│   │   ├── open_meteo.ts     # Weather fetching + parsing
│   │   └── open_elevation.ts # Elevation profile fetching
│   ├── adjustments/
│   │   ├── gap.ts            # Grade Adjusted Pace
│   │   ├── altitude.ts       # Altitude adjustment
│   │   ├── heat.ts           # Dew point heat adjustment
│   │   └── efficiency.ts     # Efficiency index + waterfall
│   └── utils/
│       ├── polyline.ts       # Google polyline encoder/decoder
│       ├── geo.ts            # Haversine distance, lat/lon sampling
│       └── units.ts          # ft/m conversions, pace formatting
├── tests/
│   ├── adjustments.test.ts
│   ├── cache.test.ts
│   └── fixtures/             # sample activity JSON for testing
└── docs/
    ├── ADJUSTMENTS.md        # explanation of each formula with citations
    ├── SETUP.md              # step-by-step install guide
    └── CLAUDE_USAGE.md       # example prompts that work well with this MCP
```

---

## Key Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "better-sqlite3": "^9.x",
    "node-fetch": "^3.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "@types/better-sqlite3": "^7.x",
    "vitest": "^1.x"
  }
}
```

No heavy frameworks. No ORM. No external state.

---

## Installation (target UX)

```bash
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/switchback-mcp
cd switchback-mcp
npm install
npm run build

# 2. Configure
cp .env.example .env
# Edit .env with your Strava credentials (or leave blank if using GetFast)

# 3. Add to Claude Desktop config
# ~/.config/claude/claude_desktop_config.json
{
  "mcpServers": {
    "switchback-mcp": {
      "command": "node",
      "args": ["/path/to/switchback-mcp/dist/index.js"]
    }
  }
}

# 4. Restart Claude Desktop — Switchback MCP tools appear automatically
```

---

## Open-Source Release Checklist

- [ ] MIT LICENSE file
- [ ] README with: what it does, why trail runners need it, quick install, example Claude prompts
- [ ] CONTRIBUTING.md — especially: how to add a new adjustment model, how to add a new data source
- [ ] `.env.example` with all config keys documented
- [ ] GitHub Actions: CI on push (lint + tests), release build on tag
- [ ] GitHub issue templates: bug report, feature request, new data source proposal
- [ ] Topics/tags: `mcp`, `trail-running`, `strava`, `running-analytics`, `claude`, `model-context-protocol`

---

## Future Extensions (post-v1)

- **HRV integration** — if user has Garmin, use morning HRV trend as a fatigue signal overlay
- **Garmin native support** — bypass Strava entirely for users with Garmin Connect
- **Power meter support** — for runners with Stryd or similar, replace pace-based efficiency with watt-based efficiency (more accurate, no GAP needed)
- **Segment analysis** — identify repeated route segments and track pace/HR progression on the same terrain over time
- **Training load score** — weighted TRIMP or similar that incorporates all three adjustment factors
- **Race result import** — manually log races with conditions so Claude can compare training fitness vs race day performance
- **Tomorrow.io MCP integration** — for *forecast* (not historical) weather when planning future runs

---

## Notes for Claude Code

1. Start with the `adjustments/` module — it has no external dependencies and can be fully tested in isolation. The formulas are all specified above.
2. Build the SQLite cache layer second — it unblocks all the API integrations by giving them a safe place to store results.
3. The Open-Meteo and Open-Elevation integrations are straightforward HTTP clients — implement them with `node-fetch` and wrap in try/catch with graceful degradation (return null weather fields rather than failing the whole tool call).
4. The GetFast integration is a special case — Switchback MCP will be running as an MCP server itself, and calling GetFast requires either a separate MCP client connection or a direct HTTP call to GetFast's underlying REST API. The cleanest approach is to accept GetFast activity data as *input* to Switchback MCP tools (the user pastes or pipes it) rather than trying to chain MCP servers at runtime. Document this clearly.
5. The polyline decoder is trivial to implement from scratch (the Google algorithm is public domain) — don't add a dependency for it.
6. All pace values internally should be stored as `seconds_per_meter` to avoid unit confusion — convert to min/mile or min/km only at output time.
