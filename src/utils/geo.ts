const EARTH_RADIUS_M = 6_371_000;

/**
 * Haversine distance between two lat/lon points in meters.
 */
export function haversineDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Sample points along a decoded polyline at a regular distance interval.
 *
 * Always includes the first and last point. Returns one intermediate point
 * for every `intervalM` meters accumulated along the route.
 *
 * @param points    Array of [lat, lon] pairs from decodePolyline
 * @param intervalM Sampling interval in meters (e.g. 200)
 */
export function samplePolylinePoints(
  points: Array<[number, number]>,
  intervalM: number
): Array<[number, number]> {
  if (points.length === 0) return [];
  if (points.length === 1) return [[...points[0]]];

  const sampled: Array<[number, number]> = [points[0]];
  let accumulated = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversineDistanceM(
      points[i - 1][0], points[i - 1][1],
      points[i][0],     points[i][1]
    );
    accumulated += d;

    if (accumulated >= intervalM) {
      sampled.push(points[i]);
      accumulated = 0;
    }
  }

  // Always include the final point if not already added
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }

  return sampled;
}

/**
 * Compute the arithmetic mean of an array of numbers.
 * Returns null for empty arrays.
 */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Fit a linear regression line to (x, y) pairs and return the slope.
 * Used for computing efficiency trend direction.
 * Returns null if fewer than 2 points.
 */
export function linearRegressionSlope(pairs: Array<[number, number]>): number | null {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const sumX = pairs.reduce((s, [x]) => s + x, 0);
  const sumY = pairs.reduce((s, [, y]) => s + y, 0);
  const sumXY = pairs.reduce((s, [x, y]) => s + x * y, 0);
  const sumX2 = pairs.reduce((s, [x]) => s + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
