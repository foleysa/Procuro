import { Router, type IRouter } from "express";
import { db, collectorsTable, collectorAuditLogTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { tenantMiddleware } from "../lib/tenant";
import { requirePlatformAdmin } from "../lib/platform-admin";
import {
  runCollector,
  getCollector,
  listRegisteredCollectorIds,
  setKillSwitch,
  approveCollector,
  disableCollector,
  setRateLimit,
  upsertCollectorRegistration,
  listCollectorAudit,
} from "../lib/intelligence/runtime";
import { z } from "zod";

const router: IRouter = Router();

const collectionPostureEnum = z.enum([
  "public-api",
  "published-data",
  "respect-robots-crawl",
  "aggressive-crawl",
]);

const RegisterCollectorSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  posture: collectionPostureEnum,
  owner: z.string().min(1).max(200),
  sourceUrl: z.string().url(),
  rateLimitRpm: z.number().int().min(1).max(10000).optional(),
  scheduleCron: z.string().max(120).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const PatchCollectorSchema = z.object({
  status: z.enum(["draft", "approved", "killed", "rejected"]).optional(),
  rateLimitRpm: z.number().int().min(1).max(10000).optional(),
  scheduleCron: z.string().max(120).nullable().optional(),
});

router.get("/collectors", tenantMiddleware, async (_req, res) => {
  const dbRows = await db
    .select()
    .from(collectorsTable)
    .orderBy(asc(collectorsTable.name));
  const items = dbRows.map((r) => {
    const reg = getCollector(r.id);
    return {
      id: r.id,
      name: r.name,
      description: reg?.description ?? r.description ?? "",
      posture: r.posture,
      status:
        r.killSwitch === 1
          ? "killed"
          : r.status === "approved"
            ? "enabled"
            : "disabled",
      registryStatus: r.status,
      killSwitch: r.killSwitch === 1,
      sourceUrl: reg?.sourceUrl ?? r.sourceUrl ?? null,
      rateLimitRpm: r.rateLimitRpm,
      defaultRateLimitRpm: reg?.defaultRateLimitRpm ?? r.rateLimitRpm ?? null,
      defaultScheduleCron: reg?.defaultScheduleCron ?? r.scheduleCron ?? null,
      owner: r.owner,
      lastRunAt: null,
      lastSignalCount: null,
    };
  });
  const have = new Set(items.map((i) => i.id));
  for (const id of listRegisteredCollectorIds()) {
    if (have.has(id)) continue;
    const reg = getCollector(id)!;
    items.push({
      id,
      name: reg.name,
      description: reg.description,
      posture: reg.posture,
      status: "disabled",
      registryStatus: "draft",
      killSwitch: false,
      sourceUrl: reg.sourceUrl,
      rateLimitRpm: reg.defaultRateLimitRpm,
      defaultRateLimitRpm: reg.defaultRateLimitRpm,
      defaultScheduleCron: reg.defaultScheduleCron,
      owner: "platform",
      lastRunAt: null,
      lastSignalCount: null,
    });
  }
  res.json(items);
});

router.post("/collectors", requirePlatformAdmin, async (req, res) => {
  const parsed = RegisterCollectorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const actor = req.actorEmail ?? "system@procuro.ai";
  const row = await upsertCollectorRegistration({ ...parsed.data, actor });
  res.status(201).json({ id: row.id, status: row.status });
});

router.patch("/collectors/:id", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const parsed = PatchCollectorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const actor = req.actorEmail ?? "system@procuro.ai";

  const [current] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, id));
  if (!current) {
    res.status(404).json({ error: "Collector not found" });
    return;
  }

  let updated = current;
  if (parsed.data.status === "approved") {
    updated = (await approveCollector(id, actor)) ?? updated;
  } else if (
    parsed.data.status === "rejected" ||
    parsed.data.status === "draft"
  ) {
    updated = (await disableCollector(id, actor, parsed.data.status)) ?? updated;
  }
  if (typeof parsed.data.rateLimitRpm === "number") {
    updated = (await setRateLimit(id, parsed.data.rateLimitRpm, actor)) ?? updated;
  }
  if (parsed.data.scheduleCron !== undefined) {
    const [row] = await db
      .update(collectorsTable)
      .set({ scheduleCron: parsed.data.scheduleCron })
      .where(eq(collectorsTable.id, id))
      .returning();
    if (row) updated = row;
    await db.insert(collectorAuditLogTable).values({
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      collectorId: id,
      event: "schedule_set",
      metadata: { actor, cron: parsed.data.scheduleCron },
    });
  }
  res.json({ id: updated.id, status: updated.status, killSwitch: updated.killSwitch === 1, rateLimitRpm: updated.rateLimitRpm });
});

router.post("/collectors/:id/kill", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const actor = req.actorEmail ?? "system@procuro.ai";
  const row = await setKillSwitch(id, true, actor);
  if (!row) {
    res.status(404).json({ error: "Collector not found" });
    return;
  }
  res.json({ id: row.id, killSwitch: true });
});

router.post("/collectors/:id/unkill", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const actor = req.actorEmail ?? "system@procuro.ai";
  const row = await setKillSwitch(id, false, actor);
  if (!row) {
    res.status(404).json({ error: "Collector not found" });
    return;
  }
  res.json({ id: row.id, killSwitch: false });
});

router.get("/collectors/:id/audit", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const limit = Math.min(
    Math.max(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 1),
    500,
  );
  const rows = await listCollectorAudit(id, limit);
  res.json(
    rows.map((r) => ({
      id: r.id,
      collectorId: r.collectorId,
      event: r.event,
      targetUrl: r.targetUrl,
      statusCode: r.statusCode,
      error: r.error,
      metadata: r.metadata ?? {},
      createdAt: r.createdAt,
    })),
  );
});

router.post("/collectors/:id/run", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const result = await runCollector(id);
  res.json({
    collectorId: id,
    signalsWritten: result.signalsCollected,
    durationMs: result.durationMs,
    skipped: result.skipped !== undefined,
    skipReason: result.skipped,
  });
});

export default router;
