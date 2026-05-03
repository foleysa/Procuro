/**
 * Public-API commodity reference collector. Fetches real daily-close
 * prices from Alpha Vantage for tracked commodities and emits them as
 * `commodity_index` market signals.
 *
 * Supported materials:
 *   - BRENT_OIL  → Alpha Vantage `BRENT` endpoint (daily)
 *   - LME_COPPER → Alpha Vantage `COPPER` endpoint (monthly, $/lb → $/tonne)
 *
 * Materials without a free public daily-close API source (HRC_STEEL,
 * PE_RESIN) are skipped gracefully — downstream consumers simply won't
 * receive signals for those scope codes from this collector. The World
 * Bank Pink Sheet collector and FRED PPI series partially cover these
 * materials through other signal types.
 *
 * Auth: requires `ALPHA_VANTAGE_API_KEY` env var. Free tier: 25 req/day,
 * 5 req/min. If unset, `collect()` returns empty drafts with a warning.
 *
 * Posture: `public-api` — Alpha Vantage has a published REST API with
 * documented rate limits.
 */

import { z } from "zod";
import { logger } from "../../logger";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
  CollectWithRawResult,
  RawPayload,
} from "../collector";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";

interface MaterialRef {
  material: string;
  unit: string;
  avFunction: string | null;
  avInterval: "daily" | "weekly" | "monthly";
  sourcePageUrl: string;
  conversionFactor?: number;
  conversionNote?: string;
}

const LBS_PER_TONNE = 2204.62;

const MATERIALS: MaterialRef[] = [
  {
    material: "LME_COPPER",
    unit: "USD/tonne",
    avFunction: "COPPER",
    avInterval: "monthly",
    sourcePageUrl: "https://www.lme.com/Metals/Non-ferrous/LME-Copper",
    conversionFactor: LBS_PER_TONNE,
    conversionNote: "Converted from USD/lb to USD/tonne",
  },
  {
    material: "BRENT_OIL",
    unit: "USD/bbl",
    avFunction: "BRENT",
    avInterval: "daily",
    sourcePageUrl:
      "https://www.theice.com/products/219/Brent-Crude-Futures",
  },
  {
    material: "HRC_STEEL",
    unit: "USD/tonne",
    avFunction: null,
    avInterval: "daily",
    sourcePageUrl:
      "https://www.cmegroup.com/markets/metals/ferrous/hrc-steel.html",
  },
  {
    material: "PE_RESIN",
    unit: "USD/tonne",
    avFunction: null,
    avInterval: "daily",
    sourcePageUrl:
      "https://www.icis.com/explore/commodities/chemicals/polyethylene/",
  },
];

const AV_API_BASE = "https://www.alphavantage.co/query";

interface AvDataPoint {
  date: string;
  value: string;
}

interface AvCommodityResponse {
  name?: string;
  interval?: string;
  unit?: string;
  data?: AvDataPoint[];
  Note?: string;
  Information?: string;
}

async function fetchCommodity(
  avFunction: string,
  interval: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ response: AvCommodityResponse; rawBody: string }> {
  const url = new URL(AV_API_BASE);
  url.searchParams.set("function", avFunction);
  url.searchParams.set("interval", interval);
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Alpha Vantage ${avFunction} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const rawBody = await res.text();
  const response = JSON.parse(rawBody) as AvCommodityResponse;
  return { response, rawBody };
}

function parseDraftsFromResponse(
  m: MaterialRef,
  response: AvCommodityResponse,
  latestOnly: boolean,
): MarketSignalDraft[] {
  if (response.Note) {
    logger.warn(
      { material: m.material, note: response.Note },
      "Alpha Vantage rate limit hit",
    );
    return [];
  }
  if (response.Information) {
    logger.warn(
      { material: m.material, info: response.Information },
      "Alpha Vantage API information/error",
    );
    return [];
  }

  const dataPoints = response.data;
  if (!dataPoints || dataPoints.length === 0) {
    logger.warn(
      { material: m.material },
      "Alpha Vantage returned no data points",
    );
    return [];
  }

  const candidates = dataPoints.filter(
    (d) =>
      d.value !== "." &&
      d.value !== "" &&
      Number.isFinite(Number(d.value)),
  );

  const toEmit = latestOnly ? candidates.slice(0, 1) : candidates;
  const drafts: MarketSignalDraft[] = [];

  for (const dp of toEmit) {
    let value = Number(dp.value);
    if (m.conversionFactor) {
      value = value * m.conversionFactor;
    }
    value = +value.toFixed(4);

    const observedAt = new Date(`${dp.date}T00:00:00Z`);
    if (Number.isNaN(observedAt.getTime())) {
      logger.warn(
        { material: m.material, date: dp.date },
        "Alpha Vantage: unparseable date — skipping data point",
      );
      continue;
    }

    drafts.push({
      signalType: "commodity_index" as const,
      scopeMaterialCode: m.material,
      value,
      unit: m.unit,
      currency: "USD",
      observedAt,
      sourceUrl: m.sourcePageUrl,
      confidence: 0.9,
      metadata: {
        feed: `alpha-vantage-${m.avFunction!.toLowerCase()}`,
        basis: m.avInterval === "daily" ? "daily_close" : `${m.avInterval}_close`,
        ...(m.conversionFactor
          ? {
              rawValue: Number(dp.value),
              conversionFactor: m.conversionFactor,
              conversionNote: m.conversionNote,
            }
          : {}),
      },
    });
  }

  return drafts;
}

const commodityMetadataSchema = z
  .object({
    feed: z.string().min(1),
    basis: z.string().optional(),
  })
  .passthrough();

const commoditySignalSchema = buildSignalDraftSchema(commodityMetadataSchema);

export const PUBLISHED_COMMODITY_INDEX_COLLECTOR_ID =
  "published-commodity-index";

export const publishedCommodityIndexCollector: IntelligenceCollector<
  typeof commoditySignalSchema
> = {
  id: PUBLISHED_COMMODITY_INDEX_COLLECTOR_ID,
  name: "Published Commodity Index",
  description:
    "Daily reference prices for tracked commodities (Brent crude, copper) sourced from Alpha Vantage public API.",
  posture: "public-api",
  sourceUrl: "https://www.alphavantage.co/documentation/",
  defaultRateLimitRpm: 5,
  defaultScheduleCron: "0 */6 * * *",
  postureClass: "public_api",
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

  async collectWithRaw({ signal, mode }): Promise<CollectWithRawResult> {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      logger.warn(
        "ALPHA_VANTAGE_API_KEY not set — published-commodity-index collector returning empty drafts",
      );
      return { drafts: [], rawPayloads: [] };
    }

    const latestOnly = mode !== "backfill";
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];

    for (const m of MATERIALS) {
      if (!m.avFunction) {
        logger.debug(
          { material: m.material },
          "No Alpha Vantage source for material — skipping",
        );
        continue;
      }

      try {
        const { response, rawBody } = await fetchCommodity(
          m.avFunction,
          m.avInterval,
          apiKey,
          signal,
        );

        rawPayloads.push({
          name: `${PUBLISHED_COMMODITY_INDEX_COLLECTOR_ID}_${m.material}`,
          contentType: "application/json",
          sourceUrl: `${AV_API_BASE}?function=${m.avFunction}`,
          body: rawBody,
          metadata: { material: m.material, avFunction: m.avFunction },
        });

        const materialDrafts = parseDraftsFromResponse(
          m,
          response,
          latestOnly,
        );
        drafts.push(...materialDrafts);
      } catch (err) {
        logger.error(
          { material: m.material, err },
          "Failed to fetch commodity price from Alpha Vantage",
        );
      }
    }

    return { drafts, rawPayloads };
  },

  async collect({ signal, mode }): Promise<MarketSignalDraft[]> {
    const result = await publishedCommodityIndexCollector.collectWithRaw!({
      since: null,
      signal,
      mode,
    });
    return result.drafts;
  },
};
