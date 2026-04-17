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
