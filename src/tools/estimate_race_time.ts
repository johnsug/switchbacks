import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import type { EnrichedActivity } from "../types.js";
import { listActivitiesFromSource } from "../sources/resolver.js";
import { enrichActivities } from "../enricher.js";
import { computeGap } from "../adjustments/gap.js";
import { computeAltitudeAdj } from "../adjustments/altitude.js";
import { computeHeatAdj } from "../adjustments/heat.js";
import { metersToMiles, formatDuration, formatPace, minPerMileToSecPerM, secPerMToMinPerMile, METERS_PER_MILE, SECS_PER_DAY, round1, round2, round3 } from "../utils/units.js";
import { mean } from "../utils/geo.js";

export interface EstimateRaceTimeParams {
  distance_miles: number;
  elevation_gain_ft: number;
  avg_route_elevation_ft: number;
  expected_temp_f?: number;
  expected_dewpoint_f?: number;
  baseline_weeks?: number;
}

export async function estimateRaceTime(
  params: EstimateRaceTimeParams,
  cache: Cache,
  config: Config
): Promise<object> {
  const {
    distance_miles,
    elevation_gain_ft,
    avg_route_elevation_ft,
    expected_temp_f,
    expected_dewpoint_f,
    baseline_weeks = 8,
  } = params;

  const after = Math.floor(Date.now() / 1000) - baseline_weeks * 7 * SECS_PER_DAY;
  const rawOrError = await listActivitiesFromSource(config, { type: "running", limit: 100, after });
  if ("error" in rawOrError) return rawOrError;

  const enriched = await enrichActivities(rawOrError, cache, config);

  const withEfficiency = enriched.filter(
    (r): r is EnrichedActivity & { efficiencyFull: number; averageHeartrate: number } =>
      r.efficiencyFull !== null && r.averageHeartrate !== null && r.distanceM >= 3 * METERS_PER_MILE
  );

  if (withEfficiency.length < 2) {
    return {
      error: "Need at least 2 qualifying runs with HR data to estimate race time.",
      qualifying_runs: withEfficiency.length,
    };
  }

  // Use mean of top 50% by efficiency (avoids weighting outlier bad days)
  const sorted = [...withEfficiency].sort((a, b) => b.efficiencyFull - a.efficiencyFull);
  const topHalf = sorted.slice(0, Math.max(2, Math.ceil(sorted.length / 2)));
  const baselineEfficiency = mean(topHalf.map((r) => r.efficiencyFull)) as number;
  const baselineHR = mean(topHalf.map((r) => r.averageHeartrate)) as number;

  // -------------------------------------------------------------------------
  // Apply race-day adjustments to derive predicted pace
  // -------------------------------------------------------------------------
  const distanceM = distance_miles * METERS_PER_MILE;

  // Reverse-engineer base pace from efficiency: efficiency = 10000 / (pace_min_per_mile * hr)
  const basePaceMinPerMile = 10000 / (baselineEfficiency * baselineHR);
  const basePaceSecPerM = minPerMileToSecPerM(basePaceMinPerMile);

  // Apply course penalties (forward: add them back to get the slower course pace)
  const gapResult = computeGap(basePaceSecPerM, elevation_gain_ft, distanceM, config.gapCoefficient);
  const coursePaceSecPerM = basePaceSecPerM * (1 + gapResult.gapPct);

  const altResult = computeAltitudeAdj(
    coursePaceSecPerM, avg_route_elevation_ft,
    config.altitudeThresholdFt, config.altitudeCoefficient
  );
  const altCoursePace = coursePaceSecPerM / (1 - altResult.altPct);

  let heatCoursePace = altCoursePace;
  let heatPct = 0;
  if (expected_dewpoint_f !== undefined) {
    const heatResult = computeHeatAdj(altCoursePace, expected_dewpoint_f);
    heatCoursePace = altCoursePace / (1 - heatResult.heatPct);
    heatPct = heatResult.heatPct;
  }

  const predictedTotalSec = heatCoursePace * distanceM;
  const conservativeSec = predictedTotalSec * 1.06;
  const aggressiveSec   = predictedTotalSec * 0.94;

  return {
    prediction: {
      finish_time: formatDuration(predictedTotalSec),
      target_pace: formatPace(heatCoursePace),
      target_pace_min_per_mile: round2(secPerMToMinPerMile(heatCoursePace)),
    },
    pace_bands: {
      conservative: { finish_time: formatDuration(conservativeSec), pace: formatPace(conservativeSec / distanceM) },
      target:       { finish_time: formatDuration(predictedTotalSec), pace: formatPace(heatCoursePace) },
      aggressive:   { finish_time: formatDuration(aggressiveSec), pace: formatPace(aggressiveSec / distanceM) },
    },
    baseline: {
      runs_used: topHalf.length,
      avg_efficiency_full: round3(baselineEfficiency),
      avg_hr: Math.round(baselineHR),
      flat_sea_level_cool_pace: formatPace(basePaceSecPerM),
    },
    adjustments: {
      gap_pct:  round1(gapResult.gapPct * 100),
      alt_pct:  round1(altResult.altPct * 100),
      heat_pct: round1(heatPct * 100),
    },
    course: {
      distance_miles,
      elevation_gain_ft,
      avg_route_elevation_ft,
      expected_dewpoint_f: expected_dewpoint_f ?? null,
      expected_temp_f: expected_temp_f ?? null,
    },
  };
}
