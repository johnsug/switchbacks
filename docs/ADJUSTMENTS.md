# Adjustment Models

Switchbacks MCP transforms raw pace and HR data into an **effort-equivalent flat sea-level cool-weather pace** — what the run would have been under ideal conditions. Three adjustments are applied in sequence.

---

## 1. Grade Adjusted Pace (GAP)

**What it does:** Removes the climbing penalty so you can compare a mountain run against a flat road run.

**Formula:**
```
gain_per_mile = total_elevation_gain_ft / distance_miles
time_penalty_sec_per_mile = (gain_per_mile / 100) × coeff
gap_pace = raw_pace_min_per_mile − (time_penalty_sec_per_mile / 60)
```

**Default coefficient:** 8 sec/mile per 100 ft/mile gain. Configurable via `TRAIL_MCP_GAP_COEFF` (range 6–12).

**Example:** 5-mile run with 500 ft gain = 100 ft/mile → 8 sec/mile penalty → 9:00/mi becomes 8:52/mi GAP.

**Citation:** Based on Jack Daniels' VDOT research and common trail running GAP models. The 8 sec/100 ft coefficient is conservative; some models use 10–12 for steeper terrain.

---

## 2. Altitude Adjustment

**What it does:** Adjusts for reduced oxygen at elevation. Running at altitude requires more cardiovascular effort for the same pace.

**Formula:**
```
if avg_elevation_ft ≤ 3000:
    penalty = 0
else:
    penalty = ((avg_elevation_ft − 3000) / 1000) × 0.01
alt_adj_pace = gap_pace × (1 − penalty)
```

The adjusted pace is *lower* (faster) than GAP pace because we're expressing the sea-level equivalent effort.

**Key detail:** Uses the *mean elevation of the sampled route* (from Open-Elevation), not just the start point. A run that climbs to 12,000 ft and descends back to 7,000 ft gets an average-based correction.

**Default threshold:** 3,000 ft. Default coefficient: 1% per 1,000 ft above threshold.

**Example:** 7,500 ft average elevation → 4,500 ft above threshold → 4.5% adjustment.

**Citation:** Based on altitude performance research. The 1%/1,000 ft model is conservative and well-established in exercise physiology literature.

---

## 3. Heat / Humidity Adjustment (Dew Point Model)

**What it does:** Adjusts for physiological cost of running in humid/hot conditions.

**Why dew point, not temperature:** Dew point measures absolute moisture in the air, which directly affects the body's ability to cool itself via sweat evaporation. Temperature alone is misleading (80°F and dry is far more manageable than 75°F and humid).

**Penalty table:**
| Dew point | Penalty |
|-----------|---------|
| < 50°F    | 0%      |
| 50–54°F   | 1%      |
| 55–59°F   | 2.5%    |
| 60–64°F   | 4%      |
| 65–69°F   | 6.5%    |
| 70–74°F   | 9%      |
| ≥ 75°F    | 12%     |

**Formula:** `heat_adj_pace = alt_adj_pace × (1 − penalty)`

**Citation:** Dew point penalty table adapted from McMillan Running and common race-day adjustment models used by elite coaches.

---

## 4. Aerobic Efficiency Index

**What it does:** Combines pace and HR into a single number that's comparable across all runs, regardless of terrain or conditions.

**Formula:**
```
efficiency = 10000 / (fully_adjusted_pace_min_per_mile × average_hr)
```

**Interpretation:**
- Higher = more aerobically efficient (same HR, faster adjusted pace)
- Comparable *only* when the same adjustment level is applied consistently
- `efficiency_raw` — uses raw pace (includes terrain/weather effects)
- `efficiency_gap` — uses GAP-adjusted pace (removes climbing)
- `efficiency_full` — uses fully adjusted pace (removes all conditions)

**Example:** 8:00/mi at HR 150 → `10000 / (8 × 150)` = 8.33. Getting the same 8.33 at 7:45/mi means HR dropped from 150 to 145 — a fitness improvement.

---

## Internal representation

All pace values are stored as **seconds per meter** internally. Conversion to min/mile or min/km only happens at output time. This avoids unit confusion when doing arithmetic on pace.
