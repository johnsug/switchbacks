import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { Cache } from "./cache.js";
import { buildMcpServer } from "./mcp-server.js";

// Catch anything that slips through so Railway logs show the real error
process.on("uncaughtException",  (err) => { console.error("Uncaught exception:", err);  process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("Unhandled rejection:", err); process.exit(1); });

// ── Hosted mode (Railway / any server with DATA_DIR set) ────────────────────
if (process.env["DATA_DIR"]) {
  const { startHostedServer } = await import("./hosted.js");
  startHostedServer();
}
// ── Local stdio mode (Claude Desktop running node directly) ─────────────────
else {
  // Config is reloaded per tool call so credentials written by setup are picked
  // up immediately without restarting the MCP server.
  const initialConfig = loadConfig();
  const cache = new Cache(initialConfig.cacheDir);

  // setup_auth is only available in local mode — it opens a browser window
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { startSetupServer } = await import("./setup/index.js");
  const { z } = await import("zod");

  const server = new McpServer({ name: "switchbacks-mcp", version: "0.1.0" });

  server.tool(
    "setup_auth",
    "Connect your Strava or Garmin account. Opens a browser window where you can sign in — including with Google or Apple. Call this first if no credentials are configured.",
    {},
    async () => {
      const config   = loadConfig();
      const hasStrava = !!config.stravaAccessToken;
      const hasGarmin = (config.garminAuthType === "password" && !!config.garminEmail && !!config.garminPassword)
                     || (config.garminAuthType === "sso"      && !!config.garminCookies);

      if (hasStrava || hasGarmin) {
        const service = hasStrava ? "Strava" : "Garmin";
        return { content: [{ type: "text", text: `Already connected to ${service}. To switch accounts, delete ~/.switchbacks-mcp/config.json and call setup_auth again.` }] };
      }

      const url = await startSetupServer();
      return {
        content: [{
          type: "text",
          text: `Setup page opened at ${url}\n\nChoose Strava or Garmin, sign in (including with Google or Apple), and return here once the page shows "You're connected!" — your next request will work immediately.`,
        }],
      };
    }
  );

  // Register remaining tools from shared builder, then connect
  const toolServer = buildMcpServer(loadConfig(), cache);
  // Copy tools from toolServer into server by re-registering — instead, just
  // use toolServer directly for the stdio transport.
  void z; // suppress unused import warning

  const transport = new StdioServerTransport();
  await toolServer.connect(transport);
}
