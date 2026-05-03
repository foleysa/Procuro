/**
 * Defense Pack routes — Gemini-backed, citation-verified procurement
 * memos.
 *
 *   POST   /defense-packs              generate
 *   GET    /defense-packs              recent for tenant
 *   GET    /defense-packs/:id          frozen view + Evidence Room
 *   GET    /defense-packs/:id/pdf      PDF render
 *   POST   /defense-packs/:id/feedback Learn-loop capture
 *
 * Tenant isolation: every read/write joins on `org_id = $tenant`.
 * Daily cap: per-tenant generation budget enforced at POST time.
 */

import { Router, type IRouter } from "express";
import {
  db,
  contractsTable,
  defensePacksTable,
  defensePackOutcomesTable,
  defensePackPositionValues,
  defensePackLengthValues,
  defensePackOutcomeUsedValues,
  defensePackOutcomeCategoryValues,
  type DefensePackRow,
  type DefensePackTarget,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import { ApiError, InvalidRequestError, NotFoundError, ConflictError } from "../lib/api-errors";
import { readDisclosurePolicy } from "../lib/disclosure-policy";
import { db as _db } from "@workspace/db";
import { orgsTable } from "@workspace/db";
import { assembleEvidence } from "../lib/defense-pack/evidence";
import {
  generateDefensePack,
  DEFENSE_PACK_MODEL,
} from "../lib/defense-pack/generator";
import { renderDefensePackPdf } from "../lib/defense-pack/pdf";

const router: IRouter = Router();

const DAILY_TENANT_CAP = 50;

const TargetSchema = z
  .object({
    supplierId: z.string().min(1).max(80),
    supplierName: z.string().min(1).max(200),
    contractId: z.string().min(1).max(80).optional(),
    lineItem: z.string().min(1).max(200).optional(),
    categoryCode: z.string().min(1).max(80).optional(),
    materialCode: z.string().min(1).max(80).optional(),
  })
  .refine(
    (t) =>
      Boolean(t.contractId && t.lineItem) ||
      Boolean(t.categoryCode) ||
      Boolean(t.materialCode),
    {
      message:
        "target must include at least one of: (contractId + lineItem), categoryCode, or materialCode",
    },
  );

const CreatePackSchema = z.object({
  target: TargetSchema,
  position: z.enum(defensePackPositionValues),
  length: z.enum(defensePackLengthValues),
  positionNote: z.string().max(2000).optional(),
});

const FeedbackSchema = z.object({
  used: z.enum(defensePackOutcomeUsedValues),
  outcomeCategory: z.enum(defensePackOutcomeCategoryValues).optional(),
  comment: z.string().max(2000).optional(),
});

interface DefensePackSummaryDto {
  id: string;
  orgId: string;
  target: DefensePackTarget;
  position: string;
  length: string;
  status: string;
  statusReason: string | null;
  disclosurePolicy: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  generatedBy: string;
  permalink: string;
  generatedAt: string | null;
  createdAt: string;
  verifiedClaimCount: number;
  evidencePoolSize: number;
  stale: boolean;
  staleSinceAt: string | null;
  stalenessReason: DefensePackRow["stalenessReason"];
}

function toSummary(row: DefensePackRow): DefensePackSummaryDto {
  const verified = row.sections.reduce(
    (acc, s) => acc + (s.claims?.length ?? 0),
    0,
  );
  return {
    id: row.id,
    orgId: row.orgId,
    target: row.target,
    position: row.position,
    length: row.length,
    status: row.status,
    statusReason: row.statusReason,
    disclosurePolicy: row.disclosurePolicy,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCostUsd:
      row.estimatedCostUsd != null ? Number(row.estimatedCostUsd) : null,
    generatedBy: row.generatedBy,
    permalink: row.permalink,
    generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    verifiedClaimCount: verified,
    evidencePoolSize: row.evidenceSnapshot.length,
    stale: row.stale,
    staleSinceAt: row.staleSinceAt ? row.staleSinceAt.toISOString() : null,
    stalenessReason: row.stalenessReason ?? null,
  };
}

function toDetail(row: DefensePackRow) {
  return {
    ...toSummary(row),
    sections: row.sections,
    evidenceSnapshot: row.evidenceSnapshot,
  };
}

async function loadOrgPolicy(orgId: string) {
  const [row] = await _db
    .select({ settings: orgsTable.settings })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
    .limit(1);
  return readDisclosurePolicy(row?.settings ?? null);
}

// ---------------------------------------------------------------------
// GET /defense-packs
// ---------------------------------------------------------------------
router.get("/defense-packs", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt(String(req.query["limit"] ?? "25"), 10) || 25, 1),
    100,
  );

  const rows = await db
    .select()
    .from(defensePacksTable)
    .where(eq(defensePacksTable.orgId, orgId))
    .orderBy(desc(defensePacksTable.createdAt))
    .limit(limit);

  res.json({ items: rows.map(toSummary) });
});

// ---------------------------------------------------------------------
// POST /defense-packs
// ---------------------------------------------------------------------
router.post("/defense-packs", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const actorEmail = req.actorEmail ?? "unknown@unknown";

  const parsed = CreatePackSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidRequestError("invalid_request", parsed.error.flatten());
  }

  // Daily cap
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [{ count: todayCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(defensePacksTable)
    .where(
      and(
        eq(defensePacksTable.orgId, orgId),
        gte(defensePacksTable.createdAt, dayStart),
      ),
    );
  if ((todayCount ?? 0) >= DAILY_TENANT_CAP) {
    req.log.warn(
      { orgId, todayCount, cap: DAILY_TENANT_CAP },
      "defensePack.cap.exceeded",
    );
    throw new ApiError(429, "quota_exceeded", "daily_cap_exceeded", { cap: DAILY_TENANT_CAP, used: todayCount });
  }

  const policy = await loadOrgPolicy(orgId);

  // Assemble evidence pool (frozen)
  const evidence = await assembleEvidence({
    orgId,
    target: parsed.data.target,
    policy,
  });

  req.log.info(
    {
      orgId,
      supplier: parsed.data.target.supplierName,
      position: parsed.data.position,
      length: parsed.data.length,
      citationItems: evidence.citationItems.length,
      narrativeItems: evidence.narrativeItems.length,
      policy,
    },
    "defensePack.evidence.assembled",
  );

  // Generate
  const result = await generateDefensePack({
    target: parsed.data.target,
    position: parsed.data.position,
    length: parsed.data.length,
    positionNote: parsed.data.positionNote ?? "",
    citationItems: evidence.citationItems,
    narrativeItems: evidence.narrativeItems,
    policy,
    logger: req.log,
  });

  const now = new Date();
  const id = newId("dpk");
  const insert = {
    id,
    orgId,
    target: parsed.data.target,
    position: parsed.data.position,
    length: parsed.data.length,
    status: result.status,
    statusReason: result.statusReason ?? null,
    sections: result.sections,
    // Snapshot the citation pool only — narrative-pool items are
    // intentionally NOT persisted because they never appear in the
    // rendered memo (T3 ride-along is narrative-only and gets summarised
    // into one paragraph).
    evidenceSnapshot: evidence.citationItems,
    disclosurePolicy: policy,
    model: result.model,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    estimatedCostUsd:
      result.estimatedCostUsd != null
        ? result.estimatedCostUsd.toFixed(5)
        : null,
    generatedBy: actorEmail,
    permalink: id,
    generatedAt: now,
    createdAt: now,
  };

  const [persisted] = await db
    .insert(defensePacksTable)
    .values(insert)
    .returning();

  req.log.info(
    {
      orgId,
      packId: persisted.id,
      status: persisted.status,
      verifiedClaimCount: toSummary(persisted).verifiedClaimCount,
      evidencePoolSize: persisted.evidenceSnapshot.length,
      inputTokens: persisted.inputTokens,
      outputTokens: persisted.outputTokens,
      estimatedCostUsd: persisted.estimatedCostUsd,
      model: persisted.model ?? DEFENSE_PACK_MODEL,
    },
    "defensePack.persisted",
  );

  res.status(201).json(toDetail(persisted));
});

// ---------------------------------------------------------------------
// GET /defense-packs/summary
// ---------------------------------------------------------------------
// Aggregates Defense Pack outcomes so the Results & Billing page can
// show ROI of the Defense Pack feature. Uses the LATEST outcome per
// pack so a buyer who corrects an earlier note is not double-counted.
// `avoidedUsd` sums `contracts.annual_baseline_usd` for packs whose
// latest outcome was `supplier_held_price` AND whose target identifies
// a contract — that contract's annual baseline is the run-rate the
// supplier was attempting to escalate, hence "avoided" once held flat.
router.get("/defense-packs/summary", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);

  const [{ count: packsGenerated }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(defensePacksTable)
    .where(eq(defensePacksTable.orgId, orgId));

  const result = await db.execute(sql`
    WITH latest_outcomes AS (
      SELECT DISTINCT ON (pack_id)
        pack_id,
        used,
        outcome_category
      FROM defense_pack_outcomes
      WHERE org_id = ${orgId}
      ORDER BY pack_id, created_at DESC
    )
    SELECT
      COUNT(*) FILTER (WHERE lo.used = 'yes')::int AS packs_used,
      COUNT(*) FILTER (
        WHERE lo.outcome_category = 'supplier_held_price'
      )::int AS supplier_held_price_count,
      COALESCE(SUM(
        CASE
          WHEN lo.outcome_category = 'supplier_held_price'
            THEN c.annual_baseline_usd::numeric
          ELSE 0
        END
      ), 0)::numeric AS avoided_usd
    FROM latest_outcomes lo
    JOIN ${defensePacksTable} dp
      ON dp.id = lo.pack_id AND dp.org_id = ${orgId}
    LEFT JOIN ${contractsTable} c
      ON c.org_id = ${orgId}
     AND c.id = (dp.target ->> 'contractId')
  `);
  const row = result.rows[0] as
    | {
        packs_used: number | null;
        supplier_held_price_count: number | null;
        avoided_usd: string | number | null;
      }
    | undefined;

  res.json({
    packsGenerated: Number(packsGenerated ?? 0),
    packsUsed: Number(row?.packs_used ?? 0),
    supplierHeldPriceCount: Number(row?.supplier_held_price_count ?? 0),
    avoidedUsd: Number(row?.avoided_usd ?? 0),
  });
});

// ---------------------------------------------------------------------
// GET /defense-packs/:id
// ---------------------------------------------------------------------
router.get("/defense-packs/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const [row] = await db
    .select()
    .from(defensePacksTable)
    .where(and(eq(defensePacksTable.id, id), eq(defensePacksTable.orgId, orgId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError("not_found");
  }
  res.json(toDetail(row));
});

// ---------------------------------------------------------------------
// GET /defense-packs/:id/pdf
// ---------------------------------------------------------------------
router.get("/defense-packs/:id/pdf", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const [row] = await db
    .select()
    .from(defensePacksTable)
    .where(and(eq(defensePacksTable.id, id), eq(defensePacksTable.orgId, orgId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError("not_found");
  }
  if (row.status !== "ready") {
    throw new ConflictError("pack_not_ready", { status: row.status, statusReason: row.statusReason });
  }
  const pdf = await renderDefensePackPdf(row);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="defense-pack-${id}.pdf"`,
  );
  res.setHeader("Content-Length", String(pdf.length));
  res.end(pdf);
});

// ---------------------------------------------------------------------
// POST /defense-packs/:id/feedback
// ---------------------------------------------------------------------
router.post(
  "/defense-packs/:id/feedback",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const actorEmail = req.actorEmail ?? "unknown@unknown";
    const id = String(req.params["id"]);

    const parsed = FeedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InvalidRequestError("invalid_request", parsed.error.flatten());
    }

    const [pack] = await db
      .select({ id: defensePacksTable.id })
      .from(defensePacksTable)
      .where(
        and(eq(defensePacksTable.id, id), eq(defensePacksTable.orgId, orgId)),
      )
      .limit(1);
    if (!pack) {
      throw new NotFoundError("not_found");
    }

    const [persisted] = await db
      .insert(defensePackOutcomesTable)
      .values({
        id: newId("dpo"),
        orgId,
        packId: id,
        used: parsed.data.used,
        outcomeCategory: parsed.data.outcomeCategory ?? null,
        comment: parsed.data.comment ?? null,
        submittedBy: actorEmail,
      })
      .returning();

    req.log.info(
      {
        orgId,
        packId: id,
        used: persisted.used,
        outcomeCategory: persisted.outcomeCategory,
      },
      "defensePack.feedback.recorded",
    );

    res.status(201).json({
      id: persisted.id,
      packId: persisted.packId,
      used: persisted.used,
      outcomeCategory: persisted.outcomeCategory,
      comment: persisted.comment,
      submittedBy: persisted.submittedBy,
      createdAt: persisted.createdAt.toISOString(),
    });
  },
);

export default router;
