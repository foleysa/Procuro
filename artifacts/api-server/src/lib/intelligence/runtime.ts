import {
  db,
  collectorsTable,
  collectorAuditLogTable,
  marketSignalsTable,
  marketSignalSchemaDriftTable,
  type CollectorRow,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  collectorContractSchema,
  isIntelligenceEnabled,
  landRawPayload,
  mergeMarketSignals,
  recordCollectorRun,
  type BqMarketSignalRow,
} from "@workspace/intelligence";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE, UnrecoverableJobError } from "../jobs/queue";
import { fanOutCollectorAlerts } from "../alerts/collector-fanout";
import { publishMarketSignalIds } from "./event-bus";
import {
  collectorContract,
  type CollectorRunMode,
  type IntelligenceCollector,
  type MarketSignalDraft,
  type RawPayload,
} from "./collector";
import {
  ECB_FX_RATES_COLLECTOR_ID,
  ecbObservedAt,
  fetchEcbBackfillDraftsWithMeta,
  headEcbHistoricalFeed,
} from "./collectors/ecb-fx-rates";
import {
  FRED_ECONOMIC_INDEX_COLLECTOR_ID,
  fetchFredBackfillDrafts,
  FRED_SERIES,
} from "./collectors/fred-economic-index";
import {
  SEC_EDGAR_COLLECTOR_ID,
  fetchEdgarBackfillDrafts,
  type SecIssuerRef,
} from "./collectors/sec-edgar";
import {
  OPENSANCTIONS_COLLECTOR_ID,
  fetchOpenSanctionsBackfillDrafts,
} from "./collectors/opensanctions";
import {
  GLEIF_LEI_COLLECTOR_ID,
  fetchGleifBackfillDrafts,
} from "./collectors/gleif-lei";
import {
  CLIMATE_TRACE_COLLECTOR_ID,
  fetchClimateTraceBackfillDrafts,
} from "./collectors/climate-trace";
import {
  COMPANIES_HOUSE_COLLECTOR_ID,
  fetchCompaniesHouseBackfillDrafts,
} from "./collectors/companies-house";
import {
  USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID,
  NASS_SERIES,
  fetchUsdaNassBackfillDrafts,
} from "./collectors/usda-nass-economic-index";
import {
  EPA_ECHO_COLLECTOR_ID,
  fetchEpaEchoBackfillDrafts,
} from "./collectors/epa-echo";
import {
  OSHA_COLLECTOR_ID,
  fetchOshaBackfillDrafts,
} from "./collectors/osha-inspections";
import type { WatchedUsSupplier } from "./collectors/_us-suppliers";
import {
  USGS_MINERAL_COLLECTOR_ID,
  USGS_MINERALS,
  fetchUsgsMineralBackfillDrafts,
} from "./collectors/usgs-mineral";
import {
  EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
  EUROSTAT_SERIES,
  fetchEurostatBackfillDrafts,
} from "./collectors/eurostat-economic-index";

/**
 * Inference target matching the unique *index* defined in
 * `lib/db/src/schema/marketSignals.ts`:
 *
 *   UNIQUE (collector_id, signal_type,
 *           COALESCE(scope_category_code, ''),
 *           COALESCE(scope_sku, ''),
 *           COALESCE(scope_material_code, ''),
 *           COALESCE(scope_supplier_name, ''),
 *           COALESCE(scope_lane_key, ''),
 *           observed_at)
 *
 * `uniqueIndex(...)` in drizzle creates a Postgres index, not a
 * constraint — so `ON CONFLICT ON CONSTRAINT <name>` can't see it. The
 * expression-list form below makes Postgres *infer* exactly this index
 * (and only this index) for the conflict target. That's still much
 * stricter than an unqualified `ON CONFLICT DO NOTHING`: a PK collision
 * or any future unique index/constraint won't match this inference list,
 * so they will fail loudly instead of being silently swallowed as a
 * "duplicate".
 */
const NATURAL_KEY_ON_CONFLICT = sql`ON CONFLICT (
  collector_id, signal_type,
  COALESCE(scope_category_code, ''),
  COALESCE(scope_sku, ''),
  COALESCE(scope_material_code, ''),
  COALESCE(scope_supplier_name, ''),
  COALESCE(scope_lane_key, ''),
  COALESCE(scope_region_code, ''),
  observed_at
) DO NOTHING`;

/**
 * Map common upstream content types to the file extension used in the
 * GCS object key. Replay tooling reads the object's contentType header
 * when re-parsing, but the extension keeps `gsutil ls` output legible.
 */
function guessExtensionFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("csv")) return "csv";
  if (ct.includes("html")) return "html";
  if (ct.includes("spreadsheetml") || ct.includes("xlsx")) return "xlsx";
  if (ct.includes("text/")) return "txt";
  return "bin";
}

/**
 * Coerce empty/whitespace strings to `null` for the nullable scope_* columns.
 *
 * The natural-key unique index uses `COALESCE(col, '')` so a `NULL` and an
 * empty string in the same column collide. Without normalization, a
 * collector that accidentally emitted `""` for a scope field would
 * silently overwrite (or be overwritten by) an unscoped row from a
 * different collector. Treating blank as null makes the dedupe contract
 * unambiguous: blank means "no scope", same as `null`.
 */
function normalizeScope(v: string | undefined | null): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build a parameterized `INSERT ... ON CONFLICT ON CONSTRAINT … DO NOTHING
 * RETURNING id` for `market_signals`.
 *
 * Drizzle's typed `onConflictDoNothing({ target })` API in this version
 * only accepts plain column references — it can't express the COALESCE
 * expression list our index uses, and an unqualified
 * `onConflictDoNothing()` would silence *any* unique-constraint violation
 * (PK, future constraints), which is too forgiving. Targeting the index
 * by name keeps the semantics tight and obvious.
 */
/**
 * Stringify the natural-key tuple the same way Postgres compares it
 * via the unique index (NULL/empty are equivalent through `COALESCE`).
 * The `\x00` separator is a byte that can never appear inside any of
 * the participating text columns, so collisions across distinct
 * tuples are impossible.
 */
function naturalKeyDigest(r: {
  collectorId: string;
  signalType: string;
  scopeCategoryCode?: string | null | undefined;
  scopeSku?: string | null | undefined;
  scopeMaterialCode?: string | null | undefined;
  scopeSupplierName?: string | null | undefined;
  scopeLaneKey?: string | null | undefined;
  scopeRegionCode?: string | null | undefined;
  observedAt: Date | string;
}): string {
  const ts =
    r.observedAt instanceof Date
      ? r.observedAt.toISOString()
      : new Date(r.observedAt).toISOString();
  return [
    r.collectorId,
    r.signalType,
    r.scopeCategoryCode ?? "",
    r.scopeSku ?? "",
    r.scopeMaterialCode ?? "",
    r.scopeSupplierName ?? "",
    r.scopeLaneKey ?? "",
    r.scopeRegionCode ?? "",
    ts,
  ].join("\x00");
}

/**
 * Exported for tests. Runtime callers use this through `runCollector`,
 * but the contract — namely the `persistedIds` map that resolves a
 * candidate id to whatever ultimately owns the natural key — is
 * critical enough to merit direct test coverage.
 */
export async function insertSignalsWithDedupe(
  rows: Array<typeof marketSignalsTable.$inferInsert>,
): Promise<{
  inserted: number;
  duplicates: number;
  /**
   * Map from the candidate `id` we generated for an input row to the
   * `market_signals.id` that ultimately *owns* that natural key after
   * the INSERT. For freshly-inserted rows the two are equal. For rows
   * that hit `ON CONFLICT DO NOTHING`, the candidate `id` was never
   * persisted — the existing row's id is the canonical one. Callers
   * that cross-link to `market_signals.id` (e.g. alert fan-out, Task
   * #161) MUST use this map and never `rows[i].id` directly, because
   * the candidate id will not exist in the database for the conflict
   * case.
   */
  persistedIds: Map<string, string>;
  /**
   * `market_signals.id` values that were *freshly* inserted on this
   * call (i.e. did not collide with the natural-key index). Used by the
   * in-process push bus to feed the War Room SSE stream without
   * republishing duplicates from idempotent collector re-runs.
   */
  newlyInsertedIds: string[];
}> {
  if (rows.length === 0) {
    return {
      inserted: 0,
      duplicates: 0,
      persistedIds: new Map(),
      newlyInsertedIds: [],
    };
  }

  const valuesClause = sql.join(
    rows.map(
      (r) => sql`(
        ${r.id},
        ${r.orgId ?? null},
        ${r.collectorId},
        ${r.signalType},
        ${r.scopeCategoryCode ?? null},
        ${r.scopeSku ?? null},
        ${r.scopeMaterialCode ?? null},
        ${r.scopeSupplierName ?? null},
        ${r.scopeLaneKey ?? null},
        ${r.scopeRegionCode ?? null},
        ${String(r.value)}::numeric,
        ${r.unit},
        ${r.currency ?? "USD"},
        ${r.observedAt},
        ${r.sourceUrl},
        ${r.posture},
        ${String(r.confidence ?? "0.7")}::numeric,
        ${JSON.stringify(r.metadata ?? {})}::jsonb
      )`,
    ),
    sql`, `,
  );

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO ${marketSignalsTable}
      (id, org_id, collector_id, signal_type,
       scope_category_code, scope_sku, scope_material_code,
       scope_supplier_name, scope_lane_key, scope_region_code,
       value, unit, currency,
       observed_at, source_url, posture, confidence, metadata)
    VALUES ${valuesClause}
    ${NATURAL_KEY_ON_CONFLICT}
    RETURNING id
  `);

  const inserted = result.rows.length;
  const insertedIds = new Set(result.rows.map((r) => r.id));
  const persistedIds = new Map<string, string>();
  const conflictRows: typeof rows = [];
  for (const r of rows) {
    if (typeof r.id !== "string") continue;
    if (insertedIds.has(r.id)) {
      // Inserted: the candidate id we provided IS the persisted id.
      persistedIds.set(r.id, r.id);
    } else {
      // Skipped by ON CONFLICT DO NOTHING — the natural key already
      // owns a row whose id we still need to look up.
      conflictRows.push(r);
    }
  }

  if (conflictRows.length > 0) {
    // Single batched OR-of-ANDs lookup. Conflicts are the rare path
    // (re-runs of an idempotent collector); the common path is all
    // inserts and skips this query entirely. We mirror the unique
    // index's `COALESCE(col, '')` normalization on BOTH sides so the
    // lookup matches the same equivalence classes the index uses —
    // `IS NOT DISTINCT FROM` would only match NULL↔NULL, missing
    // legacy rows that store `''` for an "absent" scope column where
    // a new row stores SQL NULL (or vice versa). Both shapes COALESCE
    // to the same empty-string sentinel and therefore collide in the
    // index, so we must collapse them to the same value here too or
    // the conflict-row lookup will silently miss those rows and the
    // alert fan-out will lose its `marketSignalId` link.
    const conditions = conflictRows.map(
      (r) => sql`(
        collector_id = ${r.collectorId}
        AND signal_type = ${r.signalType}
        AND COALESCE(scope_category_code, '') = COALESCE(${r.scopeCategoryCode ?? null}, '')
        AND COALESCE(scope_sku, '') = COALESCE(${r.scopeSku ?? null}, '')
        AND COALESCE(scope_material_code, '') = COALESCE(${r.scopeMaterialCode ?? null}, '')
        AND COALESCE(scope_supplier_name, '') = COALESCE(${r.scopeSupplierName ?? null}, '')
        AND COALESCE(scope_lane_key, '') = COALESCE(${r.scopeLaneKey ?? null}, '')
        AND COALESCE(scope_region_code, '') = COALESCE(${r.scopeRegionCode ?? null}, '')
        AND observed_at = ${r.observedAt}
      )`,
    );
    const lookup = await db.execute<{
      id: string;
      collector_id: string;
      signal_type: string;
      scope_category_code: string | null;
      scope_sku: string | null;
      scope_material_code: string | null;
      scope_supplier_name: string | null;
      scope_lane_key: string | null;
      scope_region_code: string | null;
      observed_at: Date | string;
    }>(sql`
      SELECT id, collector_id, signal_type,
             scope_category_code, scope_sku, scope_material_code,
             scope_supplier_name, scope_lane_key, scope_region_code,
             observed_at
        FROM ${marketSignalsTable}
       WHERE ${sql.join(conditions, sql` OR `)}
    `);
    const byKey = new Map<string, string>();
    for (const row of lookup.rows) {
      byKey.set(
        naturalKeyDigest({
          collectorId: row.collector_id,
          signalType: row.signal_type,
          scopeCategoryCode: row.scope_category_code,
          scopeSku: row.scope_sku,
          scopeMaterialCode: row.scope_material_code,
          scopeSupplierName: row.scope_supplier_name,
          scopeLaneKey: row.scope_lane_key,
          scopeRegionCode: row.scope_region_code,
          observedAt: row.observed_at,
        }),
        row.id,
      );
    }
    for (const r of conflictRows) {
      if (typeof r.id !== "string") continue;
      const persisted = byKey.get(
        naturalKeyDigest({
          collectorId: r.collectorId,
          signalType: r.signalType,
          scopeCategoryCode: r.scopeCategoryCode,
          scopeSku: r.scopeSku,
          scopeMaterialCode: r.scopeMaterialCode,
          scopeSupplierName: r.scopeSupplierName,
          scopeLaneKey: r.scopeLaneKey,
          scopeRegionCode: r.scopeRegionCode,
          observedAt: r.observedAt as Date | string,
        }),
      );
      if (persisted) persistedIds.set(r.id, persisted);
    }
  }

  return {
    inserted,
    duplicates: rows.length - inserted,
    persistedIds,
    newlyInsertedIds: result.rows.map((r) => r.id),
  };
}

const registry = new Map<string, IntelligenceCollector>();

/**
 * Register a collector with the runtime. Validates the contract metadata
 * (`postureClass`, `disclosureTier`, `jurisdiction`, `retentionDays`,
 * `tenantOptInDefault`) at boot — if a collector forgets one of these,
 * we fail fast instead of silently emitting unscored signals at runtime.
 */
export function registerCollector(c: IntelligenceCollector): void {
  // Required-field presence check (catches collectors that satisfy the
  // TS shape via `as IntelligenceCollector` casts but whose values are
  // actually undefined at runtime).
  const missing: string[] = [];
  if (typeof c.id !== "string" || c.id.trim() === "") missing.push("id");
  if (typeof c.signalSchema !== "object" || c.signalSchema === null) {
    missing.push("signalSchema");
  }
  if (typeof c.stableSignalKey !== "function") {
    missing.push("stableSignalKey");
  }
  if (missing.length > 0) {
    throw new Error(
      `registerCollector(${c.id ?? "<missing-id>"}): missing required fields: ${missing.join(", ")}`,
    );
  }
  // Contract metadata schema check (posture class, tier, jurisdiction, ...).
  const parsed = collectorContractSchema.safeParse(collectorContract(c));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `registerCollector(${c.id}): invalid contract metadata: ${issues}`,
    );
  }
  registry.set(c.id, c);
}

export function getCollector(id: string): IntelligenceCollector | undefined {
  return registry.get(id);
}

export function listRegisteredCollectorIds(): string[] {
  return Array.from(registry.keys());
}

async function audit(
  collectorId: string,
  event: string,
  metadata: Record<string, unknown> = {},
  error?: string,
): Promise<void> {
  await db.insert(collectorAuditLogTable).values({
    id: newId("aud"),
    collectorId,
    event,
    metadata,
    error: error ?? null,
  });
}

export async function runCollector(
  collectorId: string,
  opts: {
    force?: boolean;
    /**
     * Optional cooperative-cancellation hook from the job worker. We
     * check it at the two points that matter: right before the
     * potentially-long `collector.collect()` HTTP fetch, and right
     * before persisting signals (so we don't half-write a batch).
     * The skip-gates above are pure DB lookups and run fast enough
     * that an extra check there would just add noise.
     */
    isCancelled?: () => Promise<boolean>;
    /**
     * Forwarded to `collector.collect()`. Defaults to `"latest"` (the
     * normal recurring poll); pass `"backfill"` to ask collectors that
     * support history replay (e.g. BLS PPI/CPI/ECI) to emit a wider
     * observation window in this single run. The natural-key dedupe
     * keeps re-runs of either mode safe.
     */
    mode?: CollectorRunMode;
  } = {},
): Promise<{ signalsCollected: number; durationMs: number; skipped?: string }> {
  const start = Date.now();

  // Deterministic input validation: an empty / missing collector ID can
  // never succeed on a retry with the same payload. Throwing
  // UnrecoverableJobError here ensures the job runner skips the backoff
  // ladder and fails the job immediately.
  if (typeof collectorId !== "string" || collectorId.trim() === "") {
    throw new UnrecoverableJobError(
      "runCollector requires a non-empty collectorId",
    );
  }

  const checkCancel = async (): Promise<void> => {
    if (opts.isCancelled && (await opts.isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
  };

  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);

  if (!reg) {
    // Unknown collector ID is a deterministic permanent failure for this
    // payload — no amount of retrying will create the registry row.
    throw new UnrecoverableJobError(
      `Collector ${collectorId} not registered`,
    );
  }

  // Hard gates: kill switch, posture, status.
  if (reg.killSwitch === 1) {
    await audit(collectorId, "skipped_kill_switch");
    return { signalsCollected: 0, durationMs: Date.now() - start, skipped: "kill_switch" };
  }
  if (reg.status !== "approved" && !opts.force) {
    await audit(collectorId, "skipped_not_approved", { status: reg.status });
    return {
      signalsCollected: 0,
      durationMs: Date.now() - start,
      skipped: "not_approved",
    };
  }
  if (reg.posture === "aggressive-crawl" && !opts.force) {
    // Enforce: aggressive collectors require an approved=true row AND explicit
    // force flag. The platform legal/compliance gate is recorded by approval.
    await audit(collectorId, "aggressive_requires_force");
    return {
      signalsCollected: 0,
      durationMs: Date.now() - start,
      skipped: "aggressive_requires_force",
    };
  }

  const collector = registry.get(collectorId);
  if (!collector) {
    await audit(collectorId, "no_implementation");
    // The registry row exists but no in-process implementation is wired
    // up. Retrying with the same payload cannot fix this — the only
    // remedy is shipping new code that registers the collector.
    throw new UnrecoverableJobError(
      `Collector ${collectorId} registered in DB but no runtime implementation`,
    );
  }

  const runId = newId("run");
  const runStartedAt = new Date();
  // AbortController bridges cooperative cancellation into in-flight HTTP
  // requests inside the collector. We poll `isCancelled` in parallel
  // with the collect call so an operator-cancel doesn't have to wait
  // for the upstream fetch to complete (or time out) before the runtime
  // notices. The poll interval is short enough to feel responsive but
  // long enough not to thrash the DB; the runtime already does another
  // pre-persist `checkCancel` immediately after collect returns.
  const abortController = new AbortController();
  let cancelPollHandle: ReturnType<typeof setInterval> | null = null;
  if (opts.isCancelled) {
    cancelPollHandle = setInterval(() => {
      void opts
        .isCancelled?.()
        .then((cancelled) => {
          if (cancelled && !abortController.signal.aborted) {
            abortController.abort(new Error(CANCELLED_ERROR_MESSAGE));
          }
        })
        .catch(() => {
          // Treat poll errors as "not cancelled" — the post-collect
          // checkCancel will raise correctly if the DB really is
          // unreachable.
        });
    }, 500);
  }
  try {
    await checkCancel();
    await audit(collectorId, "fetch_started", { runId });

    // Prefer collectWithRaw when the collector implements it: that lets
    // us land the raw upstream payload to GCS *before* parsing, which
    // is what the future replay path needs. Collectors without
    // collectWithRaw fall back to the legacy `collect()` shape — they
    // still write Postgres + BQ, just without raw landing.
    let drafts: MarketSignalDraft[];
    let rawPayloads: RawPayload[] = [];
    if (typeof collector.collectWithRaw === "function") {
      const r = await collector.collectWithRaw({
        since: null,
        signal: abortController.signal,
        mode: opts.mode ?? "latest",
      });
      drafts = r.drafts;
      rawPayloads = r.rawPayloads;
    } else {
      drafts = await collector.collect({
        since: null,
        signal: abortController.signal,
        mode: opts.mode ?? "latest",
      });
      // Synthesize a JSON snapshot of the parsed drafts so every run —
      // not just the ones whose collector implements collectWithRaw —
      // lands a replayable artifact in GCS. The snapshot carries every
      // field the collector emitted, so the replay path can rebuild
      // BqMarketSignalRow inputs without touching the upstream API.
      // This is intentionally a parsed-output snapshot rather than the
      // raw upstream bytes; collectors that want byte-faithful replay
      // override `collectWithRaw` to surface the upstream response.
      rawPayloads = [
        {
          name: collectorId,
          contentType: "application/json",
          sourceUrl: collector.sourceUrl,
          body: JSON.stringify({
            collectorId,
            runId,
            runStartedAt: runStartedAt.toISOString(),
            postureClass: collector.postureClass,
            disclosureTier: collector.disclosureTier,
            jurisdiction: collector.jurisdiction,
            drafts,
          }),
          metadata: { snapshotKind: "parsed-drafts" },
        },
      ];
    }
    await checkCancel();

    // Land raw payloads to GCS first. We do not fail the run on GCS
    // errors because Postgres remains the system of record — but we
    // log + audit so persistent landing failures are visible.
    //
    // Raw-landing accounting: we count every attempt and every
    // landing failure so the runtime can both (a) write a dedicated
    // `raw_landing_failed` audit row that surfaces in the workbench
    // Runs & Errors tab, and (b) embed `rawLandingFailed` in the
    // `fetch_succeeded` audit metadata + the BigQuery `collector_runs`
    // record. Without this, the only signal of a sustained landing
    // outage is a warn-level worker log — see task #133.
    const landedRawPointers: string[] = [];
    let rawLandingAttempts = 0;
    let rawLandingFailures = 0;
    const rawLandingErrors: string[] = [];
    if (rawPayloads.length > 0 && isIntelligenceEnabled()) {
      for (const raw of rawPayloads) {
        rawLandingAttempts++;
        try {
          // Guess a reasonable extension from the content type (json,
          // xml, csv, ...). Defaults to "bin" when nothing matches —
          // the GCS object's contentType header is the source of truth
          // for parsers reading the blob back.
          const ext = guessExtensionFromContentType(raw.contentType);
          const r = await landRawPayload({
            collectorId,
            runId,
            observedAt: runStartedAt,
            payload: raw.body,
            contentType: raw.contentType,
            extension: ext,
            metadata: {
              ...(raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
              ...(raw.name ? { logicalName: raw.name } : {}),
            },
          });
          if (r) landedRawPointers.push(r.pointer);
        } catch (e) {
          rawLandingFailures++;
          const message = (e as Error).message;
          rawLandingErrors.push(message);
          logger.warn(
            { collectorId, runId, err: message },
            "GCS raw landing failed; continuing with Postgres+BQ writes",
          );
          // Dedicated audit event so the Runs & Errors tab in the
          // collector workbench surfaces this just like a fetch_failed.
          // Done per attempt because in multi-payload runs each upload
          // failure is independently meaningful for incident forensics.
          //
          // Wrapped in best-effort try/catch: a Postgres blip or lock
          // timeout writing the audit row must NOT escalate a non-fatal
          // GCS landing failure into a full `fetch_failed` run. The
          // outer run-level catch would otherwise swallow it and mark
          // the entire run as failed, dropping the parsed signals on
          // the floor.
          try {
            await audit(
              collectorId,
              "raw_landing_failed",
              {
                runId,
                ...(raw.name ? { logicalName: raw.name } : {}),
                ...(raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
                contentType: raw.contentType,
              },
              message,
            );
          } catch (auditErr) {
            logger.warn(
              {
                collectorId,
                runId,
                err: (auditErr as Error).message,
                landingErr: message,
              },
              "raw_landing_failed audit write failed; counters and BQ flag will still surface the outage",
            );
          }
        }
      }
    }
    // True when at least one raw payload was attempted but failed to
    // land. The downstream BQ rows from this run will carry a
    // `raw_payload_pointer` only for the *successful* uploads — when
    // every attempt fails, every BQ row gets `null`, severing the only
    // link from a market_signals row back to the upstream bytes.
    const rawLandingFailed = rawLandingFailures > 0;

    // Validate every draft against the collector's signalSchema. Drops
    // bad drafts and records a schema-drift event per failing draft.
    const validDrafts: MarketSignalDraft[] = [];
    for (const d of drafts) {
      const result = collector.signalSchema.safeParse(d);
      if (result.success) {
        validDrafts.push(d);
      } else {
        await recordSchemaDriftEvent(collectorId, runId, d, result.error);
      }
    }
    const droppedForDrift = drafts.length - validDrafts.length;

    const rows = validDrafts.map((d) => ({
      id: newId("sig"),
      orgId: null,
      collectorId,
      signalType: d.signalType,
      scopeCategoryCode: normalizeScope(d.scopeCategoryCode),
      scopeSku: normalizeScope(d.scopeSku),
      scopeMaterialCode: normalizeScope(d.scopeMaterialCode),
      scopeSupplierName: normalizeScope(d.scopeSupplierName),
      scopeLaneKey: normalizeScope(d.scopeLaneKey),
      scopeRegionCode: normalizeScope(d.scopeRegionCode),
      value: String(d.value),
      unit: d.unit,
      currency: d.currency ?? "USD",
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      posture: reg.posture,
      confidence: String(d.confidence ?? 0.7),
      // Mirror the resolved entity_uid into the legacy Postgres
      // `metadata.entityUid` slot so cross-source joins on the
      // existing pg signal stream still work; BigQuery gets the
      // first-class column below.
      metadata:
        d.entityUid !== null && d.entityUid !== undefined
          ? { ...(d.metadata ?? {}), entityUid: d.entityUid }
          : (d.metadata ?? {}),
    }));
    const { inserted, duplicates, persistedIds, newlyInsertedIds } =
      await insertSignalsWithDedupe(rows);

    // Push freshly persisted signal ids onto the in-process bus so the
    // War Room SSE endpoint can fan them out to connected operators
    // without waiting for the next 15s poll cycle. Duplicates from
    // idempotent re-runs are NOT republished — `newlyInsertedIds` is
    // exactly the set returned by Postgres' `RETURNING id`.
    publishMarketSignalIds(newlyInsertedIds);

    // Post-insert hook: collectors that maintain external cache state
    // (ETag / Last-Modified watermarks persisted as `cache_watermark`
    // audit rows) queued a commit during `collect()`. We invoke it ONLY
    // now that Postgres has committed the run's drafts — mirroring the
    // ECB historical-archive pattern (Task #127). Writing the watermark
    // before this point would open a window where a downstream insert
    // failure leaves the next run with an advanced watermark and a 304
    // short-circuit on data we never persisted.
    //
    // Best-effort: if the audit-log write itself fails we log and move
    // on. Postgres is already committed; the worst case is the next run
    // wastes one HTTP round trip re-fetching a payload we could have
    // 304-skipped.
    if (typeof collector.takePendingPostInsertCommit === "function") {
      const commit = collector.takePendingPostInsertCommit();
      if (commit) {
        try {
          await commit();
        } catch (e) {
          logger.warn(
            { collectorId, runId, err: (e as Error).message },
            "post-insert cache-watermark commit failed; next run will re-fetch",
          );
        }
      }
    }

    // BigQuery dual-write. No-op when intelligence is not configured;
    // best-effort otherwise (errors logged, never bubbled — Postgres is
    // already committed).
    let bqMerged = 0;
    const ingestedAt = new Date();
    const primaryRawPointer = landedRawPointers[0] ?? null;
    if (isIntelligenceEnabled() && validDrafts.length > 0) {
      try {
        const bqRows = validDrafts.map((d, idx): BqMarketSignalRow => ({
          signalId: rows[idx]!.id,
          orgId: null,
          collectorId,
          signalType: d.signalType,
          scopeCategoryCode: normalizeScope(d.scopeCategoryCode),
          scopeSku: normalizeScope(d.scopeSku),
          scopeMaterialCode: normalizeScope(d.scopeMaterialCode),
          scopeSupplierName: normalizeScope(d.scopeSupplierName),
          scopeLaneKey: normalizeScope(d.scopeLaneKey),
          scopeRegionCode: normalizeScope(d.scopeRegionCode),
          value: String(d.value),
          unit: d.unit,
          currency: d.currency ?? "USD",
          observedAt:
            d.observedAt instanceof Date ? d.observedAt : new Date(d.observedAt),
          ingestedAt,
          sourceUrl: d.sourceUrl,
          sourceCollectorId: collectorId,
          sourceRunId: runId,
          rawPayloadPointer: primaryRawPointer,
          postureClass: collector.postureClass,
          disclosureTier: collector.disclosureTier,
          jurisdiction: collector.jurisdiction,
          confidence: String(d.confidence ?? 0.7),
          entityUidNullable: d.entityUid ?? null,
          stableSignalKey: collector.stableSignalKey(d),
          validFrom:
            d.observedAt instanceof Date ? d.observedAt : new Date(d.observedAt),
          validTo: null,
          metadata: d.metadata ?? {},
        }));
        const r = await mergeMarketSignals(bqRows);
        bqMerged = r?.merged ?? 0;
      } catch (e) {
        logger.warn(
          { collectorId, runId, err: (e as Error).message },
          "BigQuery merge failed; Postgres path is unaffected",
        );
      }
      // Best-effort run record in BQ (cost: tiny streaming insert).
      try {
        const finishedAt = new Date();
        await recordCollectorRun({
          runId,
          collectorId,
          postureClass: collector.postureClass,
          disclosureTier: collector.disclosureTier,
          startedAt: runStartedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - runStartedAt.getTime(),
          rowsEmitted: validDrafts.length,
          bytesRaw: rawPayloads.reduce(
            (n, p) => n + (typeof p.body === "string" ? p.body.length : p.body.byteLength),
            0,
          ),
          parseErrors: 0,
          schemaDriftCount: droppedForDrift,
          rawPayloadPointer: primaryRawPointer,
          rawLandingFailed,
          status: "succeeded",
          error: null,
        });
      } catch (e) {
        logger.warn(
          { collectorId, runId, err: (e as Error).message },
          "BigQuery collector_runs record failed; ignoring",
        );
      }
    }

    // Tenant alert fan-out for signal types that warrant operator
    // attention (sanctions, hazards, disruption events, …). Best-effort:
    // a fan-out failure is logged and swallowed because the collector
    // run has already succeeded and we never want a flaky alerts table
    // to block intelligence ingestion.
    try {
      await fanOutCollectorAlerts({
        collector: reg,
        drafts: validDrafts.map((d, idx) => ({
          signalType: d.signalType,
          scopeSupplierName: d.scopeSupplierName ?? null,
          entityUid: d.entityUid ?? null,
          observedAt:
            d.observedAt instanceof Date ? d.observedAt : new Date(d.observedAt),
          sourceUrl: d.sourceUrl,
          metadata: d.metadata ?? null,
          value: d.value,
          unit: d.unit,
          // Pass the persisted `market_signals.id` so the alert
          // payload can cross-link back to the same row in the Fusion
          // war-room event stream (Task #161). `validDrafts` and
          // `rows` are zip-aligned by construction at line 517 — but
          // `rows[idx].id` is a *candidate* id we generated locally,
          // not necessarily what landed in the table: when the
          // natural-key index says "duplicate", `ON CONFLICT DO
          // NOTHING` keeps the existing row and our candidate id is
          // never persisted. `persistedIds` resolves the candidate id
          // to whatever the table actually owns (insert OR conflict),
          // so the alert payload always points at a row that exists.
          // If for some reason the lookup didn't find a hit (e.g. a
          // race where the conflict row was deleted between the
          // INSERT and the follow-up SELECT), we leave it null rather
          // than fabricate a dangling reference.
          marketSignalId: persistedIds.get(rows[idx]!.id ?? "") ?? null,
        })),
      });
    } catch (e) {
      logger.warn(
        { collectorId, runId, err: (e as Error).message },
        "Alert fan-out failed; collector run unaffected",
      );
    }

    await audit(collectorId, "fetch_succeeded", {
      runId,
      inserted,
      duplicates,
      drafts: drafts.length,
      validDrafts: validDrafts.length,
      droppedForDrift,
      bqMerged,
      rawLanded: landedRawPointers.length,
      // Surface raw-landing health on the *success* row too. The
      // workbench Registry tab reads the latest `fetch_succeeded`
      // metadata to render per-collector chips; embedding the flag
      // here lets it badge runs that succeeded for Postgres+BQ but
      // lost their replay pointer because the GCS upload failed.
      rawLandingAttempts,
      rawLandingFailures,
      rawLandingFailed,
    });
    logger.info(
      {
        collectorId,
        runId,
        inserted,
        duplicates,
        drafts: drafts.length,
        droppedForDrift,
        bqMerged,
        rawLanded: landedRawPointers.length,
        rawLandingAttempts,
        rawLandingFailures,
        rawLandingFailed,
      },
      "Collector run completed",
    );
    return { signalsCollected: inserted, durationMs: Date.now() - start };
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "fetch_failed", { runId }, e.message);
    if (isIntelligenceEnabled()) {
      try {
        const finishedAt = new Date();
        await recordCollectorRun({
          runId,
          collectorId,
          postureClass: collector.postureClass,
          disclosureTier: collector.disclosureTier,
          startedAt: runStartedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - runStartedAt.getTime(),
          rowsEmitted: 0,
          bytesRaw: null,
          parseErrors: 0,
          schemaDriftCount: 0,
          rawPayloadPointer: null,
          rawLandingFailed: false,
          status: "failed",
          error: e.message,
        });
      } catch {
        /* swallowed — already failing the run */
      }
    }
    throw e;
  } finally {
    if (cancelPollHandle) clearInterval(cancelPollHandle);
  }
}

/**
 * Persist a schema-drift event per failing draft. Bounded to keep the
 * table from blowing up on a totally-broken upstream feed: the runtime
 * truncates the sample to a few representative fields and records at
 * most one row per unique field-path/error-code per run via in-process
 * dedupe.
 */
async function recordSchemaDriftEvent(
  collectorId: string,
  runId: string,
  draft: MarketSignalDraft,
  error: import("zod").ZodError,
): Promise<void> {
  const issues = error.issues.slice(0, 5);
  for (const issue of issues) {
    const fieldPath = issue.path.join(".");
    try {
      await db.insert(marketSignalSchemaDriftTable).values({
        id: newId("drift"),
        collectorId,
        runId,
        fieldPath,
        errorCode: issue.code,
        message: issue.message,
        occurrences: 1,
        sample: {
          signalType: draft.signalType,
          observedAt:
            draft.observedAt instanceof Date
              ? draft.observedAt.toISOString()
              : String(draft.observedAt),
          sourceUrl: draft.sourceUrl,
        },
      });
    } catch (e) {
      logger.warn(
        { collectorId, runId, err: (e as Error).message },
        "Failed to record schema-drift event",
      );
    }
  }
}

export interface BackfillResult {
  collectorId: string;
  daysWritten: number;
  signalsInserted: number;
  signalsSkipped: number;
  durationMs: number;
  /**
   * True when the backfill short-circuited because the database was
   * already in sync with the upstream archive — either via the cheap
   * DB pre-check (no HTTP at all) or via the HEAD-probe watermark
   * (single HEAD, no GET). Lets the API surface a clear "already up
   * to date" indicator instead of just `signalsInserted: 0`, which
   * the UI cannot otherwise distinguish from "ran the full pipeline
   * and every row was a duplicate".
   */
  alreadyUpToDate?: boolean;
}

/**
 * Build the dedupe key for an idempotent backfill insert. We key on the
 * combination of `signalType` plus all scope columns plus `observedAt` —
 * empty string when a column is null. This matches the natural identity of
 * a market signal: "the same source measurement of the same scope at the
 * same time", regardless of which scope column is populated.
 *
 * Backfill collectors (ECB, FRED) all anchor `observedAt` to a deterministic
 * timestamp matching what their live collector would write, so this string
 * key is a correct dedupe and does not require a schema migration.
 */
function signalDedupeKey(args: {
  signalType: string;
  scopeMaterialCode: string | null;
  scopeCategoryCode: string | null;
  scopeSku: string | null;
  scopeSupplierName: string | null;
  scopeLaneKey: string | null;
  scopeRegionCode: string | null;
  observedAt: Date;
}): string {
  return [
    args.signalType,
    args.scopeMaterialCode ?? "",
    args.scopeCategoryCode ?? "",
    args.scopeSku ?? "",
    args.scopeSupplierName ?? "",
    args.scopeLaneKey ?? "",
    args.scopeRegionCode ?? "",
    args.observedAt.toISOString(),
  ].join("|");
}

/**
 * Insert a batch of MarketSignalDrafts for a collector, skipping rows that
 * already exist on the natural-key unique index.
 *
 * Used by the ECB and FRED historical backfills, which can produce
 * thousands of rows spanning years. Two protections against duplicates
 * apply:
 *   1. **In-batch**: a `signalDedupeKey` Set collapses drafts that an
 *      upstream feed accidentally repeats inside the same payload —
 *      Postgres would otherwise reject the second occurrence within a
 *      single INSERT statement ("command cannot affect row a second
 *      time") even with ON CONFLICT DO NOTHING. The key spans every
 *      column in the natural index so it's safe across signal types
 *      (ECB's `fx_rate` and FRED's `economic_index` use different
 *      scope columns).
 *   2. **Across runs**: chunked inserts go through
 *      `insertSignalsWithDedupe`, which targets the
 *      `market_signals_natural_key_uq` index by expression-list
 *      inference — already-persisted rows are silently skipped at the
 *      database, so repeat backfills are atomic and race-free.
 */
// Exported for the FX-backfill batched-insert guardrail test
// (`fx-backfill-insert-batching.test.ts`). Production callers should
// keep going through `runEcbFxRatesBackfill` / `runFredEconomicIndexBackfill`
// — they layer the kill-switch / approval gates and audit log on top.
export async function insertSignalsIdempotent(
  collectorRow: CollectorRow,
  drafts: MarketSignalDraft[],
): Promise<{ inserted: number; skipped: number }> {
  if (drafts.length === 0) return { inserted: 0, skipped: 0 };

  const seenInBatch = new Set<string>();
  const toInsert: Array<typeof marketSignalsTable.$inferInsert> = [];
  let inBatchSkipped = 0;
  for (const d of drafts) {
    const scopeMaterialCode = normalizeScope(d.scopeMaterialCode);
    const scopeCategoryCode = normalizeScope(d.scopeCategoryCode);
    const scopeSku = normalizeScope(d.scopeSku);
    const scopeSupplierName = normalizeScope(d.scopeSupplierName);
    const scopeLaneKey = normalizeScope(d.scopeLaneKey);
    const scopeRegionCode = normalizeScope(d.scopeRegionCode);
    const k = signalDedupeKey({
      signalType: d.signalType,
      scopeMaterialCode,
      scopeCategoryCode,
      scopeSku,
      scopeSupplierName,
      scopeLaneKey,
      scopeRegionCode,
      observedAt: d.observedAt,
    });
    if (seenInBatch.has(k)) {
      inBatchSkipped++;
      continue;
    }
    seenInBatch.add(k);
    toInsert.push({
      id: newId("sig"),
      orgId: null,
      collectorId: collectorRow.id,
      signalType: d.signalType,
      scopeCategoryCode,
      scopeSku,
      scopeMaterialCode,
      scopeSupplierName,
      scopeLaneKey,
      scopeRegionCode,
      value: String(d.value),
      unit: d.unit,
      currency: d.currency ?? "USD",
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      posture: collectorRow.posture,
      confidence: String(d.confidence ?? 0.7),
      metadata:
        d.entityUid !== null && d.entityUid !== undefined
          ? { ...(d.metadata ?? {}), entityUid: d.entityUid }
          : (d.metadata ?? {}),
    });
  }

  // Chunked to keep each round-trip's parameter count well under
  // Postgres' 65535-parameter limit. Signal row ≈ 17 columns, so
  // 500 rows × 17 ≈ 8.5k params per statement — comfortably safe.
  const CHUNK_SIZE = 500;
  let inserted = 0;
  let crossRunDuplicates = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const r = await insertSignalsWithDedupe(chunk);
    inserted += r.inserted;
    crossRunDuplicates += r.duplicates;
    // Mirror the live collector path: publish freshly inserted ids so
    // the War Room SSE stream picks them up. Backfills tend to land
    // historical rows that won't trigger NEW-badges (the SSE consumer
    // dedupes against rows already in its window) but the push is
    // cheap and keeps the pipelines symmetric.
    publishMarketSignalIds(r.newlyInsertedIds);
  }
  return { inserted, skipped: inBatchSkipped + crossRunDuplicates };
}

/**
 * Run the one-shot historical backfill for the ECB FX collector.
 *
 * Fetches `eurofxref-hist.xml` (one HTTP call), expands it to per-day
 * EUR-base + USD-derived drafts using the same shape the live collector
 * writes, and inserts only the day/pair rows that aren't already in
 * `market_signals`. Re-running is therefore a safe no-op.
 *
 * Gated on the same kill switch + approval status as the live collector so
 * a paused collector cannot be force-fed through the backfill path.
 */
export async function runEcbFxRatesBackfill(
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<BackfillResult> {
  const start = Date.now();
  const nowMs = opts.nowMs ?? Date.now();
  const collectorId = ECB_FX_RATES_COLLECTOR_ID;
  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);
  if (!reg) {
    throw new Error(`Collector ${collectorId} not registered`);
  }
  if (reg.killSwitch === 1) {
    await audit(collectorId, "backfill_skipped_kill_switch");
    throw new Error("Collector is killed; release the kill switch first.");
  }
  if (reg.status !== "approved" && !opts.force) {
    await audit(collectorId, "backfill_skipped_not_approved", {
      status: reg.status,
    });
    throw new Error(
      `Collector status is ${reg.status}; approve it before backfilling.`,
    );
  }

  // DB-only pre-check (no network): if we have a prior successful
  // backfill that stamped a `latestArchiveDate`, AND `now` is earlier
  // than the earliest possible time ECB could publish the next file,
  // AND the corresponding row is still present in `market_signals`,
  // then upstream provably has nothing new and we can declare
  // "already up to date" without any HTTP. This is what makes a
  // re-press of the System page's Backfill button feel instant
  // (~10ms) instead of paying for a HEAD round-trip.
  //
  // Correctness: ECB publishes the historical archive at most once
  // per business day around 16:00 CET. `nextEcbPublicationEarliestAt`
  // returns the next weekday after `latestArchiveDate` at 13:30 UTC
  // — a conservative buffer ahead of the earliest realistic publish
  // time (≈14:30 UTC during DST). Until that moment, no new archive
  // row can possibly exist upstream, so skipping is safe. After that
  // moment we fall through to the HEAD probe to learn the truth from
  // upstream headers.
  if (!opts.force) {
    const fresh = await readEcbBackfillFreshness(collectorId);
    if (fresh) {
      const nextPub = nextEcbPublicationEarliestAt(fresh.latestArchiveDate);
      if (nowMs < nextPub.getTime()) {
        const dbHasLatest = await marketSignalHasObservedAt(
          collectorId,
          ecbObservedAt(fresh.latestArchiveDate),
        );
        if (dbHasLatest) {
          await audit(collectorId, "backfill_skipped_already_up_to_date", {
            latestArchiveDate: fresh.latestArchiveDate,
            archiveEtag: fresh.etag,
            archiveLastModified: fresh.lastModified,
            nextPublicationEarliestAt: nextPub.toISOString(),
          });
          logger.info(
            {
              collectorId,
              latestArchiveDate: fresh.latestArchiveDate,
              nextPublicationEarliestAt: nextPub.toISOString(),
            },
            "ECB FX backfill skipped: DB already has the latest archive day and upstream cannot have published yet",
          );
          return {
            collectorId,
            daysWritten: 0,
            signalsInserted: 0,
            signalsSkipped: 0,
            durationMs: Date.now() - start,
            alreadyUpToDate: true,
          };
        }
      }
    }
  }

  // Cheap HEAD probe: ECB's historical archive ships static cache headers,
  // so we can short-circuit the full XML fetch + ~7000-day fan-out + dedupe
  // pass when neither header has advanced past the previous successful
  // run's watermark. `force` bypasses the check (admin override / tests).
  // If HEAD itself fails (network, upstream HEAD disabled), fall through
  // to the full fetch — we never silently skip on an inconclusive probe.
  if (!opts.force) {
    const watermark = await readEcbBackfillWatermark(collectorId);
    if (watermark) {
      try {
        const head = await headEcbHistoricalFeed();
        const etagMatches =
          watermark.etag !== null && head.etag !== null && head.etag === watermark.etag;
        const lastModifiedMatches =
          watermark.lastModified !== null &&
          head.lastModified !== null &&
          head.lastModified === watermark.lastModified;
        if (etagMatches || lastModifiedMatches) {
          await audit(collectorId, "backfill_skipped_unchanged", {
            archiveEtag: head.etag,
            archiveLastModified: head.lastModified,
            watermarkEtag: watermark.etag,
            watermarkLastModified: watermark.lastModified,
          });
          logger.info(
            { collectorId, etag: head.etag, lastModified: head.lastModified },
            "ECB FX backfill skipped: archive unchanged since last watermark",
          );
          return {
            collectorId,
            daysWritten: 0,
            signalsInserted: 0,
            signalsSkipped: 0,
            durationMs: Date.now() - start,
            alreadyUpToDate: true,
          };
        }
      } catch (err) {
        logger.warn(
          { err, collectorId },
          "ECB historical feed HEAD probe failed; falling through to full fetch",
        );
      }
    }
  }

  await audit(collectorId, "backfill_started");
  try {
    const { drafts, lastModified, etag } = await fetchEcbBackfillDraftsWithMeta();
    const days = new Set(
      drafts.map((d) => d.observedAt.toISOString().slice(0, 10)),
    ).size;
    // Pull the most-recent archived day out of the parsed drafts so the
    // next run's DB pre-check has a stable target to look up. Empty
    // archives are impossible in practice (ECB always has 25+ years
    // back) but we tolerate it by recording null.
    let latestArchiveDate: string | null = null;
    for (const d of drafts) {
      const iso = d.observedAt.toISOString().slice(0, 10);
      if (latestArchiveDate === null || iso > latestArchiveDate) {
        latestArchiveDate = iso;
      }
    }
    const { inserted, skipped } = await insertSignalsIdempotent(reg, drafts);
    const result: BackfillResult = {
      collectorId,
      daysWritten: days,
      signalsInserted: inserted,
      signalsSkipped: skipped,
      durationMs: Date.now() - start,
    };
    // Watermark is stamped into the success audit row; the next run's
    // pre-check reads `latestArchiveDate` to decide whether the DB is
    // still in sync, and the next HEAD probe reads `archiveLastModified`
    // / `archiveEtag` as its watermark. Always written on success even
    // when fields are null so the audit trail is uniform.
    await audit(collectorId, "backfill_succeeded", {
      days,
      inserted,
      skipped,
      drafts: drafts.length,
      archiveLastModified: lastModified,
      archiveEtag: etag,
      latestArchiveDate,
    });
    logger.info(
      { collectorId, days, inserted, skipped, lastModified, etag, latestArchiveDate },
      "ECB FX backfill completed",
    );
    return result;
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "backfill_failed", {}, e.message);
    throw e;
  }
}


/**
 * Look up the most recent successful ECB backfill audit row and return
 * the archive Last-Modified / ETag headers we stamped at the time. These
 * are the watermark the next run's HEAD probe compares against.
 *
 * Returns `null` if no prior success exists (first run) or if the prior
 * success row predates this watermark feature (no header fields in
 * metadata) — in either case the caller will fall through to the full
 * fetch so we never accidentally skip on missing state.
 */
async function readEcbBackfillWatermark(
  collectorId: string,
): Promise<{ lastModified: string | null; etag: string | null } | null> {
  const [row] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, collectorId),
        eq(collectorAuditLogTable.event, "backfill_succeeded"),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  if (!row) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const hasEtag = "archiveEtag" in meta;
  const hasLastModified = "archiveLastModified" in meta;
  if (!hasEtag && !hasLastModified) return null;
  const etag =
    typeof meta["archiveEtag"] === "string"
      ? (meta["archiveEtag"] as string)
      : null;
  const lastModified =
    typeof meta["archiveLastModified"] === "string"
      ? (meta["archiveLastModified"] as string)
      : null;
  return { etag, lastModified };
}

/**
 * Look up the most recent successful ECB backfill audit row and return
 * the stamped `latestArchiveDate` plus the cache headers we recorded
 * for it. The DB pre-check uses these to decide whether it can skip
 * the network entirely.
 *
 * Returns `null` when no prior success exists, when the prior row
 * predates the `latestArchiveDate` field (older runs before this
 * feature shipped), or when the stamped date is unparseable. In every
 * case the caller falls through to the HEAD path so we never silently
 * skip on missing state.
 */
async function readEcbBackfillFreshness(
  collectorId: string,
): Promise<
  | {
      latestArchiveDate: string;
      etag: string | null;
      lastModified: string | null;
    }
  | null
> {
  const [row] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, collectorId),
        eq(collectorAuditLogTable.event, "backfill_succeeded"),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  if (!row) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const latestArchiveDate =
    typeof meta["latestArchiveDate"] === "string"
      ? (meta["latestArchiveDate"] as string)
      : null;
  if (!latestArchiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(latestArchiveDate)) {
    return null;
  }
  const etag =
    typeof meta["archiveEtag"] === "string"
      ? (meta["archiveEtag"] as string)
      : null;
  const lastModified =
    typeof meta["archiveLastModified"] === "string"
      ? (meta["archiveLastModified"] as string)
      : null;
  return { latestArchiveDate, etag, lastModified };
}

/**
 * Existence probe against `market_signals` for one collector + one
 * `observed_at`. Targets the natural-key unique index so the planner
 * resolves it as a single index lookup regardless of how many rows the
 * table holds — well under the ~1ms budget the pre-check needs.
 */
async function marketSignalHasObservedAt(
  collectorId: string,
  observedAt: Date,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(
      and(
        eq(marketSignalsTable.collectorId, collectorId),
        eq(marketSignalsTable.observedAt, observedAt),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/**
 * Compute the earliest possible UTC instant at which ECB could publish
 * the next historical archive update, given the most recently archived
 * business day.
 *
 * ECB publishes the EUR foreign-exchange reference rates once per
 * business day around 16:00 CET (≈14:30–15:00 UTC depending on DST).
 * The historical archive file (`eurofxref-hist.xml`) is updated at the
 * same cadence with the new day appended. We return the next weekday
 * after `latestArchiveDate` at **13:30 UTC** — a conservative buffer
 * ahead of the earliest realistic publish time. Until that instant,
 * upstream provably cannot have published anything new, and the DB
 * pre-check can safely skip without touching the network. After that
 * instant we fall through to the HEAD probe.
 */
function nextEcbPublicationEarliestAt(latestArchiveDate: string): Date {
  const d = new Date(`${latestArchiveDate}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  d.setUTCHours(13, 30, 0, 0);
  return d;
}

/**
 * Run the one-shot historical backfill for the FRED economic index
 * collector.
 *
 * Walks the curated `FRED_SERIES` list, fetches each series' observation
 * history (default: last 5 years) from the FRED API, and inserts only the
 * (series × observed_at) rows that aren't already in `market_signals`.
 * Re-running is therefore a safe no-op.
 *
 * Gated on the same kill switch + approval status as the live collector so
 * a paused collector cannot be force-fed through the backfill path. The
 * regular daily collector (`collect()`) is unaffected — it still emits
 * latest-observation-only signals on its cron.
 *
 * `observationStart` overrides the default 5-year window when the caller
 * needs a deeper or shallower history (admin tooling or tests).
 */
export async function runFredEconomicIndexBackfill(
  opts: { force?: boolean; observationStart?: string } = {},
): Promise<BackfillResult> {
  const start = Date.now();
  const collectorId = FRED_ECONOMIC_INDEX_COLLECTOR_ID;
  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);
  if (!reg) {
    throw new Error(`Collector ${collectorId} not registered`);
  }
  if (reg.killSwitch === 1) {
    await audit(collectorId, "backfill_skipped_kill_switch");
    throw new Error("Collector is killed; release the kill switch first.");
  }
  if (reg.status !== "approved" && !opts.force) {
    await audit(collectorId, "backfill_skipped_not_approved", {
      status: reg.status,
    });
    throw new Error(
      `Collector status is ${reg.status}; approve it before backfilling.`,
    );
  }

  await audit(collectorId, "backfill_started", {
    observationStart: opts.observationStart ?? null,
  });
  try {
    const { drafts, failedSeries } = await fetchFredBackfillDrafts(
      opts.observationStart ? { observationStart: opts.observationStart } : {},
    );
    // If every tracked series failed to fetch, the run is genuinely broken
    // (bad API key, FRED outage, network) — surface it to the caller so the
    // audit log records a failure instead of "succeeded with 0 inserts".
    if (drafts.length === 0 && failedSeries.length === FRED_SERIES.length) {
      const sample = failedSeries.slice(0, 3).map((f) => f.error).join("; ");
      throw new Error(
        `FRED backfill: all ${FRED_SERIES.length} series failed. Sample errors: ${sample}`,
      );
    }
    const days = new Set(
      drafts.map((d) => d.observedAt.toISOString().slice(0, 10)),
    ).size;
    const { inserted, skipped } = await insertSignalsIdempotent(reg, drafts);
    const result: BackfillResult = {
      collectorId,
      daysWritten: days,
      signalsInserted: inserted,
      signalsSkipped: skipped,
      durationMs: Date.now() - start,
    };
    await audit(collectorId, "backfill_succeeded", {
      days,
      inserted,
      skipped,
      drafts: drafts.length,
      failedSeries: failedSeries.length,
    });
    logger.info(
      { collectorId, days, inserted, skipped, failedSeries: failedSeries.length },
      "FRED economic index backfill completed",
    );
    return result;
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "backfill_failed", {}, e.message);
    throw e;
  }
}

/**
 * Generic backfill skeleton — kill-switch + approval gating + audit
 * trail + idempotent insert. Per-collector wrappers below supply
 * `fetchDrafts` and any per-source labeling. Lives next to
 * `runEcbFxRatesBackfill` / `runFredEconomicIndexBackfill` (which
 * predate this helper); migration of those two to the generic shape
 * is a follow-up so we don't churn passing tests in this task.
 */
async function runGenericBackfill(args: {
  collectorId: string;
  startedMeta?: Record<string, unknown>;
  fetchDrafts: () => Promise<{
    drafts: MarketSignalDraft[];
    extraSucceededMeta?: Record<string, unknown>;
  }>;
  force?: boolean;
}): Promise<BackfillResult> {
  const start = Date.now();
  const { collectorId } = args;
  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);
  if (!reg) throw new Error(`Collector ${collectorId} not registered`);
  if (reg.killSwitch === 1) {
    await audit(collectorId, "backfill_skipped_kill_switch");
    throw new Error("Collector is killed; release the kill switch first.");
  }
  if (reg.status !== "approved" && !args.force) {
    await audit(collectorId, "backfill_skipped_not_approved", {
      status: reg.status,
    });
    throw new Error(
      `Collector status is ${reg.status}; approve it before backfilling.`,
    );
  }
  await audit(collectorId, "backfill_started", args.startedMeta ?? {});
  try {
    const { drafts, extraSucceededMeta } = await args.fetchDrafts();
    const days = new Set(
      drafts.map((d) =>
        (d.observedAt instanceof Date ? d.observedAt : new Date(d.observedAt))
          .toISOString()
          .slice(0, 10),
      ),
    ).size;
    const { inserted, skipped } = await insertSignalsIdempotent(reg, drafts);
    const result: BackfillResult = {
      collectorId,
      daysWritten: days,
      signalsInserted: inserted,
      signalsSkipped: skipped,
      durationMs: Date.now() - start,
    };
    await audit(collectorId, "backfill_succeeded", {
      days,
      inserted,
      skipped,
      drafts: drafts.length,
      ...(extraSucceededMeta ?? {}),
    });
    logger.info(
      { collectorId, days, inserted, skipped, drafts: drafts.length },
      "Backfill completed",
    );
    return result;
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "backfill_failed", {}, e.message);
    throw e;
  }
}

/** Backfill the SEC EDGAR collector. */
export async function runSecEdgarBackfill(
  opts: { force?: boolean; issuers?: readonly SecIssuerRef[] } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: SEC_EDGAR_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { issuers: opts.issuers?.length ?? "default" },
    fetchDrafts: async () => {
      const { drafts, failedIssuers } = await fetchEdgarBackfillDrafts(
        opts.issuers ? { issuers: opts.issuers } : {},
      );
      return {
        drafts,
        extraSucceededMeta: { failedIssuers: failedIssuers.length },
      };
    },
  });
}

/** Backfill the OpenSanctions collector (lifts the per-tick row cap). */
export async function runOpenSanctionsBackfill(
  opts: { force?: boolean; cap?: number } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: OPENSANCTIONS_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { cap: opts.cap ?? null },
    fetchDrafts: async () => {
      const { drafts } = await fetchOpenSanctionsBackfillDrafts(
        opts.cap ? { cap: opts.cap } : {},
      );
      return { drafts };
    },
  });
}

/** Backfill the GLEIF LEI collector. */
export async function runGleifLeiBackfill(
  opts: { force?: boolean; maxPages?: number; pageSize?: number } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: GLEIF_LEI_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { maxPages: opts.maxPages ?? null, pageSize: opts.pageSize ?? null },
    fetchDrafts: async () => {
      const { drafts, pagesFetched } = await fetchGleifBackfillDrafts({
        ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
        ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
      });
      return { drafts, extraSucceededMeta: { pagesFetched } };
    },
  });
}

/** Backfill the ClimateTRACE collector. */
export async function runClimateTraceBackfill(
  opts: {
    force?: boolean;
    maxPages?: number;
    pageSize?: number;
    sector?: string;
    country?: string;
  } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: CLIMATE_TRACE_COLLECTOR_ID,
    force: opts.force,
    startedMeta: {
      sector: opts.sector ?? null,
      country: opts.country ?? null,
      maxPages: opts.maxPages ?? null,
    },
    fetchDrafts: async () => {
      const { drafts, pagesFetched } = await fetchClimateTraceBackfillDrafts({
        ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
        ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
        ...(opts.sector !== undefined ? { sector: opts.sector } : {}),
        ...(opts.country !== undefined ? { country: opts.country } : {}),
      });
      return { drafts, extraSucceededMeta: { pagesFetched } };
    },
  });
}

/** Backfill the Companies House collector. */
export async function runCompaniesHouseBackfill(
  opts: { force?: boolean; numbers?: readonly string[] } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: COMPANIES_HOUSE_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { numbers: opts.numbers?.length ?? "default" },
    fetchDrafts: async () => {
      const { drafts, failed } = await fetchCompaniesHouseBackfillDrafts(
        opts.numbers ? { numbers: opts.numbers } : {},
      );
      return { drafts, extraSucceededMeta: { failed: failed.length } };
    },
  });
}

/**
 * Backfill the USDA NASS agricultural commodity collector. Replays
 * `yearGe` (default: 5 years back) of monthly Prices Received rows for
 * the curated commodity list and inserts only the (series × month)
 * rows that aren't already in `market_signals` — so re-runs are safe
 * no-ops. Throws if every curated series fails so the audit log
 * records `backfill_failed` instead of "succeeded with 0 inserts".
 */
export async function runUsdaNassEconomicIndexBackfill(
  opts: { force?: boolean; yearGe?: number } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { yearGe: opts.yearGe ?? null },
    fetchDrafts: async () => {
      const { drafts, failedSeries } = await fetchUsdaNassBackfillDrafts(
        opts.yearGe !== undefined ? { yearGe: opts.yearGe } : {},
      );
      if (drafts.length === 0 && failedSeries.length === NASS_SERIES.length) {
        const sample = failedSeries
          .slice(0, 3)
          .map((f) => f.error)
          .join("; ");
        throw new Error(
          `USDA NASS backfill: all ${NASS_SERIES.length} series failed. Sample errors: ${sample}`,
        );
      }
      return {
        drafts,
        extraSucceededMeta: { failedSeries: failedSeries.length },
      };
    },
  });
}

/**
 * Backfill the EPA ECHO supplier-risk collector. Replays the full
 * watched US supplier list (uncapped) so the supplier-risk timeline
 * picks up historical enforcement cases the recurring tick missed
 * because of the per-tick supplier cap.
 */
export async function runEpaEchoBackfill(
  opts: { force?: boolean; suppliers?: readonly WatchedUsSupplier[] } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: EPA_ECHO_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { suppliers: opts.suppliers?.length ?? "all-watched-us" },
    fetchDrafts: async () => {
      const { drafts, failed } = await fetchEpaEchoBackfillDrafts(
        opts.suppliers ? { suppliers: opts.suppliers } : {},
      );
      return { drafts, extraSucceededMeta: { failed: failed.length } };
    },
  });
}

/**
 * Backfill the OSHA inspections collector. Same shape as the EPA ECHO
 * backfill: lift the per-tick cap and replay every watched US supplier.
 */
export async function runOshaInspectionsBackfill(
  opts: { force?: boolean; suppliers?: readonly WatchedUsSupplier[] } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: OSHA_COLLECTOR_ID,
    force: opts.force,
    startedMeta: { suppliers: opts.suppliers?.length ?? "all-watched-us" },
    fetchDrafts: async () => {
      const { drafts, failed } = await fetchOshaBackfillDrafts(
        opts.suppliers ? { suppliers: opts.suppliers } : {},
      );
      return { drafts, extraSucceededMeta: { failed: failed.length } };
    },
  });
}

/**
 * Backfill the USGS Mineral Resources commodity collector. Replays
 * the full DS-140 historical statistics workbook for every curated
 * mineral and inserts only the (mineral × year) rows that aren't
 * already in `market_signals` — so re-runs are safe no-ops. Throws if
 * every curated mineral fails so the audit log records
 * `backfill_failed` instead of "succeeded with 0 inserts".
 */
export async function runUsgsMineralBackfill(
  opts: { force?: boolean } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: USGS_MINERAL_COLLECTOR_ID,
    force: opts.force,
    startedMeta: {},
    fetchDrafts: async () => {
      const { drafts, failedMinerals } = await fetchUsgsMineralBackfillDrafts();
      if (
        drafts.length === 0 &&
        failedMinerals.length === USGS_MINERALS.length
      ) {
        const sample = failedMinerals
          .slice(0, 3)
          .map((f) => f.error)
          .join("; ");
        throw new Error(
          `USGS backfill: all ${USGS_MINERALS.length} minerals failed. Sample errors: ${sample}`,
        );
      }
      return {
        drafts,
        extraSucceededMeta: { failedMinerals: failedMinerals.length },
      };
    },
  });
}

/**
 * Backfill the Eurostat economic index collector. Replays
 * 5 years of HICP / PPI history for the curated EU series and
 * inserts only the (series × period) rows that aren't already in
 * `market_signals` — so re-runs are safe no-ops. Throws if every
 * curated series fails so the audit log records `backfill_failed`
 * instead of "succeeded with 0 inserts".
 */
export async function runEurostatEconomicIndexBackfill(
  opts: {
    force?: boolean;
    sinceMonthly?: string;
    sinceQuarterly?: string;
  } = {},
): Promise<BackfillResult> {
  return runGenericBackfill({
    collectorId: EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
    force: opts.force,
    startedMeta: {
      sinceMonthly: opts.sinceMonthly ?? null,
      sinceQuarterly: opts.sinceQuarterly ?? null,
    },
    fetchDrafts: async () => {
      const { drafts, failedSeries } = await fetchEurostatBackfillDrafts({
        ...(opts.sinceMonthly !== undefined
          ? { sinceMonthly: opts.sinceMonthly }
          : {}),
        ...(opts.sinceQuarterly !== undefined
          ? { sinceQuarterly: opts.sinceQuarterly }
          : {}),
      });
      if (drafts.length === 0 && failedSeries.length === EUROSTAT_SERIES.length) {
        const sample = failedSeries
          .slice(0, 3)
          .map((f) => f.error)
          .join("; ");
        throw new Error(
          `Eurostat backfill: all ${EUROSTAT_SERIES.length} series failed. Sample errors: ${sample}`,
        );
      }
      return {
        drafts,
        extraSucceededMeta: { failedSeries: failedSeries.length },
      };
    },
  });
}

export async function setKillSwitch(
  collectorId: string,
  on: boolean,
  actor?: string,
): Promise<CollectorRow | null> {
  const [row] = await db
    .update(collectorsTable)
    .set({ killSwitch: on ? 1 : 0 })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, on ? "kill_switch_on" : "kill_switch_off", {
    actor: actor ?? null,
  });
  return row ?? null;
}

export async function approveCollector(
  collectorId: string,
  actor: string,
): Promise<CollectorRow | null> {
  const [row] = await db
    .update(collectorsTable)
    .set({ status: "approved", approvedBy: actor, approvedAt: new Date() })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, "approved", { actor });
  return row ?? null;
}

export async function disableCollector(
  collectorId: string,
  actor: string,
  reason: "rejected" | "draft" = "rejected",
): Promise<CollectorRow | null> {
  const [row] = await db
    .update(collectorsTable)
    .set({ status: reason })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, "disabled", { actor, reason });
  return row ?? null;
}

export async function setRateLimit(
  collectorId: string,
  rpm: number,
  actor: string,
): Promise<CollectorRow | null> {
  const safe = Math.max(1, Math.min(10000, Math.floor(rpm)));
  const [row] = await db
    .update(collectorsTable)
    .set({ rateLimitRpm: safe })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, "rate_limit_set", { actor, rpm: safe });
  return row ?? null;
}

export async function upsertCollectorRegistration(args: {
  id: string;
  name: string;
  description: string;
  posture: CollectorRow["posture"];
  owner: string;
  sourceUrl: string;
  rateLimitRpm?: number;
  scheduleCron?: string | null;
  notes?: string | null;
  actor: string;
}): Promise<CollectorRow> {
  const existing = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, args.id))
    .limit(1);
  if (existing.length > 0) {
    const [updated] = await db
      .update(collectorsTable)
      .set({
        name: args.name,
        description: args.description,
        posture: args.posture,
        owner: args.owner,
        sourceUrl: args.sourceUrl,
        rateLimitRpm: args.rateLimitRpm ?? existing[0]!.rateLimitRpm,
        scheduleCron: args.scheduleCron ?? existing[0]!.scheduleCron,
        notes: args.notes ?? existing[0]!.notes,
      })
      .where(eq(collectorsTable.id, args.id))
      .returning();
    await audit(args.id, "registration_updated", { actor: args.actor });
    return updated!;
  }
  const [inserted] = await db
    .insert(collectorsTable)
    .values({
      id: args.id,
      name: args.name,
      description: args.description,
      posture: args.posture,
      status: "draft",
      owner: args.owner,
      sourceUrl: args.sourceUrl,
      rateLimitRpm: args.rateLimitRpm ?? 10,
      scheduleCron: args.scheduleCron ?? null,
      notes: args.notes ?? null,
    })
    .returning();
  await audit(args.id, "registered", { actor: args.actor });
  return inserted!;
}

export async function listCollectorAudit(
  collectorId: string,
  limit = 100,
): Promise<Array<typeof collectorAuditLogTable.$inferSelect>> {
  return await db
    .select()
    .from(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, collectorId))
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
}
