import { Router, type IRouter } from "express";
import {
  db,
  erpConnectionsTable,
  erpAdapterKeyValues,
  erpConnectionStatusValues,
  type ErpAdapterKey,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

const router: IRouter = Router();

const adapterKeySchema = z.enum(erpAdapterKeyValues);
const statusSchema = z.enum(erpConnectionStatusValues);

const CreateConnectionSchema = z.object({
  label: z.string().min(1).max(120),
  adapterKey: adapterKeySchema,
  credentials: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()).default({}),
});

const UpdateConnectionSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  status: statusSchema.optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    const { label, adapterKey, credentials, settings } = parsed.data;

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
        })
        .returning();
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
    if (parsed.data.status !== undefined) updates.status = parsed.data.status;
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
