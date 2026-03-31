import type { RawActivity } from "../types.js";
import { STRAVA_RELAY_URL } from "../constants.js";

const STRAVA_API = "https://www.strava.com/api/v3";

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
}

// Strava activity shape (subset we care about)
interface StravaActivity {
  id: number;
  name: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  start_date: string;
  sport_type: string;
  start_latlng: [number, number] | null;
  map: {
    summary_polyline: string;
  };
}

interface StravaDetailedActivity extends StravaActivity {
  // Same shape, just more fields available — we only need these
}

/**
 * Refresh a Strava access token via the relay worker.
 * Throws on failure (caller should surface this to the user).
 */
export async function refreshAccessToken(tokens: StravaTokens): Promise<RefreshedTokens> {
  const res = await fetch(`${STRAVA_RELAY_URL}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Strava token refresh failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_at,
  };
}

/**
 * List activities from the Strava API.
 *
 * @param accessToken  Valid Strava access token
 * @param type         Activity type filter (default "Run") — Strava uses sport_type
 * @param limit        Max activities to return (default 30, max 200)
 * @param before       Unix timestamp — only return activities before this time
 * @param after        Unix timestamp — only return activities after this time
 */
export async function listActivities(
  accessToken: string,
  options: {
    type?: string;
    limit?: number;
    before?: number;
    after?: number;
  } = {}
): Promise<RawActivity[]> {
  const { limit = 30, before, after } = options;

  const params = new URLSearchParams({ per_page: Math.min(limit, 200).toString() });
  if (before) params.set("before", before.toString());
  if (after) params.set("after", after.toString());

  const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "switchbacks-mcp/0.1",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error("Strava access token expired — please refresh.");
    throw new Error(`Strava API error: ${res.status} ${res.statusText}`);
  }

  const activities = (await res.json()) as StravaActivity[];

  // Filter by type if requested (Strava API doesn't filter server-side by sport_type)
  const typeFilter = options.type?.toLowerCase();
  const filtered = typeFilter
    ? activities.filter((a) => a.sport_type.toLowerCase().includes(typeFilter) ||
        (typeFilter === "running" && ["run", "trailrun", "virtualrun"].some(
          (t) => a.sport_type.toLowerCase().includes(t)
        )))
    : activities;

  return filtered.map(stravaToRaw);
}

/**
 * Fetch a single activity by ID from the Strava API.
 */
export async function getActivity(
  accessToken: string,
  activityId: string
): Promise<RawActivity | null> {
  const res = await fetch(`${STRAVA_API}/activities/${activityId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "switchbacks-mcp/0.1",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Strava API error: ${res.status} ${res.statusText}`);
  }

  return stravaToRaw((await res.json()) as StravaDetailedActivity);
}

interface StravaStream {
  type: string;
  data: number[];
}

/**
 * Fetch per-point altitude (meters) for an activity via the Strava streams API.
 * Returns null if unavailable or the activity has no GPS.
 */
export async function fetchStravaAltitudeStream(
  accessToken: string,
  activityId: string
): Promise<number[] | null> {
  const streams = await fetchStravaStreams(accessToken, activityId, ["altitude"]);
  if (!streams) return null;
  const data = streams["altitude"];
  return Array.isArray(data) && data.length > 0 ? data : null;
}

/**
 * Fetch multiple Strava streams for an activity in a single request.
 * Returns a map of stream type → data array, or null on failure.
 *
 * Valid keys: "time", "distance", "latlng", "altitude", "velocity_smooth",
 *             "heartrate", "cadence", "watts", "temp", "moving", "grade_smooth"
 */
export async function fetchStravaStreams(
  accessToken: string,
  activityId: string,
  keys: string[]
): Promise<Record<string, number[]> | null> {
  try {
    const res = await fetch(
      `${STRAVA_API}/activities/${activityId}/streams?keys=${keys.join(",")}&key_by_type=true`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "switchbacks-mcp/0.1",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, StravaStream>;
    const result: Record<string, number[]> = {};
    for (const [key, stream] of Object.entries(json)) {
      if (Array.isArray(stream.data)) result[key] = stream.data;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function stravaToRaw(a: StravaActivity): RawActivity {
  return {
    id: String(a.id),
    name: a.name,
    distanceM: a.distance,
    movingTimeSec: a.moving_time,
    totalElevationGainM: a.total_elevation_gain,
    averageHeartrate: a.average_heartrate ?? null,
    maxHeartrate: a.max_heartrate ?? null,
    // Strava average_cadence is single-leg (strides/min) — double for total steps/min
    averageCadence: a.average_cadence != null ? a.average_cadence * 2 : null,
    startDate: a.start_date,
    startLatlng: a.start_latlng,
    summaryPolyline: a.map?.summary_polyline ?? null,
    type: a.sport_type,
  };
}
