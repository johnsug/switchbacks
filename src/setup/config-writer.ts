import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR  = join(homedir(), ".switchbacks-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type PartialConfig = Record<string, unknown>;

export function readStoredConfig(): PartialConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as PartialConfig;
  } catch {
    return {};
  }
}

export function mergeAndWriteConfig(updates: PartialConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const merged = { ...readStoredConfig(), ...updates };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}
