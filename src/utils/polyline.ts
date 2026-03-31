/**
 * Google Encoded Polyline Algorithm decoder.
 *
 * Spec: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 * This algorithm is public domain — implemented inline to avoid a dependency.
 *
 * Returns an array of [lat, lon] pairs (WGS-84 degrees).
 */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let delta = 0;
    let shift = 0;
    let b: number;

    // Decode latitude delta
    do {
      b = encoded.charCodeAt(index++) - 63;
      delta |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += delta & 1 ? ~(delta >> 1) : delta >> 1;

    delta = 0;
    shift = 0;

    // Decode longitude delta
    do {
      b = encoded.charCodeAt(index++) - 63;
      delta |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += delta & 1 ? ~(delta >> 1) : delta >> 1;

    points.push([lat / 1e5, lon / 1e5]);
  }

  return points;
}

/**
 * Encode an array of [lat, lon] pairs to a Google encoded polyline string.
 * Useful for testing and round-trip verification.
 */
export function encodePolyline(points: Array<[number, number]>): string {
  let output = "";
  let prevLat = 0;
  let prevLon = 0;

  for (const [lat, lon] of points) {
    output += encodeValue(Math.round(lat * 1e5) - prevLat);
    output += encodeValue(Math.round(lon * 1e5) - prevLon);
    prevLat = Math.round(lat * 1e5);
    prevLon = Math.round(lon * 1e5);
  }

  return output;
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let output = "";

  while (v >= 0x20) {
    output += String.fromCharCode(((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  output += String.fromCharCode(v + 63);

  return output;
}
