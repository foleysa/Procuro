import { Router, type IRouter } from "express";
import {
  db,
  agentsTable,
  outcomeClaimsTable,
  claimEventsTable,
  type ClaimStatusValue,
} from "@workspace/db";
import { and, eq, sql, desc, gte, lte, asc } from "drizzle-orm";
import {
  ListOutcomeClaimsQueryParams,
  CreateOutcomeClaimBody,
  GetOutcomeClaimParams,
  VerifyOutcomeClaimParams,
  VerifyOutcomeClaimBody,
  DenyOutcomeClaimParams,
  DenyOutcomeClaimBody,
} from "@workspace/api-zod";
import { orgContext } from "../middlewares/orgContext";
import { newId } from "../lib/ids";

const router: IRouter = Router();

router.use(orgContext);

type ClaimRow = typeof outcomeClaimsTable.$inferSelect;

function serializeClaim(
  row: ClaimRow,
  agentName: string,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    agentId: row.agentId,
    agentName,
    claimType: row.claimType,
    title: row.title,
    description: row.description,
    evidenceUrl: row.evidenceUrl,
    evidenceLabel: row.evidenceLabel,
    estimatedValueUsd: Number(row.estimatedValueUsd),
    status: row.status,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    denialReason: row.denialReason,
    claimedAt: row.claimedAt.toISOString(),
  };
}

router.get("/outcome-claims", async (req, res) => {
  const params = ListOutcomeClaimsQueryParams.parse(req.query);
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const conditions = [eq(outcomeClaimsTable.orgId, req.orgId)];
  if (params.agentId) {
    conditions.push(eq(outcomeClaimsTable.agentId, params.agentId));
  }
  if (params.status) {
    conditions.push(
      eq(outcomeClaimsTable.status, params.status as ClaimStatusValue),
    );
  }
  if (params.from) {
    conditions.push(gte(outcomeClaimsTable.claimedAt, params.from));
  }
  if (params.to) {
    conditions.push(lte(outcomeClaimsTable.claimedAt, params.to));
  }

  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(outcomeClaimsTable)
    .where(where);

  const rows = await db
    .select({
      claim: outcomeClaimsTable,
      agentName: agentsTable.name,
    })
    .from(outcomeClaimsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, outcomeClaimsTable.agentId))
    .where(where)
    .orderBy(desc(outcomeClaimsTable.claimedAt))
    .limit(limit)
    .offset(offset);

  res.json({
    items: rows.map((r) => serializeClaim(r.claim, r.agentName)),
    total: Number(total),
    limit,
    offset,
  });
});

router.post("/outcome-claims", async (req, res) => {
  const body = CreateOutcomeClaimBody.parse(req.body);

  // Verify agent exists in this org
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(eq(agentsTable.id, body.agentId), eq(agentsTable.orgId, req.orgId)),
    )
    .limit(1);

  if (!agent) {
    res.status(400).json({ error: "Unknown agent for this org." });
    return;
  }

  const id = newId("clm");
  const [inserted] = await db
    .insert(outcomeClaimsTable)
    .values({
      id,
      orgId: req.orgId,
      agentId: agent.id,
      claimType: body.claimType,
      title: body.title,
      description: body.description ?? null,
      evidenceUrl: body.evidenceUrl ?? null,
      evidenceLabel: body.evidenceLabel ?? null,
      estimatedValueUsd: String(body.estimatedValueUsd),
      status: "claimed",
    })
    .returning();

  await db.insert(claimEventsTable).values({
    id: newId("evt"),
    claimId: inserted.id,
    orgId: req.orgId,
    eventType: "claimed",
    actor: agent.name,
    reason: null,
  });

  res.status(201).json(serializeClaim(inserted, agent.name));
});

router.get("/outcome-claims/:claimId", async (req, res) => {
  const { claimId } = GetOutcomeClaimParams.parse(req.params);

  const [row] = await db
    .select({
      claim: outcomeClaimsTable,
      agentName: agentsTable.name,
    })
    .from(outcomeClaimsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, outcomeClaimsTable.agentId))
    .where(
      and(
        eq(outcomeClaimsTable.id, claimId),
        eq(outcomeClaimsTable.orgId, req.orgId),
      ),
    )
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Claim not found." });
    return;
  }

  const events = await db
    .select()
    .from(claimEventsTable)
    .where(eq(claimEventsTable.claimId, claimId))
    .orderBy(asc(claimEventsTable.createdAt));

  res.json({
    ...serializeClaim(row.claim, row.agentName),
    events: events.map((e) => ({
      id: e.id,
      claimId: e.claimId,
      eventType: e.eventType,
      actor: e.actor,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

router.post("/outcome-claims/:claimId/verify", async (req, res) => {
  const { claimId } = VerifyOutcomeClaimParams.parse(req.params);
  const body = VerifyOutcomeClaimBody.parse(req.body ?? {});

  const [existing] = await db
    .select()
    .from(outcomeClaimsTable)
    .where(
      and(
        eq(outcomeClaimsTable.id, claimId),
        eq(outcomeClaimsTable.orgId, req.orgId),
      ),
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Claim not found." });
    return;
  }
  if (existing.status === "verified" || existing.status === "invoiced") {
    res
      .status(409)
      .json({ error: `Claim already ${existing.status}; cannot verify again.` });
    return;
  }
  if (existing.status === "denied") {
    res
      .status(409)
      .json({ error: "Claim was denied; cannot verify a denied claim." });
    return;
  }

  // For demo, the verifier is a static admin id. In a real system this
  // would come from the authenticated user's session.
  const actor = "admin";
  const now = new Date();

  const [updated] = await db
    .update(outcomeClaimsTable)
    .set({
      status: "verified",
      verifiedBy: actor,
      verifiedAt: now,
    })
    .where(eq(outcomeClaimsTable.id, claimId))
    .returning();

  await db.insert(claimEventsTable).values({
    id: newId("evt"),
    claimId,
    orgId: req.orgId,
    eventType: "verified",
    actor,
    reason: body.note ?? null,
  });

  const [agent] = await db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.id, updated.agentId))
    .limit(1);

  res.json(serializeClaim(updated, agent?.name ?? ""));
});

router.post("/outcome-claims/:claimId/deny", async (req, res) => {
  const { claimId } = DenyOutcomeClaimParams.parse(req.params);
  const body = DenyOutcomeClaimBody.parse(req.body);

  const [existing] = await db
    .select()
    .from(outcomeClaimsTable)
    .where(
      and(
        eq(outcomeClaimsTable.id, claimId),
        eq(outcomeClaimsTable.orgId, req.orgId),
      ),
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Claim not found." });
    return;
  }
  if (existing.status === "denied") {
    res.status(409).json({ error: "Claim already denied." });
    return;
  }
  if (existing.status === "invoiced") {
    res.status(409).json({ error: "Claim already invoiced; cannot deny." });
    return;
  }

  const actor = "admin";

  const [updated] = await db
    .update(outcomeClaimsTable)
    .set({
      status: "denied",
      denialReason: body.reason,
      verifiedBy: actor,
      verifiedAt: new Date(),
    })
    .where(eq(outcomeClaimsTable.id, claimId))
    .returning();

  await db.insert(claimEventsTable).values({
    id: newId("evt"),
    claimId,
    orgId: req.orgId,
    eventType: "denied",
    actor,
    reason: body.reason,
  });

  const [agent] = await db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.id, updated.agentId))
    .limit(1);

  res.json(serializeClaim(updated, agent?.name ?? ""));
});

export default router;
