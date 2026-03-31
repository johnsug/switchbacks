import type { WeatherRecord } from "./cache.js";

// ---------------------------------------------------------------------------
// Raw activity as it arrives from Strava API or GetFast MCP
// ---------------------------------------------------------------------------

export interface RawActivity {
  id: string;
  name: string;
  distanceM: number;
  movingTimeSec: number;
  totalElevationGainM: number;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  startDate: string;                    // ISO 8601
  startLatlng: [number, number] | null; // [lat, lon]
  summaryPolyline: string | null;
  type: string;                         // "Run", "TrailRun", etc.
  vo2MaxScore?: number | null;          // Garmin only, from activity detail JSON
}

// ---------------------------------------------------------------------------
// Enriched activity — all adjustments applied
// ---------------------------------------------------------------------------

export interface EnrichedActivity {
  // Raw fields (mirrored for convenience)
  id: string;
  name: string;
  distanceM: number;
  movingTimeSec: number;
  totalElevationGainM: number;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  startDate: string;
  type: string;

  // Decoded from polyline
  startLat: number | null;
  startLon: number | null;

  // Pace (sec/meter — all internal pace values use this unit)
  rawPaceSecPerM: number;

  // Elevation
  avgRouteElevationFt: number | null;  // average absolute elevation (from GPX or streams)
  totalElevationGainFt: number;

  // Weather
  weather: WeatherRecord | null;

  // Adjustment outputs (null when inputs were unavailable)
  gapPace: number | null;        // sec/meter
  altAdjPace: number | null;     // sec/meter
  heatAdjPace: number | null;    // sec/meter
  gapPct: number | null;
  altPct: number | null;
  heatPct: number | null;
  efficiencyRaw: number | null;
  efficiencyGap: number | null;
  efficiencyFull: number | null;
  vo2MaxScore: number | null;

  // Non-fatal issues during enrichment
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Weekly summary used by get_fitness_trend
// ---------------------------------------------------------------------------

export interface WeekSummary {
  weekLabel: string;            // "2024-W33"
  weekStart: string;            // ISO date of Monday
  nRuns: number;
  distanceMiles: number;
  vertFt: number;
  avgEfficiencyRaw: number | null;
  avgEfficiencyGap: number | null;
  avgEfficiencyFull: number | null;
  avgTempF: number | null;
  avgDewpointF: number | null;
  avgVo2Max: number | null;
}
