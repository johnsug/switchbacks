import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GpxTrackpoint } from "./utils/gpx.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherRecord {
  tempF: number;
  humidityPct: number;
  dewpointF: number;
  apparentTempF: number;
  windMph: number;
  precipIn: number;
}

export interface ActivityEnrichment {
  activityId: string;
  startLat: number | null;
  startLon: number | null;
  avgRouteElevationFt: number | null;
  weather: WeatherRecord | null;
  gapPace: number | null;
  altAdjPace: number | null;
  heatAdjPace: number | null;
  gapPct: number | null;
  altPct: number | null;
  heatPct: number | null;
  efficiencyRaw: number | null;
  efficiencyGap: number | null;
  efficiencyFull: number | null;
  vo2MaxScore: number | null;
}

// ---------------------------------------------------------------------------
// Cache class
// ---------------------------------------------------------------------------

const ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class Cache {
  private db: DatabaseSync;

  constructor(cacheDir?: string) {
    const dir = cacheDir ?? join(homedir(), ".switchbacks-mcp");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const dbPath = join(dir, "cache.db");
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS weather (
        lat_r2    REAL NOT NULL,
        lon_r2    REAL NOT NULL,
        date      TEXT NOT NULL,
        data      TEXT NOT NULL,
        PRIMARY KEY (lat_r2, lon_r2, date)
      );

      CREATE TABLE IF NOT EXISTS activity_enrichments (
        activity_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      );

      -- GPS tracks have no TTL — a run's route never changes.
      CREATE TABLE IF NOT EXISTS activity_tracks (
        activity_id TEXT PRIMARY KEY,
        track_json  TEXT NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Weather
  // -------------------------------------------------------------------------

  getWeather(lat: number, lon: number, date: string): WeatherRecord | null {
    const row = this.db.prepare(
      "SELECT data FROM weather WHERE lat_r2 = ? AND lon_r2 = ? AND date = ?"
    ).get(round2(lat), round2(lon), date) as { data: string } | undefined;

    return row ? (JSON.parse(row.data) as WeatherRecord) : null;
  }

  setWeather(lat: number, lon: number, date: string, weather: WeatherRecord): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO weather (lat_r2, lon_r2, date, data) VALUES (?, ?, ?, ?)"
    ).run(round2(lat), round2(lon), date, JSON.stringify(weather));
  }

  // -------------------------------------------------------------------------
  // Activity enrichments — 24h TTL
  // -------------------------------------------------------------------------

  getEnrichment(activityId: string): ActivityEnrichment | null {
    const row = this.db.prepare(
      "SELECT data, cached_at FROM activity_enrichments WHERE activity_id = ?"
    ).get(activityId) as { data: string; cached_at: number } | undefined;

    if (!row) return null;
    if (Date.now() - row.cached_at > ENRICHMENT_TTL_MS) {
      this.db.prepare(
        "DELETE FROM activity_enrichments WHERE activity_id = ?"
      ).run(activityId);
      return null;
    }

    return JSON.parse(row.data) as ActivityEnrichment;
  }

  setEnrichment(enrichment: ActivityEnrichment): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO activity_enrichments (activity_id, data, cached_at) VALUES (?, ?, ?)"
    ).run(enrichment.activityId, JSON.stringify(enrichment), Date.now());
  }

  // -------------------------------------------------------------------------
  // GPS tracks — permanent cache (routes don't change)
  // -------------------------------------------------------------------------

  getTrack(activityId: string): GpxTrackpoint[] | null {
    const row = this.db.prepare(
      "SELECT track_json FROM activity_tracks WHERE activity_id = ?"
    ).get(activityId) as { track_json: string } | undefined;

    return row ? (JSON.parse(row.track_json) as GpxTrackpoint[]) : null;
  }

  setTrack(activityId: string, track: GpxTrackpoint[]): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO activity_tracks (activity_id, track_json) VALUES (?, ?)"
    ).run(activityId, JSON.stringify(track));
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /** Remove enrichments older than 24h. Call periodically if desired. */
  pruneExpired(): number {
    const cutoff = Date.now() - ENRICHMENT_TTL_MS;
    const result = this.db.prepare(
      "DELETE FROM activity_enrichments WHERE cached_at < ?"
    ).run(cutoff);
    return result.changes as number;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
