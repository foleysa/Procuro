import { defineConfig } from "vitest/config";

/**
 * Coverage baseline (Task #315, established 2026-05-03):
 *   Statements : 60%   (33/55)
 *   Branches   : 56%   (28/50)
 *   Functions  : 72.72% (8/11)
 *   Lines      : 66.66% (32/48)
 *
 * Threshold enforcement is deferred to a follow-up task.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/schema/**"],
    },
  },
});
