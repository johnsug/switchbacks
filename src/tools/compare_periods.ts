import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import type { EnrichedActivity } from "../types.js";
import { listActivitiesFromSource } from "../sources/resolver.js";
import { enrichActivities } from "../enricher.js";
import { metersToMiles, metersToFeet, METERS_PER_MILE, SECS_PER_DAY, round0, round1, round3 } from "../utils/units.js";
import { mean } from "../utils/geo.js";

export interface ComparePeriodParams {
  period_a_start: string; // YYYY-MM-DD
  period_a_end: string;
  period_b_start: string;
  period_b_end: string;
  min_distance_miles?: number;
}

export async function comparePeriods(
  params: ComparePeriodParams,
  cache: Cache,
  config: Config
): Promise<object> {
  const {
    period_a_start, period_a_end,
    period_b_start, period_b_end,
    min_distance_miles = 3.0,
  } = params;

  const after  = Math.floor(new Date(period_a_start).getTime() / 1000);
  const before = Math.floor(new Date(period_b_end).getTime() / 1000) + SECS_PER_DAY;

  const rawOrError = await listActivitiesFromSource(config, {
    type: "running", limit: 200, after, before,
  });
  if ("error" in rawOrError) return rawOrError;

  const enriched = await enrichActivities(rawOrError, cache, config);

  const minDistM = min_distance_miles * METERS_PER_MILE;

  const periodA = enriched.filter(
    (r) => r.startDate >= period_a_start && r.startDate <= period_a_end + "T23:59:59Z" &&
            r.distanceM >= minDistM
  );
  const periodB = enriched.filter(
    (r) => r.startDate >= period_b_start && r.startDate <= period_b_end + "T23:59:59Z" &&
            r.distanceM >= minDistM
  );

  const summaryA = periodSummary("Period A", period_a_start, period_a_end, periodA);
  const summaryB = periodSummary("Period B", period_b_start, period_b_end, periodB);

  let delta: object | null = null;
  if (summaryA.avg_efficiency_full !== null && summaryB.avg_efficiency_full !== null) {
    const pctChange = ((summaryB.avg_efficiency_full - summaryA.avg_efficiency_full) /
                        summaryA.avg_efficiency_full) * 100;
    const direction = pctChange >= 0 ? "more" : "less";
    delta = {
      efficiency_change_pct: Math.round(pctChange * 10) / 10,
      direction,
      description: `You are ${Math.abs(Math.round(pctChange * 10) / 10)}% ${direction} aerobically efficient in Period B vs Period A.`,
    };
  }

  return {
    period_a: summaryA,
    period_b: summaryB,
    delta,
    confidence: buildConfidence(periodA.length, periodB.length),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function periodSummary(
  label: string,
  start: string,
  end: string,
  runs: EnrichedActivity[]
): {
  label: string; start: string; end: string; n_runs: number;
  total_miles: number; total_vert_ft: number;
  avg_efficiency_raw: number | null;
  avg_efficiency_full: number | null;
  avg_temp_f: number | null;
  avg_dewpoint_f: number | null;
  avg_gain_per_mile: number | null;
} {
  const effRaw  = runs.map((r) => r.efficiencyRaw).filter((v): v is number => v !== null);
  const effFull = runs.map((r) => r.efficiencyFull).filter((v): v is number => v !== null);
  const temps   = runs.flatMap((r) => r.weather?.tempF != null ? [r.weather.tempF] : []);
  const dews    = runs.flatMap((r) => r.weather?.dewpointF != null ? [r.weather.dewpointF] : []);
  const totalMiles = runs.reduce((s, r) => s + metersToMiles(r.distanceM), 0);
  const totalVertFt = runs.reduce((s, r) => s + metersToFeet(r.totalElevationGainM), 0);
  const gainPerMile = totalMiles > 0 ? totalVertFt / totalMiles : null;

  return {
    label,
    start,
    end,
    n_runs: runs.length,
    total_miles: round1(totalMiles),
    total_vert_ft: round0(totalVertFt),
    avg_efficiency_raw:  nullMap(mean(effRaw),  round3),
    avg_efficiency_full: nullMap(mean(effFull), round3),
    avg_temp_f:     nullMap(mean(temps), round1),
    avg_dewpoint_f: nullMap(mean(dews),  round1),
    avg_gain_per_mile: gainPerMile !== null ? round0(gainPerMile) : null,
  };
}

function buildConfidence(nA: number, nB: number): string {
  if (nA === 0 || nB === 0) return "One or both periods have no qualifying runs.";
  if (nA < 3 || nB < 3) return "Small sample size — treat comparison with caution.";
  if (nA < 6 || nB < 6) return "Moderate sample size — directionally useful.";
  return "Good sample size.";
}

function nullMap(v: number | null, fn: (n: number) => number): number | null {
  return v !== null ? fn(v) : null;
}
