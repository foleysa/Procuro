import type { LeverId } from "@workspace/db";
import type { LeverAnalyzer } from "./types";
import { TIER_1_LEVERS } from "./tier1";
import { TIER_2_LEVERS } from "./tier2";
import { TIER_4_LEVERS } from "./fx-exposure";

export const ALL_LEVERS: LeverAnalyzer[] = [
  ...TIER_1_LEVERS,
  ...TIER_2_LEVERS,
  ...TIER_4_LEVERS,
];

export const LEVER_REGISTRY: Record<string, LeverAnalyzer> = Object.fromEntries(
  ALL_LEVERS.map((l) => [l.leverId, l]),
);

export function getLever(id: LeverId): LeverAnalyzer | undefined {
  return LEVER_REGISTRY[id];
}

export * from "./types";
export { TIER_1_LEVERS, TIER_2_LEVERS, TIER_4_LEVERS };
