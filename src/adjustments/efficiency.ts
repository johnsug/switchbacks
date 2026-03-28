import { secPerMToMinPerMile } from "../utils/units.js";
import { computeGap } from "./gap.js";
import { computeAltitudeAdj } from "./altitude.js";
import { computeHeatAdj } from "./heat.js";

export interface AdjustmentWaterfall {
  rawPace: number;        // sec/meter
  gapPace: number;        // sec/meter after GAP
  altAdjPace: number;     // sec/meter after altitude
  heatAdjPace: number;    // sec/meter after heat (final)
  gapPct: number;
  altPct: number;
  heatPct: number;
  efficiencyRaw: number;   // computed from rawPace + avgHr
  efficiencyGap: number;   // computed from gapPace + avgHr
  efficiencyFull: number;  // computed from heatAdjPace + avgHr
}

/**
 * Compute the Aerobic Efficiency Index.
 *
 * Formula: efficiency = 10000 / (pace_min_per_mile * avg_hr)
 * Higher value = more aerobically efficient.
 *
 * @param paceSecPerM  Pace in sec/meter
 * @param avgHr        Average heart rate (bpm)
 */
export function computeEfficiency(paceSecPerM: number, avgHr: number): number {
  const paceMinPerMile = secPerMToMinPerMile(paceSecPerM);
  return 10000 / (paceMinPerMile * avgHr);
}

export interface WaterfallOptions {
  gapCoeff?: number;
  altThresholdFt?: number;
  altCoeff?: number;
}

/**
 * Compute the full adjustment waterfall: raw → GAP → altitude → heat.
 *
 * @param rawPaceSecPerM  Raw pace in sec/meter
 * @param avgHr           Average heart rate (bpm)
 * @param elevGainFt      Total elevation gain in feet
 * @param distanceM       Distance in meters
 * @param avgElevFt       Average route elevation in feet
 * @param dewPointF       Dew point temperature in degrees Fahrenheit
 * @param options         Optional tuning parameters
 */
export function computeWaterfall(
  rawPaceSecPerM: number,
  avgHr: number,
  elevGainFt: number,
  distanceM: number,
  avgElevFt: number,
  dewPointF: number,
  options?: WaterfallOptions
): AdjustmentWaterfall {
  const { gapCoeff, altThresholdFt, altCoeff } = options ?? {};

  const { gapPace, gapPct } = computeGap(
    rawPaceSecPerM,
    elevGainFt,
    distanceM,
    gapCoeff
  );

  const { altAdjPace, altPct } = computeAltitudeAdj(
    gapPace,
    avgElevFt,
    altThresholdFt,
    altCoeff
  );

  const { heatAdjPace, heatPct } = computeHeatAdj(altAdjPace, dewPointF);

  return {
    rawPace: rawPaceSecPerM,
    gapPace,
    altAdjPace,
    heatAdjPace,
    gapPct,
    altPct,
    heatPct,
    efficiencyRaw: computeEfficiency(rawPaceSecPerM, avgHr),
    efficiencyGap: computeEfficiency(gapPace, avgHr),
    efficiencyFull: computeEfficiency(heatAdjPace, avgHr),
  };
}
