import { describe, it, expect } from "vitest";
import {
  secPerMToMinPerMile,
  minPerMileToSecPerM,
  secPerMToMinPerKm,
  metersToFeet,
  feetToMeters,
  metersToMiles,
  formatPace,
  formatDuration,
  METERS_PER_MILE,
} from "../src/utils/units.js";
import { computeGap } from "../src/adjustments/gap.js";
import { computeAltitudeAdj } from "../src/adjustments/altitude.js";
import { getDewPointPenalty, computeHeatAdj } from "../src/adjustments/heat.js";
import { computeEfficiency, computeWaterfall } from "../src/adjustments/efficiency.js";

// ---------------------------------------------------------------------------
// units.ts
// ---------------------------------------------------------------------------

describe("units", () => {
  describe("secPerMToMinPerMile", () => {
    it("converts 0.3 sec/m to ~8.047 min/mile", () => {
      expect(secPerMToMinPerMile(0.3)).toBeCloseTo(8.047, 2);
    });

    it("converts 0 to 0", () => {
      expect(secPerMToMinPerMile(0)).toBe(0);
    });
  });

  describe("minPerMileToSecPerM", () => {
    it("converts 8 min/mile to ~0.2988 sec/m", () => {
      expect(minPerMileToSecPerM(8)).toBeCloseTo(0.2983, 4);
    });
  });

  describe("round-trip pace conversion", () => {
    it("secPerM → minPerMile → secPerM is lossless", () => {
      const original = 0.3125;
      expect(minPerMileToSecPerM(secPerMToMinPerMile(original))).toBeCloseTo(original, 10);
    });
  });

  describe("secPerMToMinPerKm", () => {
    it("converts 0.3 sec/m to 5 min/km", () => {
      expect(secPerMToMinPerKm(0.3)).toBe(5);
    });
  });

  describe("metersToFeet", () => {
    it("converts 1000m to ~3280.84 ft", () => {
      expect(metersToFeet(1000)).toBeCloseTo(3280.84, 1);
    });
  });

  describe("feetToMeters", () => {
    it("round-trips with metersToFeet", () => {
      expect(feetToMeters(metersToFeet(500))).toBeCloseTo(500, 10);
    });
  });

  describe("metersToMiles", () => {
    it("1609.344m is 1 mile", () => {
      expect(metersToMiles(METERS_PER_MILE)).toBeCloseTo(1, 10);
    });
  });

  describe("formatPace", () => {
    it('formats 0.3 sec/m as "8:03/mi"', () => {
      // 0.3 * 1609.344 = 482.8032 sec/mile → 8 min 2.8 sec → "8:03/mi"
      expect(formatPace(0.3)).toBe("8:03/mi");
    });

    it('formats exactly 8 min/mile correctly', () => {
      const pace = minPerMileToSecPerM(8); // 480 sec/mile
      expect(formatPace(pace)).toBe("8:00/mi");
    });

    it('formats a 10:00/mi pace', () => {
      const pace = minPerMileToSecPerM(10);
      expect(formatPace(pace)).toBe("10:00/mi");
    });
  });

  describe("formatDuration", () => {
    it('formats 3661 seconds as "1:01:01"', () => {
      expect(formatDuration(3661)).toBe("1:01:01");
    });

    it('formats 125 seconds as "2:05"', () => {
      expect(formatDuration(125)).toBe("2:05");
    });

    it('formats 3600 seconds as "1:00:00"', () => {
      expect(formatDuration(3600)).toBe("1:00:00");
    });

    it('formats 59 seconds as "0:59"', () => {
      expect(formatDuration(59)).toBe("0:59");
    });

    it("rounds fractional seconds", () => {
      expect(formatDuration(60.6)).toBe("1:01");
    });
  });
});

// ---------------------------------------------------------------------------
// gap.ts
// ---------------------------------------------------------------------------

describe("computeGap", () => {
  it("returns rawPace unchanged for a flat run (0 elevation gain)", () => {
    const raw = minPerMileToSecPerM(9);
    const result = computeGap(raw, 0, 8046.72);
    expect(result.gapPace).toBeCloseTo(raw, 10);
    expect(result.gapPct).toBeCloseTo(0, 10);
  });

  it("returns rawPace unchanged for zero distance", () => {
    const raw = minPerMileToSecPerM(9);
    const result = computeGap(raw, 500, 0);
    expect(result.gapPace).toBeCloseTo(raw, 10);
    expect(result.gapPct).toBe(0);
  });

  it("known example: 5 miles, 500ft gain, 9:00/mi → GAP ≈ 8:52/mi", () => {
    // gain_per_mile = 500 / 5 = 100 ft/mile
    // time_penalty = (100/100) * 8 = 8 sec/mile
    // gap_pace_min_per_mile = 9 - 8/60 = 9 - 0.1333 = 8.8667 min/mile ≈ 8:52/mi
    const raw = minPerMileToSecPerM(9);
    const distanceM = 5 * METERS_PER_MILE;
    const result = computeGap(raw, 500, distanceM);
    const gapMinPerMile = secPerMToMinPerMile(result.gapPace);
    expect(gapMinPerMile).toBeCloseTo(8 + 52 / 60, 2);
  });

  it("custom coeff=4 is half the penalty of coeff=8", () => {
    const raw = minPerMileToSecPerM(9);
    const distanceM = 5 * METERS_PER_MILE;
    const r8 = computeGap(raw, 500, distanceM, 8);
    const r4 = computeGap(raw, 500, distanceM, 4);
    const penalty8 = raw - r8.gapPace;
    const penalty4 = raw - r4.gapPace;
    expect(penalty8).toBeCloseTo(penalty4 * 2, 10);
  });

  it("gapPct is positive (pace got faster) for a climb", () => {
    const raw = minPerMileToSecPerM(10);
    const result = computeGap(raw, 1000, 8 * METERS_PER_MILE);
    expect(result.gapPct).toBeGreaterThan(0);
    expect(result.gapPace).toBeLessThan(raw);
  });
});

// ---------------------------------------------------------------------------
// altitude.ts
// ---------------------------------------------------------------------------

describe("computeAltitudeAdj", () => {
  it("no adjustment at sea level (0 ft)", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeAltitudeAdj(pace, 0);
    expect(result.altAdjPace).toBeCloseTo(pace, 10);
    expect(result.altPct).toBe(0);
  });

  it("no adjustment below threshold (2999 ft)", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeAltitudeAdj(pace, 2999);
    expect(result.altAdjPace).toBeCloseTo(pace, 10);
    expect(result.altPct).toBe(0);
  });

  it("no adjustment exactly at threshold (3000 ft)", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeAltitudeAdj(pace, 3000);
    expect(result.altAdjPace).toBeCloseTo(pace, 10);
    expect(result.altPct).toBe(0);
  });

  it("1% adjustment at 4000 ft (1000 ft above threshold)", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeAltitudeAdj(pace, 4000);
    expect(result.altPct).toBeCloseTo(0.01, 10);
    expect(result.altAdjPace).toBeCloseTo(pace * 0.99, 10);
  });

  it("5% adjustment at 8000 ft (5000 ft above threshold)", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeAltitudeAdj(pace, 8000);
    expect(result.altPct).toBeCloseTo(0.05, 10);
    expect(result.altAdjPace).toBeCloseTo(pace * 0.95, 10);
  });

  it("adjusted pace is lower (faster) than input", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeAltitudeAdj(pace, 6000);
    expect(result.altAdjPace).toBeLessThan(pace);
  });

  it("custom threshold and coeff", () => {
    const pace = minPerMileToSecPerM(9);
    // threshold 5000ft, coeff 0.02 → at 6000ft: 1000ft above, penalty = 0.02
    const result = computeAltitudeAdj(pace, 6000, 5000, 0.02);
    expect(result.altPct).toBeCloseTo(0.02, 10);
  });
});

// ---------------------------------------------------------------------------
// heat.ts
// ---------------------------------------------------------------------------

describe("getDewPointPenalty", () => {
  it("< 50°F → 0%", () => expect(getDewPointPenalty(45)).toBe(0));
  it("49.9°F → 0%", () => expect(getDewPointPenalty(49.9)).toBe(0));
  it("50°F → 1%", () => expect(getDewPointPenalty(50)).toBe(0.01));
  it("54°F → 1%", () => expect(getDewPointPenalty(54)).toBe(0.01));
  it("55°F → 2.5%", () => expect(getDewPointPenalty(55)).toBe(0.025));
  it("59°F → 2.5%", () => expect(getDewPointPenalty(59)).toBe(0.025));
  it("60°F → 4%", () => expect(getDewPointPenalty(60)).toBe(0.04));
  it("64°F → 4%", () => expect(getDewPointPenalty(64)).toBe(0.04));
  it("65°F → 6.5%", () => expect(getDewPointPenalty(65)).toBe(0.065));
  it("69°F → 6.5%", () => expect(getDewPointPenalty(69)).toBe(0.065));
  it("70°F → 9%", () => expect(getDewPointPenalty(70)).toBe(0.09));
  it("74°F → 9%", () => expect(getDewPointPenalty(74)).toBe(0.09));
  it("75°F → 12%", () => expect(getDewPointPenalty(75)).toBe(0.12));
  it("80°F → 12% (capped)", () => expect(getDewPointPenalty(80)).toBe(0.12));
});

describe("computeHeatAdj", () => {
  it("no penalty below 50°F", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeHeatAdj(pace, 45);
    expect(result.heatAdjPace).toBeCloseTo(pace, 10);
    expect(result.heatPct).toBe(0);
  });

  it("applies 12% penalty at 75°F dew point", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeHeatAdj(pace, 75);
    expect(result.heatPct).toBe(0.12);
    expect(result.heatAdjPace).toBeCloseTo(pace * 0.88, 10);
  });

  it("adjusted pace is lower (faster) than input in hot conditions", () => {
    const pace = minPerMileToSecPerM(9);
    const result = computeHeatAdj(pace, 70);
    expect(result.heatAdjPace).toBeLessThan(pace);
  });
});

// ---------------------------------------------------------------------------
// efficiency.ts
// ---------------------------------------------------------------------------

describe("computeEfficiency", () => {
  it("at 8 min/mile and HR 150 → ≈ 8.33", () => {
    const pace = minPerMileToSecPerM(8);
    expect(computeEfficiency(pace, 150)).toBeCloseTo(10000 / (8 * 150), 4);
  });

  it("slower pace (higher sec/m) → lower efficiency", () => {
    const fast = minPerMileToSecPerM(8);
    const slow = minPerMileToSecPerM(10);
    expect(computeEfficiency(fast, 150)).toBeGreaterThan(computeEfficiency(slow, 150));
  });

  it("higher HR → lower efficiency", () => {
    const pace = minPerMileToSecPerM(9);
    expect(computeEfficiency(pace, 140)).toBeGreaterThan(computeEfficiency(pace, 160));
  });
});

describe("computeWaterfall", () => {
  // 9:00/mi, HR 155, 500ft gain, 5 miles, avg elev 5000ft, dew point 65°F
  const rawPace = minPerMileToSecPerM(9);
  const distanceM = 5 * METERS_PER_MILE;
  const result = computeWaterfall(rawPace, 155, 500, distanceM, 5000, 65);

  it("rawPace matches input", () => {
    expect(result.rawPace).toBeCloseTo(rawPace, 10);
  });

  it("gapPace < rawPace (faster after removing climb penalty)", () => {
    expect(result.gapPace).toBeLessThan(result.rawPace);
  });

  it("altAdjPace < gapPace (faster at 5000ft altitude)", () => {
    expect(result.altAdjPace).toBeLessThan(result.gapPace);
  });

  it("heatAdjPace < altAdjPace (faster in 65°F dew point conditions)", () => {
    expect(result.heatAdjPace).toBeLessThan(result.altAdjPace);
  });

  it("efficiencyFull > efficiencyGap > efficiencyRaw (adjustments improve efficiency)", () => {
    expect(result.efficiencyFull).toBeGreaterThan(result.efficiencyGap);
    expect(result.efficiencyGap).toBeGreaterThan(result.efficiencyRaw);
  });

  it("gapPct, altPct, heatPct are all > 0", () => {
    expect(result.gapPct).toBeGreaterThan(0);
    expect(result.altPct).toBeGreaterThan(0);
    expect(result.heatPct).toBeGreaterThan(0);
  });

  it("no adjustments on flat sea-level cold run → all paces equal", () => {
    const flat = computeWaterfall(rawPace, 150, 0, distanceM, 1000, 40);
    expect(flat.gapPace).toBeCloseTo(flat.rawPace, 10);
    expect(flat.altAdjPace).toBeCloseTo(flat.rawPace, 10);
    expect(flat.heatAdjPace).toBeCloseTo(flat.rawPace, 10);
    expect(flat.efficiencyRaw).toBeCloseTo(flat.efficiencyFull, 10);
  });

  it("waterfall stages are internally consistent with individual functions", () => {
    const gap = computeGap(rawPace, 500, distanceM);
    const alt = computeAltitudeAdj(gap.gapPace, 5000);
    const heat = computeHeatAdj(alt.altAdjPace, 65);

    expect(result.gapPace).toBeCloseTo(gap.gapPace, 10);
    expect(result.altAdjPace).toBeCloseTo(alt.altAdjPace, 10);
    expect(result.heatAdjPace).toBeCloseTo(heat.heatAdjPace, 10);
  });
});
