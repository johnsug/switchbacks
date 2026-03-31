/**
 * Interval detection from running activity time-series data.
 *
 * Supports both Strava streams (velocity_smooth, heartrate, distance, time, altitude)
 * and Garmin GPX trackpoints (via parseGpxTrackpoints).
 */

import { haversineDistanceM } from "./geo.js";
import type { GpxTrackpoint } from "./gpx.js";

// ---------------------------------------------------------------------------
// Shared sample type
// ---------------------------------------------------------------------------

export interface ActivitySample {
  timeS: number;       // Unix seconds
  distanceM: number;   // cumulative distance from start
  paceSecPerM: number; // instantaneous (smoothed) pace
  hr: number | null;
  elevationM: number | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface IntervalRep {
  repNumber: number;
  startTimeS: number;
  endTimeS: number;
  durationS: number;
  distanceM: number;
  avgPaceSecPerM: number;
  /** Fastest pace recorded within this rep */
  maxPaceSecPerM: number;
  avgHr: number | null;
  elevationGainM: number | null;
  /** How much faster than baseline easy pace (0.12 = 12% faster) */
  pctFasterThanBaseline: number;
}

export interface RestPeriod {
  /** Which rep this rest follows (1-based) */
  afterRep: number;
  durationS: number;
  avgPaceSecPerM: number;
}

export interface DetectedIntervals {
  isIntervalSession: boolean;
  reps: IntervalRep[];
  rests: RestPeriod[];
  /** Median recovery/easy pace used as the baseline */
  baselinePaceSecPerM: number;
  /** The pace threshold used to classify "fast" samples */
  fastThresholdSecPerM: number;
  warmupDurationS: number;
  cooldownDurationS: number;
  summary: {
    repCount: number;
    avgRepPaceSecPerM: number;
    avgRepDurationS: number;
    avgRepDistanceM: number;
    avgRestDurationS: number;
    avgHr: number | null;
    /** Coefficient of variation of rep paces, as a pct (lower = more consistent) */
    repPaceConsistencyPct: number;
  };
}

// ---------------------------------------------------------------------------
// Detection options
// ---------------------------------------------------------------------------

export interface DetectIntervalsOptions {
  /** Fraction faster than baseline to be classified as a rep (default 0.12 = 12%) */
  fastFraction?: number;
  /** Min rep duration in seconds (default 30) */
  minRepDurationS?: number;
  /** Max rep duration in seconds (default 1200 = 20 min) */
  maxRepDurationS?: number;
  /** Min rep distance in meters (default 100) */
  minRepDistanceM?: number;
  /** Min number of reps to be declared an interval session (default 2) */
  minReps?: number;
  /** Gap in seconds between fast segments that is bridged into one rep (default 10) */
  mergeGapS?: number;
}

// ---------------------------------------------------------------------------
// Convert Garmin GPX trackpoints → ActivitySample[]
// ---------------------------------------------------------------------------

/**
 * Convert GPX trackpoints to ActivitySample[], deriving pace from GPS distance/time.
 * Uses a sliding window (smoothingWindowS) to smooth noisy instantaneous pace.
 */
export function trackpointsToSamples(
  points: GpxTrackpoint[],
  smoothingWindowS = 15
): ActivitySample[] {
  if (points.length < 2) return [];

  // First pass: compute raw cumulative distance and per-point pace
  const raw: Array<{ timeS: number; cumDistM: number; rawPace: number; hr: number | null; elevationM: number | null }> = [];
  let cumDist = 0;

  raw.push({ timeS: points[0]!.timeS, cumDistM: 0, rawPace: 0, hr: points[0]!.hr, elevationM: points[0]!.elevationM });

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const dt = curr.timeS - prev.timeS;
    const dd = haversineDistanceM(prev.lat, prev.lon, curr.lat, curr.lon);
    cumDist += dd;
    const pace = dt > 0 && dd > 0 ? dt / dd : 0; // sec/meter
    raw.push({ timeS: curr.timeS, cumDistM: cumDist, rawPace: pace, hr: curr.hr, elevationM: curr.elevationM });
  }

  // Second pass: smooth pace with a backward-looking sliding window
  const samples: ActivitySample[] = [];
  for (let i = 0; i < raw.length; i++) {
    const windowStart = raw[i]!.timeS - smoothingWindowS;
    const windowSamples = raw.filter((r) => r.timeS >= windowStart && r.timeS <= raw[i]!.timeS && r.rawPace > 0);
    const smoothedPace =
      windowSamples.length > 0
        ? windowSamples.reduce((s, r) => s + r.rawPace, 0) / windowSamples.length
        : raw[i]!.rawPace;

    samples.push({
      timeS: raw[i]!.timeS,
      distanceM: raw[i]!.cumDistM,
      paceSecPerM: smoothedPace,
      hr: raw[i]!.hr,
      elevationM: raw[i]!.elevationM,
    });
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Convert Strava streams → ActivitySample[]
// ---------------------------------------------------------------------------

/**
 * Convert Strava stream data (keyed by stream type) to ActivitySample[].
 * Expected keys: "time", "distance", "velocity_smooth" (required),
 * "heartrate" and "altitude" (optional).
 *
 * velocity_smooth is in m/s — converted to sec/m (pace) as 1/v.
 */
export function stravaStreamsToSamples(
  streams: Record<string, number[]>,
  activityStartTimeS: number
): ActivitySample[] {
  const times = streams["time"];
  const distances = streams["distance"];
  const velocities = streams["velocity_smooth"];

  if (!times || !distances || !velocities) return [];
  if (times.length !== distances.length || times.length !== velocities.length) return [];

  const hrs = streams["heartrate"] ?? null;
  const alts = streams["altitude"] ?? null;

  const samples: ActivitySample[] = [];

  for (let i = 0; i < times.length; i++) {
    const v = velocities[i]!;
    const paceSecPerM = v > 0.1 ? 1 / v : 0; // avoid div-by-zero; 0 = stationary
    samples.push({
      timeS: activityStartTimeS + times[i]!,
      distanceM: distances[i]!,
      paceSecPerM,
      hr: hrs ? (hrs[i] ?? null) : null,
      elevationM: alts ? (alts[i] ?? null) : null,
    });
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Core detection algorithm
// ---------------------------------------------------------------------------

/**
 * Detect intervals from a run's time-series samples.
 * Returns null if the run has no usable samples or fewer than minReps reps.
 */
export function detectIntervals(
  samples: ActivitySample[],
  opts: DetectIntervalsOptions = {}
): DetectedIntervals | null {
  const {
    fastFraction    = 0.12,
    minRepDurationS = 30,
    maxRepDurationS = 1200,
    minRepDistanceM = 100,
    minReps         = 2,
    mergeGapS       = 10,
  } = opts;

  // Filter to samples with valid pace
  const valid = samples.filter((s) => s.paceSecPerM > 0);
  if (valid.length < 10) return null;

  // Baseline: 40th percentile pace (captures easy/recovery pace, not sprinting)
  const sorted = [...valid].sort((a, b) => a.paceSecPerM - b.paceSecPerM);
  // 40th percentile = faster than 60% of samples → index into sorted array
  const p40idx = Math.floor(sorted.length * 0.60);
  const baselinePaceSecPerM = sorted[p40idx]!.paceSecPerM;

  // Fast threshold: must be at least fastFraction faster (lower sec/m = faster)
  const fastThresholdSecPerM = baselinePaceSecPerM * (1 - fastFraction);

  // Label each sample: true = fast
  const isFast = valid.map((s) => s.paceSecPerM <= fastThresholdSecPerM && s.paceSecPerM > 0);

  // Group consecutive fast samples into segments, bridging gaps ≤ mergeGapS
  type Segment = { startIdx: number; endIdx: number };
  const segments: Segment[] = [];
  let inSeg = false;
  let segStart = 0;

  for (let i = 0; i < valid.length; i++) {
    if (isFast[i] && !inSeg) {
      inSeg = true;
      segStart = i;
    } else if (!isFast[i] && inSeg) {
      // Check if the gap to the next fast sample is within mergeGapS
      let gapEnd = i;
      while (gapEnd < valid.length && !isFast[gapEnd]) gapEnd++;
      const gapDuration =
        gapEnd < valid.length
          ? valid[gapEnd]!.timeS - valid[i]!.timeS
          : Infinity;

      if (gapDuration <= mergeGapS && gapEnd < valid.length) {
        // Bridge the gap — continue the segment
        i = gapEnd - 1;
      } else {
        segments.push({ startIdx: segStart, endIdx: i - 1 });
        inSeg = false;
      }
    }
  }
  if (inSeg) segments.push({ startIdx: segStart, endIdx: valid.length - 1 });

  // Filter segments by duration and distance
  const repSegments = segments.filter((seg) => {
    const durationS = valid[seg.endIdx]!.timeS - valid[seg.startIdx]!.timeS;
    const distanceM = valid[seg.endIdx]!.distanceM - valid[seg.startIdx]!.distanceM;
    return (
      durationS >= minRepDurationS &&
      durationS <= maxRepDurationS &&
      distanceM >= minRepDistanceM
    );
  });

  if (repSegments.length < minReps) {
    return {
      isIntervalSession: false,
      reps: [],
      rests: [],
      baselinePaceSecPerM,
      fastThresholdSecPerM,
      warmupDurationS: 0,
      cooldownDurationS: 0,
      summary: {
        repCount: 0,
        avgRepPaceSecPerM: 0,
        avgRepDurationS: 0,
        avgRepDistanceM: 0,
        avgRestDurationS: 0,
        avgHr: null,
        repPaceConsistencyPct: 0,
      },
    };
  }

  // Build IntervalRep objects
  const reps: IntervalRep[] = repSegments.map((seg, idx) => {
    const segSamples = valid.slice(seg.startIdx, seg.endIdx + 1);
    const durationS = segSamples[segSamples.length - 1]!.timeS - segSamples[0]!.timeS;
    const distanceM = segSamples[segSamples.length - 1]!.distanceM - segSamples[0]!.distanceM;
    const avgPaceSecPerM = durationS > 0 && distanceM > 0 ? durationS / distanceM : 0;
    const maxPaceSecPerM = Math.min(...segSamples.map((s) => s.paceSecPerM).filter((p) => p > 0));

    const hrValues = segSamples.map((s) => s.hr).filter((h): h is number => h !== null);
    const avgHr = hrValues.length > 0 ? hrValues.reduce((a, b) => a + b, 0) / hrValues.length : null;

    const eleValues = segSamples.map((s) => s.elevationM).filter((e): e is number => e !== null);
    let elevationGainM: number | null = null;
    if (eleValues.length >= 2) {
      let gain = 0;
      for (let i = 1; i < eleValues.length; i++) {
        const diff = eleValues[i]! - eleValues[i - 1]!;
        if (diff > 0) gain += diff;
      }
      elevationGainM = gain;
    }

    const pctFasterThanBaseline =
      baselinePaceSecPerM > 0 ? (baselinePaceSecPerM - avgPaceSecPerM) / baselinePaceSecPerM : 0;

    return {
      repNumber: idx + 1,
      startTimeS: segSamples[0]!.timeS,
      endTimeS: segSamples[segSamples.length - 1]!.timeS,
      durationS,
      distanceM,
      avgPaceSecPerM,
      maxPaceSecPerM,
      avgHr: avgHr !== null ? Math.round(avgHr) : null,
      elevationGainM: elevationGainM !== null ? Math.round(elevationGainM * 10) / 10 : null,
      pctFasterThanBaseline: Math.round(pctFasterThanBaseline * 1000) / 1000,
    };
  });

  // Build RestPeriod objects (gaps between reps)
  const rests: RestPeriod[] = [];
  for (let i = 0; i < reps.length - 1; i++) {
    const repEnd = reps[i]!.endTimeS;
    const nextStart = reps[i + 1]!.startTimeS;
    const restDuration = nextStart - repEnd;
    if (restDuration <= 0) continue;

    const restSamples = valid.filter(
      (s) => s.timeS > repEnd && s.timeS < nextStart && s.paceSecPerM > 0
    );
    const avgPace =
      restSamples.length > 0
        ? restSamples.reduce((s, r) => s + r.paceSecPerM, 0) / restSamples.length
        : baselinePaceSecPerM;

    rests.push({ afterRep: i + 1, durationS: restDuration, avgPaceSecPerM: avgPace });
  }

  // Warmup and cooldown
  const firstRepStart = reps[0]!.startTimeS;
  const lastRepEnd = reps[reps.length - 1]!.endTimeS;
  const warmupDurationS = firstRepStart - valid[0]!.timeS;
  const cooldownDurationS = valid[valid.length - 1]!.timeS - lastRepEnd;

  // Summary stats
  const avgRepPaceSecPerM =
    reps.reduce((s, r) => s + r.avgPaceSecPerM, 0) / reps.length;
  const avgRepDurationS =
    reps.reduce((s, r) => s + r.durationS, 0) / reps.length;
  const avgRepDistanceM =
    reps.reduce((s, r) => s + r.distanceM, 0) / reps.length;
  const avgRestDurationS =
    rests.length > 0 ? rests.reduce((s, r) => s + r.durationS, 0) / rests.length : 0;

  const allRepHrs = reps.map((r) => r.avgHr).filter((h): h is number => h !== null);
  const avgHr = allRepHrs.length > 0 ? Math.round(allRepHrs.reduce((a, b) => a + b, 0) / allRepHrs.length) : null;

  // Coefficient of variation for rep paces (as a percentage; lower = more consistent)
  const repPaces = reps.map((r) => r.avgPaceSecPerM);
  const meanPace = repPaces.reduce((a, b) => a + b, 0) / repPaces.length;
  const variance = repPaces.reduce((s, p) => s + (p - meanPace) ** 2, 0) / repPaces.length;
  const stdDev = Math.sqrt(variance);
  const repPaceConsistencyPct = meanPace > 0 ? Math.round((stdDev / meanPace) * 100 * 10) / 10 : 0;

  return {
    isIntervalSession: true,
    reps,
    rests,
    baselinePaceSecPerM,
    fastThresholdSecPerM,
    warmupDurationS: Math.round(warmupDurationS),
    cooldownDurationS: Math.round(cooldownDurationS),
    summary: {
      repCount: reps.length,
      avgRepPaceSecPerM,
      avgRepDurationS: Math.round(avgRepDurationS),
      avgRepDistanceM: Math.round(avgRepDistanceM),
      avgRestDurationS: Math.round(avgRestDurationS),
      avgHr,
      repPaceConsistencyPct,
    },
  };
}
