/**
 * EIA Energy Prices collector.
 *
 * Pulls the latest observation from a curated set of US Energy Information
 * Administration v2 series (crude oil, natural gas, retail diesel/gasoline,
 * industrial electricity) and emits them as `commodity_index` market signals.
 *
 * Energy is a cost driver across nearly every spend category — fuel for
 * logistics, natural gas for plastics & metals, electricity for industrial
 * production — so feeding live energy prices into the OODA pipeline gives
 * Tier-2 lever analyzers timely macro context.
 *
 * EIA v2 docs: https://www.eia.gov/opendata/documentation.php
 *   GET https://api.eia.gov/v2/seriesid/{seriesId}?api_key=...&length=1
 */

import { z } from "zod";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";

interface EiaSeriesConfig {
  seriesId: string;
  materialCode: string;
  /** Canonical unit string we store in `marketSignalsTable.unit`. */
  canonicalUnit: string;
  /** Frequency reported by EIA — informational, also stored in metadata. */
  frequency: "daily" | "weekly" | "monthly";
  /** Public-facing series page; preferred over the raw API URL. */
  seriesPageUrl: string;
}

const SERIES: EiaSeriesConfig[] = [
  {
    seriesId: "PET.RWTC.D",
    materialCode: "WTI_OIL",
    canonicalUnit: "USD/bbl",
    frequency: "daily",
    seriesPageUrl: "https://www.eia.gov/dnav/pet/hist/RWTCD.htm",
  },
  {
    seriesId: "NG.RNGWHHD.D",
    materialCode: "HENRY_HUB_GAS",
    canonicalUnit: "USD/MMBtu",
    frequency: "daily",
    seriesPageUrl: "https://www.eia.gov/dnav/ng/hist/rngwhhdD.htm",
  },
  {
    seriesId: "PET.EMD_EPD2D_PTE_NUS_DPG.W",
    materialCode: "US_DIESEL_RETAIL",
    canonicalUnit: "USD/gal",
    frequency: "weekly",
    seriesPageUrl:
      "https://www.eia.gov/dnav/pet/hist/emd_epd2d_pte_nus_dpgW.htm",
  },
  {
    seriesId: "PET.EMM_EPM0_PTE_NUS_DPG.W",
    materialCode: "US_GASOLINE_RETAIL",
    canonicalUnit: "USD/gal",
    frequency: "weekly",
    seriesPageUrl:
      "https://www.eia.gov/dnav/pet/hist/emm_epm0_pte_nus_dpgW.htm",
  },
  {
    seriesId: "ELEC.PRICE.US-IND.M",
    materialCode: "US_INDUSTRIAL_ELEC",
    canonicalUnit: "cents/kWh",
    frequency: "monthly",
    seriesPageUrl:
      "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_06_a",
  },
];

interface EiaDataPoint {
  period: string;
  value: number | string | null;
  units?: string;
}

interface EiaResponse {
  response?: {
    data?: EiaDataPoint[];
    frequency?: string;
    "data-format"?: string;
  };
  error?: string;
}

/**
 * EIA periods come in three shapes depending on frequency:
 *  - daily:   "YYYY-MM-DD"
 *  - weekly:  "YYYY-MM-DD" (week-ending Monday)
 *  - monthly: "YYYY-MM"
 *
 * We normalize all of them to a UTC `Date`, anchored at the start of the
 * period (midnight UTC for day/week, first-of-month for monthly).
 */
function parsePeriodToUtc(period: string): Date {
  const monthly = /^(\d{4})-(\d{2})$/.exec(period);
  if (monthly) {
    const [, y, m] = monthly;
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  }
  const daily = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (daily) {
    const [, y, m, d] = daily;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }
  // Fallback — let Date parse and hope.
  const fallback = new Date(period);
  if (Number.isNaN(fallback.getTime())) {
    throw new Error(`Cannot parse EIA period string: ${period}`);
  }
  return fallback;
}

async function fetchLatestPoint(
  series: EiaSeriesConfig,
  apiKey: string,
): Promise<{ point: EiaDataPoint; rawUnit: string | undefined }> {
  const url = new URL(
    `https://api.eia.gov/v2/seriesid/${encodeURIComponent(series.seriesId)}`,
  );
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("length", "1");

  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `EIA fetch failed for ${series.seriesId}: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as EiaResponse;
  if (json.error) {
    throw new Error(`EIA API error for ${series.seriesId}: ${json.error}`);
  }
  const data = json.response?.data;
  if (!data || data.length === 0) {
    throw new Error(`EIA returned no data points for ${series.seriesId}`);
  }
  return { point: data[0]!, rawUnit: data[0]!.units };
}

function coerceValue(v: EiaDataPoint["value"], seriesId: string): number {
  if (v === null || v === undefined) {
    throw new Error(`EIA point for ${seriesId} has null value`);
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`EIA point for ${seriesId} has non-numeric value: ${v}`);
  }
  return n;
}

const eiaMetadataSchema = z
  .object({
    seriesId: z.string().min(1),
    frequency: z.string().optional(),
    period: z.string().optional(),
    eiaRawUnit: z.string().nullable().optional(),
  })
  .passthrough();

const eiaSignalSchema = buildSignalDraftSchema(eiaMetadataSchema);

export const EIA_ENERGY_COLLECTOR_ID = "eia-energy";

export const eiaEnergyCollector: IntelligenceCollector<typeof eiaSignalSchema> = {
  id: EIA_ENERGY_COLLECTOR_ID,
  name: "EIA Energy Prices",
  description:
    "Latest US Energy Information Administration prices for WTI crude, Henry Hub natural gas, US average retail diesel and gasoline, and US average industrial electricity. Energy is a cross-category cost driver feeding Tier-2 lever analyzers.",
  posture: "public-api",
  sourceUrl: "https://www.eia.gov/opendata/",
  defaultRateLimitRpm: 30,
  defaultScheduleCron: "0 6 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: eiaSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(EIA_ENERGY_COLLECTOR_ID, draft);
  },
  async collect({ since: _since }): Promise<MarketSignalDraft[]> {
    const apiKey = process.env["EIA_API_KEY"];
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(
        "EIA_API_KEY is not set. Register a free key at https://www.eia.gov/opendata/register.php and add it as a secret named EIA_API_KEY.",
      );
    }

    const drafts: MarketSignalDraft[] = [];
    const errors: string[] = [];

    for (const series of SERIES) {
      try {
        const { point, rawUnit } = await fetchLatestPoint(series, apiKey);
        const value = coerceValue(point.value, series.seriesId);
        const observedAt = parsePeriodToUtc(point.period);
        drafts.push({
          signalType: "commodity_index",
          scopeMaterialCode: series.materialCode,
          value,
          unit: series.canonicalUnit,
          currency: "USD",
          observedAt,
          sourceUrl: series.seriesPageUrl,
          confidence: 0.95,
          metadata: {
            seriesId: series.seriesId,
            frequency: series.frequency,
            period: point.period,
            eiaRawUnit: rawUnit ?? null,
          },
        });
      } catch (err) {
        errors.push(`${series.seriesId}: ${(err as Error).message}`);
      }
    }

    // All five series are part of the contract for this collector. If any
    // one fails, fail the whole run so the audit log surfaces the partial
    // outage rather than silently shipping an incomplete snapshot.
    if (errors.length > 0) {
      throw new Error(
        `EIA collector failed for ${errors.length}/${SERIES.length} required series. ` +
          `Successfully fetched: ${drafts.length}. Errors: ${errors.join("; ")}`,
      );
    }
    return drafts;
  },
};
