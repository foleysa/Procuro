/**
 * Alerts subsystem REST surface (#117).
 *
 * Endpoints fall into six families:
 *   - /alerts                   — inbox: list, detail, transitions, audit
 *   - /alert-channels           — destinations: email, webhook, slack, teams
 *   - /alert-subscriptions      — per-user delivery preferences
 *   - /watchlists[/members]     — saved supplier/entity groups
 *   - /alert-rules              — tenant-defined matchers raising severity
 *   - /escalation-policies      — unacked escalation policies
 *
 * All routes are tenant-scoped via `tenantMiddleware`. The actor on
 * audit events is `req.actorEmail`. The user identity for
 * subscriptions and watchlists is the `userId` field on the request
 * body (when one is supplied) so this works in dev where the
 * middleware does not surface a real user id.
 */

import { Router, type IRouter } from "express";
import {
  db,
  alertsTable,
  alertEventsTable,
  alertChannelsTable,
  alertSubscriptionsTable,
  alertDeliveriesTable,
  alertRulesTable,
  escalationPoliciesTable,
  watchlistsTable,
  watchlistMembersTable,
  alertSeverityValues,
  alertSourceValues,
  alertStateValues,
  alertChannelKindValues,
  alertDigestModeValues,
  watchlistScopeValues,
  type AlertRow,
  type AlertChannelRow,
  type AlertSubscriptionRow,
  type AlertRuleRow,
  type EscalationPolicyRow,
  type WatchlistRow,
  type WatchlistMemberRow,
  type AlertEventRow,
  type AlertDeliveryRow,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import {
  createAlert,
  transitionAlert,
} from "@workspace/intelligence";
import { getChannelAdapter } from "../lib/alerts/channels";

const router: IRouter = Router();

// ----------------------------- Helpers -----------------------------

const severityEnum = z.enum(alertSeverityValues);
const sourceEnum = z.enum(alertSourceValues);
const stateEnum = z.enum(alertStateValues);
const channelKindEnum = z.enum(alertChannelKindValues);
const digestEnum = z.enum(alertDigestModeValues);
const watchlistScopeEnum = z.enum(watchlistScopeValues);

function mapAlert(r: AlertRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    severity: r.severity,
    source: r.source,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    dedupeKey: r.dedupeKey,
    occurrences: r.occurrences,
    payload: r.payload,
    entityUid: r.entityUid,
    supplierId: r.supplierId,
    contractId: r.contractId,
    opportunityId: r.opportunityId,
    state: r.state,
    assignedToUserId: r.assignedToUserId,
    acknowledgedAt: r.acknowledgedAt,
    acknowledgedBy: r.acknowledgedBy,
    snoozedUntil: r.snoozedUntil,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
    deliveredAt: r.deliveredAt,
    escalatedAt: r.escalatedAt,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapChannel(r: AlertChannelRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    kind: r.kind,
    name: r.name,
    config: redactChannelConfig(r.kind, r.config),
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Redact secret material from channel config before returning to the
 * client. Webhook signing secrets are particularly sensitive — we
 * surface only a 4-char hint so operators can verify they're looking
 * at the right channel without ever re-exposing the secret.
 */
function redactChannelConfig(
  kind: AlertChannelRow["kind"],
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "webhook" && typeof config["signingSecret"] === "string") {
    const s = config["signingSecret"] as string;
    return {
      ...config,
      signingSecret:
        s.length <= 4 ? "***" : `${s.slice(0, 2)}…${s.slice(-2)}`,
    };
  }
  return config;
}

function mapSubscription(r: AlertSubscriptionRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    channelId: r.channelId,
    severityThreshold: r.severityThreshold,
    sources: r.sources,
    watchlistId: r.watchlistId,
    digest: r.digest,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapRule(r: AlertRuleRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    severity: r.severity,
    condition: r.condition,
    watchlistId: r.watchlistId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapEscalation(r: EscalationPolicyRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    enabled: r.enabled,
    severityAtLeast: r.severityAtLeast,
    unackedHours: r.unackedHours,
    escalateToUserId: r.escalateToUserId,
    channelId: r.channelId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapWatchlist(r: WatchlistRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    name: r.name,
    scope: r.scope,
    description: r.description,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapWatchlistMember(r: WatchlistMemberRow) {
  return {
    id: r.id,
    watchlistId: r.watchlistId,
    supplierId: r.supplierId === "" ? null : r.supplierId,
    entityUid: r.entityUid === "" ? null : r.entityUid,
    addedAt: r.addedAt,
  };
}

function mapAlertEvent(r: AlertEventRow) {
  return {
    id: r.id,
    alertId: r.alertId,
    eventType: r.eventType,
    actor: r.actor,
    note: r.note,
    metadata: r.metadata,
    createdAt: r.createdAt,
  };
}

function mapDelivery(r: AlertDeliveryRow) {
  return {
    id: r.id,
    alertId: r.alertId,
    subscriptionId: r.subscriptionId,
    channelId: r.channelId,
    state: r.state,
    attempts: r.attempts,
    lastError: r.lastError,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ----------------------------- /alerts -----------------------------

router.get("/alerts", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query["limit"] as string) ?? "50", 10) || 50, 1),
    200,
  );
  const stateFilter = req.query["state"] as string | undefined;
  const severityFilter = req.query["severity"] as string | undefined;
  const sourceFilter = req.query["source"] as string | undefined;
  const supplierIdFilter = req.query["supplierId"] as string | undefined;
  const marketSignalIdFilter = req.query["marketSignalId"] as
    | string
    | undefined;

  const conditions = [eq(alertsTable.orgId, orgId)];
  if (stateFilter && stateEnum.safeParse(stateFilter).success) {
    conditions.push(eq(alertsTable.state, stateFilter as AlertRow["state"]));
  }
  if (severityFilter && severityEnum.safeParse(severityFilter).success) {
    conditions.push(
      eq(alertsTable.severity, severityFilter as AlertRow["severity"]),
    );
  }
  if (sourceFilter && sourceEnum.safeParse(sourceFilter).success) {
    conditions.push(eq(alertsTable.source, sourceFilter as AlertRow["source"]));
  }
  if (supplierIdFilter) {
    conditions.push(eq(alertsTable.supplierId, supplierIdFilter));
  }
  // Cross-link with the Fusion war-room event stream (Task #161). Each
  // alert minted by collector fan-out stamps the originating
  // `market_signals.id` into `payload.marketSignalId` (and the array
  // form `payload.marketSignalIds`). We accept either shape so a
  // future multi-signal alert composer can fan multiple events into
  // one alert and still be discoverable from the war-room side. The
  // `id` prefix check defends against accidental SQL injection via the
  // query string — every signal id is a `sig_…` cuid.
  if (
    marketSignalIdFilter &&
    /^sig_[A-Za-z0-9_-]{1,64}$/.test(marketSignalIdFilter)
  ) {
    conditions.push(
      sql`(${alertsTable.payload} ->> 'marketSignalId' = ${marketSignalIdFilter}
           OR ${alertsTable.payload} -> 'marketSignalIds' ? ${marketSignalIdFilter})`,
    );
  }

  const rows = await db
    .select()
    .from(alertsTable)
    .where(and(...conditions))
    .orderBy(desc(alertsTable.lastSeenAt))
    .limit(limit);
  res.json({ items: rows.map(mapAlert) });
});

router.get("/alerts/summary", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select({
      state: alertsTable.state,
      severity: alertsTable.severity,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(alertsTable)
    .where(eq(alertsTable.orgId, orgId))
    .groupBy(alertsTable.state, alertsTable.severity);

  const byState: Record<string, number> = {
    open: 0,
    acknowledged: 0,
    snoozed: 0,
    resolved: 0,
  };
  const bySeverity: Record<string, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  let openCriticalOrHigh = 0;
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + r.n;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + r.n;
    if (r.state === "open" && (r.severity === "high" || r.severity === "critical")) {
      openCriticalOrHigh += r.n;
    }
  }
  res.json({ byState, bySeverity, openCriticalOrHigh });
});

router.get("/alerts/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const [row] = await db
    .select()
    .from(alertsTable)
    .where(and(eq(alertsTable.id, id), eq(alertsTable.orgId, orgId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  res.json(mapAlert(row));
});

router.get("/alerts/:id/events", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const [alert] = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(and(eq(alertsTable.id, id), eq(alertsTable.orgId, orgId)))
    .limit(1);
  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  const rows = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, id))
    .orderBy(desc(alertEventsTable.createdAt));
  res.json({ items: rows.map(mapAlertEvent) });
});

router.get("/alerts/:id/deliveries", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const [alert] = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(and(eq(alertsTable.id, id), eq(alertsTable.orgId, orgId)))
    .limit(1);
  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  const rows = await db
    .select()
    .from(alertDeliveriesTable)
    .where(eq(alertDeliveriesTable.alertId, id))
    .orderBy(desc(alertDeliveriesTable.createdAt));
  res.json({ items: rows.map(mapDelivery) });
});

const TransitionAlertSchema = z.object({
  action: z.enum(["ack", "snooze", "resolve", "reopen", "assign", "comment"]),
  note: z.string().max(2000).optional(),
  snoozedUntil: z.string().datetime().optional(),
  assignedToUserId: z.string().nullable().optional(),
});

router.post("/alerts/:id/transitions", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const parsed = TransitionAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const [alert] = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(and(eq(alertsTable.id, id), eq(alertsTable.orgId, orgId)))
    .limit(1);
  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  try {
    const updated = await transitionAlert({
      alertId: id,
      action: parsed.data.action,
      actor: req.actorEmail ?? "system@procuro.ai",
      note: parsed.data.note,
      snoozedUntil: parsed.data.snoozedUntil
        ? new Date(parsed.data.snoozedUntil)
        : undefined,
      assignedToUserId: parsed.data.assignedToUserId ?? undefined,
    });
    res.json(mapAlert(updated));
  } catch (err) {
    req.log.warn(
      { err: (err as Error).message, alertId: id },
      "Alert transition failed",
    );
    res.status(400).json({ error: (err as Error).message });
  }
});

// Manual alert creation — used by tests and ad-hoc operator workflows.
const CreateManualAlertSchema = z.object({
  severity: severityEnum,
  source: sourceEnum.optional(),
  kind: z.string().min(1).max(120),
  title: z.string().min(1).max(500),
  summary: z.string().max(5000).optional(),
  dedupeKey: z.string().max(500).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  entityUid: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  contractId: z.string().nullable().optional(),
  opportunityId: z.string().nullable().optional(),
});

router.post("/alerts", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateManualAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const result = await createAlert({
    orgId,
    severity: parsed.data.severity,
    source: parsed.data.source ?? "manual",
    kind: parsed.data.kind,
    title: parsed.data.title,
    summary: parsed.data.summary ?? "",
    dedupeKey: parsed.data.dedupeKey,
    payload: parsed.data.payload,
    entityUid: parsed.data.entityUid ?? undefined,
    supplierId: parsed.data.supplierId ?? undefined,
    contractId: parsed.data.contractId ?? undefined,
    opportunityId: parsed.data.opportunityId ?? undefined,
    actor: req.actorEmail ?? "system@procuro.ai",
  });
  // Always returns 201 (created or bumped). The `outcome` field tells
  // the client which case occurred.
  res.status(201).json({
    alert: mapAlert(result.alert),
    outcome: result.outcome,
  });
});

// ------------------------- /alert-channels --------------------------

const CreateChannelSchema = z.object({
  kind: channelKindEnum,
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});

const PatchChannelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

router.get("/alert-channels", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select()
    .from(alertChannelsTable)
    .where(eq(alertChannelsTable.orgId, orgId))
    .orderBy(desc(alertChannelsTable.createdAt));
  res.json({ items: rows.map(mapChannel) });
});

router.post("/alert-channels", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  try {
    getChannelAdapter(parsed.data.kind).validateConfig(parsed.data.config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const id = newId("achan");
  const [row] = await db
    .insert(alertChannelsTable)
    .values({
      id,
      orgId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      config: parsed.data.config,
      enabled: parsed.data.enabled ?? true,
    })
    .returning();
  res.status(201).json(mapChannel(row!));
});

router.patch("/alert-channels/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const parsed = PatchChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const [existing] = await db
    .select()
    .from(alertChannelsTable)
    .where(
      and(
        eq(alertChannelsTable.id, id),
        eq(alertChannelsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  if (parsed.data.config) {
    try {
      getChannelAdapter(existing.kind).validateConfig(parsed.data.config);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }
  const updates: Partial<typeof alertChannelsTable.$inferInsert> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.config !== undefined) updates.config = parsed.data.config;
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
  const [row] = await db
    .update(alertChannelsTable)
    .set(updates)
    .where(eq(alertChannelsTable.id, id))
    .returning();
  res.json(mapChannel(row!));
});

router.delete("/alert-channels/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const r = await db
    .delete(alertChannelsTable)
    .where(
      and(
        eq(alertChannelsTable.id, id),
        eq(alertChannelsTable.orgId, orgId),
      ),
    );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  res.status(204).end();
});

router.post(
  "/alert-channels/:id/test",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const [channel] = await db
      .select()
      .from(alertChannelsTable)
      .where(
        and(
          eq(alertChannelsTable.id, id),
          eq(alertChannelsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // Build an ephemeral AlertRow shape (we never persist it). The
    // adapter only needs read access to the alert fields it formats.
    const now = new Date();
    const fakeAlert: AlertRow = {
      id: `alert_test_${Date.now()}`,
      orgId,
      severity: "info",
      source: "manual",
      kind: "channel_test",
      title: "Test alert",
      summary: `Smoke-test delivery for channel "${channel.name}"`,
      dedupeKey: null,
      occurrences: 1,
      payload: { test: true },
      entityUid: null,
      supplierId: null,
      contractId: null,
      opportunityId: null,
      state: "open",
      assignedToUserId: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      snoozedUntil: null,
      resolvedAt: null,
      resolvedBy: null,
      deliveredAt: null,
      escalatedAt: null,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const adapter = getChannelAdapter(channel.kind);
    const result = await adapter.send({ alert: fakeAlert, channel });
    res.json({
      status: result.status,
      providerMessageId: result.providerMessageId ?? null,
      httpStatus: result.httpStatus ?? null,
      error: result.error ?? null,
      payload: result.payload ?? null,
    });
  },
);

// ---------------------- /alert-subscriptions ------------------------

const CreateSubscriptionSchema = z.object({
  userId: z.string().min(1).max(120),
  channelId: z.string().min(1).max(120),
  severityThreshold: severityEnum.optional(),
  sources: z.array(sourceEnum).nullable().optional(),
  watchlistId: z.string().nullable().optional(),
  digest: digestEnum.optional(),
  enabled: z.boolean().optional(),
});

const PatchSubscriptionSchema = z.object({
  channelId: z.string().min(1).max(120).optional(),
  severityThreshold: severityEnum.optional(),
  sources: z.array(sourceEnum).nullable().optional(),
  watchlistId: z.string().nullable().optional(),
  digest: digestEnum.optional(),
  enabled: z.boolean().optional(),
});

router.get("/alert-subscriptions", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const userId = req.query["userId"] as string | undefined;
  const conds = [eq(alertSubscriptionsTable.orgId, orgId)];
  if (userId) conds.push(eq(alertSubscriptionsTable.userId, userId));
  const rows = await db
    .select()
    .from(alertSubscriptionsTable)
    .where(and(...conds))
    .orderBy(desc(alertSubscriptionsTable.createdAt));
  res.json({ items: rows.map(mapSubscription) });
});

router.post("/alert-subscriptions", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  // Validate the channel belongs to the same org.
  const [channel] = await db
    .select({ id: alertChannelsTable.id })
    .from(alertChannelsTable)
    .where(
      and(
        eq(alertChannelsTable.id, parsed.data.channelId),
        eq(alertChannelsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!channel) {
    res.status(400).json({ error: "Channel not found in this tenant" });
    return;
  }
  // Validate the watchlist (if provided) belongs to the same org.
  if (parsed.data.watchlistId) {
    const [wl] = await db
      .select({ id: watchlistsTable.id })
      .from(watchlistsTable)
      .where(
        and(
          eq(watchlistsTable.id, parsed.data.watchlistId),
          eq(watchlistsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!wl) {
      res.status(400).json({ error: "Watchlist not found in this tenant" });
      return;
    }
  }
  const id = newId("asub");
  const [row] = await db
    .insert(alertSubscriptionsTable)
    .values({
      id,
      orgId,
      userId: parsed.data.userId,
      channelId: parsed.data.channelId,
      severityThreshold: parsed.data.severityThreshold ?? "medium",
      sources: parsed.data.sources ?? null,
      watchlistId: parsed.data.watchlistId ?? null,
      digest: parsed.data.digest ?? "realtime",
      enabled: parsed.data.enabled ?? true,
    })
    .returning();
  res.status(201).json(mapSubscription(row!));
});

router.patch(
  "/alert-subscriptions/:id",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const parsed = PatchSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(alertSubscriptionsTable)
      .where(
        and(
          eq(alertSubscriptionsTable.id, id),
          eq(alertSubscriptionsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Subscription not found" });
      return;
    }
    if (parsed.data.channelId) {
      const [channel] = await db
        .select({ id: alertChannelsTable.id })
        .from(alertChannelsTable)
        .where(
          and(
            eq(alertChannelsTable.id, parsed.data.channelId),
            eq(alertChannelsTable.orgId, orgId),
          ),
        )
        .limit(1);
      if (!channel) {
        res.status(400).json({ error: "Channel not found in this tenant" });
        return;
      }
    }
    if (parsed.data.watchlistId) {
      const [wl] = await db
        .select({ id: watchlistsTable.id })
        .from(watchlistsTable)
        .where(
          and(
            eq(watchlistsTable.id, parsed.data.watchlistId),
            eq(watchlistsTable.orgId, orgId),
          ),
        )
        .limit(1);
      if (!wl) {
        res.status(400).json({ error: "Watchlist not found in this tenant" });
        return;
      }
    }
    const updates: Partial<typeof alertSubscriptionsTable.$inferInsert> = {};
    if (parsed.data.channelId !== undefined)
      updates.channelId = parsed.data.channelId;
    if (parsed.data.severityThreshold !== undefined)
      updates.severityThreshold = parsed.data.severityThreshold;
    if (parsed.data.sources !== undefined)
      updates.sources = parsed.data.sources;
    if (parsed.data.watchlistId !== undefined)
      updates.watchlistId = parsed.data.watchlistId;
    if (parsed.data.digest !== undefined) updates.digest = parsed.data.digest;
    if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
    const [row] = await db
      .update(alertSubscriptionsTable)
      .set(updates)
      .where(eq(alertSubscriptionsTable.id, id))
      .returning();
    res.json(mapSubscription(row!));
  },
);

router.delete(
  "/alert-subscriptions/:id",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const r = await db
      .delete(alertSubscriptionsTable)
      .where(
        and(
          eq(alertSubscriptionsTable.id, id),
          eq(alertSubscriptionsTable.orgId, orgId),
        ),
      );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Subscription not found" });
      return;
    }
    res.status(204).end();
  },
);

// --------------------------- /watchlists ----------------------------

const CreateWatchlistSchema = z.object({
  name: z.string().min(1).max(200),
  scope: watchlistScopeEnum.optional(),
  description: z.string().max(2000).optional(),
  userId: z.string().nullable().optional(),
});

const PatchWatchlistSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

router.get("/watchlists", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select()
    .from(watchlistsTable)
    .where(eq(watchlistsTable.orgId, orgId))
    .orderBy(desc(watchlistsTable.createdAt));
  res.json({ items: rows.map(mapWatchlist) });
});

router.post("/watchlists", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateWatchlistSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const id = newId("wl");
  const [row] = await db
    .insert(watchlistsTable)
    .values({
      id,
      orgId,
      userId: parsed.data.userId ?? null,
      name: parsed.data.name,
      scope: parsed.data.scope ?? "personal",
      description: parsed.data.description ?? "",
    })
    .returning();
  res.status(201).json(mapWatchlist(row!));
});

router.get("/watchlists/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const [row] = await db
    .select()
    .from(watchlistsTable)
    .where(and(eq(watchlistsTable.id, id), eq(watchlistsTable.orgId, orgId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Watchlist not found" });
    return;
  }
  const members = await db
    .select()
    .from(watchlistMembersTable)
    .where(eq(watchlistMembersTable.watchlistId, id))
    .orderBy(desc(watchlistMembersTable.addedAt));
  res.json({
    ...mapWatchlist(row),
    members: members.map(mapWatchlistMember),
  });
});

router.patch("/watchlists/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const parsed = PatchWatchlistSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const updates: Partial<typeof watchlistsTable.$inferInsert> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined)
    updates.description = parsed.data.description;
  const [row] = await db
    .update(watchlistsTable)
    .set(updates)
    .where(
      and(eq(watchlistsTable.id, id), eq(watchlistsTable.orgId, orgId)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Watchlist not found" });
    return;
  }
  res.json(mapWatchlist(row));
});

router.delete("/watchlists/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const r = await db
    .delete(watchlistsTable)
    .where(
      and(eq(watchlistsTable.id, id), eq(watchlistsTable.orgId, orgId)),
    );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Watchlist not found" });
    return;
  }
  res.status(204).end();
});

const AddMemberSchema = z
  .object({
    supplierId: z.string().min(1).max(120).optional(),
    entityUid: z.string().min(1).max(200).optional(),
  })
  .refine((d) => d.supplierId || d.entityUid, {
    message: "At least one of supplierId or entityUid is required",
  });

router.post(
  "/watchlists/:id/members",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const parsed = AddMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
      return;
    }
    const [parent] = await db
      .select({ id: watchlistsTable.id })
      .from(watchlistsTable)
      .where(
        and(eq(watchlistsTable.id, id), eq(watchlistsTable.orgId, orgId)),
      )
      .limit(1);
    if (!parent) {
      res.status(404).json({ error: "Watchlist not found" });
      return;
    }
    const memberId = newId("wlm");
    const inserted = await db
      .insert(watchlistMembersTable)
      .values({
        id: memberId,
        watchlistId: id,
        supplierId: parsed.data.supplierId ?? "",
        entityUid: parsed.data.entityUid ?? "",
      })
      .onConflictDoNothing({
        target: [
          watchlistMembersTable.watchlistId,
          watchlistMembersTable.supplierId,
          watchlistMembersTable.entityUid,
        ],
      })
      .returning();
    let row = inserted[0];
    if (!row) {
      const [existing] = await db
        .select()
        .from(watchlistMembersTable)
        .where(
          and(
            eq(watchlistMembersTable.watchlistId, id),
            eq(
              watchlistMembersTable.supplierId,
              parsed.data.supplierId ?? "",
            ),
            eq(
              watchlistMembersTable.entityUid,
              parsed.data.entityUid ?? "",
            ),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(500).json({ error: "Member upsert vanished" });
        return;
      }
      row = existing;
    }
    res.status(201).json(mapWatchlistMember(row));
  },
);

router.delete(
  "/watchlists/:id/members/:memberId",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const memberId = String(req.params["memberId"]);
    const [parent] = await db
      .select({ id: watchlistsTable.id })
      .from(watchlistsTable)
      .where(
        and(eq(watchlistsTable.id, id), eq(watchlistsTable.orgId, orgId)),
      )
      .limit(1);
    if (!parent) {
      res.status(404).json({ error: "Watchlist not found" });
      return;
    }
    const r = await db
      .delete(watchlistMembersTable)
      .where(
        and(
          eq(watchlistMembersTable.id, memberId),
          eq(watchlistMembersTable.watchlistId, id),
        ),
      );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    res.status(204).end();
  },
);

// -------------------------- /alert-rules ----------------------------

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  severity: severityEnum.optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  watchlistId: z.string().nullable().optional(),
});

const PatchRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  severity: severityEnum.optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  watchlistId: z.string().nullable().optional(),
});

router.get("/alert-rules", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select()
    .from(alertRulesTable)
    .where(eq(alertRulesTable.orgId, orgId))
    .orderBy(desc(alertRulesTable.createdAt));
  res.json({ items: rows.map(mapRule) });
});

router.post("/alert-rules", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  // Validate the watchlist (if provided) belongs to the same org.
  if (parsed.data.watchlistId) {
    const [wl] = await db
      .select({ id: watchlistsTable.id })
      .from(watchlistsTable)
      .where(
        and(
          eq(watchlistsTable.id, parsed.data.watchlistId),
          eq(watchlistsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!wl) {
      res.status(400).json({ error: "Watchlist not found in this tenant" });
      return;
    }
  }
  const id = newId("arule");
  const [row] = await db
    .insert(alertRulesTable)
    .values({
      id,
      orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      enabled: parsed.data.enabled ?? true,
      severity: parsed.data.severity ?? "medium",
      condition: parsed.data.condition ?? {},
      watchlistId: parsed.data.watchlistId ?? null,
    })
    .returning();
  res.status(201).json(mapRule(row!));
});

router.patch("/alert-rules/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const parsed = PatchRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  // Validate the watchlist (if provided) belongs to the same org.
  if (parsed.data.watchlistId) {
    const [wl] = await db
      .select({ id: watchlistsTable.id })
      .from(watchlistsTable)
      .where(
        and(
          eq(watchlistsTable.id, parsed.data.watchlistId),
          eq(watchlistsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!wl) {
      res.status(400).json({ error: "Watchlist not found in this tenant" });
      return;
    }
  }
  const updates: Partial<typeof alertRulesTable.$inferInsert> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined)
    updates.description = parsed.data.description;
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
  if (parsed.data.severity !== undefined)
    updates.severity = parsed.data.severity;
  if (parsed.data.condition !== undefined)
    updates.condition = parsed.data.condition;
  if (parsed.data.watchlistId !== undefined)
    updates.watchlistId = parsed.data.watchlistId;
  const [row] = await db
    .update(alertRulesTable)
    .set(updates)
    .where(
      and(eq(alertRulesTable.id, id), eq(alertRulesTable.orgId, orgId)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json(mapRule(row));
});

router.delete("/alert-rules/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params["id"]);
  const r = await db
    .delete(alertRulesTable)
    .where(
      and(eq(alertRulesTable.id, id), eq(alertRulesTable.orgId, orgId)),
    );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.status(204).end();
});

// ----------------------- /escalation-policies -----------------------

const CreateEscalationSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  severityAtLeast: severityEnum.optional(),
  unackedHours: z.number().int().min(1).max(720).optional(),
  escalateToUserId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
});

const PatchEscalationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  severityAtLeast: severityEnum.optional(),
  unackedHours: z.number().int().min(1).max(720).optional(),
  escalateToUserId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
});

router.get("/escalation-policies", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select()
    .from(escalationPoliciesTable)
    .where(eq(escalationPoliciesTable.orgId, orgId))
    .orderBy(desc(escalationPoliciesTable.createdAt));
  res.json({ items: rows.map(mapEscalation) });
});

router.post("/escalation-policies", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateEscalationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  // Validate the channel (if provided) belongs to the same org.
  if (parsed.data.channelId) {
    const [ch] = await db
      .select({ id: alertChannelsTable.id })
      .from(alertChannelsTable)
      .where(
        and(
          eq(alertChannelsTable.id, parsed.data.channelId),
          eq(alertChannelsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!ch) {
      res.status(400).json({ error: "Channel not found in this tenant" });
      return;
    }
  }
  const id = newId("escp");
  const [row] = await db
    .insert(escalationPoliciesTable)
    .values({
      id,
      orgId,
      name: parsed.data.name,
      enabled: parsed.data.enabled ?? true,
      severityAtLeast: parsed.data.severityAtLeast ?? "high",
      unackedHours: parsed.data.unackedHours ?? 4,
      escalateToUserId: parsed.data.escalateToUserId ?? null,
      channelId: parsed.data.channelId ?? null,
    })
    .returning();
  res.status(201).json(mapEscalation(row!));
});

router.patch(
  "/escalation-policies/:id",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const parsed = PatchEscalationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
      return;
    }
    // Validate the channel (if provided) belongs to the same org.
    if (parsed.data.channelId) {
      const [ch] = await db
        .select({ id: alertChannelsTable.id })
        .from(alertChannelsTable)
        .where(
          and(
            eq(alertChannelsTable.id, parsed.data.channelId),
            eq(alertChannelsTable.orgId, orgId),
          ),
        )
        .limit(1);
      if (!ch) {
        res.status(400).json({ error: "Channel not found in this tenant" });
        return;
      }
    }
    const updates: Partial<typeof escalationPoliciesTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.enabled !== undefined)
      updates.enabled = parsed.data.enabled;
    if (parsed.data.severityAtLeast !== undefined)
      updates.severityAtLeast = parsed.data.severityAtLeast;
    if (parsed.data.unackedHours !== undefined)
      updates.unackedHours = parsed.data.unackedHours;
    if (parsed.data.escalateToUserId !== undefined)
      updates.escalateToUserId = parsed.data.escalateToUserId;
    if (parsed.data.channelId !== undefined)
      updates.channelId = parsed.data.channelId;
    const [row] = await db
      .update(escalationPoliciesTable)
      .set(updates)
      .where(
        and(
          eq(escalationPoliciesTable.id, id),
          eq(escalationPoliciesTable.orgId, orgId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Escalation policy not found" });
      return;
    }
    res.json(mapEscalation(row));
  },
);

router.delete(
  "/escalation-policies/:id",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params["id"]);
    const r = await db
      .delete(escalationPoliciesTable)
      .where(
        and(
          eq(escalationPoliciesTable.id, id),
          eq(escalationPoliciesTable.orgId, orgId),
        ),
      );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Escalation policy not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
