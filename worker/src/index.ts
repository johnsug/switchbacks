/**
 * Switchbacks OAuth relay — Cloudflare Worker
 *
 * Holds the Strava client secret server-side so it never appears in the
 * public repo. Exposes two endpoints:
 *
 *   POST /exchange  { code }           → Strava token response
 *   POST /refresh   { refresh_token }  → Strava token response
 *
 * Deploy secrets (never commit these):
 *   npx wrangler secret put STRAVA_CLIENT_ID
 *   npx wrangler secret put STRAVA_CLIENT_SECRET
 */

export interface Env {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
}

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/exchange") {
      return handleExchange(request, env);
    }

    if (url.pathname === "/refresh") {
      return handleRefresh(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

async function handleExchange(request: Request, env: Env): Promise<Response> {
  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.code) {
    return jsonResponse({ error: "Missing code" }, 400);
  }

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code: body.code,
      grant_type: "authorization_code",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    return jsonResponse({ error: `Strava error ${res.status}: ${text}` }, res.status);
  }

  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  let body: { refresh_token?: string };
  try {
    body = (await request.json()) as { refresh_token?: string };
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.refresh_token) {
    return jsonResponse({ error: "Missing refresh_token" }, 400);
  }

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    return jsonResponse({ error: `Strava error ${res.status}: ${text}` }, res.status);
  }

  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
