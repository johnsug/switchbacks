import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import type { EnrichedActivity } from "../types.js";
import { listActivitiesFromSource } from "../sources/resolver.js";
import { enrichActivities } from "../enricher.js";
import { getDewPointPenalty } from "../adjustments/heat.js";
import { mean } from "../utils/geo.js";
import { SECS_PER_DAY, round3 } from "../utils/units.js";

export interface GetWeatherImpactParams {
  days_back?: number;
}

const DEW_POINT_BUCKETS = [
  { label: "< 50°F (ideal)",    min: -Infinity, max: 50  },
  { label: "50–54°F (good)",    min: 50,        max: 55  },
  { label: "55–59°F (ok)",      min: 55,        max: 60  },
  { label: "60–64°F (warm)",    min: 60,        max: 65  },
  { label: "65–69°F (humid)",   min: 65,        max: 70  },
  { label: "70–74°F (sticky)",  min: 70,        max: 75  },
  { label: ">= 75°F (brutal)",  min: 75,        max: Infinity },
];

export async function getWeatherImpact(
  params: GetWeatherImpactParams,
  cache: Cache,
  config: Config
): Promise<object> {
  const { days_back = 90 } = params;

  const after = Math.floor(Date.now() / 1000) - days_back * SECS_PER_DAY;
  const rawOrError = await listActivitiesFromSource(config, { type: "running", limit: 200, after });
  if ("error" in rawOrError) return rawOrError;

  const enriched = await enrichActivities(rawOrError, cache, config);

  const withData = enriched.filter(
    (r): r is EnrichedActivity & {
      weather: NonNullable<EnrichedActivity["weather"]>;
      efficiencyFull: number;
    } => r.weather !== null && r.efficiencyFull !== null
  );

  if (withData.length < 3) {
    return {
      error: "Not enough runs with both weather and HR data to analyze impact.",
      runs_analyzed: withData.length,
    };
  }

  // -------------------------------------------------------------------------
  // Dew point distribution
  // -------------------------------------------------------------------------
  const distribution = DEW_POINT_BUCKETS.map((bucket) => {
    const inBucket = withData.filter(
      (r) => r.weather.dewpointF >= bucket.min && r.weather.dewpointF < bucket.max
    );
    const efficiencies = inBucket.map((r) => r.efficiencyFull);
    const avgEff = mean(efficiencies);
    const midpoint = isFinite(bucket.min) ? (bucket.min + Math.min(bucket.max, bucket.min + 4)) / 2 : 47;
    return {
      bucket: bucket.label,
      n_runs: inBucket.length,
      avg_efficiency_full: avgEff !== null ? round3(avgEff) : null,
      model_penalty_pct: getDewPointPenalty(midpoint) * 100,
    };
  });

  // -------------------------------------------------------------------------
  // Correlation: dew point vs efficiency
  // -------------------------------------------------------------------------
  const pairs = withData.map((r) => [r.weather.dewpointF, r.efficiencyFull] as [number, number]);
  const correlation = pearsonCorrelation(pairs);
  const slope = linearSlope(pairs);
  const dewPointImpact = slope !== null
    ? Math.round(slope * 10 * 1000) / 1000
    : null;

  const goodDays = withData
    .filter((r) => r.weather.dewpointF < 55)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((r) => r.startDate.split("T")[0]);

  return {
    runs_analyzed: withData.length,
    dew_point_distribution: distribution,
    correlation: {
      dew_point_vs_efficiency: correlation !== null ? Math.round(correlation * 1000) / 1000 : null,
      interpretation: correlationInterpretation(correlation),
    },
    personal_impact: {
      efficiency_change_per_10f_dew_point: dewPointImpact,
      description: dewPointImpact !== null
        ? `Your efficiency changes by ${dewPointImpact > 0 ? "+" : ""}${dewPointImpact} per 10°F increase in dew point`
        : null,
    },
    favorable_days: goodDays.length > 0
      ? { count: goodDays.length, sample_dates: goodDays.slice(-5) }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function pearsonCorrelation(pairs: Array<[number, number]>): number | null {
  const n = pairs.length;
  if (n < 3) return null;

  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : num / denom;
}

function linearSlope(pairs: Array<[number, number]>): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  const sumX  = pairs.reduce((s, [x]) => s + x, 0);
  const sumY  = pairs.reduce((s, [, y]) => s + y, 0);
  const sumXY = pairs.reduce((s, [x, y]) => s + x * y, 0);
  const sumX2 = pairs.reduce((s, [x]) => s + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function correlationInterpretation(r: number | null): string {
  if (r === null) return "insufficient data";
  const abs = Math.abs(r);
  const dir = r < 0 ? "negative" : "positive";
  if (abs > 0.7) return `Strong ${dir} correlation`;
  if (abs > 0.4) return `Moderate ${dir} correlation`;
  if (abs > 0.2) return `Weak ${dir} correlation`;
  return "No meaningful correlation";
}
