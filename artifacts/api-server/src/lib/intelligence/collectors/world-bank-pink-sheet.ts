/**
 * World Bank "Pink Sheet" commodity collector.
 *
 * Source: Commodity Markets Outlook monthly price tables ("Pink Sheet"),
 *   published by the World Bank Prospects Group.
 *   Landing page: https://www.worldbank.org/en/research/commodity-markets
 *   Canonical data file (fetched each run):
 *     https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx
 *
 * --- Data path decision (per task #31, step 1) ---
 *
 * The Pink Sheet is published ONLY as an Excel workbook (.xlsx) and a PDF
 * report. We probed the World Bank's public surfaces for a JSON or CSV
 * alternative and found none:
 *   - The World Bank Indicators API (api.worldbank.org/v2) does not expose
 *     monthly Pink Sheet commodity prices. Source 15 (Global Economic
 *     Monitor) covers macro indicators (CPI, FX, GDP, etc.) but not
 *     commodity prices. A scan of all ~29.5k indicators across all 71
 *     sources turned up no monthly commodity-price series matching Pink
 *     Sheet content.
 *   - The Commodity Markets landing page links only to xlsx/PDF downloads
 *     ("CMO-Historical-Data-Monthly.xlsx" and the same in annual form).
 *   - The Data Catalog DDH endpoint and humdata.org mirrors do not carry
 *     the Pink Sheet as CSV.
 *
 * The task's preferred path was JSON or CSV with xlsx parsing out of
 * scope, but no JSON/CSV path exists. Implementing the collector
 * therefore requires reading the xlsx workbook directly. We use the
 * `node-xlsx` package (a thin wrapper around SheetJS) to read the
 * "Monthly Prices" sheet, find the most recent populated row, and
 * project the tracked commodity columns into MarketSignalDrafts.
 *
 * --- Sheet layout (verified Apr 2026 release) ---
 *
 * Sheet name: "Monthly Prices"
 *   Rows 0-3:  Title, subtitle, notes, "Updated on …" string
 *   Row 4:     Commodity full names (e.g. "Crude oil, Brent")
 *   Row 5:     Units in parentheses (e.g. "($/bbl)", "($/mt)")
 *   Row 6+:    Data — column 0 holds the period label "YYYYMmm"
 *              (e.g. "1960M01" … "2026M03")
 *
 * The Pink Sheet uses commodity full names as column headers, not the
 * short symbol codes that some downstream consumers use. The mapping
 * below records the exact workbook header and the canonical material
 * code we want surfaced on the MarketSignal — codes that overlap with
 * `published-commodity-index` (BRENT_OIL, LME_COPPER) are intentional
 * so downstream lever logic can cross-check exchange spot vs. Pink
 * Sheet monthly average.
 *
 * Confidence is set to 0.85 — slightly below exchange-direct feeds,
 * since Pink Sheet values are monthly averages rather than spot prices.
 */

import xlsx from "node-xlsx";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";
import { z } from "zod";
import { logger } from "../../logger";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";

const PINK_SHEET_LANDING_URL =
  "https://www.worldbank.org/en/research/commodity-markets";

const PINK_SHEET_XLSX_URL =
  "https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx";

const SHEET_NAME = "Monthly Prices";

interface PinkSheetCommodity {
  /**
   * Exact column header text from row 4 of the "Monthly Prices" sheet
   * (case-insensitive, whitespace-trimmed match). Recorded in
   * `metadata.commodityCode` on the emitted signal.
   */
  pinkSheetCode: string;
  /**
   * Canonical material code shared with the rest of the platform so
   * downstream lever logic can correlate.
   */
  materialCode: string;
  /**
   * Expected unit (post-normalization) — sanity check against what the
   * workbook publishes. If the workbook unit drifts from this, the
   * collector logs a warning so a human can audit the change.
   */
  expectedUnit: string;
}

/**
 * Curated set of ~20 procurement-relevant commodities. Headers must
 * match the "Monthly Prices" sheet row 4 exactly (post-trim,
 * case-insensitive).
 */
const COMMODITIES: PinkSheetCommodity[] = [
  // Energy
  { pinkSheetCode: "Crude oil, Brent", materialCode: "BRENT_OIL", expectedUnit: "USD/bbl" },
  { pinkSheetCode: "Crude oil, Dubai", materialCode: "DUBAI_OIL", expectedUnit: "USD/bbl" },
  { pinkSheetCode: "Crude oil, WTI", materialCode: "WTI_OIL", expectedUnit: "USD/bbl" },
  { pinkSheetCode: "Natural gas, US", materialCode: "NATGAS_US", expectedUnit: "USD/mmbtu" },
  { pinkSheetCode: "Natural gas, Europe", materialCode: "NATGAS_EU", expectedUnit: "USD/mmbtu" },
  { pinkSheetCode: "Coal, Australian", materialCode: "COAL_AUS", expectedUnit: "USD/mt" },

  // Base & precious metals
  { pinkSheetCode: "Aluminum", materialCode: "LME_ALUMINUM", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Copper", materialCode: "LME_COPPER", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Lead", materialCode: "LME_LEAD", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Nickel", materialCode: "LME_NICKEL", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Tin", materialCode: "LME_TIN", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Zinc", materialCode: "LME_ZINC", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Iron ore, cfr spot", materialCode: "IRON_ORE", expectedUnit: "USD/dmtu" },
  { pinkSheetCode: "Gold", materialCode: "GOLD", expectedUnit: "USD/toz" },
  { pinkSheetCode: "Silver", materialCode: "SILVER", expectedUnit: "USD/toz" },
  { pinkSheetCode: "Platinum", materialCode: "PLATINUM", expectedUnit: "USD/toz" },

  // Agriculture
  { pinkSheetCode: "Wheat, US HRW", materialCode: "WHEAT", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Maize", materialCode: "MAIZE", expectedUnit: "USD/mt" },
  { pinkSheetCode: "Soybeans", materialCode: "SOYBEANS", expectedUnit: "USD/mt" },

  // Fertilizers
  { pinkSheetCode: "Urea", materialCode: "UREA", expectedUnit: "USD/mt" },
  { pinkSheetCode: "DAP", materialCode: "DAP_FERTILIZER", expectedUnit: "USD/mt" },
];

type Cell = string | number | boolean | Date | null | undefined;
type Row = Cell[];

/** Convert "($/bbl)" → "USD/bbl"; "($/troy oz)" → "USD/toz". */
function normalizeUnit(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\(\$\/(.+?)\)$/);
  if (!m || !m[1]) return null;
  const u = m[1].trim().toLowerCase();
  if (u === "troy oz") return "USD/toz";
  return `USD/${u}`;
}

/** "2026M03" → Date(2026-03-31T23:59:59Z). */
function parseMonthEnd(period: unknown): Date | null {
  if (typeof period !== "string") return null;
  const m = period.match(/^(\d{4})M(\d{2})$/);
  if (!m || !m[1] || !m[2]) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) return null;
  // Date.UTC(year, month, 0) yields the last day of (month) — i.e. last
  // day of the requested 1-indexed month, since "month" in Date.UTC is
  // 0-indexed and day 0 rolls back to the previous month's last day.
  return new Date(Date.UTC(year, month, 0, 23, 59, 59));
}

/** Find the index of the last row whose period column parses successfully
 *  AND whose value cell at `dataCol` is a non-null number. */
function findLastObservation(
  rows: Row[],
  dataCol: number,
  startRow: number,
): { rowIdx: number; period: string; value: number; observedAt: Date } | null {
  for (let i = rows.length - 1; i >= startRow; i--) {
    const row = rows[i];
    if (!row) continue;
    const period = row[0];
    const observedAt = parseMonthEnd(period);
    if (!observedAt) continue;
    const cell = row[dataCol];
    if (typeof cell !== "number" || !Number.isFinite(cell)) continue;
    return {
      rowIdx: i,
      period: period as string,
      value: +cell.toFixed(6),
      observedAt,
    };
  }
  return null;
}

interface ParsedSheet {
  rows: Row[];
  headers: Row;
  units: Row;
  dataStart: number;
}

function parseMonthlyPricesSheet(buf: Buffer): ParsedSheet {
  const wb = xlsx.parse(buf);
  const sheet = wb.find((s) => s.name === SHEET_NAME);
  if (!sheet) {
    throw new Error(
      `Pink Sheet workbook does not contain a "${SHEET_NAME}" sheet`,
    );
  }
  const rows = sheet.data as Row[];
  if (rows.length < 7) {
    throw new Error(
      `Pink Sheet "${SHEET_NAME}" has too few rows (${rows.length}); layout may have changed`,
    );
  }
  // Layout: row 4 is headers (commodity full names), row 5 is units,
  // row 6+ is data.
  const headers = (rows[4] ?? []) as Row;
  const units = (rows[5] ?? []) as Row;
  return { rows, headers, units, dataStart: 6 };
}

async function fetchPinkSheetWorkbook(): Promise<{
  buffer: Buffer;
  lastModified: string | null;
}> {
  const res = await fetch(PINK_SHEET_XLSX_URL);
  if (!res.ok) {
    throw new Error(
      `Pink Sheet fetch failed: ${res.status} ${res.statusText} for ${PINK_SHEET_XLSX_URL}`,
    );
  }
  const ab = await res.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    lastModified: res.headers.get("last-modified"),
  };
}

const wbMetadataSchema = z
  .object({
    commodityCode: z.string().min(1),
    basis: z.string().optional(),
    period: z.string().optional(),
    upstreamXlsxUrl: z.string().url().optional(),
    upstreamLastModified: z.string().nullable().optional(),
  })
  .passthrough();

const wbSignalSchema = buildSignalDraftSchema(wbMetadataSchema);

export const WORLD_BANK_PINK_SHEET_COLLECTOR_ID = "world-bank-pink-sheet";

export const worldBankPinkSheetCollector: IntelligenceCollector<
  typeof wbSignalSchema
> = {
  id: WORLD_BANK_PINK_SHEET_COLLECTOR_ID,
  name: "World Bank Pink Sheet",
  description:
    "Monthly commodity prices from the World Bank's Commodity Markets Outlook (\"Pink Sheet\") covering energy, base & precious metals, grains, and fertilizers. No API key required.",
  posture: "public-api",
  sourceUrl: PINK_SHEET_LANDING_URL,
  defaultRateLimitRpm: 10,
  // Pink Sheet refreshes monthly; daily polling is cheap and lets us
  // pick up a new release within a day of publication.
  defaultScheduleCron: "0 9 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "GLOBAL",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: wbSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(WORLD_BANK_PINK_SHEET_COLLECTOR_ID, draft);
  },
  async collect({ since: _since }): Promise<MarketSignalDraft[]> {
    const { buffer, lastModified } = await fetchPinkSheetWorkbook();
    const { rows, headers, units, dataStart } = parseMonthlyPricesSheet(buffer);

    // Build a header-name → column-index lookup (trim + lowercase).
    const headerIdx = new Map<string, number>();
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (typeof h === "string") {
        headerIdx.set(h.trim().toLowerCase(), i);
      }
    }

    const drafts: MarketSignalDraft[] = [];
    for (const c of COMMODITIES) {
      const col = headerIdx.get(c.pinkSheetCode.trim().toLowerCase());
      if (col === undefined) {
        logger.warn(
          { commodity: c.pinkSheetCode },
          "world-bank-pink-sheet: column not found in workbook; skipping",
        );
        continue;
      }
      const obs = findLastObservation(rows, col, dataStart);
      if (!obs) {
        logger.warn(
          { commodity: c.pinkSheetCode, col },
          "world-bank-pink-sheet: no numeric observation found in column; skipping",
        );
        continue;
      }
      const sheetUnit = normalizeUnit(units[col]);
      if (sheetUnit && sheetUnit !== c.expectedUnit) {
        logger.warn(
          {
            commodity: c.pinkSheetCode,
            expected: c.expectedUnit,
            actual: sheetUnit,
          },
          "world-bank-pink-sheet: workbook unit drifted from expected; using workbook unit",
        );
      }
      drafts.push({
        signalType: "commodity_index" as const,
        scopeMaterialCode: c.materialCode,
        value: obs.value,
        unit: sheetUnit ?? c.expectedUnit,
        currency: "USD",
        observedAt: obs.observedAt,
        sourceUrl: PINK_SHEET_LANDING_URL,
        confidence: 0.85,
        metadata: {
          commodityCode: c.pinkSheetCode,
          basis: "monthly_avg",
          period: obs.period,
          upstreamXlsxUrl: PINK_SHEET_XLSX_URL,
          upstreamLastModified: lastModified ?? null,
        },
      });
    }

    return drafts;
  },
};
