import { Router, type IRouter } from "express";
import {
  db,
  agentsTable,
  outcomeClaimsTable,
  type AgentStatusValue,
} from "@workspace/db";
import { and, eq, sql, asc } from "drizzle-orm";
import {
  ListAgentsQueryParams,
  CreateAgentBody,
  UpdateAgentBody,
  GetAgentParams,
  UpdateAgentParams,
} from "@workspace/api-zod";
import { orgContext } from "../middlewares/orgContext";
import { newId } from "../lib/ids";

const router: IRouter = Router();

router.use(orgContext);

function serializeAgent(row: typeof agentsTable.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    role: row.role,
    kpiDefinition: row.kpiDefinition,
    status: row.status,
    ratePerOutcomeUsd: Number(row.ratePerOutcomeUsd),
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/agents", async (req, res) => {
  const params = ListAgentsQueryParams.parse(req.query);
  const conditions = [eq(agentsTable.orgId, req.orgId)];
  if (params.status) {
    conditions.push(eq(agentsTable.status, params.status as AgentStatusValue));
  }

  const rows = await db
    .select()
    .from(agentsTable)
    .where(and(...conditions))
    .orderBy(asc(agentsTable.name));

  res.json(rows.map(serializeAgent));
});

router.post("/agents", async (req, res) => {
  const body = CreateAgentBody.parse(req.body);
  const id = newId("agt");
  const [inserted] = await db
    .insert(agentsTable)
    .values({
      id,
      orgId: req.orgId,
      name: body.name,
      role: body.role,
      kpiDefinition: body.kpiDefinition,
      status: (body.status ?? "active") as AgentStatusValue,
      ratePerOutcomeUsd: String(body.ratePerOutcomeUsd),
    })
    .returning();

  res.status(201).json(serializeAgent(inserted));
});

router.get("/agents/:agentId", async (req, res) => {
  const { agentId } = GetAgentParams.parse(req.params);

  const [row] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, req.orgId)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Agent not found." });
    return;
  }

  // Aggregate lifetime totals
  const aggRows = await db
    .select({
      status: outcomeClaimsTable.status,
      count: sql<number>`count(*)::int`,
      totalValue: sql<string>`coalesce(sum(${outcomeClaimsTable.estimatedValueUsd}), 0)::text`,
    })
    .from(outcomeClaimsTable)
    .where(
      and(
        eq(outcomeClaimsTable.agentId, agentId),
        eq(outcomeClaimsTable.orgId, req.orgId),
      ),
    )
    .groupBy(outcomeClaimsTable.status);

  const lifetimeClaimsByStatus = {
    claimed: 0,
    verified: 0,
    denied: 0,
    invoiced: 0,
  };
  let lifetimeVerifiedValueUsd = 0;
  let billableCount = 0;

  for (const r of aggRows) {
    const status = r.status as keyof typeof lifetimeClaimsByStatus;
    const count = Number(r.count);
    lifetimeClaimsByStatus[status] = count;
    if (status === "verified") {
      lifetimeVerifiedValueUsd += Number(r.totalValue);
      billableCount += count;
    } else if (status === "invoiced") {
      lifetimeVerifiedValueUsd += Number(r.totalValue);
      billableCount += count;
    }
  }

  const rate = Number(row.ratePerOutcomeUsd);

  res.json({
    ...serializeAgent(row),
    lifetimeClaimsByStatus,
    lifetimeVerifiedValueUsd,
    lifetimeBillableUsd: rate * billableCount,
  });
});

router.patch("/agents/:agentId", async (req, res) => {
  const { agentId } = UpdateAgentParams.parse(req.params);
  const body = UpdateAgentBody.parse(req.body);

  const updateValues: Partial<typeof agentsTable.$inferInsert> = {};
  if (body.name !== undefined) updateValues.name = body.name;
  if (body.role !== undefined) updateValues.role = body.role;
  if (body.kpiDefinition !== undefined)
    updateValues.kpiDefinition = body.kpiDefinition;
  if (body.status !== undefined)
    updateValues.status = body.status as AgentStatusValue;
  if (body.ratePerOutcomeUsd !== undefined)
    updateValues.ratePerOutcomeUsd = String(body.ratePerOutcomeUsd);

  if (Object.keys(updateValues).length === 0) {
    const [row] = await db
      .select()
      .from(agentsTable)
      .where(
        and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, req.orgId)),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(serializeAgent(row));
    return;
  }

  const [updated] = await db
    .update(agentsTable)
    .set(updateValues)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, req.orgId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Agent not found." });
    return;
  }

  res.json(serializeAgent(updated));
});

export default router;
