import { METERS_PER_MILE, metersToFeet, metersToMiles, secPerMToMinPerMile } from "../utils/units.js";

export interface GapResult {
  gapPace: number;  // sec/meter
  gapPct: number;   // fraction of raw pace removed (0.05 = 5% faster equivalent)
}

/**
 * Compute Grade Adjusted Pace (GAP).
 *
 * Formula (in min/mile terms):
 *   gain_per_mile = total_elevation_gain_ft / distance_miles
 *   time_penalty_sec_per_mile = (gain_per_mile / 100) * coeff
 *   gap_pace_min_per_mile = raw_pace_min_per_mile - (time_penalty_sec_per_mile / 60)
 *   gap_pace_sec_per_m = gap_pace_min_per_mile * 60 / METERS_PER_MILE
 *
 * @param rawPaceSecPerM  Raw pace in sec/meter
 * @param elevGainFt      Total elevation gain in feet
 * @param distanceM       Distance in meters
 * @param coeff           Seconds per mile per 100 ft/mile gain (default 8, range 6–12)
 */
export function computeGap(
  rawPaceSecPerM: number,
  elevGainFt: number,
  distanceM: number,
  coeff: number = 8
): GapResult {
  if (distanceM === 0) {
    return { gapPace: rawPaceSecPerM, gapPct: 0 };
  }

  const distanceMiles = metersToMiles(distanceM);
  const gainPerMile = elevGainFt / distanceMiles;
  const timePenaltySecPerMile = (gainPerMile / 100) * coeff;

  const rawPaceMinPerMile = secPerMToMinPerMile(rawPaceSecPerM);
  const gapPaceMinPerMile = rawPaceMinPerMile - (timePenaltySecPerMile / 60);
  const gapPaceSecPerM = (gapPaceMinPerMile * 60) / METERS_PER_MILE;

  // gapPct: fraction removed from raw pace (positive = adjusted pace is faster)
  const gapPct = rawPaceSecPerM !== 0
    ? (rawPaceSecPerM - gapPaceSecPerM) / rawPaceSecPerM
    : 0;

  return { gapPace: gapPaceSecPerM, gapPct };
}
