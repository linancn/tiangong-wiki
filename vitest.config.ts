import { defineConfig } from "vitest/config";

const runningE2E = process.argv.some((argument) => argument.includes("tests/e2e"));

export default defineConfig({
  test: {
    testTimeout: runningE2E ? 300_000 : 30_000,
    hookTimeout: runningE2E ? 300_000 : 30_000,
    fileParallelism: !runningE2E,
    exclude: runningE2E ? ["node_modules/**", "dist/**"] : ["tests/e2e/**", "node_modules/**", "dist/**"],
  },
});
