import { STRAVA_RELAY_URL } from "../constants.js";
import { mergeAndWriteConfig } from "./config-writer.js";

interface RelayTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export async function exchangeStravaCode(
  code: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const res = await fetch(`${STRAVA_RELAY_URL}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { success: false, error: `Relay error ${res.status}: ${text}` };
    }

    const json = (await res.json()) as RelayTokenResponse;

    mergeAndWriteConfig({
      dataSource:          "strava",
      stravaAccessToken:   json.access_token,
      stravaRefreshToken:  json.refresh_token,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
