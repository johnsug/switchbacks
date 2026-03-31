import { createServer as httpCreateServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { getSetupHtml, getSuccessHtml } from "./ui.js";
import { SETUP_PORT } from "./constants.js";
import { exchangeStravaCode } from "./strava-auth.js";
import { testAndSaveGarminPassword, garminSSOWithPlaywright } from "./garmin-auth.js";

export function createSetupServer(): Server {
  return httpCreateServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String(err) }));
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const base = `http://localhost:${SETUP_PORT}`;
  const url  = new URL(req.url ?? "/", base);
  const path = url.pathname;
  const method = req.method ?? "GET";

  res.setHeader("Access-Control-Allow-Origin", "*");

  // ── Main setup page ──────────────────────────────────────────────────────
  if (path === "/" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getSetupHtml());
    return;
  }

  // ── Strava OAuth redirect ─────────────────────────────────────────────────
  // (The HTML page navigates here; we redirect to Strava's auth URL)
  // Strava auth URL is embedded in the HTML itself, so this route isn't used.
  // Kept for future direct-link support.

  // ── Strava OAuth callback ─────────────────────────────────────────────────
  if (path === "/callback/strava" && method === "GET") {
    const code  = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (!code || error) {
      const msg = error ?? "no_code";
      res.writeHead(302, { Location: `/?error=${encodeURIComponent(msg)}` });
      res.end();
      return;
    }

    const result = await exchangeStravaCode(code);
    if (result.success) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getSuccessHtml("Strava"));
    } else {
      res.writeHead(302, { Location: `/?error=${encodeURIComponent(result.error)}` });
      res.end();
    }
    return;
  }

  // ── Garmin password auth ──────────────────────────────────────────────────
  if (path === "/auth/garmin/password" && method === "POST") {
    const body = await readBody(req);
    let email: string, password: string;
    try {
      ({ email, password } = JSON.parse(body) as { email: string; password: string });
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid request body" }));
      return;
    }
    const result = await testAndSaveGarminPassword(email, password);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Garmin Google/Apple SSO ───────────────────────────────────────────────
  if (path === "/auth/garmin/sso" && method === "POST") {
    const provider = url.searchParams.get("provider");
    if (provider !== "google" && provider !== "apple") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "provider must be 'google' or 'apple'" }));
      return;
    }
    // This blocks while the user authenticates in the Playwright window (up to 2 min)
    const result = await garminSSOWithPlaywright(provider);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404);
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
