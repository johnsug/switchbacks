# Setup Guide

## Requirements

- Node.js 22.5+ (for built-in `node:sqlite`)
- pnpm (`npm install -g pnpm`)
- Claude Desktop or any MCP-compatible client

---

## Install

```bash
git clone https://github.com/YOUR_USERNAME/switchbacks-mcp
cd switchbacks-mcp
pnpm install
pnpm build
```

---

## Configure

### Option A: Use with GetFast MCP (recommended, no Strava setup needed)

If you already have the [GetFast MCP](https://getfast.ai) configured in Claude Desktop, Switchbacks MCP can accept its activity data directly — no Strava credentials required.

Just pass the `activities` parameter when calling tools:
```
"Use GetFast to get my last 20 runs, then pass them to Switchback's get_recent_runs"
```

No `.env` file needed.

### Option B: Direct Strava API

```bash
cp .env.example .env
```

Edit `.env` with your Strava app credentials. Get them from [strava.com/settings/api](https://www.strava.com/settings/api).

You'll need to complete the OAuth flow once to get an access token and refresh token. The simplest way is with `curl`:

```bash
# 1. Open this URL in your browser (replace CLIENT_ID):
https://www.strava.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=activity:read_all

# 2. After approving, grab the `code` from the redirect URL

# 3. Exchange for tokens:
curl -X POST https://www.strava.com/oauth/token \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d code=YOUR_CODE \
  -d grant_type=authorization_code
```

Copy `access_token` and `refresh_token` from the response into `.env`.

### Option C: Config file

Create `~/.switchbacks-mcp/config.json`:
```json
{
  "strava_access_token": "...",
  "strava_refresh_token": "...",
  "strava_client_id": "...",
  "strava_client_secret": "...",
  "timezone": "America/Denver",
  "gap_coefficient": 8
}
```

---

## Add to Claude Desktop

Edit `~/.config/claude/claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "switchbacks-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/switchbacks-mcp/dist/index.js"],
      "env": {
        "STRAVA_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop. The Switchbacks MCP tools will appear automatically.

---

## Verify

Ask Claude:
> "Use Switchback to show my recent runs"

If you're using GetFast:
> "Get my last 10 activities from GetFast, then use Switchback's get_recent_runs to analyze them"

---

## Cache

The SQLite cache lives at `~/.switchbacks-mcp/cache.db`. Weather and elevation data are cached permanently (historical data doesn't change). Activity enrichments expire after 24 hours.

To clear the cache:
```bash
rm ~/.switchbacks-mcp/cache.db
```

---

## Troubleshooting

**"No activity data provided and no Strava token configured"**
→ Either pass `activities` from GetFast, or add your Strava token to the config.

**"Strava access token expired"**
→ Your token needs refreshing. Switchback does not auto-refresh yet — re-run the OAuth flow.

**Weather or elevation missing from results**
→ Open-Elevation and Open-Meteo are free public APIs that occasionally time out. The run will still appear with GAP applied; weather/altitude adjustments will be skipped with a warning in the output.
