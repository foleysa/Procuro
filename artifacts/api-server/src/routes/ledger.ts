import { Router, type IRouter } from "express";
import {
  db,
  agentsTable,
  outcomeClaimsTable,
  claimEventsTable,
} from "@workspace/db";
import { and, eq, sql, desc, gte } from "drizzle-orm";
import { GetRecentActivityQueryParams } from "@workspace/api-zod";
import { orgContext } from "../middlewares/orgContext";

const router: IRouter = Router();

router.use(orgContext);

router.get("/ledger/summary", async (req, res) => {
  const rows = await db
    .select({
      status: outcomeClaimsTable.status,
      count: sql<number>`count(*)::int`,
      totalValue: sql<string>`coalesce(sum(${outcomeClaimsTable.estimatedValueUsd}), 0)::text`,
    })
    .from(outcomeClaimsTable)
    .where(eq(outcomeClaimsTable.orgId, req.orgId))
    .groupBy(outcomeClaimsTable.status);

  const counts = { claimed: 0, verified: 0, denied: 0, invoiced: 0 };
  const values = { claimed: 0, verified: 0, denied: 0, invoiced: 0 };
  for (const r of rows) {
    const s = r.status as keyof typeof counts;
    counts[s] = Number(r.count);
    values[s] = Number(r.totalValue);
  }

  // billableUsd: sum of agent.ratePerOutcomeUsd across verified+invoiced claims
  const billableRows = await db
    .select({
      total: sql<string>`coalesce(sum(${agentsTable.ratePerOutcomeUsd}), 0)::text`,
    })
    .from(outcomeClaimsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, outcomeClaimsTable.agentId))
    .where(
      and(
        eq(outcomeClaimsTable.orgId, req.orgId),
        sql`${outcomeClaimsTable.status} in ('verified', 'invoiced')`,
      ),
    );

  const billable = Number(billableRows[0]?.total ?? 0);

  res.json({
    totalClaims:
      counts.claimed + counts.verified + counts.denied + counts.invoiced,
    claimedCount: counts.claimed,
    verifiedCount: counts.verified,
    deniedCount: counts.denied,
    invoicedCount: counts.invoiced,
    claimedValueUsd: values.claimed,
    verifiedValueUsd: values.verified,
    deniedValueUsd: values.denied,
    invoicedValueUsd: values.invoiced,
    billableUsd: billable,
  });
});

router.get("/ledger/recent-activity", async (req, res) => {
  const params = GetRecentActivityQueryParams.parse(req.query);
  const limit = params.limit ?? 12;

  const rows = await db
    .select({
      eventId: claimEventsTable.id,
      claimId: claimEventsTable.claimId,
      eventType: claimEventsTable.eventType,
      actor: claimEventsTable.actor,
      createdAt: claimEventsTable.createdAt,
      claimTitle: outcomeClaimsTable.title,
      agentId: agentsTable.id,
      agentName: agentsTable.name,
      valueUsd: outcomeClaimsTable.estimatedValueUsd,
    })
    .from(claimEventsTable)
    .innerJoin(
      outcomeClaimsTable,
      eq(outcomeClaimsTable.id, claimEventsTable.claimId),
    )
    .innerJoin(agentsTable, eq(agentsTable.id, outcomeClaimsTable.agentId))
    .where(eq(claimEventsTable.orgId, req.orgId))
    .orderBy(desc(claimEventsTable.createdAt))
    .limit(limit);

  res.json(
    rows.map((r) => ({
      eventId: r.eventId,
      claimId: r.claimId,
      claimTitle: r.claimTitle,
      agentId: r.agentId,
      agentName: r.agentName,
      eventType: r.eventType,
      actor: r.actor,
      valueUsd: Number(r.valueUsd),
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

router.get("/ledger/value-by-agent", async (req, res) => {
  const rows = await db
    .select({
      agentId: agentsTable.id,
      agentName: agentsTable.name,
      verifiedValueUsd: sql<string>`coalesce(sum(case when ${outcomeClaimsTable.status} in ('verified', 'invoiced') then ${outcomeClaimsTable.estimatedValueUsd} else 0 end), 0)::text`,
      verifiedCount: sql<number>`coalesce(sum(case when ${outcomeClaimsTable.status} in ('verified', 'invoiced') then 1 else 0 end), 0)::int`,
    })
    .from(agentsTable)
    .leftJoin(
      outcomeClaimsTable,
      and(
        eq(outcomeClaimsTable.agentId, agentsTable.id),
        eq(outcomeClaimsTable.orgId, req.orgId),
      ),
    )
    .where(eq(agentsTable.orgId, req.orgId))
    .groupBy(agentsTable.id, agentsTable.name)
    .orderBy(desc(sql`coalesce(sum(case when ${outcomeClaimsTable.status} in ('verified', 'invoiced') then ${outcomeClaimsTable.estimatedValueUsd} else 0 end), 0)`));

  res.json(
    rows.map((r) => ({
      agentId: r.agentId,
      agentName: r.agentName,
      verifiedValueUsd: Number(r.verifiedValueUsd),
      verifiedCount: Number(r.verifiedCount),
    })),
  );
});

router.get("/ledger/value-over-time", async (req, res) => {
  const since = new Date();
  since.setDate(since.getDate() - 29);
  since.setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${outcomeClaimsTable.claimedAt}), 'YYYY-MM-DD')`,
      verifiedValueUsd: sql<string>`coalesce(sum(case when ${outcomeClaimsTable.status} in ('verified', 'invoiced') then ${outcomeClaimsTable.estimatedValueUsd} else 0 end), 0)::text`,
      verifiedCount: sql<number>`coalesce(sum(case when ${outcomeClaimsTable.status} in ('verified', 'invoiced') then 1 else 0 end), 0)::int`,
    })
    .from(outcomeClaimsTable)
    .where(
      and(
        eq(outcomeClaimsTable.orgId, req.orgId),
        gte(outcomeClaimsTable.claimedAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', ${outcomeClaimsTable.claimedAt})`)
    .orderBy(sql`date_trunc('day', ${outcomeClaimsTable.claimedAt})`);

  // Fill missing days with zeros so the chart has a continuous 30-day window.
  const byDay = new Map<string, { verifiedValueUsd: number; verifiedCount: number }>();
  for (const r of rows) {
    byDay.set(r.day, {
      verifiedValueUsd: Number(r.verifiedValueUsd),
      verifiedCount: Number(r.verifiedCount),
    });
  }

  const out: Array<{
    date: string;
    verifiedValueUsd: number;
    verifiedCount: number;
  }> = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const v = byDay.get(key) ?? { verifiedValueUsd: 0, verifiedCount: 0 };
    out.push({ date: key, ...v });
  }

  res.json(out);
});

export default router;
