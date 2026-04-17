import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UserRecord } from "./db.js";

export interface Config {
  dataSource: "strava" | "garmin";
  // Strava
  stravaAccessToken: string | null;
  stravaRefreshToken: string | null;
  // Garmin
  garminEmail: string | null;
  garminPassword: string | null;
  garminAuthType: "password" | "sso";
  garminCookies: Record<string, string> | null;
  // General
  timezone: string;
  gapCoefficient: number;           // sec/mile per 100 ft/mile gain (6–12)
  altitudeThresholdFt: number;      // ft above which altitude adjustment kicks in
  altitudeCoefficient: number;      // fractional penalty per 1000ft above threshold
  cacheDir: string;
}

const DEFAULT_CACHE_DIR = join(homedir(), ".switchbacks-mcp");

const DEFAULTS: Config = {
  dataSource: "strava",
  stravaAccessToken: null,
  stravaRefreshToken: null,
  garminEmail: null,
  garminPassword: null,
  garminAuthType: "password" as const,
  garminCookies: null,
  timezone: "America/Chicago",
  gapCoefficient: 8,
  altitudeThresholdFt: 3000,
  altitudeCoefficient: 0.01,
  cacheDir: DEFAULT_CACHE_DIR,
};

export function loadConfig(): Config {
  const configPath = join(homedir(), ".switchbacks-mcp", "config.json");
  let file: Partial<Config> = {};

  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<Config>;
    } catch {
      // Malformed config — proceed with defaults
    }
  }

  return {
    dataSource:             envEnum("SWITCHBACKS_DATA_SOURCE", ["strava", "garmin"])
                              ?? file.dataSource ?? DEFAULTS.dataSource,
    stravaAccessToken:      env("STRAVA_ACCESS_TOKEN")             ?? file.stravaAccessToken   ?? DEFAULTS.stravaAccessToken,
    stravaRefreshToken:     env("STRAVA_REFRESH_TOKEN")            ?? file.stravaRefreshToken  ?? DEFAULTS.stravaRefreshToken,
    garminEmail:            env("GARMIN_EMAIL")                    ?? file.garminEmail         ?? DEFAULTS.garminEmail,
    garminPassword:         env("GARMIN_PASSWORD")                 ?? file.garminPassword      ?? DEFAULTS.garminPassword,
    garminAuthType:         (file.garminAuthType                   ?? DEFAULTS.garminAuthType) as "password" | "sso",
    garminCookies:          (file.garminCookies as Record<string, string> | null) ?? DEFAULTS.garminCookies,
    timezone:               env("SWITCHBACKS_TIMEZONE")            ?? file.timezone            ?? DEFAULTS.timezone,
    gapCoefficient:         envNum("SWITCHBACKS_GAP_COEFF")        ?? file.gapCoefficient      ?? DEFAULTS.gapCoefficient,
    altitudeThresholdFt:    envNum("SWITCHBACKS_ALT_THRESHOLD_FT") ?? file.altitudeThresholdFt ?? DEFAULTS.altitudeThresholdFt,
    altitudeCoefficient:    envNum("SWITCHBACKS_ALT_COEFF")        ?? file.altitudeCoefficient ?? DEFAULTS.altitudeCoefficient,
    cacheDir:               env("SWITCHBACKS_CACHE_DIR")           ?? file.cacheDir            ?? DEFAULTS.cacheDir,
  };
}

/**
 * Build a Config from a hosted UserRecord.
 * Credentials come from the DB; tuning params use defaults.
 */
export function loadConfigForUser(user: UserRecord, dataDir: string): Config {
  return {
    dataSource:          user.dataSource,
    stravaAccessToken:   user.stravaAccessToken,
    stravaRefreshToken:  user.stravaRefreshToken,
    garminEmail:         user.garminEmail,
    garminPassword:      null, // never stored for hosted users
    garminAuthType:      user.garminCookies ? "sso" : "password",
    garminCookies:       user.garminCookies,
    timezone:            DEFAULTS.timezone,
    gapCoefficient:      DEFAULTS.gapCoefficient,
    altitudeThresholdFt: DEFAULTS.altitudeThresholdFt,
    altitudeCoefficient: DEFAULTS.altitudeCoefficient,
    cacheDir:            join(dataDir, user.token),
  };
}

function env(key: string): string | null {
  return process.env[key] ?? null;
}

function envNum(key: string): number | null {
  const v = process.env[key];
  if (v === undefined || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function envEnum<T extends string>(key: string, allowed: T[]): T | null {
  const v = process.env[key];
  if (!v) return null;
  return (allowed as string[]).includes(v) ? (v as T) : null;
}
