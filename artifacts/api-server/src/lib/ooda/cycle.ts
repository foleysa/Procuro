import {
  db,
  analysisCyclesTable,
  opportunitiesTable,
  decisionsTable,
  categoriesTable,
  type LeverId,
  type OpportunityRow,
  type AnalysisCycleRow,
  resolveDoaTierNumber,
} from "@workspace/db";
import { eq, and, asc, desc, gt, inArray, lte, sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { ALL_LEVERS } from "../levers";
import {
  applyLearnUpdates,
  ensurePriorsBootstrapped,
  loadActiveExclusions,
  loadPriors,
  type OutcomeStats,
  type PriorDelta,
  type ExclusionDelta,
  type PriorMap,
} from "./priors";
import {
  composeSignalKey,
  toAnalyzeResult,
  type AnalyzeResult,
  type LeverAnalyzer,
  type OpportunityDraft,
} from "../levers/types";
import {
  determineOpportunityMappedVia,
  leversForCategory,
  leversInFragmentedFallback,
} from "../intelligence/routing";
import { captureFunnelSnapshot } from "./funnel";
import {
  getTierAutoApplySettings,
  loadCategoryLeverScales,
  makeScaleMapKey,
  processTierUpdates,
  type CategoryLeverScaleMap,
} from "./tier-auto-apply";

export interface RunCycleResult {
  cycleId: string;
  generation: number;
  opportunitiesCreated: number;
  totalProjectedUsd: number;
  priorDeltas: PriorDelta[];
  exclusionDeltas: ExclusionDelta[];
}

/**
 * Run a full OODA cycle for a tenant.
 * Observe → Orient → Decide → Act → Learn (Learn applies to outcomes from
 * the previous cycle and shapes the priors used by THIS cycle).
 *
 * Concrete order:
 *   1. Observe: snapshot data + outcome events since last cycle.
 *   2. Learn (from previous cycle's outcomes): apply weighted updates to
 *      priors and exclusion rules — this updates the priors loaded next.
 *   3. Orient: load now-current priors + active exclusion rules.
 *   4. Decide: run all lever analyzers, apply priors, drop exclusions, rank.
 *   5. Act: persist opportunities. Approvals/rejections/realizations after
 *      this cycle will feed the NEXT cycle's Learn step.
 */
export async function runAnalysisCycle(args: {
  orgId: string;
  triggeredBy: string;
  /**
   * Optional cooperative-cancellation hook. Wired up by the job worker as
   * `() => isJobCancelRequested(job.id)` so an operator pressing Cancel
   * on the System / Jobs page short-circuits a running cycle within
   * seconds at the next phase / lever / opportunity boundary instead of
   * waiting for every analyzer to finish. We deliberately check between
   * phases (Observe / Learn / Orient / Decide / Act) and inside the per-
   * lever and per-opportunity loops — these are the only safe spots:
   * the cycle row is already in `running`, and bailing out causes the
   * surrounding `try/catch` to flip it to `failed` along with the
   * job itself. Direct callers (REST routes) just don't pass this.
   */
  isCancelled?: () => Promise<boolean>;
}): Promise<RunCycleResult> {
  const { orgId, triggeredBy, isCancelled } = args;
  const checkpoint = async (): Promise<void> => {
    if (isCancelled && (await isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
  };

  await ensurePriorsBootstrapped(orgId);

  // --- Determine generation ---
  const [last] = await db
    .select({ generation: analysisCyclesTable.generation, id: analysisCyclesTable.id })
    .from(analysisCyclesTable)
    .where(eq(analysisCyclesTable.orgId, orgId))
    .orderBy(desc(analysisCyclesTable.generation))
    .limit(1);
  const generation = (last?.generation ?? 0) + 1;
  const cycleId = newId("cyc");
  const previousCycleId = last?.id ?? null;

  // --- Insert running cycle stub ---
  await db.insert(analysisCyclesTable).values({
    id: cycleId,
    orgId,
    generation,
    triggeredBy,
    status: "running",
  });

  try {
    await checkpoint();
    // --- 1. Observe ---
    const observe = await observeStep(orgId, previousCycleId);

    await checkpoint();
    // --- 2. Learn (from outcomes since previous cycle) ---
    const outcomes = await collectOutcomesSinceLastCycle(
      orgId,
      previousCycleId,
    );
    const priorsBeforeLearn = await loadPriors(orgId);
    const { priorDeltas, exclusionDeltas } = await applyLearnUpdates({
      orgId,
      cycleId,
      cycleGeneration: generation,
      outcomes,
    });

    await checkpoint();
    // --- 3. Orient ---
    const priors = await loadPriors(orgId);
    const exclusions = await loadActiveExclusions(orgId);
    const orientPayload = {
      priors,
      priorsDiffVsPrevious: diffPriors(priorsBeforeLearn, priors),
      activeExclusionCount: exclusions.length,
    };

    await checkpoint();
    // --- 4. Decide ---
    // Per-lever analyzers are the slowest part of a typical cycle, so
    // checkpoint between each one to get sub-second cancel response on
    // big tenants.
    //
    // We retain per-lever AnalyzeResult and the per-lever draft mapping
    // so the funnel snapshot writer (downstream) can attribute signals
    // → drafts → persisted opportunities along the actual lever lineage
    // instead of guessing post-hoc from opportunity rows.
    const leverResults: Array<{ lever: LeverAnalyzer; result: AnalyzeResult }> = [];
    // First pass: run every analyzer and keep the post-exclusion
    // drafts unranked. We hold off on the rank computation until we
    // have the per-(category, lever) scale overrides loaded — those
    // depend on canonical category codes (`categoryMetaById`), and
    // resolving them requires the union of all categoryIds across
    // analyzers so it can't fold into the per-lever loop.
    const rawDrafts: { lever: LeverAnalyzer; draft: OpportunityDraft }[] = [];
    for (const lever of ALL_LEVERS) {
      await checkpoint();
      const rawResult = await lever.analyze({ orgId, cycleId });
      const result = toAnalyzeResult(rawResult);
      leverResults.push({ lever, result });
      for (const d of result.drafts) {
        if (
          exclusions.some(
            (e) =>
              (e.leverId === null || e.leverId === d.leverId) &&
              (e.supplierId === null || e.supplierId === (d.supplierId ?? null)) &&
              (e.categoryId === null || e.categoryId === (d.categoryId ?? null)),
          )
        ) {
          continue;
        }
        rawDrafts.push({ lever, draft: d });
      }
    }

    // Resolve category meta for every draft up front so both the
    // per-(category, lever) scale lookup AND the downstream band
    // applicability gate share one batched read instead of two.
    const categoryIds = Array.from(
      new Set(
        rawDrafts
          .map((d) => d.draft.categoryId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const categoryMetaById = new Map<
      string,
      { code: string; name: string }
    >();
    if (categoryIds.length > 0) {
      const cats = await db
        .select({
          id: categoriesTable.id,
          code: categoriesTable.code,
          name: categoriesTable.name,
        })
        .from(categoriesTable)
        .where(
          and(
            eq(categoriesTable.orgId, orgId),
            inArray(categoriesTable.id, categoryIds),
          ),
        );
      for (const c of cats) {
        categoryMetaById.set(c.id, { code: c.code, name: c.name });
      }
    }

    // Per-(category, lever) prior scale overrides (task #229). Only
    // mode == "auto" actually wires the override map into Decide;
    // advisory mode uses the empty map so suggestions surface in
    // admin UIs but never mutate scoring. Reading the toggle here
    // (vs gating only the post-snapshot writeback) ensures the two
    // halves of the loop — Decide-time apply and post-snapshot
    // hysteresis — are consistent within a cycle.
    const tierAutoApplyMode = (await getTierAutoApplySettings()).mode;
    const priorScaleOverrides: CategoryLeverScaleMap =
      tierAutoApplyMode === "auto"
        ? await loadCategoryLeverScales(orgId)
        : new Map();
    const lookupScale = (
      categoryId: string | null | undefined,
      leverId: LeverId,
    ): { projection: number; confidence: number } => {
      if (!categoryId) return { projection: 1, confidence: 1 };
      const code = categoryMetaById.get(categoryId)?.code;
      if (!code) return { projection: 1, confidence: 1 };
      const hit = priorScaleOverrides.get(makeScaleMapKey(code, leverId));
      if (!hit) return { projection: 1, confidence: 1 };
      return { projection: hit.projection, confidence: hit.confidence };
    };

    // Second pass: compute the rank now that priors AND per-(cat,
    // lever) overrides are both in hand.
    const drafts: {
      lever: LeverAnalyzer;
      draft: OpportunityDraft;
      rank: number;
    }[] = [];
    for (const { lever, draft: d } of rawDrafts) {
      const prior = priors[d.leverId];
      const scale = lookupScale(d.categoryId, d.leverId);
      const projected =
        d.rawProjectedSavingsUsd *
        prior.projectionMultiplier *
        scale.projection;
      const confidence = prior.confidenceWeight * scale.confidence;
      drafts.push({ lever, draft: d, rank: projected * confidence });
    }
    drafts.sort((a, b) => b.rank - a.rank);

    await checkpoint();
    // --- 5. Act ---
    // Opportunity persistence runs as chunked bulk upserts (task #203),
    // not per-row round trips. We still checkpoint inside the prep
    // pass and between chunks so a long Act phase respects Cancel.
    //
    // Task #219 dedupe: each draft gets a stable `signalKey` from
    // `composeSignalKey(lever, draft)`, built from STABLE identity
    // fields only — (leverId, supplierId, categoryId, lever-declared
    // cohortKey()). It deliberately does NOT include narrative
    // fields (title, rationale) or volatile metric fields (projected
    // savings, aggregates inside `inputs`) — those drift cycle-to-
    // cycle as source data updates and would otherwise force a fresh
    // INSERT each time, defeating dedupe. When a lever provides no
    // identifiable stable key for a draft, `composeSignalKey` returns
    // null and the row inserts with `signal_key IS NULL` (the partial
    // unique index excludes NULLs → legacy escape hatch, no dedupe
    // for that draft).
    //
    // We INSERT ... ON CONFLICT against the partial unique index
    // `opps_signal_key_uq` which covers (org_id, lever_id,
    // signal_key) WHERE status IN ('proposed','approved','executing').
    // On conflict we UPDATE the existing row's content (title/
    // rationale/projection/inputs/last_seen_at) so an operator
    // looking at it sees the freshest signal, but we DO NOT touch
    // `status`, `created_at`, or `cycle_id` — those anchor the row's
    // lifecycle. The Postgres `(xmax = 0)` idiom in RETURNING tells
    // us per-row whether we inserted (true) or updated (false),
    // which the funnel snapshot writer uses to keep `opps_persisted`
    // honest.
    const cycleStartedAt = new Date();
    const created: OpportunityRow[] = [];
    const refreshed: OpportunityRow[] = [];
    let totalProjected = 0;
    // Chunk size for the bulk upsert below. Picked so a typical cycle
    // (a few hundred opps) lands in 1–2 round trips while pathological
    // cycles still chunk safely under Postgres' bind-parameter ceiling
    // (each row binds ~18 parameters → 200 × 18 = 3,600, well under
    // the 65,535 limit).
    const OPPORTUNITY_INSERT_CHUNK_SIZE = 200;
    // (categoryMetaById is resolved up front in the Decide pre-pass —
    // see the per-(category, lever) scale lookup above. The same map
    // feeds the band applicability gate below and the prepared-row
    // builder further down.)

    // Category × band × lever applicability gate (task #213).
    //
    // Lever analyzers run org-wide and may emit drafts whose
    // (lever, category) combination is not allowed by the routing
    // model — e.g. a "concentrated" lever recommendation against a
    // category whose band is "fragmented". Without this gate, the
    // routing model has no teeth on the decide stage; drafts get
    // persisted regardless of the band's lever assignments.
    //
    // We pre-resolve the allowed lever set once per distinct canonical
    // code, then drop drafts whose lever isn't in that set. Drafts
    // without a category, with a category that has no canonical code,
    // or whose canonical code has no `category_bands` row all fall
    // through to the FRAGMENTED FALLBACK lever set — i.e. the union
    // of levers any fragmented-band category permits. This is the
    // only safe default; allowing unrouted categories through
    // unconditionally would let a concentrated-only lever persist
    // against an unmapped category and silently break the spine.
    const distinctCanonicalCodes = Array.from(
      new Set(Array.from(categoryMetaById.values()).map((m) => m.code)),
    );
    const allowedLeversByCode = new Map<string, Set<string>>();
    for (const code of distinctCanonicalCodes) {
      const rows = await leversForCategory(code);
      allowedLeversByCode.set(code, new Set(rows.map((r) => r.leverId)));
    }
    const fragmentedFallbackLevers = await leversInFragmentedFallback();
    const drafts5Pre = drafts.length;
    const filteredDrafts = drafts.filter((d) => {
      // Resolve the applicable lever set for this draft. Three layers:
      //   1. categoryId present + canonical code present + non-empty
      //      band rows → that category's allowed lever set
      //   2. categoryId present but unrouted (no code or no band rows)
      //      → the Fragmented fallback set
      //   3. no categoryId at all → the Fragmented fallback set
      let allowed: Set<string> | undefined;
      if (d.draft.categoryId) {
        const code = categoryMetaById.get(d.draft.categoryId)?.code;
        if (code) {
          const codeSet = allowedLeversByCode.get(code);
          if (codeSet && codeSet.size > 0) allowed = codeSet;
        }
      }
      const effective = allowed ?? fragmentedFallbackLevers;
      // Defensive: if neither set has any levers (e.g. mappings table
      // hasn't been seeded yet) fall open rather than dropping every
      // draft and breaking the cycle entirely.
      if (effective.size === 0) return true;
      return effective.has(d.draft.leverId);
    });
    const draftsDroppedByBandFilter = drafts5Pre - filteredDrafts.length;
    if (draftsDroppedByBandFilter > 0) {
      logger.info(
        {
          orgId,
          cycleId,
          draftsDroppedByBandFilter,
          draftsBefore: drafts5Pre,
          draftsAfter: filteredDrafts.length,
        },
        "Pruned drafts via category × band × lever applicability",
      );
    }

    // Pre-compute every row's persisted shape in a single pass so the
    // expensive part (the actual INSERT round trips) can be chunked
    // into a few bulk upserts instead of N per-row trips. We also
    // dedupe by (leverId, signalKey) within the prepared set: two
    // drafts with the same non-null signal key collide on the partial
    // unique index, and Postgres rejects "ON CONFLICT cannot affect
    // row a second time" inside one statement. The previous per-row
    // loop tolerated this only because each insert ran in its own
    // statement (the second became a no-op refresh of the first).
    // Drafts are already rank-sorted desc, so keeping the first
    // occurrence preserves the highest-ranked variant.
    interface PreparedRow {
      id: string;
      leverId: LeverId;
      tier: number;
      title: string;
      rationale: string;
      recommendedAction: string;
      supplierId: string | null;
      categoryId: string | null;
      rawProjectedSavingsUsd: string;
      projectedSavingsUsd: string;
      confidence: string;
      inputs: Record<string, unknown>;
      signalKey: string | null;
      mappedVia: OpportunityRow["mappedVia"];
      sourceTenantCategoryString: string | null;
    }
    const prepared: PreparedRow[] = [];
    const seenSignalKeys = new Set<string>();
    for (const { lever, draft } of filteredDrafts) {
      await checkpoint();
      const prior = priors[draft.leverId];
      // Per-(category, lever) tier override (task #229). Layered on
      // top of the per-lever prior so a Tier C/D bucket suppresses
      // both projected savings and confidence for *this* (cat, lever)
      // pair without affecting the same lever's other categories.
      const scale = lookupScale(draft.categoryId, draft.leverId);
      const effectiveProjMult = prior.projectionMultiplier * scale.projection;
      const effectiveConfidence = prior.confidenceWeight * scale.confidence;
      const projected = draft.rawProjectedSavingsUsd * effectiveProjMult;
      const tier = ALL_LEVERS.find((l) => l.leverId === draft.leverId)!.tier;
      // Routing provenance (task #213). Drafts without a category fall
      // back to the Fragmented band — tagged `unmapped_default` so
      // calibration excludes them.
      const meta = draft.categoryId
        ? categoryMetaById.get(draft.categoryId) ?? null
        : null;
      const canonicalCode = meta?.code ?? null;
      const sourceTenantCategoryString = meta?.name ?? null;
      const mappedVia = await determineOpportunityMappedVia(canonicalCode);
      // Task #219 dedupe key — see header comment for the design.
      const signalKey = composeSignalKey(lever, draft);
      if (signalKey !== null) {
        const dedupeKey = `${draft.leverId}\u0000${signalKey}`;
        if (seenSignalKeys.has(dedupeKey)) continue;
        seenSignalKeys.add(dedupeKey);
      }
      totalProjected += projected;
      const inputsPayload = {
        ...draft.inputs,
        __priorApplied: {
          projectionMultiplier: prior.projectionMultiplier,
          confidenceWeight: prior.confidenceWeight,
          // Per-(category, lever) tier scale, when one applied.
          // Omitted (left as 1.0/1.0) when no override row exists or
          // tier-auto-apply is in advisory mode.
          tierScaleProjection: scale.projection,
          tierScaleConfidence: scale.confidence,
        },
      };
      prepared.push({
        id: newId("opp"),
        leverId: draft.leverId,
        tier,
        title: draft.title,
        rationale: draft.rationale,
        recommendedAction: draft.recommendedAction,
        supplierId: draft.supplierId ?? null,
        categoryId: draft.categoryId ?? null,
        rawProjectedSavingsUsd: draft.rawProjectedSavingsUsd.toFixed(2),
        projectedSavingsUsd: projected.toFixed(2),
        confidence: effectiveConfidence.toFixed(4),
        inputs: inputsPayload,
        signalKey,
        mappedVia,
        sourceTenantCategoryString,
      });
    }

    // Raw SQL upsert because the partial unique index has a WHERE
    // clause and we need the `(xmax = 0) AS inserted` flag in
    // RETURNING — neither is supported by Drizzle's typed insert
    // builder. We reuse the `cycleStartedAt` timestamp for
    // `last_seen_at` so all refreshes within one cycle share one
    // monotonic value the auto-expire job can compare against.
    // Routing provenance (`mapped_via`, `source_tenant_category_string`)
    // is preserved across refreshes so retroactive Layer-C resolutions
    // can still find and audit-flag the historical rows.
    interface UpsertRowSnake extends Record<string, unknown> {
      id: string;
      org_id: string;
      cycle_id: string;
      lever_id: LeverId;
      tier: number;
      title: string;
      rationale: string;
      recommended_action: string;
      supplier_id: string | null;
      category_id: string | null;
      raw_projected_savings_usd: string;
      projected_savings_usd: string;
      confidence: string;
      inputs: Record<string, unknown>;
      status: OpportunityRow["status"];
      realized_savings_usd: string;
      realized_at: Date | null;
      rejected_reason_code: OpportunityRow["rejectedReasonCode"];
      rejected_reason_note: string | null;
      signal_key: string | null;
      last_seen_at: Date | null;
      mapped_via: OpportunityRow["mappedVia"];
      source_tenant_category_string: string | null;
      re_categorized_after_persistence: number;
      created_at: Date;
      // S2P fields (Task #284) — populated by DB defaults on INSERT below.
      savings_type: OpportunityRow["savingsType"];
      savings_classification: OpportunityRow["savingsClassification"];
      classification_needs_review: boolean | null;
      canonical_stage: OpportunityRow["canonicalStage"];
      stage_entered_at: Date | null;
      doa_tier: number | null;
      sourcing_strategy: OpportunityRow["sourcingStrategy"];
      baseline_method: OpportunityRow["baselineMethod"];
      baseline_value: string | null;
      baseline_source: string | null;
      inserted: boolean;
    }

    for (
      let chunkStart = 0;
      chunkStart < prepared.length;
      chunkStart += OPPORTUNITY_INSERT_CHUNK_SIZE
    ) {
      await checkpoint();
      const chunk = prepared.slice(
        chunkStart,
        chunkStart + OPPORTUNITY_INSERT_CHUNK_SIZE,
      );
      const valueTuples = chunk.map((r) => {
        // DOA tier from the central ladder in lib/db/src/doa-config.ts —
        // never inline thresholds here so changes stay in one place.
        const doaTier = resolveDoaTierNumber(Number(r.projectedSavingsUsd));
        return sql`(
          ${r.id},
          ${orgId},
          ${cycleId},
          ${r.leverId},
          ${r.tier},
          ${r.title},
          ${r.rationale},
          ${r.recommendedAction},
          ${r.supplierId},
          ${r.categoryId},
          ${r.rawProjectedSavingsUsd},
          ${r.projectedSavingsUsd},
          ${r.confidence},
          ${JSON.stringify(r.inputs)}::jsonb,
          ${r.signalKey},
          ${cycleStartedAt},
          ${r.mappedVia},
          ${r.sourceTenantCategoryString},
          ${doaTier},
          'Identified',
          ${cycleStartedAt},
          'Identified',
          'Hard',
          true,
          'Unclassified',
          'Internal Estimate',
          'OODA cycle — needs review'
        )`;
      });
      const upsertRes = await db.execute<UpsertRowSnake>(sql`
        INSERT INTO opportunities (
          id, org_id, cycle_id, lever_id, tier, title, rationale,
          recommended_action, supplier_id, category_id,
          raw_projected_savings_usd, projected_savings_usd, confidence,
          inputs, signal_key, last_seen_at,
          mapped_via, source_tenant_category_string,
          doa_tier,
          -- S2P fields (Task #284): new opportunities start at Identified.
          -- savings_classification + classification_needs_review default to
          -- 'Hard'/true so Finance must review before any aggregate counts
          -- the row as Hard savings.
          canonical_stage, stage_entered_at, savings_type,
          savings_classification, classification_needs_review,
          sourcing_strategy, baseline_method, baseline_source
        ) VALUES ${sql.join(valueTuples, sql`, `)}
        ON CONFLICT (org_id, lever_id, signal_key)
          WHERE status IN ('proposed', 'approved', 'executing')
            AND signal_key IS NOT NULL
        DO UPDATE SET
          title = EXCLUDED.title,
          rationale = EXCLUDED.rationale,
          recommended_action = EXCLUDED.recommended_action,
          supplier_id = EXCLUDED.supplier_id,
          category_id = EXCLUDED.category_id,
          raw_projected_savings_usd = EXCLUDED.raw_projected_savings_usd,
          projected_savings_usd = EXCLUDED.projected_savings_usd,
          confidence = EXCLUDED.confidence,
          inputs = EXCLUDED.inputs,
          last_seen_at = EXCLUDED.last_seen_at,
          tier = EXCLUDED.tier,
          mapped_via = EXCLUDED.mapped_via,
          source_tenant_category_string = EXCLUDED.source_tenant_category_string,
          -- Keep doa_tier derived from the (potentially refreshed) projected
          -- savings so threshold-crossing opportunities don't retain a stale
          -- tier across cycles. EXCLUDED.doa_tier was computed from the new
          -- projected_savings_usd in the same statement.
          doa_tier = EXCLUDED.doa_tier
        RETURNING *, (xmax = 0) AS inserted
      `);
      for (const raw of upsertRes.rows) {
        const row: OpportunityRow = {
          id: raw.id,
          orgId: raw.org_id,
          cycleId: raw.cycle_id,
          leverId: raw.lever_id,
          tier: raw.tier,
          title: raw.title,
          rationale: raw.rationale,
          recommendedAction: raw.recommended_action,
          supplierId: raw.supplier_id,
          categoryId: raw.category_id,
          rawProjectedSavingsUsd: raw.raw_projected_savings_usd,
          projectedSavingsUsd: raw.projected_savings_usd,
          confidence: raw.confidence,
          inputs: raw.inputs,
          status: raw.status,
          realizedSavingsUsd: raw.realized_savings_usd,
          realizedAt: raw.realized_at,
          rejectedReasonCode: raw.rejected_reason_code,
          rejectedReasonNote: raw.rejected_reason_note,
          signalKey: raw.signal_key,
          lastSeenAt: raw.last_seen_at,
          mappedVia: raw.mapped_via,
          sourceTenantCategoryString: raw.source_tenant_category_string,
          reCategorizedAfterPersistence: raw.re_categorized_after_persistence,
          snoozedUntil: raw.snoozed_until as Date | null,
          expiryReason: raw.expiry_reason as "ttl" | "quiet_cycles" | null,
          createdAt: raw.created_at,
          // S2P fields (Task #284) — populated from RETURNING * on the upsert.
          savingsType: raw.savings_type,
          savingsClassification: raw.savings_classification,
          classificationNeedsReview: raw.classification_needs_review ?? false,
          canonicalStage: raw.canonical_stage,
          stageEnteredAt: raw.stage_entered_at,
          doaTier: raw.doa_tier,
          sourcingStrategy: raw.sourcing_strategy,
          baselineMethod: raw.baseline_method,
          baselineValue: raw.baseline_value,
          baselineSource: raw.baseline_source,
        };
        if (raw.inserted) created.push(row);
        else refreshed.push(row);
      }
    }

    const decidePayload = {
      candidatesEvaluated: drafts.length,
      // Drafts that survived the band-applicability gate (post-pruning,
      // pre-persistence). Useful for funnel diagnostics: the gap
      // between `candidatesEvaluated` and `candidatesPostBandGate`
      // attributes how much the routing model is influencing decide.
      candidatesPostBandGate: filteredDrafts.length,
      draftsDroppedByBandFilter,
      opportunitiesCreated: created.length,
      opportunitiesRefreshed: refreshed.length,
      topByLever: summarizeTopByLever(created),
    };

    const learnPayload = {
      priorDeltas,
      exclusionDeltas,
      outcomeStats: outcomes,
    };

    const actPayload = {
      pendingApproval: created.length,
      refreshedExisting: refreshed.length,
      previousCycleId,
    };

    await db
      .update(analysisCyclesTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        observePayload: observe as unknown as Record<string, unknown>,
        orientPayload: orientPayload as unknown as Record<string, unknown>,
        decidePayload: decidePayload as unknown as Record<string, unknown>,
        actPayload: actPayload as unknown as Record<string, unknown>,
        learnPayload: learnPayload as unknown as Record<string, unknown>,
        opportunitiesCreated: created.length,
        totalProjectedUsd: totalProjected.toFixed(2),
      })
      .where(eq(analysisCyclesTable.id, cycleId));

    logger.info(
      { orgId, cycleId, generation, created: created.length },
      "Cycle completed",
    );

    // Capture the per-cycle funnel snapshot after the cycle has been
    // marked completed. This is wrapped internally — a snapshot bug
    // must NEVER fail the cycle (the value of the snapshot is purely
    // observational; degrading it shouldn't degrade tenant analysis).
    const snapshotResult = await captureFunnelSnapshot({
      orgId,
      cycleId,
      cycleGeneration: generation,
      leverResults,
      draftsPostExclusion: drafts.map(({ lever, draft }) => ({ lever, draft })),
      persistedOpps: created,
      refreshedOpps: refreshed,
      priorDeltas,
    });

    // Tier auto-apply post-snapshot processing (task #229). Runs
    // only when the operator opted in (`mode === "auto"`) AND the
    // snapshot actually persisted (a snapshot bug must not silently
    // mutate priors). Iterates the (categoryCode, leverId) pairs
    // touched by *post-band* drafts so we don't react to drafts that
    // were going to be filtered anyway. Errors here are logged but
    // don't fail the cycle — the cycle's primary output (persisted
    // opportunities) is already committed at this point.
    if (
      tierAutoApplyMode === "auto" &&
      snapshotResult.snapshotId &&
      !snapshotResult.failed
    ) {
      try {
        const pairs: Array<{ categoryCode: string; leverId: LeverId }> = [];
        for (const { draft } of filteredDrafts) {
          if (!draft.categoryId) continue;
          const code = categoryMetaById.get(draft.categoryId)?.code;
          if (!code) continue;
          pairs.push({ categoryCode: code, leverId: draft.leverId });
        }
        const tierResult = await processTierUpdates({
          orgId,
          cycleGeneration: generation,
          snapshotId: snapshotResult.snapshotId,
          pairs,
        });
        if (
          tierResult.changes.length > 0 ||
          tierResult.pendingAdvances > 0 ||
          tierResult.reaffirmations > 0
        ) {
          logger.info(
            {
              orgId,
              cycleId,
              generation,
              tierChanges: tierResult.changes.length,
              tierPendingAdvances: tierResult.pendingAdvances,
              tierReaffirmations: tierResult.reaffirmations,
              tierSkippedInsufficient: tierResult.skippedInsufficient,
              tierProcessed: tierResult.processed,
            },
            "Tier auto-apply processed snapshot",
          );
        }
      } catch (err) {
        logger.warn(
          { err, orgId, cycleId },
          "Tier auto-apply processing failed (non-fatal)",
        );
      }
    }

    return {
      cycleId,
      generation,
      opportunitiesCreated: created.length,
      totalProjectedUsd: totalProjected,
      priorDeltas,
      exclusionDeltas,
    };
  } catch (err) {
    await db
      .update(analysisCyclesTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        learnPayload: { error: (err as Error).message },
      })
      .where(eq(analysisCyclesTable.id, cycleId));
    throw err;
  }
}

/**
 * OODA Observe-step queries. Exported so the cycle-perf-budget
 * test (`artifacts/api-server/test/cycle-perf-budget.test.ts`) can
 * exercise this stage directly against a seeded large tenant
 * without having to re-implement the SQL. Internal callers should
 * keep going through `runAnalysisCycle` rather than calling this
 * helper out-of-band.
 */
export async function observeStep(
  orgId: string,
  previousCycleId: string | null,
): Promise<Record<string, unknown>> {
  const stats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM suppliers WHERE org_id = ${orgId}) AS suppliers,
      (SELECT COUNT(*) FROM purchase_orders WHERE org_id = ${orgId}) AS pos,
      (SELECT COUNT(*) FROM po_lines WHERE org_id = ${orgId}) AS po_lines,
      (SELECT COUNT(*) FROM contracts WHERE org_id = ${orgId} AND status = 'active') AS active_contracts,
      (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId}) AS invoices,
      (SELECT COUNT(*) FROM payments WHERE org_id = ${orgId}) AS payments,
      (SELECT COUNT(*) FROM shipments WHERE org_id = ${orgId}) AS shipments
  `);
  const counts = stats.rows[0] as Record<string, string>;

  let outcomeEvents = 0;
  if (previousCycleId) {
    const cycleRow = await db
      .select({ completedAt: analysisCyclesTable.completedAt })
      .from(analysisCyclesTable)
      .where(eq(analysisCyclesTable.id, previousCycleId))
      .limit(1);
    const since = cycleRow[0]?.completedAt ?? new Date(0);
    const evRow = await db.execute(sql`
      SELECT COUNT(*) AS c FROM decisions
      WHERE org_id = ${orgId} AND created_at > ${since}
    `);
    outcomeEvents = Number(
      (evRow.rows[0] as { c: string } | undefined)?.c ?? 0,
    );
  }

  return {
    snapshot: {
      suppliers: Number(counts.suppliers),
      purchaseOrders: Number(counts.pos),
      poLines: Number(counts.po_lines),
      activeContracts: Number(counts.active_contracts),
      invoices: Number(counts.invoices),
      payments: Number(counts.payments),
      shipments: Number(counts.shipments),
    },
    outcomeEventsSincePrev: outcomeEvents,
    previousCycleId,
  };
}

/**
 * Outcome aggregation feeding the OODA Learn step. Exported for the
 * same reason as `observeStep` above: the cycle-perf-budget test
 * needs to time this query independently. Not intended as a public
 * API for non-test callers.
 */
export async function collectOutcomesSinceLastCycle(
  orgId: string,
  previousCycleId: string | null,
): Promise<OutcomeStats[]> {
  if (!previousCycleId) return [];
  const cycleRow = await db
    .select({ completedAt: analysisCyclesTable.completedAt })
    .from(analysisCyclesTable)
    .where(eq(analysisCyclesTable.id, previousCycleId))
    .limit(1);
  const since = cycleRow[0]?.completedAt;
  if (!since) return [];

  // Pull every decision event since `since` joined with its opportunity.
  // Calibration-integrity rule (task #213): exclude opportunities whose
  // mapped_via is `unmapped_default`. Their category is the fragmented
  // fallback, not the tenant's actual category, so they would
  // contaminate per-lever priors.
  const rows = await db
    .select({
      decisionId: decisionsTable.id,
      eventType: decisionsTable.eventType,
      rejectedReasonCode: decisionsTable.rejectedReasonCode,
      realizedSavingsUsd: decisionsTable.realizedSavingsUsd,
      opportunityId: decisionsTable.opportunityId,
      leverId: opportunitiesTable.leverId,
      projectedSavingsUsd: opportunitiesTable.projectedSavingsUsd,
      supplierId: opportunitiesTable.supplierId,
      categoryId: opportunitiesTable.categoryId,
    })
    .from(decisionsTable)
    .innerJoin(
      opportunitiesTable,
      eq(decisionsTable.opportunityId, opportunitiesTable.id),
    )
    .where(
      and(
        eq(decisionsTable.orgId, orgId),
        gt(decisionsTable.createdAt, since),
        sql`${opportunitiesTable.mappedVia} IS DISTINCT FROM 'unmapped_default'`,
      ),
    );

  const by = new Map<LeverId, OutcomeStats>();
  function bucket(leverId: LeverId): OutcomeStats {
    let b = by.get(leverId);
    if (!b) {
      b = {
        leverId,
        approvals: 0,
        rejections: 0,
        realizations: 0,
        realizationRatioSum: 0,
        rejectionRules: [],
      };
      by.set(leverId, b);
    }
    return b;
  }
  for (const r of rows) {
    const b = bucket(r.leverId);
    if (r.eventType === "approve") b.approvals += 1;
    else if (r.eventType === "reject") {
      b.rejections += 1;
      // Translate structured rejection-reason codes to exclusion rules.
      if (r.rejectedReasonCode === "supplier_strategic_do_not_consolidate" && r.supplierId) {
        b.rejectionRules.push({
          leverId: r.leverId,
          supplierId: r.supplierId,
          categoryId: null,
          reasonCode: r.rejectedReasonCode,
          description: `Supplier flagged strategic — exclude from ${r.leverId} candidates.`,
        });
      } else if (r.rejectedReasonCode === "supplier_dei_or_diverse_program" && r.supplierId) {
        b.rejectionRules.push({
          leverId: r.leverId,
          supplierId: r.supplierId,
          categoryId: null,
          reasonCode: r.rejectedReasonCode,
          description: `Supplier protected under DEI/diverse program — exclude from ${r.leverId}.`,
        });
      } else if (r.rejectedReasonCode === "compliance_or_legal_block" && r.categoryId) {
        b.rejectionRules.push({
          leverId: r.leverId,
          supplierId: null,
          categoryId: r.categoryId,
          reasonCode: r.rejectedReasonCode,
          description: `Category blocked by compliance/legal — exclude from ${r.leverId}.`,
        });
      }
    } else if (r.eventType === "realize") {
      b.realizations += 1;
      const projected = Number(r.projectedSavingsUsd);
      const realized = Number(r.realizedSavingsUsd ?? 0);
      const ratio = projected > 0 ? realized / projected : 0;
      b.realizationRatioSum += ratio;
    }
  }
  return Array.from(by.values());
}

function summarizeTopByLever(opps: OpportunityRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of opps) {
    const lever = o.leverId as string;
    out[lever] = (out[lever] ?? 0) + Number(o.projectedSavingsUsd);
  }
  return out;
}

function diffPriors(
  before: PriorMap,
  after: PriorMap,
): Record<string, { multiplier: [number, number]; confidence: [number, number] }> {
  const out: Record<
    string,
    { multiplier: [number, number]; confidence: [number, number] }
  > = {};
  for (const lever of ALL_LEVERS) {
    const a = before[lever.leverId];
    const b = after[lever.leverId];
    if (
      Math.abs(a.projectionMultiplier - b.projectionMultiplier) > 1e-4 ||
      Math.abs(a.confidenceWeight - b.confidenceWeight) > 1e-4
    ) {
      out[lever.leverId] = {
        multiplier: [a.projectionMultiplier, b.projectionMultiplier],
        confidence: [a.confidenceWeight, b.confidenceWeight],
      };
    }
  }
  return out;
}
