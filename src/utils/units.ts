export const METERS_PER_MILE = 1609.344;
export const FEET_PER_METER = 3.28084;

/**
 * Convert sec/meter to min/mile.
 */
export function secPerMToMinPerMile(secPerM: number): number {
  return (secPerM * METERS_PER_MILE) / 60;
}

/**
 * Convert min/mile to sec/meter.
 */
export function minPerMileToSecPerM(minPerMile: number): number {
  return (minPerMile * 60) / METERS_PER_MILE;
}

/**
 * Convert sec/meter to min/km.
 */
export function secPerMToMinPerKm(secPerM: number): number {
  return (secPerM * 1000) / 60;
}

/**
 * Convert meters to feet.
 */
export function metersToFeet(m: number): number {
  return m * FEET_PER_METER;
}

/**
 * Convert feet to meters.
 */
export function feetToMeters(ft: number): number {
  return ft / FEET_PER_METER;
}

/**
 * Convert meters to miles.
 */
export function metersToMiles(m: number): number {
  return m / METERS_PER_MILE;
}

/**
 * Format sec/meter as "M:SS/mi" string.
 * e.g. 0.3 sec/m → "8:03/mi"
 */
export function formatPace(secPerM: number): string {
  const totalSecsPerMile = secPerM * METERS_PER_MILE;
  const minutes = Math.floor(totalSecsPerMile / 60);
  const seconds = Math.round(totalSecsPerMile % 60);
  const paddedSecs = seconds.toString().padStart(2, "0");
  return `${minutes}:${paddedSecs}/mi`;
}

/**
 * Format total seconds as "H:MM:SS" if >= 1 hour, or "M:SS" otherwise.
 * e.g. 3661 → "1:01:01", 125 → "2:05"
 */
export function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  const paddedSecs = seconds.toString().padStart(2, "0");

  if (hours > 0) {
    const paddedMins = minutes.toString().padStart(2, "0");
    return `${hours}:${paddedMins}:${paddedSecs}`;
  }

  return `${minutes}:${paddedSecs}`;
}
