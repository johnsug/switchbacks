export interface HeatResult {
  heatAdjPace: number;  // sec/meter
  heatPct: number;      // penalty fraction applied
}

/**
 * Dew point penalty table:
 *   < 50°F  → 0%
 *   50–54°F → 1%
 *   55–59°F → 2.5%
 *   60–64°F → 4%
 *   65–69°F → 6.5%
 *   70–74°F → 9%
 *   ≥ 75°F  → 12%
 *
 * Uses >= comparisons from highest threshold down.
 */
export function getDewPointPenalty(dewPointF: number): number {
  if (dewPointF >= 75) return 0.12;
  if (dewPointF >= 70) return 0.09;
  if (dewPointF >= 65) return 0.065;
  if (dewPointF >= 60) return 0.04;
  if (dewPointF >= 55) return 0.025;
  if (dewPointF >= 50) return 0.01;
  return 0;
}

/**
 * Compute heat-adjusted pace using the dew point penalty model.
 *
 * Formula:
 *   heat_adj_pace = alt_adj_pace * (1 - pct_penalty)
 *
 * This makes pace LOWER (faster equivalent cool-weather pace) to reflect
 * extra effort expended in humid/hot conditions.
 *
 * @param altAdjPaceSecPerM  Altitude-adjusted pace in sec/meter
 * @param dewPointF          Dew point temperature in degrees Fahrenheit
 */
export function computeHeatAdj(
  altAdjPaceSecPerM: number,
  dewPointF: number
): HeatResult {
  const heatPct = getDewPointPenalty(dewPointF);
  const heatAdjPace = altAdjPaceSecPerM * (1 - heatPct);

  return { heatAdjPace, heatPct };
}
