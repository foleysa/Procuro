import { defineConfig } from "vitest/config";

/**
 * Coverage thresholds (Task #392, enforced 2026-05-04).
 *
 * Pinned to the Task #392 baseline so the suite fails if regression-gate
 * coverage regresses below current levels. Raise these as new tests land.
 *
 *   Statements : 61.38%  (62/101)
 *   Branches   : 44.82%  (26/58)
 *   Functions  : 76.92%  (10/13)
 *   Lines      : 57.77%  (52/90)
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/check-regression-tests.ts"],
      exclude: [],
      thresholds: {
        statements: 61,
        branches: 44,
        functions: 76,
        lines: 57,
      },
    },
  },
});
