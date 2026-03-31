import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache, WeatherRecord, ActivityEnrichment } from "../src/cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "switchbacks-test-"));
}

const sampleWeather: WeatherRecord = {
  tempF: 68,
  humidityPct: 55,
  dewpointF: 51,
  apparentTempF: 67,
  windMph: 8,
  precipIn: 0,
};

const sampleEnrichment: ActivityEnrichment = {
  activityId: "abc123",
  startLat: 39.95,
  startLon: -105.17,
  avgRouteElevationFt: 5577,
  weather: sampleWeather,
  gapPace: 0.285,
  altAdjPace: 0.281,
  heatAdjPace: 0.278,
  gapPct: 0.05,
  altPct: 0.014,
  heatPct: 0.01,
  efficiencyRaw: 7.8,
  efficiencyGap: 8.1,
  efficiencyFull: 8.4,
  vo2MaxScore: 52.3,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cache", () => {
  let tempDir: string;
  let cache: Cache;

  beforeEach(() => {
    tempDir = makeTempDir();
    cache = new Cache(tempDir);
  });

  afterEach(() => {
    cache.close();
    rmSync(tempDir, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // Weather
  // -------------------------------------------------------------------------

  describe("weather", () => {
    it("returns null for a cache miss", () => {
      expect(cache.getWeather(39.95, -105.17, "2024-08-15")).toBeNull();
    });

    it("stores and retrieves a weather record", () => {
      cache.setWeather(39.95, -105.17, "2024-08-15", sampleWeather);
      const result = cache.getWeather(39.95, -105.17, "2024-08-15");
      expect(result).toEqual(sampleWeather);
    });

    it("keys by date — different date is a miss", () => {
      cache.setWeather(39.95, -105.17, "2024-08-15", sampleWeather);
      expect(cache.getWeather(39.95, -105.17, "2024-08-16")).toBeNull();
    });

    it("rounds lat/lon to 2 decimal places for the key", () => {
      cache.setWeather(39.9526, -105.1686, "2024-08-15", sampleWeather);
      // 39.9526 rounds to 39.95, -105.1686 rounds to -105.17
      const result = cache.getWeather(39.95, -105.17, "2024-08-15");
      expect(result).toEqual(sampleWeather);
    });

    it("overwrites an existing record (INSERT OR REPLACE)", () => {
      cache.setWeather(39.95, -105.17, "2024-08-15", sampleWeather);
      const updated = { ...sampleWeather, tempF: 75 };
      cache.setWeather(39.95, -105.17, "2024-08-15", updated);
      expect(cache.getWeather(39.95, -105.17, "2024-08-15")?.tempF).toBe(75);
    });
  });

  // -------------------------------------------------------------------------
  // Activity enrichments
  // -------------------------------------------------------------------------

  describe("activity enrichments", () => {
    it("returns null for a cache miss", () => {
      expect(cache.getEnrichment("nonexistent")).toBeNull();
    });

    it("stores and retrieves an enrichment", () => {
      cache.setEnrichment(sampleEnrichment);
      const result = cache.getEnrichment("abc123");
      expect(result).toEqual(sampleEnrichment);
    });

    it("returns enrichment within TTL window", () => {
      cache.setEnrichment(sampleEnrichment);
      // Fresh record — well within 24h TTL
      expect(cache.getEnrichment("abc123")).not.toBeNull();
    });

    it("expired enrichment is evicted and returns null", () => {
      cache.setEnrichment(sampleEnrichment);
      cache.close();

      // Backdate cached_at by writing directly via a second Cache instance
      // that exposes the underlying db. We use a raw SQL workaround: open the
      // db, UPDATE cached_at to 25h ago, then re-open through Cache to verify.
      const backdated = new DatabaseSync(join(tempDir, "cache.db"));
      const cutoff = Date.now() - 25 * 60 * 60 * 1000;
      backdated.prepare("UPDATE activity_enrichments SET cached_at = ? WHERE activity_id = ?")
        .run(cutoff, "abc123");
      backdated.close();

      cache = new Cache(tempDir);
      expect(cache.getEnrichment("abc123")).toBeNull();
    });

    it("overwrites an existing enrichment", () => {
      cache.setEnrichment(sampleEnrichment);
      const updated = { ...sampleEnrichment, efficiencyFull: 9.9 };
      cache.setEnrichment(updated);
      expect(cache.getEnrichment("abc123")?.efficiencyFull).toBe(9.9);
    });

    it("enrichment with null fields round-trips correctly", () => {
      const minimal: ActivityEnrichment = {
        activityId: "minimal",
        startLat: null,
        startLon: null,
        avgRouteElevationFt: null,
        weather: null,
        gapPace: null,
        altAdjPace: null,
        heatAdjPace: null,
        gapPct: null,
        altPct: null,
        heatPct: null,
        efficiencyRaw: null,
        efficiencyGap: null,
        efficiencyFull: null,
        vo2MaxScore: null,
      };
      cache.setEnrichment(minimal);
      expect(cache.getEnrichment("minimal")).toEqual(minimal);
    });
  });

  // -------------------------------------------------------------------------
  // pruneExpired
  // -------------------------------------------------------------------------

  describe("pruneExpired", () => {
    it("returns 0 when nothing is expired", () => {
      cache.setEnrichment(sampleEnrichment);
      expect(cache.pruneExpired()).toBe(0);
    });

    it("returns 0 on empty cache", () => {
      expect(cache.pruneExpired()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Isolation — separate instances use separate files
  // -------------------------------------------------------------------------

  it("two cache instances with different dirs are isolated", () => {
    const tempDir2 = makeTempDir();
    const cache2 = new Cache(tempDir2);

    cache.setWeather(39.95, -105.17, "2024-08-15", sampleWeather);
    expect(cache2.getWeather(39.95, -105.17, "2024-08-15")).toBeNull();

    cache2.close();
    rmSync(tempDir2, { recursive: true });
  });

  it("persists across close/reopen", () => {
    cache.setWeather(39.95, -105.17, "2024-08-15", sampleWeather);
    cache.close();

    cache = new Cache(tempDir);
    expect(cache.getWeather(39.95, -105.17, "2024-08-15")).toEqual(sampleWeather);
  });
});
