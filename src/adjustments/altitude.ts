export interface AltitudeResult {
  altAdjPace: number;  // sec/meter
  altPct: number;      // the penalty fraction applied (0 at sea level)
}

/**
 * Compute altitude-adjusted pace.
 *
 * Formula:
 *   if avg_elev_ft <= threshold:
 *       alt_penalty = 0
 *   else:
 *       alt_penalty = ((avg_elev_ft - threshold) / 1000) * coeff
 *   alt_adj_pace = gap_pace * (1 - alt_penalty)
 *
 * This makes pace LOWER (faster equivalent sea-level pace) to reflect extra
 * effort expended at altitude.
 *
 * @param gapPaceSecPerM  GAP-adjusted pace in sec/meter
 * @param avgElevFt       Average route elevation in feet
 * @param thresholdFt     Elevation threshold in feet (default 3000)
 * @param coeff           Penalty per 1000ft above threshold (default 0.01 = 1%)
 */
export function computeAltitudeAdj(
  gapPaceSecPerM: number,
  avgElevFt: number,
  thresholdFt: number = 3000,
  coeff: number = 0.01
): AltitudeResult {
  let altPct = 0;

  if (avgElevFt > thresholdFt) {
    altPct = ((avgElevFt - thresholdFt) / 1000) * coeff;
  }

  const altAdjPace = gapPaceSecPerM * (1 - altPct);

  return { altAdjPace, altPct };
}
