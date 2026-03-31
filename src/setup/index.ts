import { createSetupServer } from "./server.js";
import { exec } from "node:child_process";
import type { Server } from "node:http";
import { SETUP_PORT } from "./constants.js";

let _server: Server | null = null;

/**
 * Start the setup HTTP server (idempotent — safe to call multiple times).
 * Opens the browser automatically and returns the local URL.
 */
export function startSetupServer(): Promise<string> {
  const url = `http://localhost:${SETUP_PORT}`;

  if (_server?.listening) {
    openBrowser(url);
    return Promise.resolve(url);
  }

  return new Promise((resolve, reject) => {
    _server = createSetupServer();

    _server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Server already running from a previous call — just open the browser
        openBrowser(url);
        resolve(url);
      } else {
        reject(err);
      }
    });

    _server.listen(SETUP_PORT, "127.0.0.1", () => {
      openBrowser(url);
      resolve(url);
    });
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"  ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd);
}

// ── Standalone script entry point ─────────────────────────────────────────────
// Run directly with: node dist/setup/index.js
const isMain = process.argv[1]?.endsWith("setup/index.js");
if (isMain) {
  startSetupServer()
    .then((url) => console.log(`Switchbacks setup running at ${url}`))
    .catch((err) => { console.error("Setup failed:", err); process.exit(1); });
}
