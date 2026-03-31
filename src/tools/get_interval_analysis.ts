/**
 * get_interval_analysis — Detect and compare interval reps within a run.
 *
 * Fetches time-series data (Strava streams or Garmin GPX), runs the
 * interval detection algorithm, and returns per-rep stats with comparisons.
 */

import type { Config } from "../config.js";
import { getActivityFromSource, fetchActivitySamples } from "../sources/resolver.js";
import { detectIntervals } from "../utils/intervals.js";
import { formatPace, formatDuration, metersToMiles } from "../utils/units.js";

export interface GetIntervalAnalysisParams {
  activity_id: string;
  fast_fraction?: number;
  min_rep_duration_s?: number;
  min_rep_distance_m?: number;
}

function formatMinSec(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function getIntervalAnalysis(
  params: GetIntervalAnalysisParams,
  config: Config
): Promise<unknown> {
  // Fetch the activity summary to get start time and basic metadata
  const activity = await getActivityFromSource(config, params.activity_id);
  if ("error" in activity) {
    return { error: activity.error };
  }

  const startTimeS = activity.startDate ? Date.parse(activity.startDate) / 1000 : 0;

  // Fetch time-series samples
  const samples = await fetchActivitySamples(config, params.activity_id, startTimeS);
  if (!samples || samples.length < 10) {
    return {
      error: "No time-series data available for this activity. GPS streams are required for interval detection.",
      activityId: params.activity_id,
      activityName: activity.name,
    };
  }

  // Run detection
  const detected = detectIntervals(samples, {
    fastFraction:    params.fast_fraction    ?? 0.12,
    minRepDurationS: params.min_rep_duration_s ?? 30,
    minRepDistanceM: params.min_rep_distance_m ?? 100,
  });

  if (!detected) {
    return {
      isIntervalSession: false,
      activityId: params.activity_id,
      activityName: activity.name,
      message: "Could not analyze this activity — insufficient data points.",
    };
  }

  if (!detected.isIntervalSession) {
    return {
      isIntervalSession: false,
      activityId: params.activity_id,
      activityName: activity.name,
      baselinePace: formatPace(detected.baselinePaceSecPerM),
      message: "No interval structure detected. This appears to be a steady-state or easy run.",
    };
  }

  // Format reps for output
  const reps = detected.reps.map((rep) => ({
    rep: rep.repNumber,
    duration: formatMinSec(rep.durationS),
    distance: `${metersToMiles(rep.distanceM).toFixed(2)} mi`,
    avgPace: formatPace(rep.avgPaceSecPerM),
    maxPace: formatPace(rep.maxPaceSecPerM),
    avgHr: rep.avgHr !== null ? `${rep.avgHr} bpm` : null,
    elevationGain: rep.elevationGainM !== null ? `${rep.elevationGainM} m` : null,
    fasterThanBaseline: `${(rep.pctFasterThanBaseline * 100).toFixed(1)}%`,
  }));

  // Rep-to-rep comparison: flag significant drift (>5% pace change between consecutive reps)
  const repComparisons: Array<{ fromRep: number; toRep: number; paceDriftPct: number; note: string }> = [];
  for (let i = 1; i < detected.reps.length; i++) {
    const prev = detected.reps[i - 1]!;
    const curr = detected.reps[i]!;
    // Pace is in sec/m — higher = slower. Drift: positive = slowing down
    const drift = (curr.avgPaceSecPerM - prev.avgPaceSecPerM) / prev.avgPaceSecPerM;
    const driftPct = Math.round(drift * 1000) / 10; // e.g. 3.2 means 3.2% slower
    if (Math.abs(driftPct) >= 2) {
      repComparisons.push({
        fromRep: i,
        toRep: i + 1,
        paceDriftPct: driftPct,
        note: driftPct > 0 ? "slowing" : "faster",
      });
    }
  }

  const rests = detected.rests.map((rest) => ({
    afterRep: rest.afterRep,
    duration: formatMinSec(rest.durationS),
    pace: formatPace(rest.avgPaceSecPerM),
  }));

  return {
    isIntervalSession: true,
    activityId: params.activity_id,
    activityName: activity.name,
    baselinePace: formatPace(detected.baselinePaceSecPerM),
    fastThreshold: formatPace(detected.fastThresholdSecPerM),
    warmup: formatDuration(detected.warmupDurationS),
    cooldown: formatDuration(detected.cooldownDurationS),
    summary: {
      repCount: detected.summary.repCount,
      avgRepPace: formatPace(detected.summary.avgRepPaceSecPerM),
      avgRepDuration: formatMinSec(detected.summary.avgRepDurationS),
      avgRepDistance: `${metersToMiles(detected.summary.avgRepDistanceM).toFixed(2)} mi`,
      avgRestDuration: formatMinSec(detected.summary.avgRestDurationS),
      avgHr: detected.summary.avgHr !== null ? `${detected.summary.avgHr} bpm` : null,
      repPaceConsistencyPct: detected.summary.repPaceConsistencyPct,
      consistencyNote:
        detected.summary.repPaceConsistencyPct < 3   ? "Very consistent — excellent pacing control"
        : detected.summary.repPaceConsistencyPct < 6 ? "Consistent"
        : detected.summary.repPaceConsistencyPct < 10 ? "Moderate variation — pacing drifted across reps"
        : "High variation — significant fade or uneven effort",
    },
    reps,
    rests,
    repComparisons,
  };
}
