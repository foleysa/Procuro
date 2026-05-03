import { defineConfig } from "vitest/config";

/**
 * Coverage thresholds (Task #321, enforced 2026-05-03).
 *
 * Pinned to the Task #315 baseline so the suite fails if S2P data-model
 * coverage regresses below current levels. Raise these as new tests land.
 *
 *   Statements : 60%   (33/55)
 *   Branches   : 56%   (28/50)
 *   Functions  : 72.72% (8/11)
 *   Lines      : 66.66% (32/48)
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/schema/**"],
      thresholds: {
        statements: 60,
        branches: 56,
        functions: 72,
        lines: 66,
      },
    },
  },
});
