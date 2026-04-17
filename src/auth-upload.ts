/**
 * Local CLI — captures Garmin session cookies via Playwright and uploads them
 * to the hosted server so you can use the hosted MCP without re-authenticating.
 *
 * Run from the project root after building:
 *   node dist/auth-upload.js --server https://switchbacks.up.railway.app --token YOUR-UUID
 *
 * First-time setup (creates a new user, requires ADMIN_SECRET):
 *   node dist/auth-upload.js --server URL --admin-secret SECRET [--data-source garmin|strava]
 */

const args = parseArgs(process.argv.slice(2));

const serverUrl   = args["server"];
const token       = args["token"];
const adminSecret = args["admin-secret"];
const dataSource  = (args["data-source"] ?? "garmin") as "garmin" | "strava";

if (!serverUrl) {
  console.error("Usage: node dist/auth-upload.js --server URL [--token UUID | --admin-secret SECRET]");
  process.exit(1);
}

(async () => {
  let userToken = token;

  // ── Step 1: create user if no token provided ────────────────────────────────
  if (!userToken) {
    if (!adminSecret) {
      console.error("Provide --token UUID or --admin-secret SECRET to create a new user.");
      process.exit(1);
    }

    const createRes = await fetch(`${serverUrl}/admin/create-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminSecret}`,
      },
      body: JSON.stringify({ data_source: dataSource }),
    });

    if (!createRes.ok) {
      console.error("Failed to create user:", await createRes.text());
      process.exit(1);
    }

    const created = (await createRes.json()) as { token: string; mcp_url: string };
    userToken = created.token;
    console.log(`Created user token: ${userToken}`);
  }

  // ── Step 2: capture Garmin cookies via Playwright ───────────────────────────
  console.log("\nOpening Garmin sign-in. Sign in with Google, then close or wait for redirect...\n");

  let playwrightChromium: typeof import("playwright").chromium;
  try {
    playwrightChromium = (await import("playwright")).chromium;
  } catch {
    console.error("Playwright not installed. Run: pnpm run install-browser");
    process.exit(1);
  }

  const browser = await playwrightChromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto("https://connect.garmin.com/signin/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  // Click the Google button (handles both iframe and top-level layouts)
  const frame  = page.frameLocator("iframe").first();
  const btn    = frame.locator('[class*="google" i], [data-testid*="google" i], [aria-label*="Google" i]').first();
  const topBtn = page.locator('[class*="google" i], [data-testid*="google" i], [aria-label*="Google" i]').first();

  await Promise.race([
    btn.click({ timeout: 15_000 }),
    topBtn.click({ timeout: 15_000 }),
  ]).catch(() => {
    console.log("Could not auto-click Google button — please click it manually in the browser.");
  });

  // Wait for Google SSO popup and then for final Garmin Connect redirect
  await context.waitForEvent("page").catch(() => null);

  console.log("Waiting for you to complete sign-in (up to 3 minutes)...");
  await page.waitForURL(
    (url) => url.hostname.includes("connect.garmin.com") && !url.pathname.includes("signin"),
    { timeout: 180_000 }
  );

  const rawCookies = await context.cookies([
    "https://connect.garmin.com",
    "https://sso.garmin.com",
  ]);

  const cookies: Record<string, string> = {};
  for (const c of rawCookies) cookies[c.name] = c.value;

  await browser.close();

  // ── Step 3: upload cookies to hosted server ─────────────────────────────────
  console.log(`\nUploading ${Object.keys(cookies).length} cookies to ${serverUrl}...`);

  const uploadRes = await fetch(`${serverUrl}/api/upload-garmin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: userToken, cookies }),
  });

  if (!uploadRes.ok) {
    console.error("Upload failed:", await uploadRes.text());
    process.exit(1);
  }

  const result = (await uploadRes.json()) as { ok: boolean; mcp_url: string };
  console.log("\nSuccess! Add this to your Claude Desktop config:\n");
  console.log(`  "url": "${result.mcp_url}"\n`);
  console.log("Then restart Claude Desktop and you're ready.");
})().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key?.startsWith("--") && val && !val.startsWith("--")) {
      out[key.slice(2)] = val;
      i++;
    }
  }
  return out;
}
