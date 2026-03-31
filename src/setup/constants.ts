// Client ID is public (appears in OAuth authorize URLs). Secret lives in the Cloudflare worker.
export const STRAVA_CLIENT_ID = "21597";
export const SETUP_PORT       = 8788;
export const STRAVA_REDIRECT_URI   = `http://localhost:${SETUP_PORT}/callback/strava`;
export const STRAVA_SCOPE          = "activity:read_all";
