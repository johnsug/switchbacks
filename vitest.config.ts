import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in real Node.js subprocesses so node: built-ins (including
    // node:sqlite) are resolved natively instead of through Vite's bundler.
    pool: "forks",
  },
});
