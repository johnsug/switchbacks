import type { WeatherRecord } from "../cache.js";

const BASE_URL = "https://archive-api.open-meteo.com/v1/archive";

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    relativehumidity_2m: number[];
    dewpoint_2m: number[];
    apparent_temperature: number[];
    windspeed_10m: number[];
    precipitation: number[];
  };
}

/**
 * Fetch historical weather from Open-Meteo for a given location and date.
 * Free, no API key required.
 *
 * @param lat       Latitude
 * @param lon       Longitude
 * @param date      Date string "YYYY-MM-DD"
 * @param timezone  IANA timezone string (e.g. "America/Chicago")
 * @param startHour Optional 0–23 hour to use for point-in-time conditions.
 *                  If omitted, averages all hours for the day.
 * @returns WeatherRecord or null on any failure (network, parse, etc.)
 */
export async function fetchWeather(
  lat: number,
  lon: number,
  date: string,
  timezone: string,
  startHour?: number
): Promise<WeatherRecord | null> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    start_date: date,
    end_date: date,
    hourly: "temperature_2m,relativehumidity_2m,dewpoint_2m,apparent_temperature,windspeed_10m,precipitation",
    timezone,
    temperature_unit: "fahrenheit",
    windspeed_unit: "mph",
    precipitation_unit: "inch",
  });

  try {
    const res = await fetch(`${BASE_URL}?${params}`, {
      headers: { "User-Agent": "switchbacks-mcp/0.1" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as OpenMeteoResponse;
    return parseResponse(json, startHour);
  } catch {
    return null;
  }
}

function parseResponse(
  json: OpenMeteoResponse,
  startHour?: number
): WeatherRecord | null {
  const h = json.hourly;
  if (!h?.time?.length) return null;

  // Pick indices to average: either all hours or the specific run hour
  let indices: number[];
  if (startHour !== undefined) {
    // Use the nearest available hour
    const idx = h.time.findIndex((t) => {
      const hour = new Date(t).getHours();
      return hour === startHour;
    });
    indices = idx >= 0 ? [idx] : h.time.map((_, i) => i);
  } else {
    indices = h.time.map((_, i) => i);
  }

  const pick = <T extends number>(arr: T[]): number[] =>
    indices.map((i) => arr[i]).filter((v) => v !== null && v !== undefined && !isNaN(v));

  const avg = (vals: number[]): number =>
    vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  const sum = (vals: number[]): number =>
    vals.reduce((a, b) => a + b, 0);

  return {
    tempF:          avg(pick(h.temperature_2m)),
    humidityPct:    avg(pick(h.relativehumidity_2m)),
    dewpointF:      avg(pick(h.dewpoint_2m)),
    apparentTempF:  avg(pick(h.apparent_temperature)),
    windMph:        avg(pick(h.windspeed_10m)),
    precipIn:       sum(pick(h.precipitation)),
  };
}

/**
 * Extract the date string (YYYY-MM-DD) from an ISO datetime and a timezone.
 * Used to build the cache key and API request for a given activity.
 */
export function isoDateInTimezone(isoDatetime: string, timezone: string): string {
  const date = new Date(isoDatetime);
  return date.toLocaleDateString("en-CA", { timeZone: timezone }); // "en-CA" gives YYYY-MM-DD
}

/**
 * Extract the hour (0–23) from an ISO datetime in a given timezone.
 */
export function isoHourInTimezone(isoDatetime: string, timezone: string): number {
  const date = new Date(isoDatetime);
  return parseInt(
    date.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: timezone }),
    10
  );
}
