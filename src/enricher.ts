import { Cache } from "./cache.js";
import type { Config } from "./config.js";
import type { RawActivity, EnrichedActivity } from "./types.js";
import { decodePolyline } from "./utils/polyline.js";
import { metersToFeet } from "./utils/units.js";
import { fetchWeather, isoDateInTimezone, isoHourInTimezone } from "./sources/open_meteo.js";
import { fetchAvgElevationForActivity } from "./sources/resolver.js";
import { computeGap } from "./adjustments/gap.js";
import { computeAltitudeAdj } from "./adjustments/altitude.js";
import { computeHeatAdj } from "./adjustments/heat.js";
import { computeEfficiency } from "./adjustments/efficiency.js";

/**
 * Enrich a single raw activity with weather, elevation, and all adjustments.
 * Results are cached — subsequent calls for the same activity_id are instant.
 *
 * Never throws. Non-fatal failures (API timeouts, missing HR) are collected
 * in `warnings` and returned alongside whatever data was available.
 */
export async function enrichActivity(
  activity: RawActivity,
  cache: Cache,
  config: Config,
  options: {
    includeWeather?: boolean;
    includeElevationProfile?: boolean;
  } = {}
): Promise<EnrichedActivity> {
  const { includeWeather = true, includeElevationProfile = true } = options;

  // Return cached enrichment if fresh
  const cached = cache.getEnrichment(activity.id);
  if (cached) {
    return cacheRecordToEnriched(activity, cached);
  }

  const warnings: string[] = [];
  const rawPaceSecPerM = activity.movingTimeSec / activity.distanceM;

  // -------------------------------------------------------------------------
  // Decode polyline → start lat/lon
  // -------------------------------------------------------------------------
  let startLat: number | null = null;
  let startLon: number | null = null;
  let decodedPoints: Array<[number, number]> = [];
  const polyline = activity.summaryPolyline;

  if (polyline) {
    try {
      decodedPoints = decodePolyline(polyline);
      if (decodedPoints.length > 0) {
        [startLat, startLon] = decodedPoints[0];
      }
    } catch {
      warnings.push("Could not decode GPS polyline.");
    }
  } else if (activity.startLatlng) {
    [startLat, startLon] = activity.startLatlng;
  }

  // -------------------------------------------------------------------------
  // Average route elevation (from GPX or altitude stream)
  // -------------------------------------------------------------------------
  let avgRouteElevationFt: number | null = null;

  if (includeElevationProfile) {
    const avgElevM = await fetchAvgElevationForActivity(config, activity.id);
    if (avgElevM !== null) {
      avgRouteElevationFt = metersToFeet(avgElevM);
    } else {
      warnings.push("Elevation data unavailable — altitude adjustment skipped.");
    }
  }

  // -------------------------------------------------------------------------
  // Weather
  // -------------------------------------------------------------------------
  let weather = null;

  if (includeWeather && startLat !== null && startLon !== null) {
    const date = isoDateInTimezone(activity.startDate, config.timezone);
    const hour = isoHourInTimezone(activity.startDate, config.timezone);

    const cachedWeather = cache.getWeather(startLat, startLon, date);
    if (cachedWeather) {
      weather = cachedWeather;
    } else {
      weather = await fetchWeather(startLat, startLon, date, config.timezone, hour);
      if (weather) {
        cache.setWeather(startLat, startLon, date, weather);
      } else {
        warnings.push("Weather data unavailable — heat adjustment skipped.");
      }
    }
  } else if (includeWeather) {
    warnings.push("No GPS coordinates — weather lookup skipped.");
  }

  // -------------------------------------------------------------------------
  // Adjustments
  // -------------------------------------------------------------------------
  const elevGainFt = metersToFeet(activity.totalElevationGainM);

  const { gapPace, gapPct } = computeGap(
    rawPaceSecPerM,
    elevGainFt,
    activity.distanceM,
    config.gapCoefficient
  );

  const { altAdjPace, altPct } = avgRouteElevationFt !== null
    ? computeAltitudeAdj(gapPace, avgRouteElevationFt, config.altitudeThresholdFt, config.altitudeCoefficient)
    : { altAdjPace: gapPace, altPct: 0 };

  const { heatAdjPace, heatPct } = weather
    ? computeHeatAdj(altAdjPace, weather.dewpointF)
    : { heatAdjPace: altAdjPace, heatPct: 0 };

  // VO2 max — carried through from source if available (Garmin only)
  const vo2MaxScore = activity.vo2MaxScore ?? null;

  // Efficiency requires HR
  const hr = activity.averageHeartrate;
  let efficiencyRaw: number | null = null;
  let efficiencyGap: number | null = null;
  let efficiencyFull: number | null = null;

  if (hr && hr > 0) {
    efficiencyRaw  = computeEfficiency(rawPaceSecPerM, hr);
    efficiencyGap  = computeEfficiency(gapPace, hr);
    efficiencyFull = computeEfficiency(heatAdjPace, hr);
  } else {
    warnings.push("No heart rate data — efficiency index unavailable.");
  }

  // -------------------------------------------------------------------------
  // Cache the enrichment
  // -------------------------------------------------------------------------
  cache.setEnrichment({
    activityId: activity.id,
    startLat,
    startLon,
    avgRouteElevationFt,
    weather,
    gapPace,
    altAdjPace,
    heatAdjPace,
    gapPct,
    altPct,
    heatPct,
    efficiencyRaw,
    efficiencyGap,
    efficiencyFull,
    vo2MaxScore,
  });

  return {
    id: activity.id,
    name: activity.name,
    distanceM: activity.distanceM,
    movingTimeSec: activity.movingTimeSec,
    totalElevationGainM: activity.totalElevationGainM,
    totalElevationGainFt: elevGainFt,
    averageHeartrate: hr,
    maxHeartrate: activity.maxHeartrate,
    averageCadence: activity.averageCadence,
    startDate: activity.startDate,
    type: activity.type,
    startLat,
    startLon,
    rawPaceSecPerM,
    avgRouteElevationFt,
    weather,
    gapPace,
    altAdjPace,
    heatAdjPace,
    gapPct,
    altPct,
    heatPct,
    efficiencyRaw,
    efficiencyGap,
    efficiencyFull,
    vo2MaxScore,
    warnings,
  };
}

/**
 * Enrich multiple activities concurrently (capped at 5 in-flight at once).
 */
export async function enrichActivities(
  activities: RawActivity[],
  cache: Cache,
  config: Config,
  options?: { includeWeather?: boolean; includeElevationProfile?: boolean }
): Promise<EnrichedActivity[]> {
  const results: EnrichedActivity[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < activities.length; i += CONCURRENCY) {
    const batch = activities.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(
      batch.map((a) => enrichActivity(a, cache, config, options))
    );
    results.push(...enriched);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

import type { ActivityEnrichment } from "./cache.js";

function cacheRecordToEnriched(
  activity: RawActivity,
  cached: ActivityEnrichment
): EnrichedActivity {
  return {
    id: activity.id,
    name: activity.name,
    distanceM: activity.distanceM,
    movingTimeSec: activity.movingTimeSec,
    totalElevationGainM: activity.totalElevationGainM,
    totalElevationGainFt: metersToFeet(activity.totalElevationGainM),
    averageHeartrate: activity.averageHeartrate,
    maxHeartrate: activity.maxHeartrate,
    averageCadence: activity.averageCadence,
    startDate: activity.startDate,
    type: activity.type,
    startLat: cached.startLat,
    startLon: cached.startLon,
    rawPaceSecPerM: activity.movingTimeSec / activity.distanceM,
    avgRouteElevationFt: cached.avgRouteElevationFt,
    weather: cached.weather,
    gapPace: cached.gapPace,
    altAdjPace: cached.altAdjPace,
    heatAdjPace: cached.heatAdjPace,
    gapPct: cached.gapPct,
    altPct: cached.altPct,
    heatPct: cached.heatPct,
    efficiencyRaw: cached.efficiencyRaw,
    efficiencyGap: cached.efficiencyGap,
    efficiencyFull: cached.efficiencyFull,
    vo2MaxScore: cached.vo2MaxScore,
    warnings: [],
  };
}
