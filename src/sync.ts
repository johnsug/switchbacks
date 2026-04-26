/**
 * Local sync script — fetch and enrich recent activities, write to
 * ~/.switchbacks-mcp/activities.json for use with the Claude skill.
 *
 * Usage:
 *   node dist/sync.js             # last 90 days (default)
 *   node dist/sync.js --days 180  # last 180 days
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { loadConfig } from "./config.js";
import { Cache } from "./cache.js";
import { listActivitiesFromSource } from "./sources/resolver.js";
import { enrichActivities } from "./enricher.js";
import { formatRun } from "./tools/get_recent_runs.js";
import { SECS_PER_DAY } from "./utils/units.js";

const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? "90", 10) : 90;

if (isNaN(days) || days <= 0) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

console.log(`Switchbacks sync — last ${days} days`);

const config = loadConfig();

if (!config.stravaAccessToken && !config.garminEmail && !config.garminCookies) {
  console.error(
    "No credentials found. Run `pnpm setup` or configure ~/.switchbacks-mcp/config.json first."
  );
  process.exit(1);
}

const cache = new Cache(config.cacheDir);
const after = Math.floor(Date.now() / 1000) - days * SECS_PER_DAY;

const rawOrError = await listActivitiesFromSource(config, {
  type: "running",
  limit: 200,
  after,
});

if ("error" in rawOrError) {
  console.error("Failed to fetch activities:", rawOrError.error);
  process.exit(1);
}

// Running types: Run, TrailRun, VirtualRun, etc.
const running = rawOrError.filter((a) => {
  const t = a.type.toLowerCase();
  return t.includes("run");
});

console.log(`Fetched ${running.length} runs — enriching (weather, elevation, adjustments)...`);

const enriched = await enrichActivities(running, cache, config, {
  includeWeather: true,
  includeElevationProfile: true,
});

const activities = enriched.map(formatRun);

const outDir = join(homedir(), ".switchbacks-mcp");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "activities.json");

writeFileSync(
  outPath,
  JSON.stringify(
    {
      synced_at: new Date().toISOString(),
      days_back: days,
      count: activities.length,
      activities,
    },
    null,
    2
  )
);

console.log(`✓ ${activities.length} activities written to ${outPath}`);
