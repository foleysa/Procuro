/**
 * Alert delivery + escalation workers.
 *
 * `deliverAlertsTick` finds alerts that haven't been fanned out yet
 * (`delivered_at IS NULL`), computes matching subscriptions, inserts
 * `alert_deliveries` rows in `pending` state, then drains pending
 * deliveries by invoking the channel adapter. Marks `alerts.delivered_at`
 * once fan-out is done so we never re-fan-out the same alert (subsequent
 * `(org_id, dedupe_key)` re-occurrences bump `occurrences` but don't
 * re-notify — that would spam users on bursty re-runs).
 *
 * `escalateAlertsTick` finds open alerts that breached an escalation
 * policy's `unackedHours` window, fans the alert out to the policy's
 * escalation channel/user, and sets `escalated_at` so we never escalate
 * the same alert twice.
 *
 * Both ticks expose an `injectableNow` so tests can fast-forward time
 * without messing with the system clock.
 */

import {
  db,
  alertsTable,
  alertEventsTable,
  alertSubscriptionsTable,
  alertChannelsTable,
  alertDeliveriesTable,
  escalationPoliciesTable,
  watchlistMembersTable,
  watchlistsTable,
  type AlertRow,
  type AlertChannelRow,
  type AlertSubscriptionRow,
  type AlertSeverity,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { getChannelAdapter } from "./channels";

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

interface TickOptions {
  /** For tests: override "now". Defaults to `new Date()`. */
  now?: () => Date;
  /** For tests: cap how many alerts/deliveries to process per call. */
  limit?: number;
}

export interface DeliverAlertsResult {
  alertsConsidered: number;
  deliveriesInserted: number;
  deliveriesSent: number;
  deliveriesFailed: number;
  deliveriesSimulated: number;
}

export async function deliverAlertsTick(
  opts: TickOptions = {},
): Promise<DeliverAlertsResult> {
  const now = (opts.now ?? (() => new Date()))();
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));

  // 1) Find alerts that haven't been fanned out.
  const undelivered = await db
    .select()
    .from(alertsTable)
    .where(isNull(alertsTable.deliveredAt))
    .limit(limit);

  let inserted = 0;
  let sent = 0;
  let failed = 0;
  let simulated = 0;

  for (const alert of undelivered) {
    inserted += await fanOutAlert(alert);
    // Mark fan-out complete (so a re-occurrence on the same dedupeKey
    // won't redo this; new alerts that hit later will pass through).
    await db
      .update(alertsTable)
      .set({ deliveredAt: now })
      .where(eq(alertsTable.id, alert.id));
  }

  // 2) Drain pending deliveries.
  const pending = await db
    .select({
      delivery: alertDeliveriesTable,
      alert: alertsTable,
      channel: alertChannelsTable,
    })
    .from(alertDeliveriesTable)
    .innerJoin(alertsTable, eq(alertDeliveriesTable.alertId, alertsTable.id))
    .innerJoin(
      alertChannelsTable,
      eq(alertDeliveriesTable.channelId, alertChannelsTable.id),
    )
    .where(eq(alertDeliveriesTable.state, "pending"))
    .limit(limit);

  for (const row of pending) {
    if (!row.channel.enabled) {
      await db
        .update(alertDeliveriesTable)
        .set({
          state: "skipped",
          lastError: "channel disabled",
          attempts: row.delivery.attempts + 1,
        })
        .where(eq(alertDeliveriesTable.id, row.delivery.id));
      continue;
    }

    const adapter = getChannelAdapter(row.channel.kind);
    let outcome;
    try {
      outcome = await adapter.send({ alert: row.alert, channel: row.channel });
    } catch (err) {
      outcome = {
        status: "failed" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.status === "delivered" || outcome.status === "simulated") {
      await db
        .update(alertDeliveriesTable)
        .set({
          state: "sent",
          attempts: row.delivery.attempts + 1,
          sentAt: now,
          lastError: null,
        })
        .where(eq(alertDeliveriesTable.id, row.delivery.id));
      await db.insert(alertEventsTable).values({
        id: newId("ae"),
        alertId: row.alert.id,
        eventType: "delivered",
        actor: null,
        note: null,
        metadata: {
          channelId: row.channel.id,
          channelKind: row.channel.kind,
          status: outcome.status,
          providerMessageId: outcome.providerMessageId ?? null,
          httpStatus: outcome.httpStatus ?? null,
        },
      });
      if (outcome.status === "simulated") simulated += 1;
      else sent += 1;
    } else if (outcome.status === "skipped") {
      await db
        .update(alertDeliveriesTable)
        .set({
          state: "skipped",
          attempts: row.delivery.attempts + 1,
          lastError: outcome.error ?? "skipped",
        })
        .where(eq(alertDeliveriesTable.id, row.delivery.id));
    } else {
      await db
        .update(alertDeliveriesTable)
        .set({
          state: "failed",
          attempts: row.delivery.attempts + 1,
          lastError: outcome.error ?? "unknown failure",
        })
        .where(eq(alertDeliveriesTable.id, row.delivery.id));
      await db.insert(alertEventsTable).values({
        id: newId("ae"),
        alertId: row.alert.id,
        eventType: "delivery_failed",
        actor: null,
        note: outcome.error ?? null,
        metadata: {
          channelId: row.channel.id,
          channelKind: row.channel.kind,
          httpStatus: outcome.httpStatus ?? null,
        },
      });
      failed += 1;
    }
  }

  return {
    alertsConsidered: undelivered.length,
    deliveriesInserted: inserted,
    deliveriesSent: sent,
    deliveriesFailed: failed,
    deliveriesSimulated: simulated,
  };
}

/**
 * Insert `alert_deliveries` rows for an alert by matching subscriptions
 * within the same org. Idempotent — the unique index on
 * `(alert_id, subscription_id, channel_id)` guarantees we never
 * double-insert if this is somehow called twice for the same alert.
 */
async function fanOutAlert(alert: AlertRow): Promise<number> {
  const subs = await db
    .select({
      subscription: alertSubscriptionsTable,
      channel: alertChannelsTable,
    })
    .from(alertSubscriptionsTable)
    .innerJoin(
      alertChannelsTable,
      eq(alertSubscriptionsTable.channelId, alertChannelsTable.id),
    )
    .where(
      and(
        eq(alertSubscriptionsTable.orgId, alert.orgId),
        eq(alertSubscriptionsTable.enabled, true),
      ),
    );

  let count = 0;
  for (const { subscription, channel } of subs) {
    if (!subscriptionMatches(subscription, alert)) continue;
    if (!channel.enabled) continue;
    if (subscription.watchlistId) {
      const watchlistHits = await watchlistMatches(
        subscription.watchlistId,
        alert,
      );
      if (!watchlistHits) continue;
    }
    try {
      await db.insert(alertDeliveriesTable).values({
        id: newId("adv"),
        alertId: alert.id,
        subscriptionId: subscription.id,
        channelId: channel.id,
        state: "pending",
      });
      count += 1;
    } catch (err) {
      // unique-constraint hits are expected if a previous tick crashed
      // mid-fan-out; log and continue.
      const code = (err as { code?: string }).code;
      if (code === "23505") continue;
      throw err;
    }
  }
  return count;
}

function subscriptionMatches(
  sub: AlertSubscriptionRow,
  alert: AlertRow,
): boolean {
  if (
    SEVERITY_RANK[alert.severity] < SEVERITY_RANK[sub.severityThreshold]
  ) {
    return false;
  }
  const sources = sub.sources;
  if (sources && sources.length > 0 && !sources.includes(alert.source)) {
    return false;
  }
  return true;
}

async function watchlistMatches(
  watchlistId: string,
  alert: AlertRow,
): Promise<boolean> {
  const members = await db
    .select({
      supplierId: watchlistMembersTable.supplierId,
      entityUid: watchlistMembersTable.entityUid,
    })
    .from(watchlistMembersTable)
    .innerJoin(
      watchlistsTable,
      eq(watchlistMembersTable.watchlistId, watchlistsTable.id),
    )
    .where(
      and(
        eq(watchlistMembersTable.watchlistId, watchlistId),
        eq(watchlistsTable.orgId, alert.orgId),
      ),
    );
  for (const m of members) {
    if (m.supplierId && m.supplierId === alert.supplierId) return true;
    if (m.entityUid && m.entityUid === alert.entityUid) return true;
  }
  return false;
}

export interface EscalateAlertsResult {
  policiesEvaluated: number;
  alertsEscalated: number;
}

export async function escalateAlertsTick(
  opts: TickOptions = {},
): Promise<EscalateAlertsResult> {
  const now = (opts.now ?? (() => new Date()))();
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));

  // First, wake any snoozed alerts whose snoozes have expired so we
  // don't wrongly pin them in the snoozed bucket forever.
  await db.execute(sql`
    UPDATE alerts
    SET state = 'open', snoozed_until = NULL, updated_at = now()
    WHERE state = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ${now.toISOString()}
  `);

  const policies = await db
    .select()
    .from(escalationPoliciesTable)
    .where(eq(escalationPoliciesTable.enabled, true));

  let escalated = 0;
  for (const policy of policies) {
    if (!policy.channelId) continue;
    const cutoff = new Date(
      now.getTime() - policy.unackedHours * 60 * 60 * 1000,
    );
    const candidates = await db
      .select()
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.orgId, policy.orgId),
          eq(alertsTable.state, "open"),
          isNull(alertsTable.escalatedAt),
        ),
      )
      .limit(limit);

    for (const alert of candidates) {
      if (
        SEVERITY_RANK[alert.severity] <
        SEVERITY_RANK[policy.severityAtLeast]
      ) {
        continue;
      }
      if (alert.firstSeenAt > cutoff) continue;

      const [channel] = await db
        .select()
        .from(alertChannelsTable)
        .where(
          and(
            eq(alertChannelsTable.id, policy.channelId),
            eq(alertChannelsTable.orgId, policy.orgId),
          ),
        )
        .limit(1);
      if (!channel || !channel.enabled) continue;

      const adapter = getChannelAdapter(channel.kind);
      let outcome;
      try {
        outcome = await adapter.send({ alert, channel });
      } catch (err) {
        outcome = {
          status: "failed" as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      await db
        .update(alertsTable)
        .set({ escalatedAt: now })
        .where(eq(alertsTable.id, alert.id));
      await db.insert(alertEventsTable).values({
        id: newId("ae"),
        alertId: alert.id,
        eventType: "escalated",
        actor: null,
        note: null,
        metadata: {
          policyId: policy.id,
          channelId: channel.id,
          channelKind: channel.kind,
          escalateToUserId: policy.escalateToUserId,
          deliveryStatus: outcome.status,
        },
      });
      escalated += 1;
      logger.info(
        {
          alertId: alert.id,
          policyId: policy.id,
          escalatedTo: policy.escalateToUserId,
        },
        "Alert escalated",
      );
    }
  }

  return { policiesEvaluated: policies.length, alertsEscalated: escalated };
}

export type EscalateAlertChannel = AlertChannelRow;
