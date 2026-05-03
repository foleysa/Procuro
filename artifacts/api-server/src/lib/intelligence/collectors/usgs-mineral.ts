/**
 * USGS Mineral Resources commodity collector.
 *
 * Source: U.S. Geological Survey, National Minerals Information Center.
 *   "Historical Statistics for Mineral and Material Commodities in the
 *   United States" — Data Series 140 (DS-140). Each commodity is
 *   published as a standalone XLSX workbook with annual production,
 *   imports/exports, apparent consumption, and unit value (price)
 *   columns going back decades.
 *
 *   Landing page (per-commodity links):
 *     https://www.usgs.gov/centers/national-minerals-information-center/historical-statistics-mineral-and-material-commodities
 *
 * Why this collector exists
 * -------------------------
 * The World Bank Pink Sheet covers a handful of base & precious metals
 * at the global monthly-average level. Procurement teams buying
 * batteries, EV components, electronics, and specialty metals need a
 * deeper view of *critical minerals* — lithium, cobalt, nickel, rare
 * earths, graphite — where supply concentration and price volatility
 * are top procurement risks. USGS DS-140 is the authoritative US
 * federal source for these series, with no API key required.
 *
 * --- Data path decision ---
 *
 * Like Pink Sheet, USGS publishes only XLSX (and PDF) — there is no
 * JSON or CSV API for DS-140. We use `node-xlsx` (a thin SheetJS
 * wrapper, already a dependency for Pink Sheet) to fetch each
 * commodity's workbook, locate the historical-statistics sheet,
 * find the "Year" and "Unit value" columns, and emit one
 * `commodity_index` draft per (year, value) pair.
 *
 * Idempotency
 * -----------
 * The runtime's natural-key dedupe (collectorId, signalType, scope_*,
 * observed_at) makes re-runs safe. Both the live `collect()` (latest
 * annual observation per commodity) and the historical backfill
 * (full year history) call the same `buildUsgsDraftForObservation` so
 * a backfilled row is indistinguishable from a row the daily collector
 * would have produced for the same (commodity, year). Re-running the
 * collector is therefore an idempotent no-op.
 *
 * Posture: `public-api` — DS-140 is a public USGS publication. We
 * default to a conservative 5 rpm because each request downloads a
 * full XLSX (typically tens of KB) and USGS does not publish a stated
 * rate limit.
 */

import { parseXlsxBuffer } from "./xlsx-parser";
import { z } from "zod";
import { logger } from "../../logger";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
  CollectorRunMode,
} from "../collector";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";

/** Public id for the USGS Mineral Resources commodity collector. */
export const USGS_MINERAL_COLLECTOR_ID = "usgs-mineral";

const USGS_LANDING_URL =
  "https://www.usgs.gov/centers/national-minerals-information-center/historical-statistics-mineral-and-material-commodities";

/**
 * Curated commodity definition. `xlsxUrl` is the canonical DS-140
 * download for the commodity; `materialCode` is the canonical platform
 * material code surfaced on the MarketSignal so downstream lever logic
 * can correlate across collectors. `expectedUnit` is the post-normalize
 * unit string we expect on the row — drift triggers a warning so a
 * human can audit the change.
 *
 * Adding or changing a series: extend this list and the curated-list
 * guardrail test (mirroring task #69 / NASS) will pin the new entry
 * against silent removal.
 */
export interface UsgsMineralRef {
  materialCode: string;
  label: string;
  xlsxUrl: string;
  expectedUnit: string;
}

/**
 * Curated critical-mineral list. Per task #245 brief: lithium, cobalt,
 * nickel, copper, aluminum, rare earth elements, graphite. Each entry
 * points at the canonical USGS DS-140 historical-statistics workbook
 * for that commodity.
 *
 * URLs follow the DS-140 naming convention used by USGS NMIC.
 * Operators should re-confirm the URL whenever USGS republishes the
 * dataset; the per-series fetch failure path keeps the rest of the run
 * healthy if one URL drifts.
 */
export const USGS_MINERALS: readonly UsgsMineralRef[] = [
  {
    // URLs sourced from the per-commodity landing pages under
    // https://www.usgs.gov/media/files/{commodity}-historical-statistics-data-series-140
    // (resolved 2026-05). USGS retired the old `/atoms/files/ds140-{slug5}.xlsx`
    // paths; the canonical S3 path now lives under
    // `/s3fs-public/media/files/ds140-{commodity}-{lastReportedYear}.xlsx`.
    // The trailing year reflects the last release of the workbook, not the
    // last data row inside it, so we re-publish updated curated URLs as USGS
    // refreshes the underlying DS-140 series.
    materialCode: "LITHIUM",
    label: "Lithium — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-lithium-2021.xlsx",
    expectedUnit: "USD/t",
  },
  {
    materialCode: "COBALT",
    label: "Cobalt — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-cobalt-2021.xlsx",
    expectedUnit: "USD/t",
  },
  {
    materialCode: "NICKEL_USGS",
    label: "Nickel — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-nickel-2019.xlsx",
    expectedUnit: "USD/t",
  },
  {
    materialCode: "COPPER_USGS",
    label: "Copper — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-copper-2020.xlsx",
    expectedUnit: "USD/t",
  },
  {
    materialCode: "ALUMINUM_USGS",
    label: "Aluminum — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-aluminum-2021.xlsx",
    expectedUnit: "USD/t",
  },
  {
    materialCode: "RARE_EARTHS",
    label: "Rare earth elements — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-rare-earths-2020.xlsx",
    expectedUnit: "USD/t",
  },
  {
    materialCode: "GRAPHITE",
    label: "Graphite (natural) — US apparent consumption unit value (annual)",
    xlsxUrl:
      "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/ds140-graphite-2022.xlsx",
    expectedUnit: "USD/t",
  },
];

type Cell = string | number | boolean | Date | null | undefined;
type Row = Cell[];

/**
 * Locate the index of the column whose header text best matches a USGS
 * "Unit value" column. DS-140 workbooks publish two unit-value columns
 * — nominal-dollars and constant-dollars — and we prefer the nominal
 * column ("Unit value, dollars per ton" or similar) so downstream
 * trend charts can compare directly with current-year prices from
 * other feeds.
 *
 * Returns -1 when no plausible column is found so the caller can skip
 * the workbook with a logged warning rather than emit garbage.
 */
export function findUnitValueColumn(headerRow: Row): number {
  let preferredIdx = -1;
  let fallbackIdx = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const cell = headerRow[i];
    if (typeof cell !== "string") continue;
    const text = cell.toLowerCase();
    if (!text.includes("unit value")) continue;
    // Prefer the nominal-dollar column. USGS labels constant-dollar
    // columns with a year (e.g. "98$" or "constant"), so any header
    // containing those tokens is the wrong column.
    // USGS constant-dollar columns are tagged with the deflation base
    // year — "98$", "98 $", "1998 dollars", "constant 1998", etc. Any
    // 2-digit or 4-digit year token next to "dollars"/"$" means the
    // column is deflated and must be skipped in favour of the nominal
    // column for cross-feed comparability.
    const isConstant =
      /constant/.test(text) ||
      /\b(19|20)\d{2}\s*\$/.test(text) ||
      /\b(19|20)\d{2}\s+dollars?/.test(text) ||
      /\b\d{2}\s+dollars?/.test(text) ||
      text.includes("98$") ||
      text.includes("98 $");
    if (isConstant) {
      if (fallbackIdx === -1) fallbackIdx = i;
      continue;
    }
    if (preferredIdx === -1) preferredIdx = i;
  }
  return preferredIdx !== -1 ? preferredIdx : fallbackIdx;
}

/**
 * Locate the index of the "Year" column on the header row. USGS uses
 * the literal string "Year" (case varies). Returns -1 when not found.
 */
export function findYearColumn(headerRow: Row): number {
  for (let i = 0; i < headerRow.length; i++) {
    const cell = headerRow[i];
    if (typeof cell !== "string") continue;
    if (cell.trim().toLowerCase() === "year") return i;
  }
  return -1;
}

/**
 * Find the header row in a DS-140 workbook. USGS typically places
 * descriptive title rows at the top, with the column headers (a row
 * containing "Year" plus value columns) appearing before the data
 * rows. We scan the first 30 rows for one that contains a literal
 * "Year" cell.
 *
 * Returns -1 if no header row is found so the caller can skip the
 * workbook gracefully.
 */
export function findHeaderRow(rows: Row[]): number {
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row) continue;
    if (findYearColumn(row) !== -1) return i;
  }
  return -1;
}

/**
 * Parse a USGS year cell. Years are usually integers but occasionally
 * surface as strings ("2023") or "1990 e" (estimate marker). We accept
 * any cell that begins with a 4-digit year in the plausible range
 * 1900..2200.
 */
export function parseUsgsYear(cell: Cell): number | null {
  if (typeof cell === "number" && Number.isInteger(cell)) {
    return cell >= 1900 && cell <= 2200 ? cell : null;
  }
  if (typeof cell !== "string") return null;
  const m = cell.trim().match(/^(\d{4})/);
  if (!m || !m[1]) return null;
  const y = Number(m[1]);
  return y >= 1900 && y <= 2200 ? y : null;
}

/**
 * Parse a USGS unit-value cell. Values are usually numeric, but USGS
 * sometimes formats them as strings with commas ("1,234") or appends
 * estimate markers ("123 e"). Suppression markers ("W", "NA", "—",
 * "(D)") return null so the row is skipped rather than written as
 * garbage.
 */
export function parseUsgsValue(cell: Cell): number | null {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : null;
  }
  if (typeof cell !== "string") return null;
  const trimmed = cell.trim();
  if (trimmed === "") return null;
  // Common USGS suppression markers — never numeric.
  const markers = new Set(["w", "na", "n/a", "—", "-", "(d)", "(w)", "(na)"]);
  if (markers.has(trimmed.toLowerCase())) return null;
  // Strip thousands separators and any trailing estimate suffix
  // ("e", " r" for revised, " p" for preliminary).
  const cleaned = trimmed
    .replace(/,/g, "")
    .replace(/\s+[erpERP]$/, "")
    .replace(/[eE]$/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Year" → last instant of December UTC, so the natural-key dedupe
 * groups DS-140's annual observations into a single deterministic
 * `observed_at` per (commodity, year).
 */
export function yearToObservedAt(year: number): Date {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59));
}

/**
 * Build a `MarketSignalDraft` from a single (year, value) pair plus
 * the curated commodity descriptor. Shared between the live collector
 * (`basis: "usgs_latest_observation"`) and the historical backfill
 * (`basis: "usgs_historical_backfill"`) so backfilled rows dedupe
 * cleanly against same-day live rows.
 */
export function buildUsgsDraftForObservation(
  mineral: UsgsMineralRef,
  year: number,
  value: number,
  basis: "usgs_latest_observation" | "usgs_historical_backfill",
): MarketSignalDraft {
  return {
    signalType: "commodity_index" as const,
    scopeMaterialCode: mineral.materialCode,
    value: +value.toFixed(6),
    unit: mineral.expectedUnit,
    currency: "USD",
    observedAt: yearToObservedAt(year),
    sourceUrl: USGS_LANDING_URL,
    confidence: 0.85,
    metadata: {
      commodityLabel: mineral.label,
      year: String(year),
      basis,
      upstreamXlsxUrl: mineral.xlsxUrl,
    },
  };
}

/**
 * Parse a DS-140 workbook into (year, value) observations. Walks every
 * sheet, finds the first one with a recognisable header row containing
 * a "Year" column and a "Unit value" column, and returns the
 * deduplicated set of (year, value) pairs.
 *
 * Returns an empty array (and logs a warning) when the workbook
 * layout cannot be recognised — that lets the per-mineral failure
 * path skip the workbook without aborting the whole run.
 */
export async function parseUsgsWorkbook(
  buf: Buffer,
  mineral: UsgsMineralRef,
): Promise<Array<{ year: number; value: number }>> {
  const wb = await parseXlsxBuffer(buf);
  for (const sheet of wb) {
    const rows = sheet.data as Row[];
    if (rows.length === 0) continue;
    const headerIdx = findHeaderRow(rows);
    if (headerIdx === -1) continue;
    const headerRow = rows[headerIdx]!;
    const yearCol = findYearColumn(headerRow);
    const valueCol = findUnitValueColumn(headerRow);
    if (yearCol === -1 || valueCol === -1) continue;
    const seen = new Set<number>();
    const out: Array<{ year: number; value: number }> = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const year = parseUsgsYear(row[yearCol]);
      if (year === null) continue;
      const value = parseUsgsValue(row[valueCol]);
      if (value === null) continue;
      if (seen.has(year)) continue;
      seen.add(year);
      out.push({ year, value });
    }
    if (out.length > 0) return out;
  }
  logger.warn(
    {
      collectorId: USGS_MINERAL_COLLECTOR_ID,
      materialCode: mineral.materialCode,
    },
    "USGS workbook layout not recognised; skipping mineral",
  );
  return [];
}

/**
 * Fetch one DS-140 workbook. Throws on transport / non-2xx errors so
 * the caller's try/catch can record the per-mineral failure without
 * poisoning the other minerals in the same run.
 */
export async function fetchUsgsWorkbook(
  mineral: UsgsMineralRef,
  signal?: AbortSignal,
): Promise<Buffer> {
  const res = await fetch(mineral.xlsxUrl, { signal });
  if (!res.ok) {
    throw new Error(
      `USGS ${mineral.materialCode} HTTP ${res.status} ${res.statusText} for ${mineral.xlsxUrl}`,
    );
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Run the collector against the curated mineral list. `mode` controls
 * whether the run emits the latest annual observation per commodity
 * (the default daily-poll behaviour) or the full historical series
 * (the on-demand backfill behaviour). The natural-key dedupe makes
 * both paths idempotent against re-runs.
 */
export async function collectUsgsDrafts(opts: {
  mode: CollectorRunMode;
  signal?: AbortSignal;
}): Promise<{
  drafts: MarketSignalDraft[];
  failedMinerals: Array<{ materialCode: string; error: string }>;
}> {
  const drafts: MarketSignalDraft[] = [];
  const failedMinerals: Array<{ materialCode: string; error: string }> = [];
  const basis =
    opts.mode === "backfill"
      ? "usgs_historical_backfill"
      : "usgs_latest_observation";
  for (const mineral of USGS_MINERALS) {
    let buf: Buffer;
    try {
      buf = await fetchUsgsWorkbook(mineral, opts.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedMinerals.push({ materialCode: mineral.materialCode, error: message });
      logger.warn(
        {
          collectorId: USGS_MINERAL_COLLECTOR_ID,
          materialCode: mineral.materialCode,
          err,
        },
        "USGS workbook fetch failed",
      );
      continue;
    }
    const observations = await parseUsgsWorkbook(buf, mineral);
    if (observations.length === 0) continue;
    if (opts.mode === "backfill") {
      for (const o of observations) {
        drafts.push(
          buildUsgsDraftForObservation(mineral, o.year, o.value, basis),
        );
      }
    } else {
      // Latest mode: pick the single most recent year. Re-emitting the
      // same row each daily poll is a free no-op thanks to natural-key
      // dedupe.
      let best = observations[0]!;
      for (const o of observations) {
        if (o.year > best.year) best = o;
      }
      drafts.push(
        buildUsgsDraftForObservation(mineral, best.year, best.value, basis),
      );
    }
  }
  return { drafts, failedMinerals };
}

/**
 * One-shot historical backfill for the USGS collector. Walks every
 * curated mineral, parses its DS-140 workbook, and returns one
 * `MarketSignalDraft` per (mineral × year). The caller (runtime) is
 * responsible for the idempotent insert against `market_signals` so
 * re-runs are safe no-ops.
 *
 * A single bad workbook (USGS reorganises a sheet, retires a series)
 * does not abort the whole run — failures are collected and surfaced
 * to the caller, which decides whether to throw (e.g. zero successes
 * = genuine breakage).
 */
export async function fetchUsgsMineralBackfillDrafts(): Promise<{
  drafts: MarketSignalDraft[];
  failedMinerals: Array<{ materialCode: string; error: string }>;
}> {
  return collectUsgsDrafts({ mode: "backfill" });
}

const usgsMetadataSchema = z
  .object({
    commodityLabel: z.string().optional(),
    year: z.string().optional(),
    basis: z.string().optional(),
    upstreamXlsxUrl: z.string().url().optional(),
  })
  .passthrough();

const usgsSignalSchema = buildSignalDraftSchema(usgsMetadataSchema);

export const usgsMineralCollector: IntelligenceCollector<typeof usgsSignalSchema> = {
  id: USGS_MINERAL_COLLECTOR_ID,
  name: "USGS Mineral Resources",
  description:
    "Annual US unit-value (price) signals for a curated set of critical minerals — lithium, cobalt, nickel, copper, aluminum, rare earths, graphite — from the USGS National Minerals Information Center's Historical Statistics for Mineral and Material Commodities (Data Series 140). No API key required.",
  posture: "public-api",
  sourceUrl: USGS_LANDING_URL,
  // DS-140 workbooks are tens of KB each and refresh annually — a low
  // RPM cap is plenty and keeps us well-behaved against USGS's S3
  // distribution.
  defaultRateLimitRpm: 5,
  // USGS publishes DS-140 updates annually; a daily poll picks up new
  // releases promptly and the natural-key dedupe makes the redundant
  // polls free.
  defaultScheduleCron: "0 8 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 365,
  tenantOptInDefault: true,
  // Annual feed — tolerate a longer empty-result window before the
  // source-health endpoint flags this as stale.
  staleEmptyThresholdHours: 24 * 14,
  signalSchema: usgsSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(USGS_MINERAL_COLLECTOR_ID, draft);
  },
  async collect({ since: _since, signal, mode }): Promise<MarketSignalDraft[]> {
    const runMode: CollectorRunMode = mode ?? "latest";
    const { drafts, failedMinerals } = await collectUsgsDrafts({
      mode: runMode,
      ...(signal !== undefined ? { signal } : {}),
    });
    // If every mineral failed to fetch, the run is genuinely broken
    // (USGS outage, network, all URLs drifted) — surface it so the
    // audit log records `fetch_failed` instead of "succeeded with 0
    // inserts".
    if (drafts.length === 0 && failedMinerals.length === USGS_MINERALS.length) {
      const sample = failedMinerals
        .slice(0, 3)
        .map((f) => f.error)
        .join("; ");
      throw new Error(
        `USGS collector: all ${USGS_MINERALS.length} minerals failed. Sample errors: ${sample}`,
      );
    }
    return drafts;
  },
};
