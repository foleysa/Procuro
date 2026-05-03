import { Router, type IRouter } from "express";
import {
  db,
  erpConnectionsTable,
  erpSyncRunsTable,
  erpAdapterKeyValues,
  erpConnectionStatusValues,
  type ErpAdapterKey,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requireOrgAdmin } from "../lib/org-admin";
import { newId } from "../lib/ids";
import {
  encryptCredentials,
  summarizeCredentialFields,
} from "../lib/erp/crypto";
import {
  getErpConnector,
  listErpConnectors,
} from "../lib/connectors/erp-connector";
import { enqueueJob, JobQuotaExceededError } from "../lib/jobs/queue";
import { writeAdminAudit } from "../lib/admin-audit";

const router: IRouter = Router();

const adapterKeySchema = z.enum(erpAdapterKeyValues);
const statusSchema = z.enum(erpConnectionStatusValues);

/**
 * Recurring-sync cadence. Lower bound 5 min keeps the worker from
 * stampeding upstream APIs faster than the typical OAuth rate-limit
 * window. Upper bound 7 days (10 080 min) is "barely scheduled" — past
 * that, operators should pause the connection instead.
 */
const SYNC_INTERVAL_MIN = 5;
const SYNC_INTERVAL_MAX = 7 * 24 * 60;
const syncIntervalSchema = z
  .number()
  .int()
  .min(SYNC_INTERVAL_MIN)
  .max(SYNC_INTERVAL_MAX);

const CreateConnectionSchema = z.object({
  label: z.string().min(1).max(120),
  adapterKey: adapterKeySchema,
  credentials: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()).default({}),
  syncIntervalMinutes: syncIntervalSchema.optional(),
});

const UpdateConnectionSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  status: statusSchema.optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  syncIntervalMinutes: syncIntervalSchema.optional(),
});

const TestConnectionSchema = z.object({
  adapterKey: adapterKeySchema,
  credentials: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()).default({}),
});

interface ConnectionView {
  id: string;
  orgId: string;
  label: string;
  adapterKey: ErpAdapterKey;
  status: (typeof erpConnectionStatusValues)[number];
  settings: Record<string, unknown>;
  watermarks: Record<string, string>;
  credentialFields: string[];
  lastSyncedAt: string | null;
  lastError: string | null;
  syncIntervalMinutes: number;
  nextScheduledSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(
  row: typeof erpConnectionsTable.$inferSelect,
): ConnectionView {
  return {
    id: row.id,
    orgId: row.orgId,
    label: row.label,
    adapterKey: row.adapterKey,
    status: row.status,
    settings: row.settings,
    watermarks: row.watermarks,
    credentialFields: summarizeCredentialFields(row.credentialsCipher).fields,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastError: row.lastError,
    syncIntervalMinutes: row.syncIntervalMinutes,
    nextScheduledSyncAt: row.nextScheduledSyncAt
      ? row.nextScheduledSyncAt.toISOString()
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Default cadence for newly-created ERP connections, in minutes. Mirrors
 * the schema-level default (`erp_connections.sync_interval_minutes`)
 * so the route can compute a non-null `next_scheduled_sync_at` on
 * insert without having to round-trip through the DB to read the
 * default back out.
 */
const DEFAULT_SYNC_INTERVAL_MINUTES = 120;

function nextSyncAtFromNow(intervalMinutes: number): Date {
  return new Date(Date.now() + intervalMinutes * 60_000);
}

// ---------- Adapter catalog (no DB) -----------------------------------

router.get(
  "/integrations/adapters",
  tenantMiddleware,
  requireOrgAdmin,
  (_req, res) => {
    const out = listErpConnectors().map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description,
      postureClass: c.postureClass,
      disclosureTier: c.disclosureTier,
      jurisdiction: c.jurisdiction,
      retentionDays: c.retentionDays,
    }));
    res.json({ adapters: out });
  },
);

// ---------- List ------------------------------------------------------

router.get(
  "/integrations/connections",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const rows = await db
      .select()
      .from(erpConnectionsTable)
      .where(eq(erpConnectionsTable.orgId, orgId));
    res.json({ connections: rows.map(toView) });
  },
);

router.get(
  "/integrations/connections/:id",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"] ?? "");
    const [row] = await db
      .select()
      .from(erpConnectionsTable)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    res.json({ connection: toView(row) });
  },
);

// ---------- Create ----------------------------------------------------

router.post(
  "/integrations/connections",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const parsed = CreateConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }
    const {
      label,
      adapterKey,
      credentials,
      settings,
      syncIntervalMinutes,
    } = parsed.data;

    const connector = getErpConnector(adapterKey);
    if (!connector) {
      res.status(400).json({ error: `Unknown adapter "${adapterKey}"` });
      return;
    }
    const credsValid = connector.credentialsSchema.safeParse(credentials);
    if (!credsValid.success) {
      res
        .status(400)
        .json({
          error: "Invalid credentials for this adapter",
          details: credsValid.error.format(),
        });
      return;
    }
    const settingsValid = connector.settingsSchema.safeParse(settings);
    if (!settingsValid.success) {
      res
        .status(400)
        .json({
          error: "Invalid settings for this adapter",
          details: settingsValid.error.format(),
        });
      return;
    }

    const cipher = encryptCredentials(
      credentials as Record<string, unknown>,
    );
    const id = newId("erpc");
    const interval = syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
    try {
      const [row] = await db
        .insert(erpConnectionsTable)
        .values({
          id,
          orgId,
          label,
          adapterKey,
          status: "active",
          credentialsCipher: cipher,
          settings: settingsValid.data as Record<string, unknown>,
          watermarks: {},
          syncIntervalMinutes: interval,
          // First scheduled run lands one full interval after
          // creation so the recurring scheduler doesn't double-fire
          // on top of the operator's likely manual "Sync now" press
          // immediately after setup.
          nextScheduledSyncAt: nextSyncAtFromNow(interval),
        })
        .returning();
      try {
        await writeAdminAudit({
          orgId,
          actor: req.actorEmail ?? "system@procuro.ai",
          action: "integration.connect",
          targetId: id,
          targetLabel: label,
          metadata: { adapterKey, syncIntervalMinutes: interval },
        });
      } catch (auditErr) {
        req.log.warn({ err: auditErr }, "Failed to write admin audit row");
      }
      res.status(201).json({ connection: toView(row!) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        res
          .status(409)
          .json({ error: `A connection labeled "${label}" already exists.` });
        return;
      }
      throw err;
    }
  },
);

// ---------- Update ----------------------------------------------------

router.patch(
  "/integrations/connections/:id",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"] ?? "");
    const parsed = UpdateConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }
    const [existing] = await db
      .select()
      .from(erpConnectionsTable)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    const connector = getErpConnector(existing.adapterKey);
    if (!connector) {
      res
        .status(400)
        .json({ error: `Adapter "${existing.adapterKey}" no longer registered` });
      return;
    }

    const updates: Partial<typeof erpConnectionsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.data.label !== undefined) updates.label = parsed.data.label;
    if (parsed.data.status !== undefined) {
      updates.status = parsed.data.status;
      // Resuming a previously-paused connection should fire the next
      // recurring sync one cadence-window from now (not immediately,
      // because the operator can press "Sync now" if they want a
      // catch-up; not at the original schedule, because that may be
      // far in the past while paused). Pausing leaves
      // next_scheduled_sync_at untouched — the scheduler simply skips
      // any non-active row.
      if (
        parsed.data.status === "active" &&
        existing.status === "paused"
      ) {
        updates.nextScheduledSyncAt = nextSyncAtFromNow(
          parsed.data.syncIntervalMinutes ?? existing.syncIntervalMinutes,
        );
      }
    }
    if (parsed.data.syncIntervalMinutes !== undefined) {
      updates.syncIntervalMinutes = parsed.data.syncIntervalMinutes;
      // Always reset the watermark to "now + new interval" when the
      // cadence changes so a shorter interval doesn't immediately fire
      // (the old long interval may still be in the future, OR a longer
      // interval shouldn't keep an old "due now" watermark).
      updates.nextScheduledSyncAt = nextSyncAtFromNow(
        parsed.data.syncIntervalMinutes,
      );
    }
    if (parsed.data.settings !== undefined) {
      const settingsValid = connector.settingsSchema.safeParse(
        parsed.data.settings,
      );
      if (!settingsValid.success) {
        res
          .status(400)
          .json({
            error: "Invalid settings for this adapter",
            details: settingsValid.error.format(),
          });
        return;
      }
      updates.settings = settingsValid.data as Record<string, unknown>;
    }
    if (parsed.data.credentials !== undefined) {
      const credsValid = connector.credentialsSchema.safeParse(
        parsed.data.credentials,
      );
      if (!credsValid.success) {
        res
          .status(400)
          .json({
            error: "Invalid credentials for this adapter",
            details: credsValid.error.format(),
          });
        return;
      }
      updates.credentialsCipher = encryptCredentials(
        parsed.data.credentials as Record<string, unknown>,
      );
    }

    const [row] = await db
      .update(erpConnectionsTable)
      .set(updates)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      )
      .returning();
    try {
      await writeAdminAudit({
        orgId,
        actor: req.actorEmail ?? "system@procuro.ai",
        action: "integration.update",
        targetId: id,
        targetLabel: row?.label ?? existing.label,
        metadata: {
          adapterKey: existing.adapterKey,
          changedKeys: Object.keys(parsed.data),
          credentialsRotated: parsed.data.credentials !== undefined,
          status: row?.status ?? existing.status,
        },
      });
    } catch (auditErr) {
      req.log.warn({ err: auditErr }, "Failed to write admin audit row");
    }
    res.json({ connection: toView(row!) });
  },
);

// ---------- Delete ----------------------------------------------------

router.delete(
  "/integrations/connections/:id",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"] ?? "");
    // Read the row before deleting so the audit row can carry the
    // human-friendly label / adapter key the operator just removed.
    const [existing] = await db
      .select({
        label: erpConnectionsTable.label,
        adapterKey: erpConnectionsTable.adapterKey,
      })
      .from(erpConnectionsTable)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      );
    const result = await db
      .delete(erpConnectionsTable)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      )
      .returning({ id: erpConnectionsTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    try {
      await writeAdminAudit({
        orgId,
        actor: req.actorEmail ?? "system@procuro.ai",
        action: "integration.disconnect",
        targetId: id,
        targetLabel: existing?.label ?? id,
        metadata: { adapterKey: existing?.adapterKey ?? null },
      });
    } catch (auditErr) {
      req.log.warn({ err: auditErr }, "Failed to write admin audit row");
    }
    res.status(204).end();
  },
);

// ---------- Test connection (does not persist) ------------------------

router.post(
  "/integrations/test",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const parsed = TestConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }
    const connector = getErpConnector(parsed.data.adapterKey);
    if (!connector) {
      res
        .status(400)
        .json({ error: `Unknown adapter "${parsed.data.adapterKey}"` });
      return;
    }
    const credsValid = connector.credentialsSchema.safeParse(
      parsed.data.credentials,
    );
    if (!credsValid.success) {
      res.status(400).json({ error: "Invalid credentials shape" });
      return;
    }
    const settingsValid = connector.settingsSchema.safeParse(
      parsed.data.settings,
    );
    if (!settingsValid.success) {
      res.status(400).json({ error: "Invalid settings shape" });
      return;
    }
    const result = await connector.testConnection({
      credentials: credsValid.data,
      settings: settingsValid.data,
    });
    res.status(result.ok ? 200 : 502).json(result);
  },
);

// ---------- Recent sync runs (audit history) -------------------------

/**
 * Per-connection upper bound on the recent-runs window. Operators get
 * a meaningful "last few syncs" view without us paging through months
 * of history; if they want more they should look at the System / Jobs
 * page or query the DB directly. 100 keeps the response payload well
 * under 100 KB even with a chatty multi-entity feed.
 */
const RUNS_DEFAULT_LIMIT = 10;
const RUNS_MAX_LIMIT = 100;

const RunsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RUNS_MAX_LIMIT)
    .optional(),
});

router.get(
  "/integrations/connections/:id/runs",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"] ?? "");
    const parsed = RunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }
    const limit = parsed.data.limit ?? RUNS_DEFAULT_LIMIT;

    // Confirm the connection belongs to the requesting tenant before
    // returning history — otherwise an operator on org A could read
    // org B's run timestamps just by guessing connection IDs.
    const [conn] = await db
      .select({ id: erpConnectionsTable.id })
      .from(erpConnectionsTable)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      );
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    const rows = await db
      .select()
      .from(erpSyncRunsTable)
      .where(
        and(
          eq(erpSyncRunsTable.orgId, orgId),
          eq(erpSyncRunsTable.connectionId, id),
        ),
      )
      .orderBy(desc(erpSyncRunsTable.startedAt))
      .limit(limit);

    res.json({
      connectionId: id,
      runs: rows.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        jobId: r.jobId,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt.toISOString(),
        durationMs: r.durationMs,
        recordsByEntity: r.recordsByEntity,
        pagesByEntity: r.pagesByEntity,
        droppedByEntity: r.droppedByEntity,
        recordsProcessed: r.recordsProcessed,
        recordsSkipped: r.recordsSkipped,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

// ---------- Trigger sync ---------------------------------------------

router.post(
  "/integrations/connections/:id/sync",
  tenantMiddleware,
  requireOrgAdmin,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"] ?? "");
    const [conn] = await db
      .select({
        id: erpConnectionsTable.id,
        status: erpConnectionsTable.status,
      })
      .from(erpConnectionsTable)
      .where(
        and(
          eq(erpConnectionsTable.orgId, orgId),
          eq(erpConnectionsTable.id, id),
        ),
      );
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    if (conn.status === "paused") {
      res.status(409).json({ error: "Connection is paused" });
      return;
    }
    try {
      const job = await enqueueJob({
        kind: "sync_erp_connection",
        orgId,
        payload: { connectionId: id },
      });
      res.status(202).json({
        job: {
          id: job.id,
          kind: job.kind,
          status: job.status,
          enqueuedAt: job.enqueuedAt,
        },
      });
    } catch (err) {
      if (err instanceof JobQuotaExceededError) {
        res
          .status(429)
          .json({ error: "Job quota exceeded for this organisation." });
        return;
      }
      throw err;
    }
  },
);

export default router;
