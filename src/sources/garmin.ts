/**
 * Garmin Connect unofficial API client.
 *
 * Uses cookie-based SSO authentication — same credentials as connect.garmin.com.
 * No API key required. Sessions are cached in-process for ~55 minutes.
 *
 * Auth flow:
 *   1. GET SSO embed page → extract CSRF token
 *   2. POST credentials → redirect contains ticket parameter
 *   3. GET Connect with ticket → establishes session cookies
 *   4. All subsequent requests use those cookies
 */

import type { RawActivity } from "../types.js";
import { encodePolyline } from "../utils/polyline.js";

const SSO = "https://sso.garmin.com/sso";
const CONNECT = "https://connect.garmin.com";
const MODERN = `${CONNECT}/modern/`;

// ---------------------------------------------------------------------------
// Session cache (in-process, keyed by email)
// ---------------------------------------------------------------------------

interface Session {
  cookies: Map<string, string>;
  expiresAt: number;
}

const _sessions = new Map<string, Session>();

// ---------------------------------------------------------------------------
// Auth type
// ---------------------------------------------------------------------------

export type GarminAuth =
  | { type: "password"; email: string; password: string }
  | { type: "sso"; cookies: Record<string, string> };

async function ensureSession(auth: GarminAuth): Promise<Map<string, string>> {
  const cacheKey = auth.type === "password" ? auth.email : "__sso__";
  const cached   = _sessions.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.cookies;

  if (auth.type === "sso") {
    const cookieMap = new Map(Object.entries(auth.cookies));
    _sessions.set("__sso__", { cookies: cookieMap, expiresAt: Date.now() + 55 * 60 * 1000 });
    return cookieMap;
  }

  const cookies = await ssoLogin(auth.email, auth.password);
  _sessions.set(auth.email, { cookies, expiresAt: Date.now() + 55 * 60 * 1000 });
  return cookies;
}

// ---------------------------------------------------------------------------
// SSO login
// ---------------------------------------------------------------------------

export async function ssoLogin(email: string, password: string): Promise<Map<string, string>> {
  const ssoParams = new URLSearchParams({
    id: "gauth-widget",
    embedWidget: "true",
    gauthHost: SSO,
    service: MODERN,
    source: MODERN,
    redirectAfterAccountLoginUrl: MODERN,
    redirectAfterAccountCreationUrl: MODERN,
  });
  const signinUrl = `${SSO}/signin?${ssoParams}`;

  // Step 1: Load login page for CSRF token
  const pageRes = await fetch(signinUrl, {
    headers: browserHeaders(),
    redirect: "manual",
  });
  const pageCookies = extractCookies(pageRes.headers);
  const html = await pageRes.text();

  const csrf = html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  if (!csrf) {
    throw new Error(
      "Garmin SSO: CSRF token not found. Garmin may have updated their login page."
    );
  }

  // Step 2: POST credentials
  const body = new URLSearchParams({
    username: email,
    password,
    _csrf: csrf,
    embed: "true",
    gauthHost: SSO,
    service: MODERN,
    source: MODERN,
    redirectAfterAccountLoginUrl: MODERN,
    redirectAfterAccountCreationUrl: MODERN,
  });

  const loginRes = await fetch(signinUrl, {
    method: "POST",
    headers: {
      ...browserHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": serializeCookies(pageCookies),
      "Referer": signinUrl,
    },
    body: body.toString(),
    redirect: "manual",
  });

  mergeCookies(pageCookies, extractCookies(loginRes.headers));

  // Ticket is in the Location redirect header
  const location = loginRes.headers.get("location") ?? "";
  let ticket = location.match(/ticket=([^&]+)/)?.[1] ?? null;

  if (!ticket) {
    // Fall back: ticket sometimes appears in the response body
    const responseText = await loginRes.text();
    ticket = responseText.match(/ticket=([A-Z0-9-]+)/)?.[1] ?? null;

    if (!ticket) {
      const errMsg =
        responseText.match(/id="error-message-container"[^>]*>([^<]+)/)?.[1]?.trim() ??
        responseText.match(/class="error-message[^"]*"[^>]*>([^<]+)/)?.[1]?.trim() ??
        "Invalid credentials or Garmin login page changed.";
      throw new Error(`Garmin login failed: ${errMsg}`);
    }
  }

  // Step 3: Exchange ticket at Connect to establish session cookies
  let currentUrl = `${MODERN}?ticket=${ticket}`;
  let maxRedirects = 5;

  while (maxRedirects-- > 0) {
    const res = await fetch(currentUrl, {
      headers: {
        ...browserHeaders(),
        "Cookie": serializeCookies(pageCookies),
      },
      redirect: "manual",
    });
    mergeCookies(pageCookies, extractCookies(res.headers));

    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get("location");
    if (!next) break;
    currentUrl = next;
  }

  if (pageCookies.size === 0) {
    throw new Error("Garmin SSO: authentication succeeded but no session cookies received.");
  }

  return pageCookies;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Download the GPX file for an activity. Returns raw XML string, or null on failure.
 * Uses the same session cookies as all other Garmin requests.
 */
export async function fetchGarminActivityGpx(
  auth: GarminAuth,
  activityId: string
): Promise<string | null> {
  try {
    const session = await ensureSession(auth);
    const res = await fetch(
      `${CONNECT}/download-service/export/gpx/activity/${activityId}`,
      {
        headers: {
          "Cookie": serializeCookies(session),
          "NK": "NT",
          "Accept": "application/gpx+xml, text/xml, */*",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Di-Backend": "connectapi.garmin.com",
        },
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

export async function listGarminActivities(
  auth: GarminAuth,
  options: { limit?: number; after?: number; before?: number } = {}
): Promise<RawActivity[]> {
  const session = await ensureSession(auth);
  const { limit = 30, after, before } = options;

  const params = new URLSearchParams({
    start: "0",
    limit: String(Math.min(limit, 100)),
    activityType: "running",
  });
  if (after) params.set("startDate", epochToDate(after * 1000));
  if (before) params.set("endDate", epochToDate(before * 1000));

  const data = await garminGet(
    `${CONNECT}/activitylist-service/activities/search/activities?${params}`,
    session
  );

  if (!Array.isArray(data)) return [];
  return data.flatMap((a) => {
    const norm = normalizeSummary(a);
    return norm ? [norm] : [];
  });
}

export async function getGarminActivity(
  auth: GarminAuth,
  activityId: string
): Promise<RawActivity | null> {
  const session = await ensureSession(auth);

  // Fetch detail endpoint — richer than summary, may include GPS
  const data = await garminGet(
    `${CONNECT}/activity-service/activity/${activityId}`,
    session
  );
  if (!data || typeof data !== "object") return null;
  return normalizeDetail(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeSummary(a: unknown): RawActivity | null {
  if (!a || typeof a !== "object") return null;
  const r = a as Record<string, unknown>;

  const id = r["activityId"];
  const distanceM = num(r["distance"]) ?? 0;
  const movingTimeSec = num(r["movingDuration"]) ?? num(r["elapsedDuration"]) ?? 0;

  if (!id || distanceM <= 0 || movingTimeSec <= 0) return null;

  const startLat = num(r["startLatitude"]);
  const startLon = num(r["startLongitude"]);

  return {
    id: String(id),
    name: str(r["activityName"]) ?? "Untitled",
    distanceM,
    movingTimeSec,
    totalElevationGainM: num(r["elevationGain"]) ?? 0,
    averageHeartrate: num(r["averageHR"]),
    maxHeartrate: num(r["maxHR"]),
    averageCadence: parseCadence(r),
    startDate: parseGarminDate(str(r["startTimeGMT"]) ?? ""),
    startLatlng: startLat != null && startLon != null ? [startLat, startLon] : null,
    summaryPolyline: null, // Not available in list endpoint
    type: parseActivityType(r),
    vo2MaxScore: num(r["vO2MaxValue"]),
  };
}

function normalizeDetail(r: Record<string, unknown>): RawActivity | null {
  // Detail response wraps fields in a summaryDTO
  const s = (r["summaryDTO"] as Record<string, unknown> | null) ?? r;

  const id = r["activityId"];
  const distanceM = num(s["distance"]) ?? num(r["distance"]) ?? 0;
  const movingTimeSec = num(s["movingDuration"]) ?? num(r["movingDuration"]) ?? num(s["elapsedDuration"]) ?? 0;

  if (!id || distanceM <= 0 || movingTimeSec <= 0) return null;

  const startLat = num(s["startLatitude"]) ?? num(r["startLatitude"]);
  const startLon = num(s["startLongitude"]) ?? num(r["startLongitude"]);

  return {
    id: String(id),
    name: str(r["activityName"]) ?? "Untitled",
    distanceM,
    movingTimeSec,
    totalElevationGainM: num(s["elevationGain"]) ?? num(r["elevationGain"]) ?? 0,
    averageHeartrate: num(s["averageHR"]) ?? num(r["averageHR"]),
    maxHeartrate: num(s["maxHR"]) ?? num(r["maxHR"]),
    averageCadence: parseCadence(s) ?? parseCadence(r),
    startDate: parseGarminDate(str(s["startTimeGMT"]) ?? str(r["startTimeGMT"]) ?? ""),
    startLatlng: startLat != null && startLon != null ? [startLat, startLon] : null,
    summaryPolyline: extractPolyline(r),
    type: parseActivityType(r),
    vo2MaxScore: num(s["vO2MaxValue"]) ?? num(r["vO2MaxValue"]),
  };
}

/** Extract a Google-encoded polyline from Garmin's geoPolylineDTO field, if present. */
function extractPolyline(r: Record<string, unknown>): string | null {
  const geo = r["geoPolylineDTO"] as Record<string, unknown> | null;
  if (!geo) return null;

  const pts = geo["polyline"] as Array<Record<string, unknown>> | null;
  if (!Array.isArray(pts) || pts.length < 2) return null;

  const latLons = pts
    .map((p) => [num(p["lat"]), num(p["lon"])] as [number | null, number | null])
    .filter((p): p is [number, number] => p[0] != null && p[1] != null);

  return latLons.length >= 2 ? encodePolyline(latLons) : null;
}

/**
 * Garmin's API returns cadence as single-leg steps per minute despite the field name
 * "averageRunningCadenceInStepsPerMinute". Multiply by 2 to get total steps per minute.
 * Biking cadence (RPM) is already full-rotation and is returned as-is.
 */
function parseCadence(r: Record<string, unknown>): number | null {
  const runCadence =
    num(r["averageRunningCadenceInStepsPerMinute"]) ??
    num(r["averageRunCadence"]);
  if (runCadence !== null) return runCadence * 2;

  const bikeCadence = num(r["averageBikingCadenceInRPM"]);
  return bikeCadence;
}

function parseActivityType(r: Record<string, unknown>): string {
  const typeKey =
    str((r["activityType"] as Record<string, unknown> | null)?.["typeKey"]) ??
    str(r["activityType"]);
  if (!typeKey) return "running";
  const lower = typeKey.toLowerCase();
  if (lower.includes("trail")) return "TrailRun";
  if (lower.includes("run")) return "Run";
  return typeKey;
}

function parseGarminDate(raw: string): string {
  if (!raw) return new Date().toISOString();
  // Garmin format: "2024-01-15 12:30:00" (UTC)
  return new Date(raw.replace(" ", "T") + "Z").toISOString();
}

function epochToDate(ms: number): string {
  return new Date(ms).toISOString().split("T")[0]!;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function garminGet(url: string, session: Map<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "Cookie": serializeCookies(session),
      "NK": "NT", // Required by Garmin Connect API
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Di-Backend": "connectapi.garmin.com",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    // Invalidate cached session so next call re-authenticates
    for (const [k, v] of _sessions.entries()) {
      if (v.cookies === session) {
        _sessions.delete(k);
        break;
      }
    }
    throw new Error("Garmin session expired — will re-authenticate on next request.");
  }

  if (!res.ok) {
    throw new Error(`Garmin API ${res.status}: ${res.statusText} — ${url}`);
  }

  return res.json();
}

function extractCookies(headers: Headers): Map<string, string> {
  const map = new Map<string, string>();
  const rawHeaders: string[] =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=[^ ])/);

  for (const h of rawHeaders) {
    const [pair = ""] = h.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) {
      map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  return map;
}

function mergeCookies(base: Map<string, string>, updates: Map<string, string>): void {
  for (const [k, v] of updates) base.set(k, v);
}

function serializeCookies(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function browserHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Origin": "https://sso.garmin.com",
  };
}

// ---------------------------------------------------------------------------
// Type-safe field accessors
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
