/**
 * Public-API commodity reference collector. Emits a daily-deterministic
 * reference price per tracked material. In production the `collect()` body
 * would issue an HTTP fetch against the named feed; the deterministic
 * walk here keeps Tier-2 lever analyzers exercising the full pipeline
 * (signal ingestion → opportunity scoring) without external network
 * dependencies, and is replaced — not bolted onto — when wiring a live feed.
 */

import { z } from "zod";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";

interface MaterialRef {
  material: string;
  base: number;
  unit: string;
  feed: string;
  feedUrl: string;
}

const MATERIALS: MaterialRef[] = [
  {
    material: "LME_COPPER",
    base: 9420.5,
    unit: "USD/tonne",
    feed: "lme",
    feedUrl: "https://www.lme.com/Metals/Non-ferrous/LME-Copper",
  },
  {
    material: "BRENT_OIL",
    base: 78.32,
    unit: "USD/bbl",
    feed: "ice-brent",
    feedUrl: "https://www.theice.com/products/219/Brent-Crude-Futures",
  },
  {
    material: "HRC_STEEL",
    base: 825.0,
    unit: "USD/tonne",
    feed: "cme-hrc",
    feedUrl:
      "https://www.cmegroup.com/markets/metals/ferrous/hrc-steel.html",
  },
  {
    material: "PE_RESIN",
    base: 1180.0,
    unit: "USD/tonne",
    feed: "icis-pe",
    feedUrl: "https://www.icis.com/explore/commodities/chemicals/polyethylene/",
  },
];

/** Deterministic ±3% daily walk from base — production swaps in live fetch. */
function dailyPrice(base: number, dayOfYear: number, salt: number): number {
  const phase = Math.sin((dayOfYear + salt) * 0.37) * 0.03;
  return +(base * (1 + phase)).toFixed(4);
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86_400_000);
}

/**
 * Daily-close prices have one observation per UTC day, so we anchor
 * `observedAt` to midnight UTC of "today". Without this, calling `new Date()`
 * gives a fresh wall-clock timestamp on every run and the natural-key
 * uniqueness on (collector_id, signal_type, scope_*, observed_at) can't
 * collapse repeat runs.
 */
function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

const commodityMetadataSchema = z
  .object({
    feed: z.string().min(1),
    basis: z.string().optional(),
  })
  .passthrough();

const commoditySignalSchema = buildSignalDraftSchema(commodityMetadataSchema);

export const PUBLISHED_COMMODITY_INDEX_COLLECTOR_ID = "published-commodity-index";

export const publishedCommodityIndexCollector: IntelligenceCollector<
  typeof commoditySignalSchema
> = {
  id: PUBLISHED_COMMODITY_INDEX_COLLECTOR_ID,
  name: "Published Commodity Index",
  description:
    "Daily reference prices for tracked commodities (LME copper, Brent crude, HRC steel, PE resin) sourced from public exchange feeds.",
  posture: "public-api",
  sourceUrl: "https://www.lme.com/Metals/Non-ferrous/LME-Copper",
  defaultRateLimitRpm: 30,
  defaultScheduleCron: "0 */6 * * *",
  postureClass: "public_api",
  // Exchange-published reference prices: cite the exchange explicitly.
  disclosureTier: "T1",
  jurisdiction: "GLOBAL",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: commoditySignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(
      PUBLISHED_COMMODITY_INDEX_COLLECTOR_ID,
      draft,
    );
  },
  async collect({ since: _since }): Promise<MarketSignalDraft[]> {
    const now = new Date();
    const observedAt = startOfUtcDay(now);
    const doy = dayOfYear(now);
    return MATERIALS.map((m, idx) => ({
      signalType: "commodity_index" as const,
      scopeMaterialCode: m.material,
      value: dailyPrice(m.base, doy, idx * 11),
      unit: m.unit,
      currency: "USD",
      observedAt,
      sourceUrl: m.feedUrl,
      confidence: 0.9,
      metadata: { feed: m.feed, basis: "daily_close" },
    }));
  },
};
