import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface UserRecord {
  token: string;
  dataSource: "strava" | "garmin";
  stravaAccessToken: string | null;
  stravaRefreshToken: string | null;
  garminCookies: Record<string, string> | null;
  garminEmail: string | null;
}

export class UserDb {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "users.db"));
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        token                TEXT PRIMARY KEY,
        data_source          TEXT NOT NULL DEFAULT 'garmin',
        strava_access_token  TEXT,
        strava_refresh_token TEXT,
        garmin_cookies       TEXT,
        garmin_email         TEXT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
    `);
  }

  createUser(dataSource: "strava" | "garmin" = "garmin"): string {
    const token = randomUUID();
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO users (token, data_source, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(token, dataSource, now, now);
    return token;
  }

  getUser(token: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM users WHERE token = ?"
    ).get(token) as Record<string, string | number | null> | undefined;

    if (!row) return null;
    return {
      token:               row["token"] as string,
      dataSource:          row["data_source"] as "strava" | "garmin",
      stravaAccessToken:   (row["strava_access_token"] as string | null) ?? null,
      stravaRefreshToken:  (row["strava_refresh_token"] as string | null) ?? null,
      garminCookies:       row["garmin_cookies"]
                             ? JSON.parse(row["garmin_cookies"] as string) as Record<string, string>
                             : null,
      garminEmail:         (row["garmin_email"] as string | null) ?? null,
    };
  }

  updateGarminCookies(
    token: string,
    cookies: Record<string, string>,
    email?: string
  ): void {
    this.db.prepare(
      `UPDATE users
          SET garmin_cookies = ?, garmin_email = ?, data_source = 'garmin', updated_at = ?
        WHERE token = ?`
    ).run(JSON.stringify(cookies), email ?? null, Date.now(), token);
  }

  updateStravaTokens(
    token: string,
    accessToken: string,
    refreshToken: string
  ): void {
    this.db.prepare(
      `UPDATE users
          SET strava_access_token = ?, strava_refresh_token = ?, data_source = 'strava', updated_at = ?
        WHERE token = ?`
    ).run(accessToken, refreshToken, Date.now(), token);
  }
}
