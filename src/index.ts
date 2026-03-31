import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { Cache } from "./cache.js";
import { getRecentRuns } from "./tools/get_recent_runs.js";
import { getFitnessTrend } from "./tools/get_fitness_trend.js";
import { getActivityDetail } from "./tools/get_activity_detail.js";
import { comparePeriods } from "./tools/compare_periods.js";
import { getWeatherImpact } from "./tools/get_weather_impact.js";
import { estimateRaceTime } from "./tools/estimate_race_time.js";
import { getIntervalAnalysis } from "./tools/get_interval_analysis.js";
import { startSetupServer } from "./setup/index.js";

// Cache is initialized once — cacheDir is fixed at startup.
// Config is reloaded per tool call so credentials written by setup are picked up
// without restarting the MCP server.
const _initialConfig = loadConfig();
const cache = new Cache(_initialConfig.cacheDir);

const server = new McpServer({
  name: "switchbacks-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// setup_auth  — connect Strava or Garmin account
// ---------------------------------------------------------------------------
server.tool(
  "setup_auth",
  "Connect your Strava or Garmin account. Opens a browser window where you can sign in — including with Google or Apple. Call this first if no credentials are configured.",
  {},
  async () => {
    const config = loadConfig();
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

// ---------------------------------------------------------------------------
// get_recent_runs
// ---------------------------------------------------------------------------
server.tool(
  "get_recent_runs",
  "Fetch and enrich recent runs with grade-adjusted pace, altitude and heat adjustments, and aerobic efficiency index. Uses the configured Strava or Garmin data source.",
  {
    days_back:                 z.number().int().positive().optional().describe("Limit to last N days"),
    activity_type:             z.string().optional().default("running").describe("Activity type filter (default: running)"),
    include_weather:           z.boolean().optional().default(true).describe("Fetch weather data and apply heat adjustment"),
    include_elevation_profile: z.boolean().optional().default(true).describe("Fetch elevation profiles and apply altitude adjustment"),
    limit:                     z.number().int().min(1).max(100).optional().default(20).describe("Max runs to return (default 20)"),
  },
  async (params) => {
    const result = await getRecentRuns(params, cache, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// get_fitness_trend
// ---------------------------------------------------------------------------
server.tool(
  "get_fitness_trend",
  "Weekly aggregated aerobic efficiency trend over a date range. Shows whether fitness is improving, stable, or declining — normalized for terrain and conditions.",
  {
    weeks:  z.number().int().min(2).max(52).optional().default(12).describe("Number of weeks to analyze (default 12)"),
    metric: z.enum(["efficiency_raw", "efficiency_gap", "efficiency_full"]).optional().default("efficiency_full")
               .describe("Which efficiency metric to trend (default: efficiency_full)"),
  },
  async (params) => {
    const result = await getFitnessTrend(params, cache, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// get_activity_detail
// ---------------------------------------------------------------------------
server.tool(
  "get_activity_detail",
  "Deep dive on a single activity: full adjustment waterfall (Raw → GAP → Altitude → Heat), terrain context, and efficiency vs recent history.",
  {
    activity_id:   z.string().describe("Strava or Garmin activity ID"),
    history_days:  z.number().int().min(14).max(365).optional().default(90).describe("Days of recent history to use for comparison (default 90)"),
  },
  async (params) => {
    const result = await getActivityDetail(params, cache, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// compare_periods
// ---------------------------------------------------------------------------
server.tool(
  "compare_periods",
  "Compare fitness between two date ranges, normalized for terrain and conditions. Answers: am I fitter now than 3 months ago?",
  {
    period_a_start:     z.string().describe("Period A start date (YYYY-MM-DD)"),
    period_a_end:       z.string().describe("Period A end date (YYYY-MM-DD)"),
    period_b_start:     z.string().describe("Period B start date (YYYY-MM-DD)"),
    period_b_end:       z.string().describe("Period B end date (YYYY-MM-DD)"),
    min_distance_miles: z.number().positive().optional().default(3.0).describe("Min distance to include (default 3 miles, filters shakeouts)"),
  },
  async (params) => {
    const result = await comparePeriods(params, cache, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// get_weather_impact
// ---------------------------------------------------------------------------
server.tool(
  "get_weather_impact",
  "Analyze how weather and humidity have affected your performance. Shows dew point distribution, correlation with efficiency, and your personal pace slow-down per 10°F dew point increase.",
  {
    days_back: z.number().int().positive().optional().default(90).describe("Days of history to analyze (default 90)"),
  },
  async (params) => {
    const result = await getWeatherImpact(params, cache, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// estimate_race_time
// ---------------------------------------------------------------------------
server.tool(
  "estimate_race_time",
  "Predict finish time for a target race based on your recent fitness, adjusted for course terrain, altitude, and expected race-day conditions.",
  {
    distance_miles:         z.number().positive().describe("Race distance in miles"),
    elevation_gain_ft:      z.number().min(0).describe("Total course elevation gain in feet"),
    avg_route_elevation_ft: z.number().min(0).describe("Average route elevation in feet (for altitude adjustment)"),
    expected_temp_f:        z.number().optional().describe("Expected race temperature °F"),
    expected_dewpoint_f:    z.number().optional().describe("Expected race dew point °F (drives heat adjustment)"),
    baseline_weeks:         z.number().int().min(1).max(26).optional().default(8).describe("Weeks of recent runs to use for baseline (default 8)"),
  },
  async (params) => {
    const result = await estimateRaceTime(params, cache, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// get_interval_analysis
// ---------------------------------------------------------------------------
server.tool(
  "get_interval_analysis",
  "Detect interval reps within a specific run and compare them side-by-side. Identifies warm-up, reps, rest periods, and cool-down. Shows per-rep pace, HR, distance, and flags pacing drift across reps. Requires an activity ID with GPS data.",
  {
    activity_id:       z.string().describe("Strava or Garmin activity ID"),
    fast_fraction:     z.number().min(0.05).max(0.40).optional()
                         .describe("How much faster than easy pace counts as a rep (default 0.12 = 12%)"),
    min_rep_duration_s: z.number().int().min(10).max(600).optional()
                         .describe("Minimum rep duration in seconds (default 30)"),
    min_rep_distance_m: z.number().positive().optional()
                         .describe("Minimum rep distance in meters (default 100)"),
  },
  async (params) => {
    const result = await getIntervalAnalysis(params, loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
