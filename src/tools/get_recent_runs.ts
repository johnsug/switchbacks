import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import type { EnrichedActivity } from "../types.js";
import { listActivitiesFromSource } from "../sources/resolver.js";
import { enrichActivities } from "../enricher.js";
import { metersToMiles, secPerMToMinPerMile, formatPace, metersToFeet, formatDuration, SECS_PER_DAY, round0, round1, round2, round3 } from "../utils/units.js";

export interface GetRecentRunsParams {
  days_back?: number;
  activity_type?: string;
  include_weather?: boolean;
  include_elevation_profile?: boolean;
  limit?: number;
}

export async function getRecentRuns(
  params: GetRecentRunsParams,
  cache: Cache,
  config: Config
): Promise<object> {
  const {
    days_back,
    activity_type = "running",
    include_weather = true,
    include_elevation_profile = true,
    limit = 20,
  } = params;

  const after = days_back
    ? Math.floor(Date.now() / 1000) - days_back * SECS_PER_DAY
    : undefined;

  const rawOrError = await listActivitiesFromSource(config, {
    type: activity_type,
    limit: Math.min(limit, 100),
    after,
  });

  if ("error" in rawOrError) return rawOrError;

  const typeFilter = activity_type.toLowerCase();
  const cutoff = days_back
    ? new Date(Date.now() - days_back * SECS_PER_DAY * 1000).toISOString()
    : null;

  const filtered = rawOrError
    .filter((a) => {
      const matchesType =
        a.type.toLowerCase().includes(typeFilter) ||
        (typeFilter === "running" &&
          ["run", "trailrun", "virtualrun"].some((t) => a.type.toLowerCase().includes(t)));
      const matchesDate = !cutoff || a.startDate >= cutoff;
      return matchesType && matchesDate;
    })
    .slice(0, limit);

  const enriched = await enrichActivities(filtered, cache, config, {
    includeWeather: include_weather,
    includeElevationProfile: include_elevation_profile,
  });

  return {
    runs: enriched.map(formatRun),
    count: enriched.length,
  };
}

export function formatRun(r: EnrichedActivity): object {
  const distanceMiles = metersToMiles(r.distanceM);
  const gainPerMile = distanceMiles > 0
    ? round0(r.totalElevationGainFt / distanceMiles)
    : null;

  return {
    id: r.id,
    name: r.name,
    date: r.startDate.split("T")[0],
    distance_miles: round2(distanceMiles),
    duration: formatDuration(r.movingTimeSec),
    elevation_gain_ft: round0(r.totalElevationGainFt),
    gain_per_mile: gainPerMile,
    avg_hr: r.averageHeartrate,
    cadence: r.averageCadence,
    type: r.type,
    location: r.startLat !== null
      ? { lat: r.startLat, lon: r.startLon }
      : null,
    avg_route_elevation_ft: r.avgRouteElevationFt !== null
      ? round0(r.avgRouteElevationFt)
      : null,
    pace: {
      raw: formatPace(r.rawPaceSecPerM),
      gap: r.gapPace ? formatPace(r.gapPace) : null,
      alt_adj: r.altAdjPace ? formatPace(r.altAdjPace) : null,
      heat_adj: r.heatAdjPace ? formatPace(r.heatAdjPace) : null,
    },
    pace_raw_min_per_mile: round2(secPerMToMinPerMile(r.rawPaceSecPerM)),
    adjustments: {
      gap_pct: r.gapPct !== null ? round2(r.gapPct * 100) : null,
      alt_pct: r.altPct !== null ? round2(r.altPct * 100) : null,
      heat_pct: r.heatPct !== null ? round2(r.heatPct * 100) : null,
    },
    efficiency: {
      raw: r.efficiencyRaw !== null ? round3(r.efficiencyRaw) : null,
      gap: r.efficiencyGap !== null ? round3(r.efficiencyGap) : null,
      full: r.efficiencyFull !== null ? round3(r.efficiencyFull) : null,
    },
    weather: r.weather
      ? {
          temp_f: round1(r.weather.tempF),
          humidity_pct: round1(r.weather.humidityPct),
          dewpoint_f: round1(r.weather.dewpointF),
          apparent_temp_f: round1(r.weather.apparentTempF),
          wind_mph: round1(r.weather.windMph),
          precip_in: round2(r.weather.precipIn),
        }
      : null,
    warnings: r.warnings.length ? r.warnings : undefined,
  };
}
