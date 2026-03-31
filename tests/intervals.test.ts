import { describe, it, expect } from "vitest";
import {
  detectIntervals,
  trackpointsToSamples,
  stravaStreamsToSamples,
  type ActivitySample,
} from "../src/utils/intervals.js";
import type { GpxTrackpoint } from "../src/utils/gpx.js";

// ---------------------------------------------------------------------------
// Helpers for building synthetic data
// ---------------------------------------------------------------------------

/**
 * Build ActivitySample[] with a pattern: N seconds easy, N seconds fast, repeated.
 * pace in sec/m; distanceM is computed from pace × dt with 1s sampling.
 */
function buildIntervalSamples(
  pattern: Array<{ durationS: number; paceSecPerM: number; hr?: number }>,
  startTimeS = 1_700_000_000
): ActivitySample[] {
  const samples: ActivitySample[] = [];
  let t = startTimeS;
  let distM = 0;

  for (const segment of pattern) {
    for (let i = 0; i < segment.durationS; i++) {
      const dd = 1 / segment.paceSecPerM; // meters covered in 1 second
      distM += dd;
      samples.push({
        timeS: t++,
        distanceM: distM,
        paceSecPerM: segment.paceSecPerM,
        hr: segment.hr ?? null,
        elevationM: null,
      });
    }
  }

  return samples;
}

// ---------------------------------------------------------------------------
// detectIntervals
// ---------------------------------------------------------------------------

describe("detectIntervals", () => {
  it("returns null for fewer than 10 valid samples", () => {
    const samples: ActivitySample[] = Array.from({ length: 5 }, (_, i) => ({
      timeS: i,
      distanceM: i * 3,
      paceSecPerM: 0.35,
      hr: null,
      elevationM: null,
    }));
    expect(detectIntervals(samples)).toBeNull();
  });

  it("returns isIntervalSession=false for a steady-state run", () => {
    // All samples at the same pace — nothing qualifies as fast
    const samples = buildIntervalSamples([{ durationS: 600, paceSecPerM: 0.35 }]);
    const result = detectIntervals(samples);
    expect(result).not.toBeNull();
    expect(result!.isIntervalSession).toBe(false);
  });

  it("detects a classic 4×400m workout", () => {
    // Warm-up 5 min easy, 4 reps of 90s fast / 90s easy, cool-down 5 min
    const easy = 0.38;     // ~10:08/mi
    const fast = 0.26;     // ~7:00/mi (32% faster — well above threshold)
    const samples = buildIntervalSamples([
      { durationS: 300, paceSecPerM: easy },
      { durationS: 90,  paceSecPerM: fast },
      { durationS: 90,  paceSecPerM: easy },
      { durationS: 90,  paceSecPerM: fast },
      { durationS: 90,  paceSecPerM: easy },
      { durationS: 90,  paceSecPerM: fast },
      { durationS: 90,  paceSecPerM: easy },
      { durationS: 90,  paceSecPerM: fast },
      { durationS: 300, paceSecPerM: easy },
    ]);

    const result = detectIntervals(samples);
    expect(result).not.toBeNull();
    expect(result!.isIntervalSession).toBe(true);
    expect(result!.reps).toHaveLength(4);
  });

  it("numbers reps starting at 1", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples)!;
    expect(result.reps[0]!.repNumber).toBe(1);
    expect(result.reps[1]!.repNumber).toBe(2);
  });

  it("rep duration is correct", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 90,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 90,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples)!;
    // 90 samples × 1s = 89s duration (endIdx - startIdx)
    expect(result.reps[0]!.durationS).toBeCloseTo(89, 0);
  });

  it("rep avg pace matches the fast segment pace", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 120, paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 120, paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples)!;
    // avgPaceSecPerM = durationS / distanceM ≈ fast pace
    expect(result.reps[0]!.avgPaceSecPerM).toBeCloseTo(fast, 2);
  });

  it("computes warmup and cooldown durations", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 300, paceSecPerM: easy },   // warmup
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 300, paceSecPerM: easy },   // cooldown
    ]);
    const result = detectIntervals(samples)!;
    expect(result.warmupDurationS).toBeCloseTo(300, -1);
    expect(result.cooldownDurationS).toBeCloseTo(300, -1);
  });

  it("generates rest periods between reps", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 90,  paceSecPerM: easy },  // rest 1
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 90,  paceSecPerM: easy },  // rest 2
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples)!;
    expect(result.rests).toHaveLength(2);
    expect(result.rests[0]!.afterRep).toBe(1);
    expect(result.rests[1]!.afterRep).toBe(2);
  });

  it("short segments below minRepDurationS are not counted as reps", () => {
    const easy = 0.38;
    const fast = 0.26;
    // 20s fast < default 30s minimum
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 20,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 20,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples);
    expect(result!.isIntervalSession).toBe(false);
    expect(result!.reps).toHaveLength(0);
  });

  it("respects minReps option", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    // Only 1 rep found — normally isIntervalSession=false (minReps=2 default)
    const result = detectIntervals(samples, { minReps: 1 });
    expect(result!.isIntervalSession).toBe(true);
    expect(result!.reps).toHaveLength(1);
  });

  it("pctFasterThanBaseline is positive for fast reps", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
      { durationS: 60,  paceSecPerM: fast },
      { durationS: 60,  paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples)!;
    for (const rep of result.reps) {
      expect(rep.pctFasterThanBaseline).toBeGreaterThan(0);
    }
  });

  it("includes summary with repCount", () => {
    const easy = 0.38;
    const fast = 0.26;
    const samples = buildIntervalSamples([
      { durationS: 60, paceSecPerM: easy },
      { durationS: 60, paceSecPerM: fast },
      { durationS: 60, paceSecPerM: easy },
      { durationS: 60, paceSecPerM: fast },
      { durationS: 60, paceSecPerM: easy },
      { durationS: 60, paceSecPerM: fast },
      { durationS: 60, paceSecPerM: easy },
    ]);
    const result = detectIntervals(samples)!;
    expect(result.summary.repCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// stravaStreamsToSamples
// ---------------------------------------------------------------------------

describe("stravaStreamsToSamples", () => {
  it("returns empty array for missing required keys", () => {
    expect(stravaStreamsToSamples({}, 0)).toHaveLength(0);
    expect(stravaStreamsToSamples({ time: [0, 1] }, 0)).toHaveLength(0);
  });

  it("converts velocity_smooth (m/s) to paceSecPerM correctly", () => {
    const streams = {
      time:             [0, 1, 2],
      distance:         [0, 3, 6],
      velocity_smooth:  [3, 3, 3],  // 3 m/s = 0.333 sec/m
    };
    const samples = stravaStreamsToSamples(streams, 1_000_000);
    expect(samples).toHaveLength(3);
    expect(samples[0]!.paceSecPerM).toBeCloseTo(1 / 3, 4);
  });

  it("treats near-zero velocity as stationary (pace=0)", () => {
    const streams = {
      time:             [0, 1],
      distance:         [0, 0],
      velocity_smooth:  [0, 0.05],  // below 0.1 threshold
    };
    const samples = stravaStreamsToSamples(streams, 0);
    expect(samples[0]!.paceSecPerM).toBe(0);
    expect(samples[1]!.paceSecPerM).toBe(0);
  });

  it("offsets time by activityStartTimeS", () => {
    const streams = {
      time:            [10, 20],
      distance:        [30, 60],
      velocity_smooth: [3, 3],
    };
    const start = 1_700_000_000;
    const samples = stravaStreamsToSamples(streams, start);
    expect(samples[0]!.timeS).toBe(start + 10);
    expect(samples[1]!.timeS).toBe(start + 20);
  });

  it("extracts heartrate and altitude when present", () => {
    const streams = {
      time:            [0, 1],
      distance:        [0, 3],
      velocity_smooth: [3, 3],
      heartrate:       [140, 145],
      altitude:        [1600, 1602],
    };
    const samples = stravaStreamsToSamples(streams, 0);
    expect(samples[0]!.hr).toBe(140);
    expect(samples[0]!.elevationM).toBe(1600);
    expect(samples[1]!.hr).toBe(145);
  });

  it("returns null hr/elevation when streams are absent", () => {
    const streams = {
      time:            [0, 1],
      distance:        [0, 3],
      velocity_smooth: [3, 3],
    };
    const samples = stravaStreamsToSamples(streams, 0);
    expect(samples[0]!.hr).toBeNull();
    expect(samples[0]!.elevationM).toBeNull();
  });

  it("returns empty array when stream lengths do not match", () => {
    const streams = {
      time:            [0, 1, 2],
      distance:        [0, 3],      // wrong length
      velocity_smooth: [3, 3, 3],
    };
    expect(stravaStreamsToSamples(streams, 0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// trackpointsToSamples
// ---------------------------------------------------------------------------

describe("trackpointsToSamples", () => {
  it("returns empty array for fewer than 2 trackpoints", () => {
    const single: GpxTrackpoint = { timeS: 0, lat: 39.95, lon: -105.17, elevationM: 1600, hr: null, cadence: null };
    expect(trackpointsToSamples([])).toHaveLength(0);
    expect(trackpointsToSamples([single])).toHaveLength(0);
  });

  it("returns one sample per trackpoint", () => {
    const trkpts: GpxTrackpoint[] = [
      { timeS: 1000, lat: 39.950, lon: -105.170, elevationM: 1600, hr: 140, cadence: 85 },
      { timeS: 1010, lat: 39.951, lon: -105.170, elevationM: 1601, hr: 142, cadence: 86 },
      { timeS: 1020, lat: 39.952, lon: -105.170, elevationM: 1602, hr: 144, cadence: 87 },
    ];
    const samples = trackpointsToSamples(trkpts, 0);
    expect(samples).toHaveLength(3);
  });

  it("cumulative distance is monotonically increasing", () => {
    const trkpts: GpxTrackpoint[] = [
      { timeS: 1000, lat: 39.950, lon: -105.170, elevationM: null, hr: null, cadence: null },
      { timeS: 1010, lat: 39.951, lon: -105.170, elevationM: null, hr: null, cadence: null },
      { timeS: 1020, lat: 39.952, lon: -105.170, elevationM: null, hr: null, cadence: null },
    ];
    const samples = trackpointsToSamples(trkpts, 0);
    expect(samples[0]!.distanceM).toBe(0);
    expect(samples[1]!.distanceM).toBeGreaterThan(0);
    expect(samples[2]!.distanceM).toBeGreaterThan(samples[1]!.distanceM);
  });

  it("preserves timestamps from trackpoints", () => {
    const trkpts: GpxTrackpoint[] = [
      { timeS: 1000, lat: 39.950, lon: -105.170, elevationM: null, hr: null, cadence: null },
      { timeS: 1010, lat: 39.951, lon: -105.170, elevationM: null, hr: null, cadence: null },
    ];
    const samples = trackpointsToSamples(trkpts, 0);
    expect(samples[0]!.timeS).toBe(1000);
    expect(samples[1]!.timeS).toBe(1010);
  });

  it("carries through HR from trackpoints", () => {
    const trkpts: GpxTrackpoint[] = [
      { timeS: 1000, lat: 39.950, lon: -105.170, elevationM: null, hr: 150, cadence: null },
      { timeS: 1010, lat: 39.951, lon: -105.170, elevationM: null, hr: 155, cadence: null },
    ];
    const samples = trackpointsToSamples(trkpts, 0);
    expect(samples[0]!.hr).toBe(150);
    expect(samples[1]!.hr).toBe(155);
  });
});
