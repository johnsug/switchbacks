import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import type { EnrichedActivity, WeekSummary } from "../types.js";
import { listActivitiesFromSource } from "../sources/resolver.js";
import { enrichActivities } from "../enricher.js";
import { metersToMiles, metersToFeet, SECS_PER_DAY, round1, round3 } from "../utils/units.js";
import { mean, linearRegressionSlope } from "../utils/geo.js";

export type EfficiencyMetric = "efficiency_raw" | "efficiency_gap" | "efficiency_full";

export interface GetFitnessTrendParams {
  weeks?: number;
  metric?: EfficiencyMetric;
}

export async function getFitnessTrend(
  params: GetFitnessTrendParams,
  cache: Cache,
  config: Config
): Promise<object> {
  const { weeks = 12, metric = "efficiency_full" } = params;

  const after = Math.floor(Date.now() / 1000) - weeks * 7 * SECS_PER_DAY;
  const rawOrError = await listActivitiesFromSource(config, { type: "running", limit: 200, after });
  if ("error" in rawOrError) return rawOrError;

  const enriched = await enrichActivities(rawOrError, cache, config);

  // -------------------------------------------------------------------------
  // Bucket into calendar weeks
  // -------------------------------------------------------------------------
  const weekMap = new Map<string, EnrichedActivity[]>();

  for (const run of enriched) {
    const label = isoWeekLabel(new Date(run.startDate));
    const bucket = weekMap.get(label) ?? [];
    bucket.push(run);
    weekMap.set(label, bucket);
  }

  const summaries: WeekSummary[] = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, runs]) => buildWeekSummary(label, runs, metric));

  // -------------------------------------------------------------------------
  // Trend stats
  // -------------------------------------------------------------------------
  const metricValues = summaries
    .map((s, i): [number, number] | null => {
      const v = s[metricKey(metric)];
      return typeof v === "number" ? [i, v] : null;
    })
    .filter((p): p is [number, number] => p !== null);

  const slope = linearRegressionSlope(metricValues);
  const nonNull = metricValues.map(([, v]) => v);
  const peakIdx = nonNull.indexOf(Math.max(...nonNull));
  const troughIdx = nonNull.indexOf(Math.min(...nonNull));

  const direction =
    slope === null ? "insufficient data"
    : slope > 0.01  ? "improving"
    : slope < -0.01 ? "declining"
    : "stable";

  return {
    weeks: summaries,
    trend: {
      metric,
      direction,
      slope_per_week: slope !== null ? Math.round(slope * 1000) / 1000 : null,
      peak_week: peakIdx >= 0 ? summaries[peakIdx]?.weekLabel ?? null : null,
      trough_week: troughIdx >= 0 ? summaries[troughIdx]?.weekLabel ?? null : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWeekSummary(
  label: string,
  runs: EnrichedActivity[],
  metric: EfficiencyMetric
): WeekSummary {
  const effRaw  = runs.map((r) => r.efficiencyRaw).filter((v): v is number => v !== null);
  const effGap  = runs.map((r) => r.efficiencyGap).filter((v): v is number => v !== null);
  const effFull = runs.map((r) => r.efficiencyFull).filter((v): v is number => v !== null);
  const vo2s    = runs.map((r) => r.vo2MaxScore).filter((v): v is number => v !== null);
  const temps   = runs.flatMap((r) => r.weather?.tempF != null ? [r.weather.tempF] : []);
  const dews    = runs.flatMap((r) => r.weather?.dewpointF != null ? [r.weather.dewpointF] : []);

  const parts = label.split("-W");
  const weekStart = isoWeekStart(parseInt(parts[0] ?? "2000", 10), parseInt(parts[1] ?? "1", 10));

  return {
    weekLabel: label,
    weekStart,
    nRuns: runs.length,
    distanceMiles: Math.round(runs.reduce((s, r) => s + metersToMiles(r.distanceM), 0) * 10) / 10,
    vertFt: Math.round(runs.reduce((s, r) => s + metersToFeet(r.totalElevationGainM), 0)),
    avgEfficiencyRaw:  nullMap(mean(effRaw),  round3),
    avgEfficiencyGap:  nullMap(mean(effGap),  round3),
    avgEfficiencyFull: nullMap(mean(effFull), round3),
    avgTempF:     nullMap(mean(temps), round1),
    avgDewpointF: nullMap(mean(dews),  round1),
    avgVo2Max:    nullMap(mean(vo2s),  round1),
  };
}

function metricKey(m: EfficiencyMetric): keyof WeekSummary {
  return m === "efficiency_raw" ? "avgEfficiencyRaw"
       : m === "efficiency_gap" ? "avgEfficiencyGap"
       : "avgEfficiencyFull";
}

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isoWeekStart(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  const monday = new Date(startOfWeek1);
  monday.setUTCDate(startOfWeek1.getUTCDate() + (week - 1) * 7);
  return monday.toISOString().split("T")[0]!;
}

function nullMap(v: number | null, fn: (n: number) => number): number | null {
  return v !== null ? fn(v) : null;
}
