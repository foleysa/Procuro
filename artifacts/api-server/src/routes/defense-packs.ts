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
    res.status(400).json({
      error: "invalid_request",
      details: parsed.error.flatten(),
    });
    return;
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
    res.status(429).json({
      error: "daily_cap_exceeded",
      details: { cap: DAILY_TENANT_CAP, used: todayCount },
    });
    return;
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
    res.status(404).json({ error: "not_found" });
    return;
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
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (row.status !== "ready") {
    res.status(409).json({
      error: "pack_not_ready",
      details: { status: row.status, statusReason: row.statusReason },
    });
    return;
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
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const [pack] = await db
      .select({ id: defensePacksTable.id })
      .from(defensePacksTable)
      .where(
        and(eq(defensePacksTable.id, id), eq(defensePacksTable.orgId, orgId)),
      )
      .limit(1);
    if (!pack) {
      res.status(404).json({ error: "not_found" });
      return;
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
