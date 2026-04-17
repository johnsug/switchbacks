/**
 * Unified data source resolver.
 *
 * Delegates to Strava or Garmin based on config.dataSource.
 * All tools should use these functions instead of calling strava/garmin directly.
 */

import type { RawActivity } from "../types.js";
import type { Config } from "../config.js";
import { listActivities as stravaList, getActivity as stravaGet, fetchStravaAltitudeStream, fetchStravaStreams, refreshAccessToken } from "./strava.js";
import { listGarminActivities, getGarminActivity, fetchGarminActivityGpx, type GarminAuth } from "./garmin.js";
import { parseElevationsFromGpx, parseGpxTrackpoints, type GpxTrackpoint } from "../utils/gpx.js";
import { mean } from "../utils/geo.js";
import { trackpointsToSamples, stravaStreamsToSamples, type ActivitySample } from "../utils/intervals.js";
import { mergeAndWriteConfig } from "../setup/config-writer.js";

/**
 * Wraps a Strava API call with automatic token refresh on 401.
 * On refresh, writes new tokens to disk so subsequent tool calls pick them up.
 */
async function withStravaRefresh<T>(
  config: Config,
  fn: (token: string) => Promise<T>
): Promise<T> {
  if (!config.stravaAccessToken) throw new Error("No Strava access token configured. Call setup_auth to connect.");

  try {
    return await fn(config.stravaAccessToken);
  } catch (err) {
    const msg = String(err);
    if ((msg.includes("expired") || msg.includes("401")) && config.stravaRefreshToken) {
      const refreshed = await refreshAccessToken({
        accessToken: config.stravaAccessToken,
        refreshToken: config.stravaRefreshToken,
      });
      mergeAndWriteConfig({
        stravaAccessToken: refreshed.accessToken,
        stravaRefreshToken: refreshed.refreshToken,
      });
      return await fn(refreshed.accessToken);
    }
    throw err;
  }
}

function garminAuth(config: Config): GarminAuth {
  if (config.garminAuthType === "sso" && config.garminCookies) {
    return { type: "sso", cookies: config.garminCookies };
  }
  return { type: "password", email: config.garminEmail!, password: config.garminPassword! };
}

export interface ListOptions {
  limit?: number;
  after?: number;  // Unix timestamp (seconds)
  before?: number; // Unix timestamp (seconds)
  type?: string;
}

export async function listActivitiesFromSource(
  config: Config,
  options: ListOptions = {}
): Promise<RawActivity[] | { error: string }> {
  if (config.dataSource === "garmin") {
    if (!config.garminEmail || !config.garminPassword) {
      return { error: "Garmin credentials not configured. Set garminEmail and garminPassword in ~/.switchbacks-mcp/config.json." };
    }
    try {
      return await listGarminActivities(garminAuth(config), options);
    } catch (err) {
      return { error: String(err) };
    }
  }

  // Default: Strava
  try {
    return await withStravaRefresh(config, (token) => stravaList(token, options));
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Fetch average absolute elevation (meters) for an activity.
 * Garmin: downloads the GPX and averages <ele> values.
 * Strava: uses the altitude stream endpoint.
 * Returns null if credentials are missing or the request fails.
 */
export async function fetchAvgElevationForActivity(
  config: Config,
  activityId: string
): Promise<number | null> {
  if (config.dataSource === "garmin") {
    if (!config.garminEmail || !config.garminPassword) return null;
    try {
      const gpx = await fetchGarminActivityGpx(garminAuth(config), activityId);
      if (!gpx) return null;
      const elevations = parseElevationsFromGpx(gpx);
      return mean(elevations);
    } catch {
      return null;
    }
  }

  // Strava
  try {
    const altitudes = await withStravaRefresh(config, (token) => fetchStravaAltitudeStream(token, activityId));
    return altitudes ? mean(altitudes) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch time-series samples (pace, HR, elevation) for interval detection.
 * Garmin: downloads GPX and converts trackpoints.
 * Strava: fetches time/distance/velocity_smooth/heartrate/altitude streams.
 * Returns null if credentials are missing, the activity has no GPS, or the request fails.
 */
export async function fetchActivitySamples(
  config: Config,
  activityId: string,
  activityStartTimeS: number
): Promise<ActivitySample[] | null> {
  if (config.dataSource === "garmin") {
    if (!config.garminEmail && !config.garminCookies) return null;
    try {
      const gpx = await fetchGarminActivityGpx(garminAuth(config), activityId);
      if (!gpx) return null;
      const trackpoints = parseGpxTrackpoints(gpx);
      return trackpointsToSamples(trackpoints);
    } catch {
      return null;
    }
  }

  // Strava
  try {
    const streams = await withStravaRefresh(config, (token) =>
      fetchStravaStreams(token, activityId, ["time", "distance", "velocity_smooth", "heartrate", "altitude"])
    );
    if (!streams) return null;
    return stravaStreamsToSamples(streams, activityStartTimeS);
  } catch {
    return null;
  }
}

/**
 * Fetch the full GPS track for an activity.
 * Garmin: parses all trackpoints from GPX (lat/lon/ele/HR/cadence/time).
 * Strava: returns null for now — latlng stream support is a future addition.
 */
export async function fetchTrackForActivity(
  config: Config,
  activityId: string
): Promise<GpxTrackpoint[] | null> {
  if (config.dataSource === "garmin") {
    if (!config.garminEmail && !config.garminCookies) return null;
    try {
      const gpx = await fetchGarminActivityGpx(garminAuth(config), activityId);
      if (!gpx) return null;
      return parseGpxTrackpoints(gpx);
    } catch {
      return null;
    }
  }
  // Strava: TODO — fetch latlng+time+altitude streams
  return null;
}

export async function getActivityFromSource(
  config: Config,
  activityId: string
): Promise<RawActivity | { error: string }> {
  if (config.dataSource === "garmin") {
    if (!config.garminEmail || !config.garminPassword) {
      return { error: "Garmin credentials not configured." };
    }
    try {
      const activity = await getGarminActivity(garminAuth(config), activityId);
      if (!activity) return { error: `Garmin activity ${activityId} not found.` };
      return activity;
    } catch (err) {
      return { error: String(err) };
    }
  }

  // Default: Strava
  try {
    const activity = await withStravaRefresh(config, (token) => stravaGet(token, activityId));
    if (!activity) return { error: `Activity ${activityId} not found.` };
    return activity;
  } catch (err) {
    return { error: String(err) };
  }
}
