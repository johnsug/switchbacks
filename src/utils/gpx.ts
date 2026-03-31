/**
 * Minimal GPX parser — no XML library needed.
 * Handles both Garmin (ns3:) and Strava (gpxtpx:) TrackPointExtension namespaces.
 */

// ---------------------------------------------------------------------------
// Elevation-only (used by enricher for avg altitude)
// ---------------------------------------------------------------------------

export function parseElevationsFromGpx(xml: string): number[] {
  const elevations: number[] = [];
  const re = /<ele>\s*(-?[\d.]+)\s*<\/ele>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const v = parseFloat(match[1]!);
    if (isFinite(v)) elevations.push(v);
  }
  return elevations;
}

// ---------------------------------------------------------------------------
// Full trackpoint parsing (used by interval detection)
// ---------------------------------------------------------------------------

export interface GpxTrackpoint {
  timeS: number;         // Unix timestamp (seconds)
  lat: number;
  lon: number;
  elevationM: number | null;
  hr: number | null;
  cadence: number | null;
}

/**
 * Parse all <trkpt> elements from a GPX string.
 * Returns points sorted by time.
 */
export function parseGpxTrackpoints(xml: string): GpxTrackpoint[] {
  const trkptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  const points: GpxTrackpoint[] = [];

  let m: RegExpExecArray | null;
  while ((m = trkptRe.exec(xml)) !== null) {
    const attrs = m[1]!;
    const inner = m[2]!;

    const lat = parseFloat(attrs.match(/lat="([^"]+)"/)?.[1] ?? "NaN");
    const lon = parseFloat(attrs.match(/lon="([^"]+)"/)?.[1] ?? "NaN");
    if (!isFinite(lat) || !isFinite(lon)) continue;

    const timeStr = inner.match(/<time>\s*([^<]+)\s*<\/time>/)?.[1]?.trim();
    if (!timeStr) continue;
    const timeS = Date.parse(timeStr) / 1000;
    if (!isFinite(timeS)) continue;

    const eleStr = inner.match(/<ele>\s*(-?[\d.]+)\s*<\/ele>/)?.[1];
    // HR and cadence: handle both ns3: and gpxtpx: prefixes
    const hrStr  = inner.match(/<(?:ns3|gpxtpx):hr>\s*(\d+)\s*<\/(?:ns3|gpxtpx):hr>/)?.[1];
    const cadStr = inner.match(/<(?:ns3|gpxtpx):cad>\s*(\d+)\s*<\/(?:ns3|gpxtpx):cad>/)?.[1];

    points.push({
      timeS,
      lat,
      lon,
      elevationM: eleStr ? parseFloat(eleStr) : null,
      hr:         hrStr  ? parseInt(hrStr,  10) : null,
      cadence:    cadStr ? parseInt(cadStr, 10) : null,
    });
  }

  return points.sort((a, b) => a.timeS - b.timeS);
}
