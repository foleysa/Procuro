/**
 * Pulse edition tags are **lenses** on one horizontal judgment desk.
 * They are not product identities, niches, or live-coverage claims.
 *
 * Day 0–30 skins: Industrial MRO (`mro`) and Food & Ag (`food`).
 * Logistics is a Core lens, not a third company.
 */

/** First skins shipped in parallel under Pulse Core. */
export const pulseDay030EditionTags = ["mro", "food"] as const;
export type PulseDay030EditionTag = (typeof pulseDay030EditionTags)[number];

/**
 * Cross-cutting logistics / freight lens. Lives in Pulse Core.
 * Do not sell or brand this tag as the company.
 */
export const pulseCoreLensTags = ["logistics"] as const;
export type PulseCoreLensTag = (typeof pulseCoreLensTags)[number];

/**
 * Reserved edition tags — named so the data model stays multi-vertical.
 * Presence here is **not** a claim that a depth kit or Pulse skin is live.
 */
export const pulseReservedEditionTags = [
  "energy",
  "aero",
  "healthcare",
  "packaging",
  "discrete",
] as const;
export type PulseReservedEditionTag = (typeof pulseReservedEditionTags)[number];

export const pulseEditionTags = [
  ...pulseDay030EditionTags,
  ...pulseReservedEditionTags,
  ...pulseCoreLensTags,
] as const;
export type PulseEditionTag = (typeof pulseEditionTags)[number];

const EDITION_TAG_SET = new Set<string>(pulseEditionTags);

export function isPulseEditionTag(value: string): value is PulseEditionTag {
  return EDITION_TAG_SET.has(value);
}

export function isPulseDay030EditionTag(
  value: string,
): value is PulseDay030EditionTag {
  return (pulseDay030EditionTags as readonly string[]).includes(value);
}

/** Human labels for packaging copy. Not SKUs, not niche brands. */
export const pulseEditionLabel: Record<PulseEditionTag, string> = {
  mro: "Industrial MRO",
  food: "Food & Ag",
  energy: "Energy & Utilities",
  aero: "Aerospace / Defense-adjacent",
  healthcare: "Healthcare Ops",
  packaging: "Packaging & Materials",
  discrete: "Discrete Manufacturing / OEM",
  logistics: "Logistics & Freight (core lens)",
};

/**
 * How a Pulse product edition maps to Layer C / issue tags.
 * Core is always on; editions add lenses. Logistics is Core, not an unlock.
 */
export const pulseEditionToTags = {
  core: ["logistics"] as const satisfies readonly PulseEditionTag[],
  mro: ["mro"] as const satisfies readonly PulseEditionTag[],
  food: ["food"] as const satisfies readonly PulseEditionTag[],
} as const;

export type PulseProductEdition = keyof typeof pulseEditionToTags;

export function tagsForPulseEdition(
  edition: PulseProductEdition,
): readonly PulseEditionTag[] {
  return pulseEditionToTags[edition];
}
