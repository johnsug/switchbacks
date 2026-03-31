import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import type { EnrichedActivity } from "../types.js";
import { getActivityFromSource, listActivitiesFromSource } from "../sources/resolver.js";
import { enrichActivity, enrichActivities } from "../enricher.js";
import { computeEfficiency } from "../adjustments/efficiency.js";
import {
  metersToMiles, metersToFeet, formatPace, formatDuration,
  secPerMToMinPerMile, SECS_PER_DAY, round0, round1, round2, round3,
} from "../utils/units.js";
import { mean } from "../utils/geo.js";

export interface GetActivityDetailParams {
  activity_id: string;
  /** Days of history to fetch for comparison context (default 90) */
  history_days?: number;
}

export async function getActivityDetail(
  params: GetActivityDetailParams,
  cache: Cache,
  config: Config
): Promise<object> {
  const { activity_id, history_days = 90 } = params;

  // -------------------------------------------------------------------------
  // Fetch the target activity and recent history concurrently
  // -------------------------------------------------------------------------
  const after = Math.floor(Date.now() / 1000) - history_days * SECS_PER_DAY;

  const [activityResult, historyResult] = await Promise.all([
    getActivityFromSource(config, activity_id),
    listActivitiesFromSource(config, { type: "running", limit: 200, after }),
  ]);

  if ("error" in activityResult) return activityResult;

  // Enrich the target activity
  const enriched = await enrichActivity(activityResult, cache, config);

  // Enrich history for comparison (skip if source error — we can still show the activity)
  let history: EnrichedActivity[] = [];
  if (!("error" in historyResult)) {
    // Exclude the current activity from history to avoid self-comparison
    const otherActivities = historyResult.filter((a) => a.id !== activity_id);
    history = await enrichActivities(otherActivities, cache, config);
  }

  // -------------------------------------------------------------------------
  // Build output sections
  // -------------------------------------------------------------------------
  const distanceMiles = metersToMiles(enriched.distanceM);
  const gainPerMile = distanceMiles > 0
    ? round0(enriched.totalElevationGainFt / distanceMiles)
    : 0;

  return {
    activity: buildActivitySummary(enriched, distanceMiles, gainPerMile),
    waterfall: buildWaterfall(enriched, distanceMiles, config.altitudeThresholdFt),
    terrain: buildTerrainContext(enriched, distanceMiles, gainPerMile, history),
    vs_history: buildHistoryContext(enriched, history),
    verdict: buildVerdict(enriched, gainPerMile, history),
  };
}

// ---------------------------------------------------------------------------
// Activity summary
// ---------------------------------------------------------------------------

function buildActivitySummary(
  r: EnrichedActivity,
  distanceMiles: number,
  gainPerMile: number
): object {
  return {
    id: r.id,
    name: r.name,
    date: r.startDate.split("T")[0],
    type: r.type,
    distance_miles: round2(distanceMiles),
    duration: formatDuration(r.movingTimeSec),
    elevation_gain_ft: round0(r.totalElevationGainFt),
    gain_per_mile: gainPerMile,
    avg_hr: r.averageHeartrate,
    cadence: r.averageCadence,
    avg_route_elevation_ft: r.avgRouteElevationFt !== null ? round0(r.avgRouteElevationFt) : null,
    weather: r.weather
      ? {
          temp_f: round1(r.weather.tempF),
          dewpoint_f: round1(r.weather.dewpointF),
          humidity_pct: round1(r.weather.humidityPct),
          apparent_temp_f: round1(r.weather.apparentTempF),
          wind_mph: round1(r.weather.windMph),
        }
      : null,
    warnings: r.warnings.length ? r.warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// Waterfall table
// ---------------------------------------------------------------------------

function buildWaterfall(r: EnrichedActivity, distanceMiles: number, altThresholdFt: number): object {
  const gainPerMile = distanceMiles > 0
    ? round0(r.totalElevationGainFt / distanceMiles)
    : 0;

  const table: object[] = [
    {
      stage: "Raw",
      pace: formatPace(r.rawPaceSecPerM),
      pace_min_per_mile: round2(secPerMToMinPerMile(r.rawPaceSecPerM)),
      efficiency: r.efficiencyRaw !== null ? round3(r.efficiencyRaw) : null,
      note: "Actual pace from GPS + time",
    },
  ];

  // GAP row
  if (r.gapPace !== null) {
    const gapPct = r.gapPct !== null ? round1(r.gapPct * 100) : 0;
    const gapNote = gainPerMile > 0
      ? `${gainPerMile} ft/mile gain — removed climb penalty`
      : "flat course — no adjustment";
    table.push({
      stage: gainPerMile > 0
        ? `+ GAP (${gainPerMile} ft/mile)`
        : "+ GAP (flat)",
      pace: formatPace(r.gapPace),
      pace_min_per_mile: round2(secPerMToMinPerMile(r.gapPace)),
      efficiency: r.efficiencyGap !== null ? round3(r.efficiencyGap) : null,
      adjustment_pct: `${gapPct}%`,
      note: gapNote,
    });
  }

  // Altitude row
  if (r.altAdjPace !== null) {
    const altPct = r.altPct ?? 0;
    const showAlt = r.avgRouteElevationFt !== null ? round0(r.avgRouteElevationFt) : null;
    table.push({
      stage: altPct > 0 ? `+ Altitude (${showAlt?.toLocaleString() ?? "?"}ft avg)` : "+ Altitude (below threshold)",
      pace: formatPace(r.altAdjPace),
      pace_min_per_mile: round2(secPerMToMinPerMile(r.altAdjPace)),
      efficiency: r.efficiencyFull !== null && r.heatAdjPace === r.altAdjPace
        ? round3(r.efficiencyFull)  // heat not applied — this is the final pace
        : (r.averageHeartrate
            ? round3(computeEfficiency(r.altAdjPace, r.averageHeartrate))
            : null),
      adjustment_pct: `${round1(altPct * 100)}%`,
      note: altPct > 0
        ? `${round1(altPct * 100)}% penalty above ${altThresholdFt.toLocaleString()}ft threshold`
        : "Below altitude threshold — no adjustment",
    });
  }

  // Heat row
  if (r.heatAdjPace !== null && r.weather) {
    const heatPct = r.heatPct ?? 0;
    table.push({
      stage: `+ Heat (${round0(r.weather.dewpointF)}°F dew point)`,
      pace: formatPace(r.heatAdjPace),
      pace_min_per_mile: round2(secPerMToMinPerMile(r.heatAdjPace)),
      efficiency: r.efficiencyFull !== null ? round3(r.efficiencyFull) : null,
      adjustment_pct: `${round1(heatPct * 100)}%`,
      note: heatPct > 0
        ? `${round1(heatPct * 100)}% slowdown from humidity`
        : "Dew point below threshold — no heat penalty",
    });
  }

  const finalPace = r.heatAdjPace ?? r.altAdjPace ?? r.gapPace ?? r.rawPaceSecPerM;
  const headline = r.heatAdjPace !== null
    ? `Equivalent flat sea-level cool-weather pace: ${formatPace(r.heatAdjPace)} (${formatDuration(r.heatAdjPace * r.distanceM)} for this distance)`
    : r.altAdjPace !== null
    ? `Equivalent flat sea-level pace: ${formatPace(r.altAdjPace)} (${formatDuration(r.altAdjPace * r.distanceM)} for this distance)`
    : `Grade-adjusted pace: ${formatPace(finalPace)}`;

  return { table, headline };
}

// ---------------------------------------------------------------------------
// Terrain context
// ---------------------------------------------------------------------------

function buildTerrainContext(
  r: EnrichedActivity,
  distanceMiles: number,
  gainPerMile: number,
  history: EnrichedActivity[]
): object {
  const hilliness =
    gainPerMile < 50  ? "flat"
    : gainPerMile < 100 ? "rolling"
    : gainPerMile < 150 ? "hilly"
    : "very hilly";

  // Compare to historical average gain-per-mile
  const histGains = history
    .filter((h) => h.distanceM > 0)
    .map((h) => metersToFeet(h.totalElevationGainM) / metersToMiles(h.distanceM));

  const avgHistGain = mean(histGains);
  let vsHistContext: string | null = null;

  if (avgHistGain !== null && history.length >= 5) {
    const diff = gainPerMile - round0(avgHistGain);
    const sign = diff >= 0 ? "+" : "";
    vsHistContext = `${sign}${diff} ft/mile vs your ${history_days_label(history)} average of ${round0(avgHistGain)} ft/mile`;
  }

  return {
    gain_per_mile: gainPerMile,
    total_gain_ft: round0(r.totalElevationGainFt),
    hilliness,
    avg_route_elevation_ft: r.avgRouteElevationFt !== null ? round0(r.avgRouteElevationFt) : null,
    vs_recent_context: vsHistContext,
  };
}

// ---------------------------------------------------------------------------
// Historical comparison
// ---------------------------------------------------------------------------

function buildHistoryContext(
  r: EnrichedActivity,
  history: EnrichedActivity[]
): object | null {
  if (r.efficiencyFull === null) {
    return { note: "No HR data — efficiency comparison unavailable." };
  }

  const histEfficiencies = history
    .map((h) => h.efficiencyFull)
    .filter((v): v is number => v !== null);

  if (histEfficiencies.length < 3) {
    return {
      efficiency_full: round3(r.efficiencyFull),
      note: "Not enough recent history for comparison.",
    };
  }

  const recentAvg = mean(histEfficiencies) as number;
  const peak = Math.max(...histEfficiencies);
  const vsAvgPct = round1(((r.efficiencyFull - recentAvg) / recentAvg) * 100);

  // Percentile rank (what fraction of history runs are below this efficiency)
  const below = histEfficiencies.filter((v) => v < r.efficiencyFull!).length;
  const percentile = Math.round((below / histEfficiencies.length) * 100);

  return {
    efficiency_full: round3(r.efficiencyFull),
    recent_avg: round3(recentAvg),
    recent_peak: round3(peak),
    vs_avg_pct: vsAvgPct,
    percentile,
    n_runs: histEfficiencies.length,
    context: `${percentile}th percentile vs your last ${histEfficiencies.length} runs (avg ${round3(recentAvg)}, peak ${round3(peak)})`,
  };
}

// ---------------------------------------------------------------------------
// One-line verdict
// ---------------------------------------------------------------------------

function buildVerdict(
  r: EnrichedActivity,
  gainPerMile: number,
  history: EnrichedActivity[]
): string {
  if (r.efficiencyFull === null) {
    return "No HR data — efficiency verdict unavailable. Add a heart rate monitor for full analysis.";
  }

  const histEfficiencies = history
    .map((h) => h.efficiencyFull)
    .filter((v): v is number => v !== null);

  let verdictBase = "run";
  let rankNote = "";
  let conditionNote = "";

  if (histEfficiencies.length >= 3) {
    const below = histEfficiencies.filter((v) => v < r.efficiencyFull!).length;
    const percentile = Math.round((below / histEfficiencies.length) * 100);
    const rank = histEfficiencies.length - below;

    if (percentile >= 80) {
      verdictBase = "excellent effort";
      rankNote = `#${rank} best efficiency in the last ${histEfficiencies.length} runs`;
    } else if (percentile >= 60) {
      verdictBase = "solid run";
      rankNote = `${percentile}th percentile in the last ${histEfficiencies.length} runs`;
    } else if (percentile >= 40) {
      verdictBase = "average effort";
      rankNote = `${percentile}th percentile in the last ${histEfficiencies.length} runs`;
    } else {
      verdictBase = "tough day";
      rankNote = `${percentile}th percentile in the last ${histEfficiencies.length} runs`;
    }
  }

  const hillPart = gainPerMile >= 150 ? "very hilly terrain"
    : gainPerMile >= 100 ? "hilly terrain"
    : gainPerMile >= 50  ? "rolling terrain"
    : "flat terrain";

  const heatPart = r.weather && r.heatPct && r.heatPct > 0.02
    ? ` and ${round0(r.weather.dewpointF)}°F dew point`
    : "";

  conditionNote = `${hillPart}${heatPart}`;

  const parts = [
    verdictBase.charAt(0).toUpperCase() + verdictBase.slice(1),
    rankNote ? `— ${rankNote}` : "",
    conditionNote ? `despite ${conditionNote}.` : ".",
  ].filter(Boolean);

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function history_days_label(history: EnrichedActivity[]): string {
  if (history.length === 0) return "recent";
  const oldest = history.reduce((min, h) => h.startDate < min ? h.startDate : min, history[0]!.startDate);
  const days = Math.round((Date.now() - new Date(oldest).getTime()) / (1000 * 86400));
  if (days < 40) return `${days}-day`;
  if (days < 120) return `${Math.round(days / 30)}-month`;
  return `${Math.round(days / 30)}-month`;
}
