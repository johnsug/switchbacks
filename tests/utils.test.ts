import { describe, it, expect } from "vitest";
import { decodePolyline, encodePolyline } from "../src/utils/polyline.js";
import { haversineDistanceM, samplePolylinePoints, mean, linearRegressionSlope } from "../src/utils/geo.js";
import { parseElevationsFromGpx } from "../src/utils/gpx.js";

// ---------------------------------------------------------------------------
// polyline.ts
// ---------------------------------------------------------------------------

describe("decodePolyline", () => {
  it("decodes an empty string to an empty array", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it("decodes a single point", () => {
    // Encode [38.5, -120.2] per Google spec → "_p~iF~ps|U"
    const points = decodePolyline("_p~iF~ps|U");
    expect(points).toHaveLength(1);
    expect(points[0][0]).toBeCloseTo(38.5, 4);
    expect(points[0][1]).toBeCloseTo(-120.2, 4);
  });

  it("decodes the canonical Google example", () => {
    // Google's example: [38.5,-120.2], [40.7,-120.95], [43.252,-126.453]
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(points).toHaveLength(3);
    expect(points[0][0]).toBeCloseTo(38.5, 4);
    expect(points[0][1]).toBeCloseTo(-120.2, 4);
    expect(points[1][0]).toBeCloseTo(40.7, 4);
    expect(points[1][1]).toBeCloseTo(-120.95, 4);
    expect(points[2][0]).toBeCloseTo(43.252, 4);
    expect(points[2][1]).toBeCloseTo(-126.453, 4);
  });

  it("round-trips through encode/decode", () => {
    const original: Array<[number, number]> = [
      [39.9526, -105.1686],
      [39.9612, -105.1750],
      [39.9700, -105.1820],
    ];
    const encoded = encodePolyline(original);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(original[i][0], 4);
      expect(decoded[i][1]).toBeCloseTo(original[i][1], 4);
    }
  });

  it("handles negative coordinates (southern hemisphere)", () => {
    const points: Array<[number, number]> = [[-33.8688, 151.2093]]; // Sydney
    const decoded = decodePolyline(encodePolyline(points));
    expect(decoded[0][0]).toBeCloseTo(-33.8688, 4);
    expect(decoded[0][1]).toBeCloseTo(151.2093, 4);
  });
});

// ---------------------------------------------------------------------------
// geo.ts
// ---------------------------------------------------------------------------

describe("haversineDistanceM", () => {
  it("returns 0 for same point", () => {
    expect(haversineDistanceM(39.95, -105.17, 39.95, -105.17)).toBe(0);
  });

  it("returns ~111,195m for 1 degree of latitude", () => {
    // 1 degree latitude ≈ 111,195m (varies slightly by latitude)
    expect(haversineDistanceM(0, 0, 1, 0)).toBeCloseTo(111_195, -2);
  });

  it("Boulder to Denver is ~40km", () => {
    // Boulder CO: 40.015, -105.27 / Denver CO: 39.739, -104.984
    const d = haversineDistanceM(40.015, -105.27, 39.739, -104.984);
    expect(d).toBeGreaterThan(38_000);
    expect(d).toBeLessThan(43_000);
  });
});

describe("samplePolylinePoints", () => {
  it("returns empty array for empty input", () => {
    expect(samplePolylinePoints([], 200)).toEqual([]);
  });

  it("returns single point unchanged", () => {
    expect(samplePolylinePoints([[39.95, -105.17]], 200)).toEqual([[39.95, -105.17]]);
  });

  it("always includes first and last point", () => {
    const points: Array<[number, number]> = [
      [39.95, -105.17],
      [39.96, -105.18],
      [39.97, -105.19],
      [39.98, -105.20],
      [39.99, -105.21],
    ];
    const sampled = samplePolylinePoints(points, 50); // tight interval
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled[sampled.length - 1]).toEqual(points[points.length - 1]);
  });

  it("returns fewer points with a large interval", () => {
    const points: Array<[number, number]> = [
      [39.00, -105.00],
      [39.01, -105.00], // ~1111m apart
      [39.02, -105.00],
      [39.03, -105.00],
      [39.04, -105.00],
    ];
    const tight = samplePolylinePoints(points, 100);
    const sparse = samplePolylinePoints(points, 2000);
    expect(sparse.length).toBeLessThan(tight.length);
  });
});

describe("mean", () => {
  it("returns null for empty array", () => {
    expect(mean([])).toBeNull();
  });

  it("returns the value for a single element", () => {
    expect(mean([5])).toBe(5);
  });

  it("computes arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// gpx.ts
// ---------------------------------------------------------------------------

describe("parseElevationsFromGpx", () => {
  it("returns empty array for xml with no ele tags", () => {
    expect(parseElevationsFromGpx("<gpx></gpx>")).toEqual([]);
  });

  it("parses integer ele values", () => {
    const xml = `<trkpt><ele>354</ele></trkpt><trkpt><ele>350</ele></trkpt>`;
    expect(parseElevationsFromGpx(xml)).toEqual([354, 350]);
  });

  it("parses float ele values", () => {
    const xml = `<ele>353.79998779296875</ele>`;
    const result = parseElevationsFromGpx(xml);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(353.8, 2);
  });

  it("parses negative ele values (below sea level)", () => {
    const xml = `<ele>-10.5</ele>`;
    expect(parseElevationsFromGpx(xml)).toEqual([-10.5]);
  });

  it("handles whitespace around the value", () => {
    const xml = `<ele>  354.0  </ele>`;
    expect(parseElevationsFromGpx(xml)).toEqual([354.0]);
  });

  it("parses a realistic multi-point GPX snippet", () => {
    const xml = `
      <trkpt lat="29.68" lon="-98.44"><ele>354</ele></trkpt>
      <trkpt lat="29.69" lon="-98.44"><ele>360</ele></trkpt>
      <trkpt lat="29.70" lon="-98.44"><ele>349</ele></trkpt>
    `;
    const result = parseElevationsFromGpx(xml);
    expect(result).toEqual([354, 360, 349]);
  });
});

describe("linearRegressionSlope", () => {
  it("returns null for fewer than 2 points", () => {
    expect(linearRegressionSlope([])).toBeNull();
    expect(linearRegressionSlope([[1, 2]])).toBeNull();
  });

  it("returns correct slope for a perfect line y = 2x", () => {
    const pairs: Array<[number, number]> = [[0, 0], [1, 2], [2, 4], [3, 6]];
    expect(linearRegressionSlope(pairs)).toBeCloseTo(2, 5);
  });

  it("returns 0 for a horizontal line", () => {
    const pairs: Array<[number, number]> = [[0, 5], [1, 5], [2, 5]];
    expect(linearRegressionSlope(pairs)).toBeCloseTo(0, 5);
  });

  it("returns negative slope for a declining trend", () => {
    const pairs: Array<[number, number]> = [[0, 10], [1, 8], [2, 6], [3, 4]];
    expect(linearRegressionSlope(pairs)).toBeCloseTo(-2, 5);
  });
});
