/**
 * Hosted HTTP server — SSE MCP transport + OAuth routes.
 *
 * Environment variables required:
 *   DATA_DIR      — path to persistent disk (e.g. /data on Railway)
 *   SERVER_URL    — public base URL (e.g. https://switchbacks.up.railway.app)
 *   ADMIN_SECRET  — secret for /admin/create-user endpoint
 *   PORT          — HTTP port (Railway sets this automatically)
 *
 * Optional (Strava OAuth):
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { UserDb } from "./db.js";
import { Cache } from "./cache.js";
import { loadConfigForUser } from "./config.js";
import { buildMcpServer } from "./mcp-server.js";
import { getRecentRuns } from "./tools/get_recent_runs.js";

const DATA_DIR     = process.env["DATA_DIR"]!;
const SERVER_URL   = (process.env["SERVER_URL"] ?? "").replace(/\/$/, "");
const ADMIN_SECRET = process.env["ADMIN_SECRET"] ?? "";
const PORT         = parseInt(process.env["PORT"] ?? "3000", 10);

const STRAVA_CLIENT_ID     = process.env["STRAVA_CLIENT_ID"] ?? "";
const STRAVA_CLIENT_SECRET = process.env["STRAVA_CLIENT_SECRET"] ?? "";
const STRAVA_TOKEN_URL     = "https://www.strava.com/oauth/token";
const STRAVA_REDIRECT_PATH = "/callback/strava";

// One UserDb instance shared across all requests
const userDb = new UserDb(DATA_DIR);

// Active SSE transports — last connection per user token wins
const activeTransports = new Map<string, SSEServerTransport>();

export function startHostedServer(): void {
  console.log(`Starting Switchbacks hosted server...`);
  console.log(`DATA_DIR=${DATA_DIR} PORT=${PORT} SERVER_URL=${SERVER_URL}`);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  server.on("error", (err) => {
    console.error("HTTP server error:", err);
    process.exit(1);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Switchbacks hosted server running on port ${PORT}`);
    console.log(`Public URL: ${SERVER_URL}`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url    = new URL(req.url ?? "/", `http://localhost`);
  const path   = url.pathname;
  const method = req.method ?? "GET";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Health check ────────────────────────────────────────────────────────────
  if (path === "/health" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── MCP SSE connection: GET /mcp/:token ─────────────────────────────────────
  const sseMatch = path.match(/^\/mcp\/([0-9a-f-]+)$/i);
  if (sseMatch && method === "GET") {
    const token = sseMatch[1]!;
    const user  = userDb.getUser(token);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown token. Visit /connect to set up." }));
      return;
    }

    const config    = loadConfigForUser(user, DATA_DIR);
    const cache     = new Cache(config.cacheDir);
    const mcpServer = buildMcpServer(config, cache);
    const postPath  = `/mcp/${token}/message`;

    const transport = new SSEServerTransport(postPath, res);
    activeTransports.set(token, transport);

    req.on("close", () => {
      activeTransports.delete(token);
    });

    await mcpServer.connect(transport);
    return;
  }

  // ── MCP message: POST /mcp/:token/message ───────────────────────────────────
  const msgMatch = path.match(/^\/mcp\/([0-9a-f-]+)\/message$/i);
  if (msgMatch && method === "POST") {
    const token     = msgMatch[1]!;
    const transport = activeTransports.get(token);
    if (!transport) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No active SSE connection for this token." }));
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  // ── Strava OAuth callback: GET /callback/strava ─────────────────────────────
  if (path === STRAVA_REDIRECT_PATH && method === "GET") {
    const code  = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // user token passed as state
    const error = url.searchParams.get("error");

    if (!code || !state || error) {
      res.writeHead(302, { Location: `/?error=${encodeURIComponent(error ?? "auth_failed")}` });
      res.end();
      return;
    }

    const user = userDb.getUser(state);
    if (!user) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Unknown user token in OAuth state.");
      return;
    }

    // Exchange code directly (server holds the secret)
    const tokenRes = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => tokenRes.statusText);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Strava error: ${text}`);
      return;
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    userDb.updateStravaTokens(state, tokens.access_token, tokens.refresh_token);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(connectedHtml("Strava", `${SERVER_URL}/mcp/${state}`));
    return;
  }

  // ── Upload Garmin cookies from local CLI: POST /api/upload-garmin ───────────
  if (path === "/api/upload-garmin" && method === "POST") {
    const body = await readBody(req);
    let payload: { token: string; cookies: Record<string, string>; email?: string };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.token || !payload.cookies) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing token or cookies" }));
      return;
    }

    const user = userDb.getUser(payload.token);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown token" }));
      return;
    }

    userDb.updateGarminCookies(payload.token, payload.cookies, payload.email);

    const mcpUrl = `${SERVER_URL}/mcp/${payload.token}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mcp_url: mcpUrl }));
    return;
  }

  // ── Admin: create user token: POST /admin/create-user ───────────────────────
  if (path === "/admin/create-user" && method === "POST") {
    const authHeader = req.headers["authorization"] ?? "";
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const body = await readBody(req);
    let payload: { data_source?: "strava" | "garmin" } = {};
    try { payload = JSON.parse(body) as typeof payload; } catch { /* use defaults */ }

    const token  = userDb.createUser(payload.data_source ?? "garmin");
    const mcpUrl = `${SERVER_URL}/mcp/${token}`;

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ token, mcp_url: mcpUrl }));
    return;
  }

  // ── Activities API: GET /api/activities/:token ──────────────────────────────
  const activitiesMatch = path.match(/^\/api\/activities\/([0-9a-f-]+)$/i);
  if (activitiesMatch && method === "GET") {
    const token = activitiesMatch[1]!;
    const user  = userDb.getUser(token);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown token" }));
      return;
    }

    const days  = parseInt(url.searchParams.get("days")  ?? "90",  10);
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

    const config = loadConfigForUser(user, DATA_DIR);
    const cache  = new Cache(config.cacheDir);
    const result = await getRecentRuns(
      { days_back: days, limit, include_weather: true, include_elevation_profile: true },
      cache,
      config
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Friend dashboard: GET /dashboard/:token ─────────────────────────────────
  const dashMatch = path.match(/^\/dashboard\/([0-9a-f-]+)$/i);
  if (dashMatch && method === "GET") {
    const token = dashMatch[1]!;
    const user  = userDb.getUser(token);
    if (!user) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Not found</h1><p>That link doesn't look right.</p>");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml(token, SERVER_URL));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function dashboardHtml(token: string, serverUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Switchbacks</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f8f9fa; color: #1a1a1a; min-height: 100vh; }
    header { background: #fff; border-bottom: 1px solid #e5e7eb;
             padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; font-weight: 700; }
    header span { font-size: 22px; }
    .subhead { font-size: 13px; color: #888; margin-left: auto; }
    main { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
             gap: 16px; margin-bottom: 32px; }
    .stat { background: #fff; border-radius: 12px; padding: 20px;
            box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    .stat-label { font-size: 12px; color: #888; font-weight: 500;
                  text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
    .stat-value { font-size: 26px; font-weight: 700; }
    .stat-sub   { font-size: 12px; color: #aaa; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #fff;
            border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    thead th { background: #f1f3f5; font-size: 11px; font-weight: 600;
               text-transform: uppercase; letter-spacing: .06em; color: #555;
               padding: 12px 14px; text-align: left; }
    tbody tr { border-top: 1px solid #f1f3f5; }
    tbody tr:hover { background: #fafafa; }
    td { padding: 12px 14px; font-size: 14px; vertical-align: middle; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 20px;
            font-size: 12px; font-weight: 500; }
    .pill-green  { background: #d1fae5; color: #065f46; }
    .pill-yellow { background: #fef3c7; color: #92400e; }
    .pill-red    { background: #fee2e2; color: #991b1b; }
    .pace-row { display: flex; flex-direction: column; gap: 2px; }
    .pace-main { font-weight: 600; }
    .pace-adj  { font-size: 12px; color: #888; }
    .weather-icon { margin-right: 4px; }
    #loading { text-align: center; padding: 80px; color: #aaa; font-size: 16px; }
    #error   { text-align: center; padding: 80px; color: #c00; }
    .refresh { background: none; border: 1px solid #d1d5db; border-radius: 8px;
               padding: 6px 14px; font-size: 13px; cursor: pointer; color: #555; }
    .refresh:hover { background: #f3f4f6; }
  </style>
</head>
<body>
<header>
  <span>🏃</span>
  <h1>Switchbacks</h1>
  <div class="subhead" id="sync-time"></div>
  <button class="refresh" onclick="load()">Refresh</button>
</header>
<main>
  <div class="stats" id="stats"></div>
  <div id="loading">Loading your runs…</div>
  <div id="error" style="display:none"></div>
  <table id="run-table" style="display:none">
    <thead>
      <tr>
        <th>Date</th>
        <th>Name</th>
        <th>Miles</th>
        <th>Time</th>
        <th>Vert</th>
        <th>Pace (raw → adjusted)</th>
        <th>HR</th>
        <th>Fitness</th>
        <th>Weather</th>
      </tr>
    </thead>
    <tbody id="run-body"></tbody>
  </table>
</main>
<script>
const API = '${serverUrl}/api/activities/${token}?days=90&limit=50';

async function load() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('error').style.display   = 'none';
  document.getElementById('run-table').style.display = 'none';
  document.getElementById('stats').innerHTML = '';

  let data;
  try {
    const r = await fetch(API);
    if (!r.ok) throw new Error(await r.text());
    data = await r.json();
  } catch (e) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    document.getElementById('error').textContent = 'Could not load runs: ' + e.message;
    return;
  }

  document.getElementById('loading').style.display = 'none';

  const runs = data.runs || [];
  if (!runs.length) {
    document.getElementById('error').style.display = 'block';
    document.getElementById('error').textContent = 'No runs found in the last 90 days.';
    return;
  }

  // ── Summary stats ───────────────────────────────────────────────────────────
  const totalMiles  = runs.reduce((s, r) => s + (r.distance_miles || 0), 0);
  const avgHr       = avg(runs.map(r => r.avg_hr).filter(Boolean));
  const recentEff   = avg(runs.slice(0, 8).map(r => r.efficiency?.full).filter(Boolean));
  const olderEff    = avg(runs.slice(8, 16).map(r => r.efficiency?.full).filter(Boolean));
  const trend       = recentEff && olderEff ? ((recentEff - olderEff) / olderEff * 100) : null;

  document.getElementById('stats').innerHTML = [
    stat(runs.length + ' runs', totalMiles.toFixed(0) + ' miles', 'last 90 days'),
    stat(avgHr ? Math.round(avgHr) + ' bpm' : '—', 'avg heart rate', ''),
    recentEff
      ? stat(recentEff.toFixed(4), 'fitness score',
             trend !== null ? (trend > 0 ? '↑ ' : '↓ ') + Math.abs(trend).toFixed(1) + '% vs prev 8 runs' : '')
      : '',
  ].join('');

  document.getElementById('sync-time').textContent =
    'Updated ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

  // ── Run rows ────────────────────────────────────────────────────────────────
  const tbody = document.getElementById('run-body');
  tbody.innerHTML = runs.map(r => {
    const eff = r.efficiency?.full;
    const effPill = eff
      ? '<span class="pill ' + effClass(eff) + '">' + eff.toFixed(4) + '</span>'
      : '<span style="color:#ccc">—</span>';

    const paceAdj = r.pace?.heat_adj || r.pace?.alt_adj || r.pace?.gap;
    const paceCell = paceAdj && paceAdj !== r.pace?.raw
      ? '<div class="pace-row"><span class="pace-main">' + (r.pace?.raw||'—') + '</span>'
        + '<span class="pace-adj">→ ' + paceAdj + ' adj</span></div>'
      : '<span class="pace-main">' + (r.pace?.raw||'—') + '</span>';

    const wx = r.weather
      ? weatherIcon(r.weather.temp_f, r.weather.dewpoint_f)
        + Math.round(r.weather.temp_f) + '°F'
        + (r.weather.dewpoint_f >= 60
           ? ' <small style="color:#c07000">dp ' + Math.round(r.weather.dewpoint_f) + '°</small>'
           : '')
      : '—';

    return '<tr>'
      + '<td>' + fmtDate(r.date) + '</td>'
      + '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name||'') + '</td>'
      + '<td>' + (r.distance_miles||0).toFixed(1) + '</td>'
      + '<td>' + (r.duration||'—') + '</td>'
      + '<td>' + (r.elevation_gain_ft ? Math.round(r.elevation_gain_ft).toLocaleString() + ' ft' : '—') + '</td>'
      + '<td>' + paceCell + '</td>'
      + '<td>' + (r.avg_hr ? Math.round(r.avg_hr) : '—') + '</td>'
      + '<td>' + effPill + '</td>'
      + '<td style="font-size:13px">' + wx + '</td>'
      + '</tr>';
  }).join('');

  document.getElementById('run-table').style.display = 'table';
}

function avg(arr) { return arr.length ? arr.reduce((a,b) => a+b, 0)/arr.length : null; }

function effClass(v) {
  if (v >= 0.020) return 'pill-green';
  if (v >= 0.015) return 'pill-yellow';
  return 'pill-red';
}

function weatherIcon(temp, dp) {
  if (dp >= 65) return '<span class="weather-icon">🥵</span>';
  if (temp <= 32) return '<span class="weather-icon">🥶</span>';
  if (temp >= 80) return '<span class="weather-icon">☀️</span>';
  return '<span class="weather-icon">🌤️</span>';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString([], { month:'short', day:'numeric' });
}

function esc(s) {
  return s.replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function stat(value, label, sub) {
  return '<div class="stat">'
    + '<div class="stat-label">' + esc(label) + '</div>'
    + '<div class="stat-value">' + esc(String(value)) + '</div>'
    + (sub ? '<div class="stat-sub">' + esc(sub) + '</div>' : '')
    + '</div>';
}

load();
</script>
</body>
</html>`;
}

function connectedHtml(service: string, mcpUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Switchbacks — Connected</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f0f2f5; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 20px; padding: 52px 44px;
            width: 460px; box-shadow: 0 8px 40px rgba(0,0,0,0.13); text-align: center; }
    h1 { font-size: 22px; font-weight: 700; margin: 14px 0 8px; }
    p  { font-size: 14px; color: #777; line-height: 1.6; margin-bottom: 16px; }
    .url { background: #f4f4f5; border-radius: 8px; padding: 10px 14px;
           font-family: monospace; font-size: 13px; word-break: break-all;
           color: #111; text-align: left; }
  </style>
</head>
<body>
<div class="card">
  <div style="font-size:54px">✅</div>
  <h1>Connected to ${service}!</h1>
  <p>Add this URL to your Claude Desktop config under <code>mcpServers</code>:</p>
  <div class="url">${mcpUrl}</div>
  <p style="margin-top:16px">Then restart Claude Desktop and you're ready.</p>
</div>
</body>
</html>`;
}
