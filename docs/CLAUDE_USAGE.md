# Example Claude Prompts

These prompts work well with Switchbacks MCP. Copy and adapt them.

---

## Getting started

```
Show me my last 20 runs with full adjustments applied.
```

```
Get my recent runs from GetFast and analyze them with Switchback — I want to see
grade-adjusted pace, altitude correction, and efficiency for each one.
```

---

## Fitness trend

```
Am I getting fitter? Show me my weekly aerobic efficiency trend over the last 12 weeks.
```

```
Compare my efficiency_full trend this month vs last month. Account for terrain and conditions.
```

```
Plot my fitness trend — has my aerobic efficiency been improving, declining, or flat?
```

---

## Single activity deep dive

```
Analyze my run from last Saturday in detail. Walk me through the full adjustment
waterfall — what did terrain, altitude, and humidity each cost me?
```

```
How did that mountain run rank compared to my other runs? Was it actually a strong effort
once you account for the climbing and altitude?
```

---

## Period comparison

```
Compare my fitness from January through March vs April through June.
Was the spring training block actually effective?
```

```
I took 3 weeks off in February. Compare the month before vs the month after
to see if I lost much fitness. Filter out runs under 4 miles.
```

---

## Weather impact

```
How much does humidity slow me down? Analyze the last 90 days and show me
how my efficiency varies with dew point.
```

```
When have been my best running conditions this summer? Show me the days
with favorable weather where I performed well.
```

---

## Race prediction

```
I'm racing a 50K this fall: 31 miles, 6,500 ft gain, average elevation 8,200 ft,
expecting 65°F dew point. What's my realistic finish time?
```

```
Estimate my time for a local marathon (26.2 miles, 800 ft gain, sea level,
expecting dry conditions). Give me conservative, target, and aggressive pace bands.
```

```
I'm pacing a friend at a trail race next month: 25 miles, 4,200 ft gain,
7,500 ft average elevation, forecast dew point 58°F. What pace should I plan for?
```

---

## Tips

- **GetFast + Switchback together:** GetFast gets raw activity data; Switchback enriches it. Ask Claude to chain them: *"Get activities from GetFast and analyze with Switchback."*
- **Historical data is cached:** The first time you analyze a run, weather and elevation are fetched and stored. Subsequent calls for the same runs are instant.
- **Efficiency is the north star:** `efficiency_full` is the most comparable metric across runs. Track it weekly to see true fitness trends.
- **Dew point > temperature:** When asking about weather impact, focus on dew point rather than temperature. It's a more accurate predictor of perceived effort.
